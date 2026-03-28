use anyhow::Result;
use crossbeam_channel::Sender;

use super::resampler::ToWhisper;
use crate::ipc::{AudioChunk, AudioSource};

const CHUNK_FRAMES: usize = 1600; // 100ms at 16kHz

fn current_time_us() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

// ── macOS — CoreAudio via cpal ────────────────────────────────────────────────

#[cfg(target_os = "macos")]
pub fn run(tx: Sender<AudioChunk>, _chunk_ms: u32) -> Result<()> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tracing::{info, warn};

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow::anyhow!("No default input device"))?;

    let name = device.name().unwrap_or_else(|_| "unknown".into());
    info!("Mic device: {name}");

    let config = device.default_input_config()?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels() as u16;
    let sample_format = config.sample_format();
    info!("Mic format: {sample_rate}Hz {channels}ch {sample_format:?}");

    if sample_format != cpal::SampleFormat::F32 {
        anyhow::bail!("Mic: expected F32 audio from CoreAudio, got {sample_format:?}");
    }

    let mut resampler = ToWhisper::new(sample_rate, channels)?;
    let mut accumulated: Vec<f32> = Vec::new();
    let stopped = Arc::new(AtomicBool::new(false));
    let stopped_cb = stopped.clone();
    let first_cb = Arc::new(AtomicBool::new(false));
    let first_cb2 = first_cb.clone();

    let stream = device.build_input_stream(
        &config.into(),
        move |data: &[f32], _: &cpal::InputCallbackInfo| {
            if !first_cb2.swap(true, Ordering::Relaxed) {
                tracing::info!("Mic: first audio callback ({} frames, non-zero={})",
                    data.len(),
                    data.iter().any(|&s| s != 0.0));
            }
            match resampler.process(data) {
                Ok(resampled) => {
                    accumulated.extend_from_slice(&resampled);
                    while accumulated.len() >= CHUNK_FRAMES {
                        let samples: Vec<f32> = accumulated.drain(..CHUNK_FRAMES).collect();
                        let chunk = AudioChunk {
                            source: AudioSource::Mic,
                            timestamp_us: current_time_us(),
                            samples,
                        };
                        if tx.send(chunk).is_err() {
                            stopped_cb.store(true, Ordering::Relaxed);
                            return;
                        }
                    }
                }
                Err(e) => warn!("Mic resample error: {e}"),
            }
        },
        move |err| tracing::error!("Mic stream error: {err}"),
        None,
    )?;

    stream.play()?;
    info!("Mic capture started");

    while !stopped.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Ok(())
}

// ── Windows — WASAPI ──────────────────────────────────────────────────────────

#[cfg(windows)]
pub fn run(tx: Sender<AudioChunk>, _chunk_ms: u32) -> Result<()> {
    use std::collections::VecDeque;
    use tracing::{info, warn};
    use wasapi::*;

    initialize_mta().ok()?;

    let device = get_default_device(&Direction::Capture)?;
    let device_name = device.get_friendlyname().unwrap_or_else(|_| "unknown".into());
    info!("Mic device: {device_name}");

    let mut audio_client = device.get_iaudioclient()?;
    let mix_format = audio_client.get_mixformat()?;
    let rate = mix_format.get_samplespersec();
    let channels = mix_format.get_nchannels();
    let blockalign = mix_format.get_blockalign() as usize;
    info!("Mic format: {rate}Hz {channels}ch blockalign={blockalign}");

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
    info!("Mic capture started");

    loop {
        capture_client.read_from_device_to_deque(&mut sample_queue)?;

        if h_event.wait_for_event(3000).is_err() {
            warn!("Mic: event timeout");
            continue;
        }

        while sample_queue.len() >= blockalign {
            let frame_bytes: Vec<u8> = sample_queue.drain(..blockalign).collect();
            let interleaved: Vec<f32> = frame_bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();

            match resampler.process(&interleaved) {
                Ok(resampled) => accumulated.extend_from_slice(&resampled),
                Err(e) => warn!("Mic resample error: {e}"),
            }
        }

        while accumulated.len() >= CHUNK_FRAMES {
            let chunk_data: Vec<f32> = accumulated.drain(..CHUNK_FRAMES).collect();
            let chunk = AudioChunk {
                source: AudioSource::Mic,
                timestamp_us: current_time_us(),
                samples: chunk_data,
            };
            if tx.send(chunk).is_err() {
                info!("Mic: channel closed, stopping");
                audio_client.stop_stream()?;
                return Ok(());
            }
        }
    }
}
