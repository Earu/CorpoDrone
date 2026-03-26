"""
Writes newline-delimited JSON messages to the transcript named pipe.
The Rust web-server reads from this pipe and fans out to WebSocket clients.
"""
import json
import threading
import time
from typing import Any, Dict
import structlog

log = structlog.get_logger(__name__)


class TranscriptWriter:
    """Thread-safe writer to the Windows named pipe transcript channel."""

    def __init__(self, pipe_path: str):
        self.pipe_path = pipe_path
        self._lock = threading.Lock()
        self._pipe = None
        self._connect()

    def _connect(self):
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        retries = 0
        log.info("connecting_transcript_pipe", path=self.pipe_path)
        while True:
            try:
                # WaitNamedPipe blocks until the server is ready to accept a connection
                kernel32.WaitNamedPipeW(self.pipe_path, 2000)  # 2s timeout per attempt
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
