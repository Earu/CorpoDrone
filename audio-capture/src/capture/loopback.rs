use std::collections::VecDeque;
use anyhow::Result;
use crossbeam_channel::Sender;
use tracing::{info, warn};
use wasapi::*;

use super::resampler::ToWhisper;
use crate::ipc::{AudioChunk, AudioSource};

const CHUNK_FRAMES: usize = 1600; // 100ms at 16kHz

pub fn run(tx: Sender<AudioChunk>, _chunk_ms: u32) -> Result<()> {
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

    let desired_format = WaveFormat::new(32, 32, &SampleType::Float, rate as usize, channels as usize, None);
    let (_, min_time) = audio_client.get_periods()?;

    // Pass Direction::Capture + loopback=true to enable WASAPI loopback capture
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

    let mut sample_queue: VecDeque<u8> = VecDeque::with_capacity(
        100 * blockalign * (1024 + 2 * buf_frames as usize),
    );

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

        // When nothing is playing, loopback returns silence — that's fine, still process it
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

fn current_time_us() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}
