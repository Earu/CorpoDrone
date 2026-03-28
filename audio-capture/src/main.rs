mod capture;
mod ipc;

use anyhow::Result;
use clap::Parser;
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
    /// Named pipe or FIFO path for audio output
    #[arg(long, default_value_t = default_pipe())]
    pipe: String,

    /// Audio chunk duration in milliseconds
    #[arg(long, default_value_t = 100)]
    chunk_ms: u32,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env()
            .add_directive("audio_capture=info".parse()?))
        .init();

    let args = Args::parse();
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
            if let Err(e) = capture::loopback::run(tx_loop, chunk_ms) {
                tracing::error!("loopback capture error: {e:#}");
            }
        })?;

    drop(tx);
    ipc::pipe_writer::run(&args.pipe, rx)?;
    Ok(())
}
