use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as TokioMutex;

static RECORDING: AtomicBool = AtomicBool::new(false);
static MUTED: AtomicBool = AtomicBool::new(false);
static PYTHON_PID: AtomicU32 = AtomicU32::new(0);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

struct Config {
    transcript_pipe: String,
    audio_pipe: String,
    capture_bin: String,
    python_exe: String,
    python_script: String,
    speakers_file: String,
    ollama_host: String,
    ollama_model: String,
    summarize: bool,
}

/// Holds Python's stdin so Tauri commands can send JSON-line control messages.
struct PythonStdin(TokioMutex<Option<tokio::process::ChildStdin>>);

fn load_config() -> Config {
    // Platform-specific binary name and paths
    #[cfg(windows)]
    let capture_bin_name = "audio-capture.exe";
    #[cfg(not(windows))]
    let capture_bin_name = "audio-capture";

    let capture_bin = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(capture_bin_name)))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| capture_bin_name.to_string());

    #[cfg(windows)]
    let (transcript_pipe, audio_pipe, python_exe, python_script) = (
        r"\\.\pipe\corpodrone-transcript".to_string(),
        r"\\.\pipe\corpodrone-audio".to_string(),
        r".venv\Scripts\python.exe".to_string(),
        r"pipeline\pipeline.py".to_string(),
    );
    #[cfg(not(windows))]
    let (transcript_pipe, audio_pipe, python_exe, python_script) = (
        "/tmp/corpodrone-transcript".to_string(),
        "/tmp/corpodrone-audio".to_string(),
        ".venv/bin/python".to_string(),
        "pipeline/pipeline.py".to_string(),
    );

    let mut cfg = Config {
        transcript_pipe,
        audio_pipe,
        capture_bin,
        python_exe,
        python_script,
        speakers_file: "speakers.json".to_string(),
        ollama_host: "http://localhost:11434".to_string(),
        ollama_model: "llama3.1:8b".to_string(),
        summarize: true,
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
                    "ollama_host" => cfg.ollama_host = v.to_string(),
                    "ollama_model" => cfg.ollama_model = v.to_string(),
                    "summarize" => cfg.summarize = v == "true",
                    _ => {}
                }
            }
        }
    }
    cfg
}

/// Microphone device name from `config.toml` ([python]).
/// Read at recording start so changes apply without restarting the app.
fn read_mic_device_from_config() -> String {
    let mut in_python = false;
    let mut input = String::new();
    let Ok(text) = std::fs::read_to_string("config.toml") else {
        return input;
    };
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_python = line == "[python]";
            continue;
        }
        if !in_python || line.starts_with('#') {
            continue;
        }
        let Some((k, rest)) = line.split_once('=') else {
            continue;
        };
        let k = k.trim();
        let v = rest
            .split('#')
            .next()
            .unwrap_or("")
            .trim()
            .trim_matches('"')
            .trim_matches('\'');
        if k == "audio_input_device" {
            input = v.to_string();
        }
    }
    input
}

// ---- Log helpers ----

/// Forwards a raw line (already JSON from a subprocess) to a log pane in the UI.
fn emit_log(app: &AppHandle, process: &str, line: impl Into<String>) {
    let _ = app.emit("log-line", serde_json::json!({
        "process": process,
        "line": line.into(),
    }));
}

/// Emits a structured system log to the "system" pane in the UI.
/// Uses the same JSON shape as structlog so `formatLogLine` renders it consistently.
fn emit_system(app: &AppHandle, level: &str, event: impl Into<String>) {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let ts = format!("{:02}:{:02}:{:02}", secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let json_line = serde_json::json!({
        "level": level,
        "timestamp": ts,
        "event": event.into(),
    }).to_string();
    let _ = app.emit("log-line", serde_json::json!({
        "process": "system",
        "line": json_line,
    }));
}

async fn stream_output(
    reader: impl tokio::io::AsyncRead + Unpin + Send + 'static,
    process: &'static str,
    app: AppHandle,
) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(reader).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => emit_log(&app, process, line),
            _ => break,
        }
    }
}

// ---- Tauri commands ----

#[tauri::command]
fn get_status() -> serde_json::Value {
    serde_json::json!({
        "recording": RECORDING.load(Ordering::Relaxed),
        "muted": MUTED.load(Ordering::Relaxed),
    })
}

#[tauri::command]
fn set_mute(muted: bool) -> serde_json::Value {
    MUTED.store(muted, Ordering::Relaxed);
    if muted {
        let _ = std::fs::write(".mic_muted", "1");
    } else {
        let _ = std::fs::remove_file(".mic_muted");
    }
    serde_json::json!({ "ok": true, "muted": muted })
}

/// Enumerate microphones (see `audio-capture list-devices`).
#[tauri::command]
async fn list_audio_devices(state: State<'_, Arc<Config>>) -> Result<serde_json::Value, String> {
    let bin = state.capture_bin.clone();
    let output = tokio::process::Command::new(&bin)
        .arg("list-devices")
        .output()
        .await
        .map_err(|e| format!("Failed to run audio-capture list-devices: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "audio-capture list-devices failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| format!("Invalid device list JSON: {e}"))
}

/// macOS: `[{name, bundle_id}]` for per-app loopback. Other platforms: `[]`.
#[tauri::command]
async fn list_loopback_apps(state: State<'_, Arc<Config>>) -> Result<serde_json::Value, String> {
    #[cfg(not(target_os = "macos"))]
    return Ok(serde_json::json!([]));

    #[cfg(target_os = "macos")]
    {
        let bin = state.capture_bin.clone();
        let output = tokio::process::Command::new(&bin)
            .arg("list-apps")
            .output()
            .await
            .map_err(|e| format!("Failed to run audio-capture list-apps: {e}"))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let apps: serde_json::Value = serde_json::from_str(stdout.trim())
            .unwrap_or(serde_json::json!([]));
        Ok(apps)
    }
}

#[tauri::command]
async fn start_recording(
    state: State<'_, Arc<Config>>,
    app: AppHandle,
    loopback_apps: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    if RECORDING.load(Ordering::Relaxed) {
        return Err("Already recording".to_string());
    }

    let bin = state.capture_bin.clone();
    let pipe = state.audio_pipe.clone();

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("--pipe").arg(&pipe);
    if let Some(ref ids) = loopback_apps {
        if !ids.is_empty() {
            cmd.arg("--loopback-apps").arg(ids.join(","));
        }
    }
    let mic = read_mic_device_from_config();
    if !mic.trim().is_empty() {
        cmd.arg("--mic-device").arg(mic.trim());
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to start audio capture: {e}"))?;

    let pid = child.id().unwrap_or(0);
    RECORDING.store(true, Ordering::Relaxed);
    emit_system(&app, "info", format!("audio_capture_started pid={pid}"));

    if let Some(stdout) = child.stdout.take() {
        let app_c = app.clone();
        tokio::spawn(async move { stream_output(stdout, "audio", app_c).await });
    }
    if let Some(stderr) = child.stderr.take() {
        let app_c = app.clone();
        tokio::spawn(async move { stream_output(stderr, "audio", app_c).await });
    }

    tokio::spawn(async move {
        let _ = child.wait().await;
        RECORDING.store(false, Ordering::Relaxed);
        emit_system(&app, "info", "audio_capture_stopped");
    });

    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn stop_recording(app: AppHandle) -> Result<serde_json::Value, String> {
    if !RECORDING.load(Ordering::Relaxed) {
        return Err("Not recording".to_string());
    }

    #[cfg(windows)]
    let _ = tokio::process::Command::new("taskkill")
        .args(["/F", "/IM", "audio-capture.exe"])
        .output()
        .await;

    #[cfg(not(windows))]
    let _ = tokio::process::Command::new("pkill")
        .args(["-f", "audio-capture"])
        .output()
        .await;

    RECORDING.store(false, Ordering::Relaxed);
    MUTED.store(false, Ordering::Relaxed);
    let _ = std::fs::remove_file(".mic_muted");
    emit_system(&app, "info", "recording_stopped");
    Ok(serde_json::json!({ "ok": true }))
}

/// Read config.toml and return all [python] settings as JSON.
/// Missing keys return their pipeline defaults.
#[tauri::command]
fn get_settings() -> serde_json::Value {
    let mut s = serde_json::json!({
        "whisper_model":               "small",
        "whisper_device":              "auto",
        "whisper_compute_type":        "auto",
        "diarize":                     true,
        "hf_token":                    "",
        "min_speakers":                1,
        "max_speakers":                8,
        "window_seconds":              20.0,
        "step_seconds":                3.0,
        "speech_gate_enabled":         true,
        "speech_gate_rms_db_floor":    -50.0,
        "speech_gate_min_speech_fraction": 0.12,
        "speech_gate_silero_threshold": 0.5,
        "summarize":                   true,
        "ollama_model":                "llama3.1:8b",
        "ollama_host":                 "http://localhost:11434",
        "speaker_enroll":              true,
        "speaker_identify_threshold":  0.58,
        "audio_input_device":          "",
    });

    let text = match std::fs::read_to_string("config.toml") {
        Ok(t) => t,
        Err(_) => return s,
    };

    let m = s.as_object_mut().unwrap();
    let mut in_python = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_python = line == "[python]";
            continue;
        }
        if !in_python || line.starts_with('#') { continue; }
        let Some((k, rest)) = line.split_once('=') else { continue };
        let k = k.trim();
        // strip inline comment then quotes
        let v = rest.split('#').next().unwrap_or("").trim().trim_matches('"').trim_matches('\'');
        match k {
            "whisper_model" | "whisper_device" | "whisper_compute_type" |
            "ollama_model"  | "ollama_host"    | "hf_token" |
            "audio_input_device" => {
                m.insert(k.to_string(), serde_json::Value::String(v.to_string()));
            }
            "diarize" | "summarize" | "speaker_enroll" | "speech_gate_enabled" => {
                m.insert(k.to_string(), serde_json::Value::Bool(v == "true"));
            }
            "min_speakers" | "max_speakers" => {
                if let Ok(n) = v.parse::<i64>() {
                    m.insert(k.to_string(), n.into());
                }
            }
            "window_seconds" | "step_seconds" | "speaker_identify_threshold" |
            "speech_gate_rms_db_floor" | "speech_gate_min_speech_fraction" |
            "speech_gate_silero_threshold" => {
                if let Ok(f) = v.parse::<f64>() {
                    m.insert(k.to_string(), serde_json::json!(f));
                }
            }
            _ => {}
        }
    }

    // If hf_token wasn't set via config.toml, fall back to HUGGINGFACE_TOKEN in .env
    if m.get("hf_token").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        if let Ok(env_text) = std::fs::read_to_string(".env") {
            for line in env_text.lines() {
                let line = line.trim();
                if line.starts_with('#') { continue; }
                if let Some(val) = line.strip_prefix("HUGGINGFACE_TOKEN=") {
                    let val = val.trim().trim_matches('"').trim_matches('\'');
                    if !val.is_empty() {
                        m.insert("hf_token".to_string(), serde_json::Value::String(val.to_string()));
                    }
                    break;
                }
            }
        }
    }

    s
}

fn fmt_float(f: f64) -> String {
    let s = f.to_string();
    if s.contains('.') { s } else { format!("{s}.0") }
}

/// Write updated settings back to config.toml, preserving any [server] section.
/// If a HuggingFace token is present, sends a prefetch_diarizer command to the
/// pipeline so the pyannote model is downloaded in the background immediately.
#[tauri::command]
async fn save_settings(
    stdin_state: State<'_, Arc<PythonStdin>>,
    settings: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let m = settings.as_object().ok_or("expected object")?;
    macro_rules! str_val {
        ($k:expr, $d:expr) => {
            m.get($k).and_then(|v| v.as_str()).unwrap_or($d)
        };
    }
    macro_rules! bool_val {
        ($k:expr, $d:expr) => {
            m.get($k).and_then(|v| v.as_bool()).unwrap_or($d)
        };
    }
    macro_rules! i64_val {
        ($k:expr, $d:expr) => {
            m.get($k).and_then(|v| v.as_i64()).unwrap_or($d)
        };
    }
    macro_rules! f64_val {
        ($k:expr, $d:expr) => {
            m.get($k).and_then(|v| v.as_f64()).unwrap_or($d)
        };
    }

    // Preserve any [server] section from the existing file.
    let existing = std::fs::read_to_string("config.toml").unwrap_or_default();
    let mut server_block = String::new();
    let mut in_server = false;
    for line in existing.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_server = t == "[server]";
        }
        if in_server {
            server_block.push_str(line);
            server_block.push('\n');
        }
    }

    let python_block = format!(
"# CorpoDrone configuration
# Edit this file to configure the pipeline without recompiling.

[python]
# Whisper model size: tiny / base / small / medium / large-v3
whisper_model = \"{whisper_model}\"
whisper_device = \"{whisper_device}\"
whisper_compute_type = \"{whisper_compute_type}\"

# Speaker diarization (requires HuggingFace token)
diarize = {diarize}
hf_token = \"{hf_token}\"
min_speakers = {min_speakers}
max_speakers = {max_speakers}

# Sliding window config (seconds)
window_seconds = {window_seconds}
step_seconds = {step_seconds}

# Silence filtering before Whisper (RMS + Silero VAD)
speech_gate_enabled = {speech_gate_enabled}
speech_gate_rms_db_floor = {speech_gate_rms_db_floor}
speech_gate_min_speech_fraction = {speech_gate_min_speech_fraction}
speech_gate_silero_threshold = {speech_gate_silero_threshold}

# Summarization via Ollama
summarize = {summarize}
ollama_model = \"{ollama_model}\"
ollama_host = \"{ollama_host}\"

# Speaker recognition
speaker_enroll = {speaker_enroll}
speaker_identify_threshold = {speaker_identify_threshold}

# Microphone (empty = OS default; applies next recording)
audio_input_device = \"{audio_input_device}\"
",
        whisper_model             = str_val!("whisper_model", "small"),
        whisper_device            = str_val!("whisper_device", "auto"),
        whisper_compute_type      = str_val!("whisper_compute_type", "auto"),
        diarize                   = bool_val!("diarize", true),
        hf_token                  = str_val!("hf_token", ""),
        min_speakers              = i64_val!("min_speakers", 1),
        max_speakers              = i64_val!("max_speakers", 8),
        window_seconds            = fmt_float(f64_val!("window_seconds", 20.0)),
        step_seconds              = fmt_float(f64_val!("step_seconds", 3.0)),
        speech_gate_enabled       = bool_val!("speech_gate_enabled", true),
        speech_gate_rms_db_floor  = fmt_float(f64_val!("speech_gate_rms_db_floor", -50.0)),
        speech_gate_min_speech_fraction =
            fmt_float(f64_val!("speech_gate_min_speech_fraction", 0.12)),
        speech_gate_silero_threshold =
            fmt_float(f64_val!("speech_gate_silero_threshold", 0.5)),
        summarize                 = bool_val!("summarize", true),
        ollama_model              = str_val!("ollama_model", "llama3.1:8b"),
        ollama_host               = str_val!("ollama_host", "http://localhost:11434"),
        speaker_enroll            = bool_val!("speaker_enroll", true),
        speaker_identify_threshold = fmt_float(f64_val!("speaker_identify_threshold", 0.58)),
        audio_input_device        = str_val!("audio_input_device", ""),
    );

    let out = if server_block.is_empty() {
        python_block
    } else {
        format!("{python_block}\n{server_block}")
    };

    std::fs::write("config.toml", out).map_err(|e| e.to_string())?;

    // If a HuggingFace token was provided, ask the pipeline to pre-download
    // the pyannote diarization model in the background right now.
    let hf_token = str_val!("hf_token", "");
    if !hf_token.is_empty() {
        send_python_cmd(
            &stdin_state,
            serde_json::json!({ "cmd": "prefetch_diarizer", "hf_token": hf_token }),
        ).await;
    }

    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn get_ollama_config(
    cfg: State<'_, Arc<Config>>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "host": cfg.ollama_host,
        "model": cfg.ollama_model,
        "summarize": cfg.summarize,
    }))
}

#[tauri::command]
async fn check_ollama_status(
    cfg: State<'_, Arc<Config>>,
) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/api/tags", cfg.ollama_host.trim_end_matches('/'));
    let res = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(serde_json::json!({ "running": false, "has_model": false })),
    };
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    let model = &cfg.ollama_model;
    let has_model = body["models"]
        .as_array()
        .map(|arr| {
            arr.iter().any(|m| {
                m["name"].as_str().map(|n| n == model || n.starts_with(&format!("{model}:"))).unwrap_or(false)
            })
        })
        .unwrap_or(false);
    Ok(serde_json::json!({ "running": true, "has_model": has_model }))
}

#[tauri::command]
async fn start_ollama_service(app: AppHandle) -> Result<serde_json::Value, String> {
    emit_system(&app, "info", "starting_ollama_service");
    // Launch `ollama serve` as a fully detached process (not a child of ours).
    // On Windows: `cmd /c start "" ollama serve` — the shell's START command
    // creates an independent process; cmd exits immediately.
    // On Unix: `sh -c "ollama serve &"` — shell backgrounds and exits.
    #[cfg(windows)]
    let result = {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        tokio::process::Command::new("cmd")
            .args(["/c", "start", "", "ollama", "serve"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
    };
    #[cfg(not(windows))]
    let result = tokio::process::Command::new("sh")
        .args(["-c", "ollama serve &"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
    match result {
        Ok(_) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[tauri::command]
async fn kill_pipeline(app: AppHandle) -> Result<serde_json::Value, String> {
    let pid = PYTHON_PID.load(Ordering::Relaxed);
    if pid == 0 {
        return Ok(serde_json::json!({ "ok": false, "reason": "no pipeline running" }));
    }
    emit_system(&app, "warning", format!("killing_pipeline_by_user pid={pid}"));
    #[cfg(windows)]
    let _ = tokio::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output()
        .await;
    #[cfg(not(windows))]
    let _ = tokio::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .await;
    Ok(serde_json::json!({ "ok": true }))
}

/// Send a JSON-line command to the Python pipeline via its stdin.
async fn send_python_cmd(stdin_state: &PythonStdin, cmd: serde_json::Value) {
    let line = format!("{}\n", cmd);
    let mut guard = stdin_state.0.lock().await;
    if let Some(stdin) = guard.as_mut() {
        if let Err(e) = stdin.write_all(line.as_bytes()).await {
            tracing::warn!("Failed to write to Python stdin: {e}");
        }
    }
}

#[tauri::command]
async fn set_pipeline_mode(
    mode: String,
    stdin_state: State<'_, Arc<PythonStdin>>,
) -> Result<serde_json::Value, String> {
    send_python_cmd(&stdin_state, serde_json::json!({"cmd": "set_mode", "mode": mode})).await;
    Ok(serde_json::json!({ "ok": true }))
}

// ── Speaker identity database ──────────────────────────────────────────────

fn read_speakers_db() -> serde_json::Value {
    let path = std::path::Path::new("speakers_db.json");
    if !path.exists() {
        return serde_json::json!({ "version": 1, "persons": {} });
    }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({ "version": 1, "persons": {} }))
}

fn write_speakers_db(data: &serde_json::Value) {
    if let Ok(s) = serde_json::to_string(data) {
        let _ = std::fs::write("speakers_db.json", s);
    }
}

#[tauri::command]
fn get_speaker_database() -> serde_json::Value {
    read_speakers_db()
}

#[tauri::command]
fn enroll_speaker(name: String, person_id: Option<String>, embedding: Vec<f64>) -> serde_json::Value {
    let mut db = read_speakers_db();
    let pid = person_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if let Some(persons) = db["persons"].as_object_mut() {
        if let Some(person) = persons.get_mut(&pid) {
            if let Some(arr) = person["embeddings"].as_array_mut() {
                arr.push(serde_json::json!(embedding));
            }
        } else {
            persons.insert(pid.clone(), serde_json::json!({
                "name": name,
                "embeddings": [embedding],
            }));
        }
    }
    write_speakers_db(&db);
    serde_json::json!({ "ok": true, "person_id": pid })
}

#[tauri::command]
fn delete_speaker(person_id: String) -> serde_json::Value {
    let mut db = read_speakers_db();
    let removed = db["persons"].as_object_mut()
        .map(|p| p.remove(&person_id).is_some())
        .unwrap_or(false);
    if removed { write_speakers_db(&db); }
    serde_json::json!({ "ok": removed })
}

#[tauri::command]
fn rename_speaker(person_id: String, name: String) -> serde_json::Value {
    let mut db = read_speakers_db();
    let ok = if let Some(person) = db["persons"].get_mut(&person_id) {
        person["name"] = serde_json::json!(name);
        write_speakers_db(&db);
        true
    } else { false };
    serde_json::json!({ "ok": ok })
}

/// Open a native file-picker dialog and return the selected path (or null if cancelled).
#[tauri::command]
async fn pick_audio_file() -> Result<Option<String>, String> {
    let path = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter(
                "Audio / video",
                &[
                    "wav", "mp3", "m4a", "flac", "ogg", "aac", "wma", "opus", "mp4", "m4v", "mov",
                    "mkv", "webm", "avi", "wmv", "flv",
                ],
            )
            .add_filter("All files", &["*"])
            .pick_file()
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(path)
}

/// Tell the Python pipeline to process a local audio file and generate a debrief.
#[tauri::command]
async fn import_audio_file(
    path: String,
    stdin_state: State<'_, Arc<PythonStdin>>,
) -> Result<serde_json::Value, String> {
    send_python_cmd(
        &stdin_state,
        serde_json::json!({ "cmd": "process_audio_file", "path": path }),
    )
    .await;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn update_speaker(
    speaker_id: String,
    name: String,
    state: State<'_, Arc<Config>>,
) -> Result<serde_json::Value, String> {
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
                emit_system(&app, "warning", format!("transcript_pipe_create_failed error={e}"));
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                continue;
            }
        };

        emit_system(&app, "info", "waiting_for_pipeline_transcript_pipe");
        if let Err(e) = server.connect().await {
            emit_system(&app, "warning", format!("transcript_pipe_connect_error error={e}"));
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            continue;
        }

        emit_system(&app, "info", "pipeline_connected_transcript_pipe");
        let mut reader = BufReader::new(server);
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    emit_system(&app, "info", "transcript_pipe_closed_reconnecting");
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<serde_json::Value>(trimmed) {
                        Ok(msg) => { let _ = app.emit("pipeline-event", msg); }
                        Err(e) => emit_system(&app, "warning", format!("transcript_pipe_invalid_json error={e}")),
                    }
                }
                Err(e) => {
                    emit_system(&app, "warning", format!("transcript_pipe_read_error error={e}"));
                    break;
                }
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
}

// Unix: create a POSIX FIFO and read JSON lines from it.
// Python opens the write end; we open the read end (blocking until Python connects).
#[cfg(unix)]
async fn run_pipe_reader(pipe_path: String, app: AppHandle) {
    use tokio::io::{AsyncBufReadExt, BufReader};

    loop {
        // Clean up any stale FIFO from a previous run, then create a fresh one
        let _ = std::fs::remove_file(&pipe_path);
        let _ = std::process::Command::new("mkfifo").arg(&pipe_path).status();

        emit_system(&app, "info", "waiting_for_pipeline_transcript_pipe");

        // Opening a FIFO for reading blocks until the writer (Python) opens its end.
        // Run this in a blocking thread so we don't stall the async runtime.
        let path_clone = pipe_path.clone();
        let file = match tokio::task::spawn_blocking(move || {
            std::fs::OpenOptions::new().read(true).open(&path_clone)
        })
        .await
        {
            Ok(Ok(f)) => f,
            Ok(Err(e)) => {
                emit_system(&app, "warning", format!("transcript_fifo_open_failed error={e}"));
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                continue;
            }
            Err(e) => {
                emit_system(&app, "warning", format!("transcript_fifo_spawn_blocking_error error={e}"));
                break;
            }
        };

        emit_system(&app, "info", "pipeline_connected_transcript_pipe");

        let async_file = tokio::fs::File::from_std(file);
        let mut reader = BufReader::new(async_file);
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    emit_system(&app, "info", "transcript_pipe_closed_reconnecting");
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        match serde_json::from_str::<serde_json::Value>(trimmed) {
                            Ok(msg) => { let _ = app.emit("pipeline-event", msg); }
                            Err(e) => emit_system(&app, "warning", format!("transcript_pipe_invalid_json error={e}")),
                        }
                    }
                }
                Err(e) => {
                    emit_system(&app, "warning", format!("transcript_pipe_read_error error={e}"));
                    break;
                }
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
}

// ---- Python process ----

async fn spawn_python(cfg: &Config, stdin_state: Arc<PythonStdin>, app: AppHandle) -> anyhow::Result<()> {
    let script = std::path::Path::new(&cfg.python_script);
    if !script.exists() {
        anyhow::bail!("Python script not found: {}", script.display());
    }

    loop {
        emit_system(&app, "info", format!("spawning_python_pipeline script={}", script.display()));

        let mut cmd = tokio::process::Command::new(&cfg.python_exe);
        cmd.arg(&cfg.python_script);
        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        #[cfg(windows)]
        {
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        }

        match cmd.spawn() {
            Ok(mut child) => {
                {
                    let mut guard = stdin_state.0.lock().await;
                    *guard = child.stdin.take();
                }

                if let Some(stdout) = child.stdout.take() {
                    let app_c = app.clone();
                    tokio::spawn(async move { stream_output(stdout, "pipeline", app_c).await });
                }
                if let Some(stderr) = child.stderr.take() {
                    let app_c = app.clone();
                    tokio::spawn(async move { stream_output(stderr, "pipeline", app_c).await });
                }

                if let Some(pid) = child.id() {
                    PYTHON_PID.store(pid, Ordering::Relaxed);
                    emit_system(&app, "info", format!("python_pipeline_started pid={pid}"));
                }

                let _ = child.wait().await;

                {
                    let mut guard = stdin_state.0.lock().await;
                    *guard = None;
                }

                emit_system(&app, "info", "python_pipeline_exited");

                // Tell the frontend so it can recover from any stuck processing screen.
                // Guarded so we don't fire this during intentional app shutdown.
                if !SHUTTING_DOWN.load(Ordering::Relaxed) {
                    let _ = app.emit("pipeline-event", serde_json::json!({
                        "type": "status",
                        "state": "pipeline_crashed",
                    }));
                }
            }
            Err(e) => {
                emit_system(&app, "warning", format!("python_pipeline_spawn_failed error={e}"));
            }
        }

        if SHUTTING_DOWN.load(Ordering::Relaxed) {
            break;
        }

        emit_system(&app, "info", "python_pipeline_restarting delay=1s");
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

        if SHUTTING_DOWN.load(Ordering::Relaxed) {
            break;
        }
    }
    Ok(())
}

#[cfg(windows)]
fn kill_subprocesses() {
    SHUTTING_DOWN.store(true, Ordering::Relaxed);
    let pid = PYTHON_PID.load(Ordering::Relaxed);
    if pid != 0 {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
    }
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/IM", "audio-capture.exe"])
        .output();
}

#[cfg(not(windows))]
fn kill_subprocesses() {
    SHUTTING_DOWN.store(true, Ordering::Relaxed);
    let pid = PYTHON_PID.load(Ordering::Relaxed);
    if pid != 0 {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
    let _ = std::process::Command::new("pkill")
        .args(["-f", "audio-capture"])
        .output();
}

// ---- App entry point ----

pub fn run() {
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
    let python_stdin = Arc::new(PythonStdin(TokioMutex::new(None)));

    tauri::Builder::default()
        .manage(Arc::clone(&cfg))
        .manage(Arc::clone(&python_stdin))
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_settings,
            save_settings,
            list_loopback_apps,
            list_audio_devices,
            start_recording,
            stop_recording,
            kill_pipeline,
            get_ollama_config,
            check_ollama_status,
            start_ollama_service,
            update_speaker,
            set_pipeline_mode,
            set_mute,
            get_speaker_database,
            enroll_speaker,
            delete_speaker,
            rename_speaker,
            pick_audio_file,
            import_audio_file,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let pipe_path = cfg.transcript_pipe.clone();

            tauri::async_runtime::spawn(async move {
                run_pipe_reader(pipe_path, app_handle).await;
            });

            let cfg_py = Arc::clone(&cfg);
            let stdin_py = Arc::clone(&python_stdin);
            let app_py = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = spawn_python(&cfg_py, stdin_py, app_py).await {
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
