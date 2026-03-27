mod capture;
mod ipc;

use anyhow::Result;
use clap::Parser;
use tracing::info;

#[derive(Parser, Debug)]
#[command(name = "audio-capture", about = "Captures mic + loopback audio and streams to Python pipeline")]
struct Args {
    /// Named pipe path for audio output
    #[arg(long, default_value = r"\\.\pipe\corpodrone-audio")]
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

    // Spawn capture threads
    let tx_mic = tx.clone();
    let chunk_ms = args.chunk_ms;
    std::thread::Builder::new()
        .name("wasapi-mic".into())
        .spawn(move || {
            if let Err(e) = capture::mic::run(tx_mic, chunk_ms) {
                tracing::error!("mic capture error: {e:#}");
            }
        })?;

    let tx_loop = tx.clone();
    std::thread::Builder::new()
        .name("wasapi-loopback".into())
        .spawn(move || {
            if let Err(e) = capture::loopback::run(tx_loop, chunk_ms) {
                tracing::error!("loopback capture error: {e:#}");
            }
        })?;

    drop(tx);

    // Write audio chunks to named pipe
    ipc::pipe_writer::run(&args.pipe, rx)?;

    Ok(())
}
