use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

static RECORDING: AtomicBool = AtomicBool::new(false);
static PYTHON_PID: AtomicU32 = AtomicU32::new(0);

struct Config {
    transcript_pipe: String,
    audio_pipe: String,
    capture_bin: String,
    python_exe: String,
    python_script: String,
    speakers_file: String,
}

fn load_config() -> Config {
    // audio-capture.exe always lives next to this binary (both in target/{profile}/ or
    // both extracted side-by-side in a distribution zip).
    let capture_bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("audio-capture.exe")))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "audio-capture.exe".to_string());

    let mut cfg = Config {
        transcript_pipe: r"\\.\pipe\corpodrone-transcript".to_string(),
        audio_pipe: r"\\.\pipe\corpodrone-audio".to_string(),
        capture_bin,
        python_exe: r".venv\Scripts\python.exe".to_string(),
        python_script: r"pipeline\pipeline.py".to_string(),
        speakers_file: "speakers.json".to_string(),
    };

    let Ok(text) = std::fs::read_to_string("config.toml") else {
        return cfg;
    };

    let mut in_server = false;
    let mut in_python = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_server = line == "[server]";
            in_python = line == "[python]";
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            let v = v.trim().trim_matches('\'').trim_matches('"');
            if in_server {
                match k {
                    "python_exe" => cfg.python_exe = v.to_string(),
                    "python_script" => cfg.python_script = v.to_string(),
                    "capture_bin" => cfg.capture_bin = v.to_string(),
                    _ => {}
                }
            } else if in_python {
                match k {
                    "transcript_pipe" => cfg.transcript_pipe = v.to_string(),
                    "audio_pipe" => cfg.audio_pipe = v.to_string(),
                    "speakers_file" => cfg.speakers_file = v.to_string(),
                    _ => {}
                }
            }
        }
    }
    cfg
}

// ---- Tauri commands ----

#[tauri::command]
fn get_status() -> serde_json::Value {
    serde_json::json!({ "recording": RECORDING.load(Ordering::Relaxed) })
}

#[tauri::command]
async fn start_recording(state: State<'_, Arc<Config>>) -> Result<serde_json::Value, String> {
    if RECORDING.load(Ordering::Relaxed) {
        return Err("Already recording".to_string());
    }

    let bin = state.capture_bin.clone();
    let pipe = state.audio_pipe.clone();

    let child = tokio::process::Command::new(&bin)
        .arg("--pipe")
        .arg(&pipe)
        .spawn()
        .map_err(|e| format!("Failed to start audio capture: {e}"))?;

    RECORDING.store(true, Ordering::Relaxed);
    tracing::info!("audio-capture started (pid={})", child.id().unwrap_or(0));

    tokio::spawn(async move {
        let _ = child.wait_with_output().await;
        RECORDING.store(false, Ordering::Relaxed);
        tracing::info!("audio-capture process exited");
    });

    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn stop_recording() -> Result<serde_json::Value, String> {
    if !RECORDING.load(Ordering::Relaxed) {
        return Err("Not recording".to_string());
    }

    let _ = tokio::process::Command::new("taskkill")
        .args(["/F", "/IM", "audio-capture.exe"])
        .output()
        .await;

    RECORDING.store(false, Ordering::Relaxed);
    tracing::info!("Recording stopped");
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn update_speaker(
    speaker_id: String,
    name: String,
    state: State<'_, Arc<Config>>,
) -> Result<serde_json::Value, String> {
    // Update speakers.json so the name persists across sessions.
    // Format: [{"id": "spk_mic", "name": "You"}, ...]
    let path = &state.speakers_file;
    if let Ok(text) = std::fs::read_to_string(path) {
        if let Ok(mut entries) = serde_json::from_str::<Vec<serde_json::Value>>(&text) {
            let mut found = false;
            for entry in &mut entries {
                if entry.get("id").and_then(|v| v.as_str()) == Some(&speaker_id) {
                    if let Some(obj) = entry.as_object_mut() {
                        obj.insert("name".to_string(), serde_json::Value::String(name.clone()));
                    }
                    found = true;
                    break;
                }
            }
            if !found {
                entries.push(serde_json::json!({"id": speaker_id, "name": name}));
            }
            let _ = std::fs::write(
                path,
                serde_json::to_string_pretty(&entries).unwrap_or_default(),
            );
        }
    }
    Ok(serde_json::json!({ "ok": true }))
}

// ---- Transcript pipe reader ----

#[cfg(windows)]
async fn run_pipe_reader(pipe_path: String, app: AppHandle) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::windows::named_pipe::ServerOptions;

    loop {
        let server = match ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_path)
        {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("Failed to create transcript pipe: {e}");
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                continue;
            }
        };

        tracing::info!("Waiting for Python to connect to transcript pipe...");
        if let Err(e) = server.connect().await {
            tracing::warn!("Transcript pipe connect error: {e}");
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            continue;
        }

        tracing::info!("Python connected to transcript pipe");
        let mut reader = BufReader::new(server);
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    tracing::info!("Transcript pipe closed by Python, reconnecting...");
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<serde_json::Value>(trimmed) {
                        Ok(msg) => {
                            let _ = app.emit("pipeline-event", msg);
                        }
                        Err(e) => {
                            tracing::warn!("Invalid JSON from Python pipeline: {e}");
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("Transcript pipe read error: {e}");
                    break;
                }
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
}

#[cfg(not(windows))]
async fn run_pipe_reader(pipe_path: String, _app: AppHandle) {
    tracing::warn!("Transcript pipe reader is Windows-only (path: {pipe_path})");
}

// ---- Python process ----

async fn spawn_python(cfg: &Config) -> anyhow::Result<()> {
    let script = std::path::Path::new(&cfg.python_script);
    if !script.exists() {
        anyhow::bail!("Python script not found: {}", script.display());
    }

    tracing::info!(
        "Spawning Python pipeline: {} {}",
        cfg.python_exe,
        script.display()
    );

    let mut cmd = tokio::process::Command::new(&cfg.python_exe);
    cmd.arg(script);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    let child = cmd.spawn()?;
    if let Some(pid) = child.id() {
        PYTHON_PID.store(pid, Ordering::Relaxed);
        tracing::info!("Python pipeline pid={pid}");
    }
    Ok(())
}

fn kill_subprocesses() {
    let pid = PYTHON_PID.load(Ordering::Relaxed);
    if pid != 0 {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
        tracing::info!("Killed Python pipeline (pid={pid})");
    }
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/IM", "audio-capture.exe"])
        .output();
}

// ---- App entry point ----

pub fn run() {
    // Anchor CWD so that relative paths (config.toml, pipeline/, speakers.json) resolve correctly
    // in both dev and distributed modes.
    //   Dev:          exe is target/{profile}/corpo-drone.exe → go up two levels to workspace root
    //   Distributed:  exe is next to config.toml → use exe directory directly
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let base = if exe_dir.join("config.toml").exists() {
                exe_dir.to_path_buf()
            } else {
                exe_dir.parent()
                    .and_then(|p| p.parent())
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| exe_dir.to_path_buf())
            };
            let _ = std::env::set_current_dir(&base);
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("corpo_drone=info".parse().unwrap()),
        )
        .init();

    let cfg = Arc::new(load_config());

    tauri::Builder::default()
        .manage(Arc::clone(&cfg))
        .invoke_handler(tauri::generate_handler![
            get_status,
            start_recording,
            stop_recording,
            update_speaker,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let pipe_path = cfg.transcript_pipe.clone();

            // Start transcript pipe reader
            tauri::async_runtime::spawn(async move {
                run_pipe_reader(pipe_path, app_handle).await;
            });

            // Spawn Python pipeline
            let cfg_py = Arc::clone(&cfg);
            tauri::async_runtime::spawn(async move {
                if let Err(e) = spawn_python(&cfg_py).await {
                    tracing::warn!("Could not auto-start Python pipeline: {e}");
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_subprocesses();
            }
        });
}
