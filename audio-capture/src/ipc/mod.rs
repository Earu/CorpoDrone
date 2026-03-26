pub mod pipe_writer;

/// Which audio device a chunk came from.
#[derive(Clone, Copy, Debug)]
pub enum AudioSource {
    Mic = 0x01,
    Loopback = 0x02,
}

/// A single framed audio chunk sent over the named pipe.
///
/// Wire format:
///   [4 bytes] total payload length (u32 LE) — everything after these 4 bytes
///   [1 byte]  source tag (0x01=mic, 0x02=loopback, 0xFF=sentinel/end)
///   [8 bytes] timestamp_us (u64 LE)
///   [4 bytes] num_samples (u32 LE)
///   [num_samples * 4 bytes] f32 LE PCM samples
pub struct AudioChunk {
    pub source: AudioSource,
    pub timestamp_us: u64,
    pub samples: Vec<f32>,
}

impl AudioChunk {
    pub fn encode(&self) -> Vec<u8> {
        let num_samples = self.samples.len() as u32;
        // 1 (tag) + 8 (ts) + 4 (len) + num_samples*4
        let payload_len = 1u32 + 8 + 4 + num_samples * 4;

        let mut buf = Vec::with_capacity(4 + payload_len as usize);
        buf.extend_from_slice(&payload_len.to_le_bytes());
        buf.push(self.source as u8);
        buf.extend_from_slice(&self.timestamp_us.to_le_bytes());
        buf.extend_from_slice(&num_samples.to_le_bytes());
        for &s in &self.samples {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        buf
    }

    /// Encode a sentinel chunk signalling end-of-stream.
    pub fn sentinel() -> Vec<u8> {
        let payload_len = 1u32 + 8 + 4;
        let mut buf = Vec::with_capacity(4 + payload_len as usize);
        buf.extend_from_slice(&payload_len.to_le_bytes());
        buf.push(0xFF); // sentinel tag
        buf.extend_from_slice(&0u64.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf
    }
}
