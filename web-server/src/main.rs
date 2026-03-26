mod hub;
mod ipc;
mod routes;

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use actix_web::{web, App, HttpServer};
use anyhow::Result;
use clap::Parser;
use tracing::info;

use hub::Hub;

/// PID of the Python pipeline subprocess. 0 = not running.
pub static PYTHON_PID: AtomicU32 = AtomicU32::new(0);

/// Overlay config.toml [server] section onto Args defaults.
/// Only updates fields that still hold their default value so CLI args win.
fn load_config(args: &mut Args) {
    let path = "config.toml";
    let Ok(text) = std::fs::read_to_string(path) else { return };

    // Minimal TOML key=value parser for the [server] section — avoids a heavy dep.
    let mut in_server = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_server = line == "[server]";
            continue;
        }
        if !in_server { continue; }
        if let Some((k, v)) = line.split_once('=') {
            let k = k.trim();
            let v = v.trim().trim_matches('\'').trim_matches('"');
            match k {
                "python_exe"    => args.python_exe    = v.to_string(),
                "python_script" => args.python_script = v.to_string(),
                "capture_bin"   => args.capture_bin   = v.to_string(),
                "bind"          => args.bind          = v.to_string(),
                _ => {}
            }
        }
    }
}

#[derive(Parser, Debug, Clone)]
#[command(name = "web-server", about = "CorpoDrone web server and pipeline coordinator")]
pub struct Args {
    /// HTTP listen address
    #[arg(long, default_value = "127.0.0.1:8080")]
    pub bind: String,

    /// Named pipe: transcript from Python
    #[arg(long, default_value = r"\\.\pipe\corpodrone-transcript")]
    pub transcript_pipe: String,

    /// Named pipe: control commands to Python
    #[arg(long, default_value = r"\\.\pipe\corpodrone-control")]
    pub control_pipe: String,

    /// Named pipe: audio from audio-capture
    #[arg(long, default_value = r"\\.\pipe\corpodrone-audio")]
    pub audio_pipe: String,

    /// Path to audio-capture binary
    #[arg(long, default_value = r"target\release\audio-capture.exe")]
    pub capture_bin: String,

    /// Path to Python pipeline script
    #[arg(long, default_value = r"python\pipeline.py")]
    pub python_script: String,

    /// Python executable
    #[arg(long, default_value = "python")]
    pub python_exe: String,
}

#[actix_web::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("web_server=info".parse()?)
                .add_directive("actix_web=warn".parse()?),
        )
        .init();

    let mut args = Args::parse();
    // Load overrides from config.toml (CLI flags still take precedence if explicitly passed)
    load_config(&mut args);
    info!("Starting CorpoDrone web-server on {}", args.bind);

    let hub = Arc::new(Hub::new());
    let args = Arc::new(args);

    // Start Python pipeline subprocess
    let py_handle = routes::api::spawn_python(Arc::clone(&args)).await;
    if let Err(ref e) = py_handle {
        tracing::warn!("Could not auto-start Python pipeline: {e} — start it manually");
    }

    // On Ctrl+C / shutdown: kill Python pipeline and audio-capture
    tokio::spawn(async {
        let _ = tokio::signal::ctrl_c().await;
        info!("Shutting down — killing subprocesses");
        kill_subprocesses().await;
        std::process::exit(0);
    });

    // Start transcript pipe reader (Python → hub)
    let hub_clone = Arc::clone(&hub);
    let pipe_path = args.transcript_pipe.clone();
    tokio::spawn(async move {
        ipc::pipe_reader::run(pipe_path, hub_clone).await;
    });

    let hub_data = web::Data::from(Arc::clone(&hub));
    let args_data = web::Data::from(Arc::clone(&args));
    let bind = args.bind.clone();

    // Also kill subprocesses when the server finishes (e.g. closed programmatically)
    // Open the UI in the default browser once the server is bound
    let url = format!("http://{}", bind);
    tokio::spawn(async move {
        // Small delay to ensure the listener is ready before the browser hits it
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let _ = std::process::Command::new("cmd").args(["/c", "start", &url]).spawn();
        info!("Opened browser at {url}");
    });

    let server = HttpServer::new(move || {
        App::new()
            .app_data(hub_data.clone())
            .app_data(args_data.clone())
            .route("/ws", web::get().to(routes::ws::handler))
            .route("/api/start", web::post().to(routes::api::start))
            .route("/api/stop", web::post().to(routes::api::stop))
            .route("/api/speakers", web::post().to(routes::api::update_speaker))
            .route("/api/status", web::get().to(routes::api::status))
            .route("/", web::get().to(routes::static_files::index))
            .route("/app.js", web::get().to(routes::static_files::app_js))
            .route("/style.css", web::get().to(routes::static_files::style_css))
    })
    .bind(&bind)?
    .run();

    server.await?;
    kill_subprocesses().await;
    Ok(())
}

async fn kill_subprocesses() {
    // Kill Python pipeline
    let pid = PYTHON_PID.load(Ordering::Relaxed);
    if pid != 0 {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output()
            .await;
        info!("Killed Python pipeline (pid={pid})");
    }
    // Kill audio-capture if running
    let _ = tokio::process::Command::new("taskkill")
        .args(["/F", "/IM", "audio-capture.exe"])
        .output()
        .await;
}
