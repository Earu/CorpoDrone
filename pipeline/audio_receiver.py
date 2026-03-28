"""
Reads audio chunks from the named pipe / FIFO written by audio-capture.

Wire format per chunk:
  [4 bytes] payload_len  u32 LE
  [1 byte]  source tag   0x01=mic, 0x02=loopback, 0xFF=sentinel
  [8 bytes] timestamp_us u64 LE
  [4 bytes] num_samples  u32 LE
  [num_samples*4 bytes]  f32 LE PCM @ 16kHz mono
"""
import os
import struct
import sys
import threading
import queue
import time
from dataclasses import dataclass
from typing import Optional
import numpy as np
import structlog

log = structlog.get_logger(__name__)

if sys.platform == "win32":
    import ctypes
    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    def _wait_pipe(path: str, timeout_ms: int = 5000) -> bool:
        """Returns True if the Windows named pipe becomes available within timeout_ms."""
        return bool(_kernel32.WaitNamedPipeW(path, timeout_ms))
else:
    def _wait_pipe(path: str, timeout_ms: int = 5000) -> bool:
        """Returns True if the POSIX FIFO exists within timeout_ms."""
        deadline = time.monotonic() + timeout_ms / 1000.0
        while time.monotonic() < deadline:
            if os.path.exists(path):
                return True
            time.sleep(0.05)
        return False

SOURCE_MIC = 0x01
SOURCE_LOOPBACK = 0x02
SOURCE_SENTINEL = 0xFF

HEADER_FMT = "<BQI"   # tag(1) + ts_us(8) + num_samples(4)
HEADER_SIZE = struct.calcsize(HEADER_FMT)  # 13 bytes


@dataclass
class AudioChunk:
    source: int          # SOURCE_MIC or SOURCE_LOOPBACK
    timestamp_us: int
    samples: np.ndarray  # float32, 16kHz mono


class AudioReceiver(threading.Thread):
    """
    Connects to the audio pipe and feeds chunks into a queue.
    Runs in a dedicated thread; the main pipeline reads from self.queue.
    """

    def __init__(self, pipe_path: str, maxsize: int = 256):
        super().__init__(daemon=True, name="audio-receiver")
        self.pipe_path = pipe_path
        self.queue: queue.Queue[Optional[AudioChunk]] = queue.Queue(maxsize=maxsize)
        self._stop_event = threading.Event()
        self._connected_once = False  # True once we successfully open the pipe

    def stop(self):
        self._stop_event.set()

    def run(self):
        while not self._stop_event.is_set():
            if not _wait_pipe(self.pipe_path, 5000):
                if self._connected_once:
                    # Was recording, pipe is gone — signal pipeline to stop
                    log.info("audio_pipe_gone_signalling_stop")
                    self.queue.put(None)
                    return
                log.debug("audio_pipe_not_ready", path=self.pipe_path)
                continue
            try:
                self._connect_and_read()
            except Exception as e:
                log.error("audio_receiver_error", error=str(e))
                if self._connected_once:
                    # Unexpected error after we were connected — stop cleanly
                    self.queue.put(None)
                    return
                time.sleep(1.0)

    def _connect_and_read(self):
        log.info("opening_audio_pipe", path=self.pipe_path)
        with open(self.pipe_path, "rb") as pipe:
            self._connected_once = True
            log.info("audio_pipe_connected")
            while not self._stop_event.is_set():
                # Read 4-byte length prefix
                raw_len = self._read_exact(pipe, 4)
                if raw_len is None:
                    log.info("audio_pipe_eof")
                    break
                (payload_len,) = struct.unpack("<I", raw_len)

                payload = self._read_exact(pipe, payload_len)
                if payload is None:
                    break

                tag, timestamp_us, num_samples = struct.unpack_from(HEADER_FMT, payload, 0)

                if tag == SOURCE_SENTINEL:
                    log.info("audio_pipe_sentinel_received")
                    self.queue.put(None)  # signal end-of-stream
                    return

                if num_samples == 0:
                    continue

                samples_bytes = payload[HEADER_SIZE: HEADER_SIZE + num_samples * 4]
                if len(samples_bytes) < num_samples * 4:
                    log.warning("short_samples_payload", got=len(samples_bytes), expected=num_samples * 4)
                    continue

                samples = np.frombuffer(samples_bytes, dtype=np.float32).copy()

                chunk = AudioChunk(
                    source=tag,
                    timestamp_us=timestamp_us,
                    samples=samples,
                )

                try:
                    self.queue.put_nowait(chunk)
                except queue.Full:
                    # Drop oldest chunk to make room
                    try:
                        self.queue.get_nowait()
                        self.queue.put_nowait(chunk)
                    except queue.Empty:
                        pass

    @staticmethod
    def _read_exact(pipe, n: int) -> Optional[bytes]:
        """Read exactly n bytes or return None on EOF."""
        buf = b""
        while len(buf) < n:
            data = pipe.read(n - len(buf))
            if not data:
                return None
            buf += data
        return buf
