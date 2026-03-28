use anyhow::Result;
use rubato::{FftFixedIn, Resampler};

/// Converts audio to 16kHz mono f32 PCM as required by Whisper.
pub struct ToWhisper {
    resampler: Option<FftFixedIn<f32>>,
    input_channels: u16,
    /// Leftover samples from the last conversion that didn't fill a full resampler chunk
    remainder: Vec<f32>,
}

impl ToWhisper {
    pub fn new(input_rate: u32, input_channels: u16) -> Result<Self> {
        const TARGET_RATE: u32 = 16_000;
        let resampler = if input_rate != TARGET_RATE {
            Some(FftFixedIn::<f32>::new(
                input_rate as usize,
                TARGET_RATE as usize,
                // Process chunks of ~50ms at input rate
                (input_rate / 20) as usize,
                2,
                1,
            )?)
        } else {
            None
        };
        Ok(Self {
            resampler,
            input_channels,
            remainder: Vec::new(),
        })
    }

    /// Convert interleaved multi-channel samples to 16kHz mono f32.
    /// Returns accumulated 16kHz mono samples (may be empty if not enough input yet).
    pub fn process(&mut self, interleaved: &[f32]) -> Result<Vec<f32>> {
        // Downmix to mono by averaging channels
        let channels = self.input_channels as usize;
        let mono: Vec<f32> = interleaved
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect();

        if let Some(ref mut resampler) = self.resampler {
            // Feed into remainder buffer
            self.remainder.extend_from_slice(&mono);

            let chunk_size = resampler.input_frames_next();
            let mut out = Vec::new();

            while self.remainder.len() >= chunk_size {
                let chunk: Vec<f32> = self.remainder.drain(..chunk_size).collect();
                let resampled = resampler.process(&[chunk], None)?;
                out.extend_from_slice(&resampled[0]);
            }

            Ok(out)
        } else {
            Ok(mono)
        }
    }

}
