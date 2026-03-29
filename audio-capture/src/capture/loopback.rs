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

// ── macOS — ScreenCaptureKit audio capture ────────────────────────────────────
//
// Two kinds of SCStream are created:
//
//   1. Display stream  — captures the system audio output mix (Firefox, Safari,
//      YouTube, Spotify, system sounds, and most apps).
//
//   2. Per-app streams — one stream per running communication app (Discord,
//      Slack, Teams, Zoom, …).  These apps route voice audio through helper
//      processes that bypass the system mix, so they need their own stream.
//      We poll shareable content every few seconds so apps launched after the
//      session starts still get a stream (keyed by process ID).
//
// All streams send AudioChunk { source: Loopback } into the same channel, so
// the downstream pipeline needs no changes.

#[cfg(target_os = "macos")]
mod macos_sck {
    use std::collections::HashSet;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };
    use std::time::Duration;
    use anyhow::Result;
    use crossbeam_channel::Sender;
    use screencapturekit::prelude::*;

    use crate::capture::resampler::ToWhisper;
    use crate::ipc::{AudioChunk, AudioSource};
    use super::{CHUNK_FRAMES, current_time_us};


    struct CaptureState {
        resampler: ToWhisper,
        accumulated: Vec<f32>,
        tx: Sender<AudioChunk>,
        stopped: Arc<AtomicBool>,
    }

    struct AudioHandler {
        state: Arc<Mutex<CaptureState>>,
    }

    impl SCStreamOutputTrait for AudioHandler {
        fn did_output_sample_buffer(
            &self,
            sample_buffer: CMSampleBuffer,
            of_type: SCStreamOutputType,
        ) {
            if of_type != SCStreamOutputType::Audio {
                return;
            }

            let audio_buf_list = match sample_buffer.audio_buffer_list() {
                Some(list) => list,
                None => return,
            };

            // CoreAudio can deliver audio in two layouts:
            //   Interleaved:     1 buffer containing [L0 R0 L1 R1 …]
            //   Non-interleaved: N buffers, one per channel: [L0 L1 …] [R0 R1 …]
            // Naively concatenating non-interleaved buffers produces [L0..Ln R0..Rn],
            // which the resampler then misreads as interleaved, pairing same-channel
            // adjacent samples instead of L+R pairs. Detect and interleave explicitly.
            let channel_bufs: Vec<Vec<f32>> = audio_buf_list
                .iter()
                .map(|buf| {
                    buf.data()
                        .chunks_exact(4)
                        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                        .collect::<Vec<f32>>()
                })
                .collect();

            if channel_bufs.is_empty() || channel_bufs[0].is_empty() {
                return;
            }

            let pcm: Vec<f32> = if channel_bufs.len() == 1 {
                // Single buffer: mono or already interleaved stereo — use directly.
                channel_bufs.into_iter().next().unwrap()
            } else {
                // Non-interleaved: zip frames across channel buffers.
                let n_frames = channel_bufs[0].len();
                let n_ch = channel_bufs.len();
                let mut interleaved = Vec::with_capacity(n_frames * n_ch);
                for i in 0..n_frames {
                    for ch in &channel_bufs {
                        interleaved.push(*ch.get(i).unwrap_or(&0.0));
                    }
                }
                interleaved
            };

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

    fn make_state(
        tx: Sender<AudioChunk>,
        stopped: Arc<AtomicBool>,
        channels: u16,
    ) -> Result<Arc<Mutex<CaptureState>>> {
        Ok(Arc::new(Mutex::new(CaptureState {
            resampler: ToWhisper::new(48_000u32, channels)?,
            accumulated: Vec::new(),
            tx,
            stopped,
        })))
    }

    /// Per-app stream config: stereo, because some apps (e.g. Discord) return
    /// empty audio callbacks when channel_count=1 is requested.
    /// The callback handles CoreAudio's non-interleaved layout explicitly.
    fn app_audio_config() -> SCStreamConfiguration {
        SCStreamConfiguration::new()
            .with_captures_audio(true)
            .with_excludes_current_process_audio(false)
            .with_sample_rate(48_000)
            .with_channel_count(2)
            .with_width(2)
            .with_height(2)
    }

    /// Start a per-app SCKit stream for `app` if not already tracked by PID.
    fn try_start_app_stream(
        app: &SCRunningApplication,
        display: &SCDisplay,
        tx: &Sender<AudioChunk>,
        stopped: &Arc<AtomicBool>,
        tracked_pids: &mut HashSet<i32>,
        app_streams: &mut Vec<SCStream>,
    ) {
        let pid = app.process_id();
        if tracked_pids.contains(&pid) {
            return;
        }

        let app_filter = SCContentFilter::create()
            .with_display(display)
            .with_including_applications(&[app], &[])
            .build();

        let app_state = match make_state(tx.clone(), stopped.clone(), 2) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    "Loopback: resampler init failed for {} (pid={}): {e}",
                    app.application_name(),
                    pid
                );
                return;
            }
        };

        let mut app_stream = SCStream::new(&app_filter, &app_audio_config());
        app_stream.add_output_handler(
            AudioHandler { state: app_state },
            SCStreamOutputType::Audio,
        );
        match app_stream.start_capture() {
            Ok(()) => {
                tracked_pids.insert(pid);
                app_streams.push(app_stream);
                tracing::info!(
                    "Loopback: per-app stream started for {} (pid={pid})",
                    app.application_name()
                );
            }
            Err(e) => tracing::warn!(
                "Loopback: failed to start stream for {} (pid={pid}): {e:?}",
                app.bundle_identifier()
            ),
        }
    }

    /// Returns true only for apps with NSApplicationActivationPolicyRegular (= 0),
    /// i.e. apps that appear in the Dock and Cmd-Tab switcher.
    ///
    /// System UI components (Dock, Notification Center, Control Center, Universal
    /// Control, Finder helpers, Accessibility agents, Autofill, etc.) all have
    /// Accessory (1) or Prohibited (2) activation policy and are excluded.
    ///
    /// Uses direct ObjC runtime FFI so no extra crate dependencies are needed.
    fn is_regular_app(pid: i32) -> bool {
        use std::ffi::{c_char, c_void};

        // Link against the ObjC runtime and AppKit (always present on macOS).
        #[link(name = "objc", kind = "dylib")]
        extern "C" {
            fn objc_getClass(name: *const c_char) -> *mut c_void;
            fn sel_registerName(name: *const c_char) -> *const c_void;
        }
        #[link(name = "AppKit", kind = "framework")]
        extern "C" {}

        unsafe {
            let cls = objc_getClass(c"NSRunningApplication".as_ptr());
            if cls.is_null() { return false; }

            let sel_for_pid = sel_registerName(c"runningApplicationWithProcessIdentifier:".as_ptr());
            // Cast objc_msgSend to the exact signature for this call.
            // On AArch64/x86-64 macOS, integer args and id returns use the standard C ABI.
            let msg_send_pid: unsafe extern "C" fn(*mut c_void, *const c_void, i32) -> *mut c_void = {
                extern "C" { fn objc_msgSend(rcv: *mut c_void, sel: *const c_void, ...) -> *mut c_void; }
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn(_, _, ...) -> _)
            };
            let app = msg_send_pid(cls, sel_for_pid, pid);
            if app.is_null() { return false; }

            let sel_policy = sel_registerName(c"activationPolicy".as_ptr());
            let msg_send_policy: unsafe extern "C" fn(*mut c_void, *const c_void) -> isize = {
                extern "C" { fn objc_msgSend(rcv: *mut c_void, sel: *const c_void, ...) -> *mut c_void; }
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn(_, _, ...) -> _)
            };
            let policy = msg_send_policy(app, sel_policy);
            policy == 0 // NSApplicationActivationPolicyRegular
        }
    }

    pub fn run(tx: Sender<AudioChunk>, _chunk_ms: u32, target_bundles: Option<Vec<String>>) -> Result<()> {
        let ids = match target_bundles {
            Some(v) if !v.is_empty() => v,
            _ => {
                tracing::warn!("No loopback apps specified — loopback capture disabled");
                return Ok(());
            }
        };

        let stopped = Arc::new(AtomicBool::new(false));

        let content = SCShareableContent::get()
            .map_err(|e| anyhow::anyhow!("SCShareableContent::get failed: {e:?}"))?;

        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!(
                "No display found — ensure Screen Recording permission is granted"
            ))?;

        // Start one per-app stream for each selected bundle ID that is currently running.
        // Apps must be running at the time recording starts (no polling for late launches).
        let mut app_streams: Vec<SCStream> = Vec::new();
        let mut tracked_pids: HashSet<i32> = HashSet::new();
        for app in content.applications() {
            if ids.iter().any(|id| id == &app.bundle_identifier()) {
                try_start_app_stream(
                    &app,
                    &display,
                    &tx,
                    &stopped,
                    &mut tracked_pids,
                    &mut app_streams,
                );
            }
        }

        if app_streams.is_empty() {
            tracing::warn!("None of the requested apps were found running; loopback capture will produce no audio");
        }

        while !stopped.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(50));
        }

        for s in app_streams { s.stop_capture().ok(); }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub fn run(tx: Sender<AudioChunk>, chunk_ms: u32, target_bundles: Option<Vec<String>>) -> Result<()> {
    macos_sck::run(tx, chunk_ms, target_bundles)
}

/// Returns (name, bundle_id) for every running GUI application visible to
/// ScreenCaptureKit. Requires Screen Recording permission only — no Automation
/// permission needed. Returns an empty list on non-macOS platforms.
#[cfg(target_os = "macos")]
pub fn list_apps() -> Vec<(String, String)> {
    use screencapturekit::prelude::*;
    match SCShareableContent::get() {
        Ok(content) => content
            .applications()
            .into_iter()
            .filter_map(|app| {
                let name = app.application_name();
                let bid  = app.bundle_identifier();
                if name.is_empty() || bid.is_empty() { return None; }
                if !is_regular_app(app.process_id()) { return None; }
                Some((name, bid))
            })
            .collect(),
        Err(e) => {
            tracing::warn!("list_apps: SCShareableContent::get failed: {e:?}");
            vec![]
        }
    }
}

// ── Windows — WASAPI loopback ─────────────────────────────────────────────────

#[cfg(windows)]
pub fn list_apps() -> Vec<(String, String)> {
    vec![]
}

#[cfg(windows)]
pub fn run(tx: Sender<AudioChunk>, _chunk_ms: u32, _target_bundles: Option<Vec<String>>) -> Result<()> {
    use std::collections::VecDeque;
    use tracing::{info, warn};
    use wasapi::*;
    use crate::capture::resampler::ToWhisper;
    use crate::ipc::AudioSource;

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
