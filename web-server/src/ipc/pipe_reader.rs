use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::{info, warn};

use crate::hub::Hub;

#[cfg(windows)]
pub async fn run(pipe_path: String, hub: Arc<Hub>) {
    use tokio::net::windows::named_pipe::ServerOptions;

    loop {
        info!("Creating transcript pipe server: {pipe_path}");
        let server = match ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_path)
        {
            Ok(s) => s,
            Err(e) => {
                warn!("Failed to create transcript pipe: {e}");
                tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                continue;
            }
        };

        info!("Waiting for Python to connect to transcript pipe...");
        if let Err(e) = server.connect().await {
            warn!("Transcript pipe connect error: {e}");
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            continue;
        }

        info!("Python connected to transcript pipe");
        let mut reader = BufReader::new(server);
        let mut line = String::new();

        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    info!("Transcript pipe closed by Python, reconnecting...");
                    break;
                }
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<serde_json::Value>(trimmed) {
                        Ok(msg) => {
                            hub.broadcast(msg).await;
                        }
                        Err(e) => {
                            warn!("Invalid JSON from Python pipeline: {e} — line: {trimmed}");
                        }
                    }
                }
                Err(e) => {
                    warn!("Transcript pipe read error: {e}");
                    break;
                }
            }
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
}

#[cfg(not(windows))]
pub async fn run(pipe_path: String, hub: Arc<Hub>) {
    warn!("Transcript pipe reader is Windows-only (path: {pipe_path})");
}
