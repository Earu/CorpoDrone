use anyhow::{bail, Result};
use crossbeam_channel::Receiver;
use tracing::{info, warn};

use super::AudioChunk;

// ── Windows — named pipe ──────────────────────────────────────────────────────

#[cfg(windows)]
pub fn run(pipe_path: &str, rx: Receiver<AudioChunk>) -> Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::WriteFile;
    use windows::Win32::Storage::FileSystem::PIPE_ACCESS_OUTBOUND;
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, NAMED_PIPE_MODE, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
        PIPE_WAIT,
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
            1,
            65536,
            0,
            0,
            None,
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

    let sentinel = AudioChunk::sentinel();
    let _ = unsafe { WriteFile(pipe, Some(&sentinel), None, None) };

    unsafe { CloseHandle(pipe) }.ok();
    info!("Audio pipe closed");
    Ok(())
}

// ── Unix — POSIX FIFO ─────────────────────────────────────────────────────────

#[cfg(unix)]
pub fn run(pipe_path: &str, rx: Receiver<AudioChunk>) -> Result<()> {
    use std::ffi::CString;
    use std::io::Write;

    // Create the FIFO. If one already exists (stale from a crashed previous run),
    // reuse it — do NOT remove it first. Removing it would cause a deadlock: Python
    // may already be blocking on open(O_RDONLY) against the old inode, and after
    // remove+mkfifo audio-capture would open a *new* inode. They'd wait on different
    // inodes forever. By reusing the existing FIFO, audio-capture's write-open
    // unblocks Python's pending read-open on the same inode.
    let c_path = CString::new(pipe_path)?;
    let ret = unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) };
    if ret < 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::EEXIST) {
            anyhow::bail!("mkfifo({pipe_path}) failed: {}", err);
        }
        // EEXIST: stale FIFO from a previous run — reuse it
        info!("Reusing existing audio FIFO: {pipe_path}");
    }

    info!("Waiting for Python to connect to audio FIFO: {pipe_path}");

    // Opening a FIFO for writing blocks until the reader (Python) opens its end
    let mut file = std::fs::OpenOptions::new().write(true).open(pipe_path)?;
    info!("Python connected to audio pipe");

    let mut chunks_written: u64 = 0;
    for chunk in &rx {
        let encoded = chunk.encode();
        if let Err(e) = file.write_all(&encoded) {
            warn!("Audio pipe write error: {e}");
            break;
        }
        chunks_written += 1;
        if chunks_written == 1 || chunks_written % 100 == 0 {
            info!("Audio pipe: {chunks_written} chunks written");
        }
    }

    let sentinel = AudioChunk::sentinel();
    let _ = file.write_all(&sentinel);
    let _ = std::fs::remove_file(pipe_path);

    info!("Audio pipe closed");
    Ok(())
}

#[cfg(not(any(windows, unix)))]
pub fn run(_pipe_path: &str, _rx: Receiver<AudioChunk>) -> Result<()> {
    anyhow::bail!("audio-capture: unsupported platform");
}
