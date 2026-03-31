mod capture;
mod ipc;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing::info;

fn default_pipe() -> String {
    if cfg!(windows) {
        r"\\.\pipe\corpodrone-audio".to_string()
    } else {
        "/tmp/corpodrone-audio".to_string()
    }
}

#[derive(Parser, Debug)]
#[command(name = "audio-capture", about = "Captures mic + loopback audio and streams to Python pipeline")]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,

    /// Named pipe or FIFO path for audio output
    #[arg(long, default_value_t = default_pipe())]
    pipe: String,

    /// Audio chunk duration in milliseconds
    #[arg(long, default_value_t = 100)]
    chunk_ms: u32,

    /// Comma-separated bundle IDs for per-app loopback (macOS only; ignored on Linux/Windows).
    /// Example: com.hnc.Discord,us.zoom.xos
    #[arg(long)]
    loopback_apps: Option<String>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// List running GUI applications for per-app loopback (macOS only; Linux prints []).
    /// Prints a JSON array of {name, bundle_id} objects to stdout, then exits.
    ListApps,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env()
            .add_directive("audio_capture=info".parse()?))
        .init();

    let args = Args::parse();

    if let Some(Command::ListApps) = args.command {
        let apps = capture::loopback::list_apps();
        // Print compact JSON to stdout for the caller to parse.
        let json = apps.iter()
            .map(|(name, bid)| format!(r#"{{"name":"{}","bundle_id":"{}"}}"#,
                name.replace('"', "\\\""), bid.replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(",");
        println!("[{}]", json);
        return Ok(());
    }

    let loopback_apps: Option<Vec<String>> = args.loopback_apps.map(|s| {
        s.split(',').map(|id| id.trim().to_string()).filter(|id| !id.is_empty()).collect()
    });

    info!("Starting audio-capture, pipe={}", args.pipe);

    let (tx, rx) = crossbeam_channel::bounded::<ipc::AudioChunk>(64);

    let tx_mic = tx.clone();
    let chunk_ms = args.chunk_ms;
    std::thread::Builder::new()
        .name("capture-mic".into())
        .spawn(move || {
            if let Err(e) = capture::mic::run(tx_mic, chunk_ms) {
                tracing::error!("mic capture error: {e:#}");
            }
        })?;

    let tx_loop = tx.clone();
    std::thread::Builder::new()
        .name("capture-loopback".into())
        .spawn(move || {
            if let Err(e) = capture::loopback::run(tx_loop, chunk_ms, loopback_apps) {
                tracing::error!("loopback capture error: {e:#}");
            }
        })?;

    drop(tx);
    ipc::pipe_writer::run(&args.pipe, rx)?;
    Ok(())
}
