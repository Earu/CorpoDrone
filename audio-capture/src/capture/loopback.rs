use anyhow::Result;
use crossbeam_channel::Sender;

use crate::ipc::AudioChunk;

const CHUNK_FRAMES: usize = 1600; // 100ms at 16kHz

fn current_time_us() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

// ── macOS — ScreenCaptureKit system audio loopback ────────────────────────────

#[cfg(target_os = "macos")]
mod macos_sck {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use anyhow::Result;
    use crossbeam_channel::Sender;
    use tracing::info;

    use core_media_rs::cm_sample_buffer::CMSampleBuffer;
    use screencapturekit::{
        shareable_content::SCShareableContent,
        stream::{
            configuration::SCStreamConfiguration,
            content_filter::SCContentFilter,
            output_trait::SCStreamOutputTrait,
            output_type::SCStreamOutputType,
            SCStream,
        },
    };

    use crate::capture::resampler::ToWhisper;
    use crate::ipc::{AudioChunk, AudioSource};
    use super::{CHUNK_FRAMES, current_time_us};

    struct CaptureState {
        resampler: ToWhisper,
        accumulated: Vec<f32>,
        tx: Sender<AudioChunk>,
        stopped: Arc<AtomicBool>,
    }

    struct AudioOutput {
        state: Arc<Mutex<CaptureState>>,
    }

    impl SCStreamOutputTrait for AudioOutput {
        fn did_output_sample_buffer(
            &self,
            sample_buffer: CMSampleBuffer,
            of_type: SCStreamOutputType,
        ) {
            if of_type != SCStreamOutputType::Audio {
                return;
            }

            let audio_buf_list = match sample_buffer.get_audio_buffer_list() {
                Ok(list) => list,
                Err(e) => {
                    tracing::warn!("Loopback: failed to get audio buffer list: {e:?}");
                    return;
                }
            };

            let mut pcm: Vec<f32> = Vec::new();
            for i in 0..audio_buf_list.num_buffers() {
                if let Some(buf) = audio_buf_list.get(i) {
                    let bytes = buf.data();
                    let samples = bytes
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]));
                    pcm.extend(samples);
                }
            }

            if pcm.is_empty() {
                return;
            }

            let mut s = self.state.lock().unwrap();
            match s.resampler.process(&pcm) {
                Ok(resampled) => {
                    s.accumulated.extend_from_slice(&resampled);
                    while s.accumulated.len() >= CHUNK_FRAMES {
                        let samples: Vec<f32> = s.accumulated.drain(..CHUNK_FRAMES).collect();
                        let chunk = AudioChunk {
                            source: AudioSource::Loopback,
                            timestamp_us: current_time_us(),
                            samples,
                        };
                        if s.tx.send(chunk).is_err() {
                            s.stopped.store(true, Ordering::Relaxed);
                            return;
                        }
                    }
                }
                Err(e) => tracing::warn!("Loopback resample error: {e}"),
            }
        }
    }

    pub fn run(tx: Sender<AudioChunk>, _chunk_ms: u32) -> Result<()> {
        let stopped = Arc::new(AtomicBool::new(false));
        let state = Arc::new(Mutex::new(CaptureState {
            // Request mono 48kHz; SCKit resamples internally.
            // ToWhisper then resamples 48kHz→16kHz.
            resampler: ToWhisper::new(48_000u32, 1u16)?,
            accumulated: Vec::new(),
            tx,
            stopped: stopped.clone(),
        }));

        let mut displays = SCShareableContent::get()
            .map_err(|e| anyhow::anyhow!("SCShareableContent::get failed: {e:?}"))?
            .displays();
        let display = displays
            .first_mut()
            .ok_or_else(|| anyhow::anyhow!(
                "No display found — ensure screen recording permission is granted"
            ))?;

        info!("Loopback capture: SCStream on display");

        // Minimal 2×2 video frame; we only care about audio.
        let config = SCStreamConfiguration::new()
            .set_captures_audio(true)
            .map_err(|e| anyhow::anyhow!("set_captures_audio: {e:?}"))?
            .set_excludes_current_process_audio(false)
            .map_err(|e| anyhow::anyhow!("set_excludes_current_process_audio: {e:?}"))?
            .set_sample_rate(48_000)
            .map_err(|e| anyhow::anyhow!("set_sample_rate: {e:?}"))?
            .set_channel_count(1)
            .map_err(|e| anyhow::anyhow!("set_channel_count: {e:?}"))?;

        let filter = SCContentFilter::new().with_display_excluding_windows(display, &[]);
        let mut stream = SCStream::new(&filter, &config);
        stream.add_output_handler(AudioOutput { state }, SCStreamOutputType::Audio);
        stream
            .start_capture()
            .map_err(|e| anyhow::anyhow!("start_capture: {e:?}"))?;
        info!("Loopback capture started (ScreenCaptureKit)");

        while !stopped.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        stream.stop_capture().ok();
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub fn run(tx: Sender<AudioChunk>, chunk_ms: u32) -> Result<()> {
    macos_sck::run(tx, chunk_ms)
}

// ── Windows — WASAPI loopback ─────────────────────────────────────────────────

#[cfg(windows)]
pub fn run(tx: Sender<AudioChunk>, _chunk_ms: u32) -> Result<()> {
    use std::collections::VecDeque;
    use tracing::{info, warn};
    use wasapi::*;

    initialize_mta().ok()?;

    // Loopback = connect to the RENDER (speaker) endpoint in capture mode
    let device = get_default_device(&Direction::Render)?;
    let device_name = device.get_friendlyname().unwrap_or_else(|_| "unknown".into());
    info!("Loopback device: {device_name}");

    let mut audio_client = device.get_iaudioclient()?;
    let mix_format = audio_client.get_mixformat()?;
    let rate = mix_format.get_samplespersec();
    let channels = mix_format.get_nchannels();
    let blockalign = mix_format.get_blockalign() as usize;
    info!("Loopback format: {rate}Hz {channels}ch blockalign={blockalign}");

    let desired_format = WaveFormat::new(
        32, 32, &SampleType::Float, rate as usize, channels as usize, None,
    );
    let (_, min_time) = audio_client.get_periods()?;

    audio_client.initialize_client(
        &desired_format,
        min_time,
        &Direction::Capture,
        &ShareMode::Shared,
        true,
    )?;

    let h_event = audio_client.set_get_eventhandle()?;
    let buf_frames = audio_client.get_bufferframecount()?;
    let capture_client = audio_client.get_audiocaptureclient()?;

    let mut sample_queue: VecDeque<u8> =
        VecDeque::with_capacity(100 * blockalign * (1024 + 2 * buf_frames as usize));
    let mut resampler = ToWhisper::new(rate, channels)?;
    let mut accumulated: Vec<f32> = Vec::new();

    audio_client.start_stream()?;
    info!("Loopback capture started");

    loop {
        capture_client.read_from_device_to_deque(&mut sample_queue)?;

        if h_event.wait_for_event(3000).is_err() {
            warn!("Loopback: event timeout");
            continue;
        }

        // When nothing is playing, loopback returns silence — that's fine
        while sample_queue.len() >= blockalign {
            let frame_bytes: Vec<u8> = sample_queue.drain(..blockalign).collect();
            let interleaved: Vec<f32> = frame_bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();

            match resampler.process(&interleaved) {
                Ok(resampled) => accumulated.extend_from_slice(&resampled),
                Err(e) => warn!("Loopback resample error: {e}"),
            }
        }

        while accumulated.len() >= CHUNK_FRAMES {
            let chunk_data: Vec<f32> = accumulated.drain(..CHUNK_FRAMES).collect();
            let chunk = AudioChunk {
                source: AudioSource::Loopback,
                timestamp_us: current_time_us(),
                samples: chunk_data,
            };
            if tx.send(chunk).is_err() {
                info!("Loopback: channel closed, stopping");
                audio_client.stop_stream()?;
                return Ok(());
            }
        }
    }
}
