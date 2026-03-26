use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::{hub::Hub, Args, PYTHON_PID};

static RECORDING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
struct StatusResponse {
    recording: bool,
    ws_clients: usize,
}

#[derive(Deserialize)]
pub struct SpeakerUpdate {
    pub speaker_id: String,
    pub name: String,
}

pub async fn status(hub: web::Data<Hub>) -> HttpResponse {
    HttpResponse::Ok().json(StatusResponse {
        recording: RECORDING.load(Ordering::Relaxed),
        ws_clients: hub.session_count(),
    })
}

pub async fn start(
    hub: web::Data<Hub>,
    args: web::Data<Args>,
) -> HttpResponse {
    if RECORDING.load(Ordering::Relaxed) {
        return HttpResponse::Conflict().body("Already recording");
    }

    info!("Starting audio-capture...");
    let bin = args.capture_bin.clone();
    let pipe = args.audio_pipe.clone();

    match tokio::process::Command::new(&bin)
        .arg("--pipe")
        .arg(&pipe)
        .spawn()
    {
        Ok(child) => {
            RECORDING.store(true, Ordering::Relaxed);
            // Store in app-global handle via hub broadcast
            hub.broadcast(serde_json::json!({"type": "status", "state": "recording"})).await;
            info!("audio-capture started (pid={})", child.id().unwrap_or(0));

            // Spawn task to wait for child and update state
            tokio::spawn(async move {
                let _ = child.wait_with_output().await;
                RECORDING.store(false, Ordering::Relaxed);
                info!("audio-capture process exited");
            });

            HttpResponse::Ok().json(serde_json::json!({"ok": true}))
        }
        Err(e) => {
            warn!("Failed to start audio-capture: {e}");
            HttpResponse::InternalServerError().body(format!("Failed to start capture: {e}"))
        }
    }
}

pub async fn stop(hub: web::Data<Hub>) -> HttpResponse {
    if !RECORDING.load(Ordering::Relaxed) {
        return HttpResponse::Conflict().body("Not recording");
    }
    // Kill by name — simplest approach on Windows
    let _ = tokio::process::Command::new("taskkill")
        .args(["/F", "/IM", "audio-capture.exe"])
        .output()
        .await;

    RECORDING.store(false, Ordering::Relaxed);
    hub.broadcast(serde_json::json!({"type": "status", "state": "stopped"})).await;
    info!("Recording stopped");
    HttpResponse::Ok().json(serde_json::json!({"ok": true}))
}

pub async fn update_speaker(
    body: web::Json<SpeakerUpdate>,
    hub: web::Data<Hub>,
) -> HttpResponse {
    // Broadcast speaker rename to all clients (Python pipeline reads it from them via WS or control pipe)
    hub.broadcast(serde_json::json!({
        "type": "speaker_update",
        "speaker_id": body.speaker_id,
        "name": body.name,
    }))
    .await;
    HttpResponse::Ok().json(serde_json::json!({"ok": true}))
}

/// Spawn Python pipeline as a subprocess.
pub async fn spawn_python(args: Arc<Args>) -> anyhow::Result<()> {
    let script = std::path::Path::new(&args.python_script);
    if !script.exists() {
        anyhow::bail!("Python script not found: {}", script.display());
    }

    info!("Spawning Python pipeline: {} {}", args.python_exe, script.display());
    let mut cmd = tokio::process::Command::new(&args.python_exe);
    cmd.arg(script);

    // Detach from the console's Ctrl+C signal group so the Python process
    // keeps running if the user presses Ctrl+C in the terminal.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    let child = cmd.spawn()?;
    if let Some(pid) = child.id() {
        PYTHON_PID.store(pid, Ordering::Relaxed);
        info!("Python pipeline pid={pid}");
    }
    Ok(())
}
