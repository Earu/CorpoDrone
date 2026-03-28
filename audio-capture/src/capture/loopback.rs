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

// ── macOS — ScreenCaptureKit system audio loopback ────────────────────────────

#[cfg(target_os = "macos")]
mod macos_sck {
    use std::ffi::c_void;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use anyhow::Result;
    use crossbeam_channel::Sender;
    use tracing::info;

    use screencapturekit::{
        cm_sample_buffer::CMSampleBuffer,
        sc_content_filter::{InitParams, SCContentFilter},
        sc_error_handler::StreamErrorHandler,
        sc_output_handler::{SCStreamOutput, StreamType},
        sc_shareable_content::SCShareableContent,
        sc_stream::SCStream,
        sc_stream_configuration::SCStreamConfiguration,
    };

    use crate::capture::resampler::ToWhisper;
    use crate::ipc::{AudioChunk, AudioSource};
    use super::{CHUNK_FRAMES, current_time_us};

    // CoreMedia FFI — extract raw PCM from a CMSampleBuffer.
    // SCStream delivers Float32 LPCM; we ask for mono 48kHz so there is
    // exactly one AudioBuffer per sample buffer.
    #[repr(C)]
    struct RawAudioBuffer {
        number_channels: u32,
        data_byte_size: u32,
        data: *mut c_void,
    }

    // Fixed-size AudioBufferList sized for up to 8 channels
    #[repr(C)]
    struct RawAudioBufferList {
        number_buffers: u32,
        buffers: [RawAudioBuffer; 8],
    }

    #[link(name = "CoreMedia", kind = "framework")]
    extern "C" {
        fn CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sbuf: *mut c_void,
            buffer_list_size_needed_out: *mut usize,
            buffer_list_out: *mut RawAudioBufferList,
            buffer_list_size: usize,
            block_buf_structure_allocator: *const c_void,
            block_buf_block_allocator: *const c_void,
            flags: u32,
            block_buffer_out: *mut *mut c_void,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    // Extract f32 PCM samples from a CMSampleBuffer.
    //
    // screencapturekit's CMSampleBuffer is a transparent newtype around the raw
    // CMSampleBufferRef pointer, so reading the first pointer-sized word gives
    // us the underlying ObjC object reference we can pass to CoreMedia C APIs.
    //
    // Safety: `sample_buffer` must be alive for the duration of this call.
    unsafe fn extract_pcm(sample_buffer: &CMSampleBuffer) -> Vec<f32> {
        let raw_ref: *mut c_void =
            std::mem::transmute_copy::<CMSampleBuffer, *mut c_void>(sample_buffer);
        if raw_ref.is_null() {
            return Vec::new();
        }

        let mut list = std::mem::MaybeUninit::<RawAudioBufferList>::uninit();
        let mut block_buf: *mut c_void = std::ptr::null_mut();

        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            raw_ref,
            std::ptr::null_mut(),
            list.as_mut_ptr(),
            std::mem::size_of::<RawAudioBufferList>(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut block_buf,
        );

        if status != 0 {
            return Vec::new();
        }

        let list = list.assume_init();
        let mut out = Vec::new();

        for i in 0..(list.number_buffers.min(8) as usize) {
            let b = &list.buffers[i];
            if b.data.is_null() || b.data_byte_size == 0 {
                continue;
            }
            let n = b.data_byte_size as usize / std::mem::size_of::<f32>();
            out.extend_from_slice(std::slice::from_raw_parts(b.data as *const f32, n));
        }

        if !block_buf.is_null() {
            CFRelease(block_buf);
        }
        out
    }

    struct CaptureState {
        resampler: ToWhisper,
        accumulated: Vec<f32>,
        tx: Sender<AudioChunk>,
        stopped: Arc<AtomicBool>,
    }

    struct AudioOutput {
        state: Arc<Mutex<CaptureState>>,
    }

    struct ErrorHandler;
    impl StreamErrorHandler for ErrorHandler {
        fn on_error(&self) {
            tracing::error!("SCStream error");
        }
    }

    impl SCStreamOutput for AudioOutput {
        fn did_output_sample_buffer(&self, sample_buffer: CMSampleBuffer, of_type: StreamType) {
            if of_type != StreamType::Audio {
                return;
            }

            let pcm = unsafe { extract_pcm(&sample_buffer) };
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

        let content = SCShareableContent::current();
        let display = content
            .displays
            .first()
            .ok_or_else(|| anyhow::anyhow!(
                "No display found — ensure screen recording permission is granted"
            ))?;

        info!("Loopback capture: SCStream on display");

        let filter = SCContentFilter::new(InitParams::Display(display.clone()));
        let config = SCStreamConfiguration {
            width: 2,
            height: 2,
            captures_audio: true,
            excludes_current_process_audio: false,
            // mono 48kHz → ToWhisper resamples to 16kHz
            sample_rate: 48000,
            channel_count: 1,
            ..Default::default()
        };

        let mut stream = SCStream::new(filter, config, ErrorHandler);
        stream.add_output(AudioOutput { state }, StreamType::Audio);
        stream.start_capture()?;
        info!("Loopback capture started (ScreenCaptureKit)");

        while !stopped.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let _ = stream.stop_capture();
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
