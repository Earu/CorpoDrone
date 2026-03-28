"""
Writes newline-delimited JSON messages to the transcript named pipe / FIFO.
The Rust backend reads from this pipe and emits Tauri events.
"""
import json
import os
import sys
import threading
import time
from typing import Any, Dict
import structlog

log = structlog.get_logger(__name__)

if sys.platform == "win32":
    import ctypes
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    def _wait_transcript_pipe(path: str) -> None:
        """Block until the Windows named pipe server is ready."""
        _kernel32.WaitNamedPipeW(path, 2000)
else:
    def _wait_transcript_pipe(path: str) -> None:
        """Block until the POSIX FIFO appears (created by Tauri)."""
        while not os.path.exists(path):
            time.sleep(0.1)


class TranscriptWriter:
    """Thread-safe writer to the transcript pipe / FIFO."""

    def __init__(self, pipe_path: str):
        self.pipe_path = pipe_path
        self._lock = threading.Lock()
        self._pipe = None
        self._connect()

    def _connect(self):
        retries = 0
        log.info("connecting_transcript_pipe", path=self.pipe_path)
        while True:
            try:
                _wait_transcript_pipe(self.pipe_path)
                self._pipe = open(self.pipe_path, "w", encoding="utf-8", buffering=1)
                log.info("transcript_pipe_connected")
                return
            except OSError as e:
                retries += 1
                if retries % 10 == 1:
                    log.warning("transcript_pipe_not_ready", error=str(e), retries=retries)
                time.sleep(0.5)

    def send(self, msg: Dict[str, Any]):
        """Send a JSON message. Reconnects on broken pipe."""
        line = json.dumps(msg, ensure_ascii=False) + "\n"
        with self._lock:
            for attempt in range(3):
                try:
                    self._pipe.write(line)
                    self._pipe.flush()
                    return
                except (OSError, BrokenPipeError):
                    log.warning("transcript_pipe_broken_reconnecting")
                    try:
                        self._pipe.close()
                    except Exception:
                        pass
                    self._connect()
        log.error("transcript_pipe_send_failed_after_retries")

    def close(self):
        if self._pipe:
            try:
                self._pipe.close()
            except Exception:
                pass
