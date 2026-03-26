use anyhow::{bail, Result};
use crossbeam_channel::Receiver;
use tracing::{info, warn};

use super::AudioChunk;

#[cfg(windows)]
pub fn run(pipe_path: &str, rx: Receiver<AudioChunk>) -> Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::WriteFile;
    use windows::Win32::Storage::FileSystem::PIPE_ACCESS_OUTBOUND;
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW,
        NAMED_PIPE_MODE, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    use windows::core::PCWSTR;

    let wide: Vec<u16> = OsStr::new(pipe_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    info!("Creating named pipe server: {pipe_path}");

    let pipe: HANDLE = unsafe {
        CreateNamedPipeW(
            PCWSTR(wide.as_ptr()),
            PIPE_ACCESS_OUTBOUND,
            NAMED_PIPE_MODE(PIPE_TYPE_BYTE.0 | PIPE_READMODE_BYTE.0 | PIPE_WAIT.0),
            1,     // max instances
            65536, // out buffer size
            0,     // in buffer size
            0,     // default timeout
            None,  // security attributes
        )
    };

    if pipe == INVALID_HANDLE_VALUE {
        bail!("CreateNamedPipeW failed");
    }

    info!("Waiting for Python to connect to audio pipe...");
    unsafe { ConnectNamedPipe(pipe, None) }?;
    info!("Python connected to audio pipe");

    for chunk in &rx {
        let encoded = chunk.encode();
        if let Err(e) = unsafe { WriteFile(pipe, Some(&encoded), None, None) } {
            warn!("Audio pipe write error: {e}");
            break;
        }
    }

    // Send end-of-stream sentinel
    let sentinel = AudioChunk::sentinel();
    let _ = unsafe { WriteFile(pipe, Some(&sentinel), None, None) };

    unsafe { CloseHandle(pipe) }.ok();
    info!("Audio pipe closed");
    Ok(())
}

#[cfg(not(windows))]
pub fn run(_pipe_path: &str, _rx: Receiver<AudioChunk>) -> Result<()> {
    anyhow::bail!("audio-capture only supports Windows");
}
