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

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn mic_process_cpal_interleaved_f32(
    resampler: &mut ToWhisper,
    accumulated: &mut Vec<f32>,
    tx: &Sender<AudioChunk>,
    stopped_cb: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    first_callback: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    interleaved: &[f32],
) {
    use std::sync::atomic::Ordering;
    use tracing::warn;

    if !first_callback.swap(true, Ordering::Relaxed) {
        tracing::info!(
            "Mic: first audio callback ({} samples, non-zero={})",
            interleaved.len(),
            interleaved.iter().any(|&s| s != 0.0)
        );
    }
    match resampler.process(interleaved) {
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
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn mic_cpal_stream_error(err: cpal::StreamError) {
    tracing::error!("Mic stream error: {err}");
}

/// Input stream that converts `T` samples to `f32` via cpal/dasp before resampling.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn build_cpal_mic_input_converting<T>(
    device: &cpal::Device,
    stream_cfg: &cpal::StreamConfig,
    mut resampler: ToWhisper,
    mut accumulated: Vec<f32>,
    tx: Sender<AudioChunk>,
    stopped_cb: std::sync::Arc<std::sync::atomic::AtomicBool>,
    first_cb2: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    use cpal::traits::DeviceTrait;

    let mut scratch = Vec::<f32>::with_capacity(8192);
    device.build_input_stream(
        stream_cfg,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            scratch.clear();
            scratch.extend(data.iter().map(|&s| s.to_sample::<f32>()));
            mic_process_cpal_interleaved_f32(
                &mut resampler,
                &mut accumulated,
                &tx,
                &stopped_cb,
                &first_cb2,
                &scratch,
            );
        },
        mic_cpal_stream_error,
        None,
    )
}

// ── macOS / Linux — cpal (CoreAudio on macOS; ALSA/JACK/PipeWire compat on Linux) ─

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub fn run(tx: Sender<AudioChunk>, _chunk_ms: u32) -> Result<()> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use tracing::info;

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

    let stream_cfg: cpal::StreamConfig = config.clone().into();

    let mut resampler = ToWhisper::new(sample_rate, channels)?;
    let mut accumulated: Vec<f32> = Vec::new();
    let stopped = Arc::new(AtomicBool::new(false));
    let stopped_cb = stopped.clone();
    let first_cb = Arc::new(AtomicBool::new(false));
    let first_cb2 = first_cb.clone();

    let stream_result = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_cfg,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                mic_process_cpal_interleaved_f32(
                    &mut resampler,
                    &mut accumulated,
                    &tx,
                    &stopped_cb,
                    &first_cb2,
                    data,
                );
            },
            mic_cpal_stream_error,
            None,
        ),
        cpal::SampleFormat::I8 => build_cpal_mic_input_converting::<i8>(
            &device,
            &stream_cfg,
            resampler,
            accumulated,
            tx,
            stopped_cb,
            first_cb2,
        ),
        cpal::SampleFormat::I16 => build_cpal_mic_input_converting::<i16>(
            &device,
            &stream_cfg,
            resampler,
            accumulated,
            tx,
            stopped_cb,
            first_cb2,
        ),
        cpal::SampleFormat::I32 => build_cpal_mic_input_converting::<i32>(
            &device,
            &stream_cfg,
            resampler,
            accumulated,
            tx,
            stopped_cb,
            first_cb2,
        ),
        cpal::SampleFormat::I64 => build_cpal_mic_input_converting::<i64>(
            &device,
            &stream_cfg,
            resampler,
            accumulated,
            tx,
            stopped_cb,
            first_cb2,
        ),
        cpal::SampleFormat::U8 => build_cpal_mic_input_converting::<u8>(
            &device,
            &stream_cfg,
            resampler,
            accumulated,
            tx,
            stopped_cb,
            first_cb2,
        ),
        cpal::SampleFormat::U16 => build_cpal_mic_input_converting::<u16>(
            &device,
            &stream_cfg,
            resampler,
            accumulated,
            tx,
            stopped_cb,
            first_cb2,
        ),
        cpal::SampleFormat::U32 => build_cpal_mic_input_converting::<u32>(
            &device,
            &stream_cfg,
            resampler,
            accumulated,
            tx,
            stopped_cb,
            first_cb2,
        ),
        cpal::SampleFormat::U64 => build_cpal_mic_input_converting::<u64>(
            &device,
            &stream_cfg,
            resampler,
            accumulated,
            tx,
            stopped_cb,
            first_cb2,
        ),
        cpal::SampleFormat::F64 => build_cpal_mic_input_converting::<f64>(
            &device,
            &stream_cfg,
            resampler,
            accumulated,
            tx,
            stopped_cb,
            first_cb2,
        ),
        f => {
            return Err(anyhow::anyhow!(
                "Mic: unsupported sample format {f:?} (cpal added a new format)"
            ));
        }
    };

    let stream = stream_result.map_err(|e| anyhow::anyhow!("Mic: failed to open input stream: {e}"))?;

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
