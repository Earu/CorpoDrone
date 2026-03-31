//! Enumerate microphone devices for the settings UI (cpal on macOS/Linux, WASAPI on Windows).

use serde::Serialize;

#[derive(Serialize)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct AudioDeviceList {
    pub inputs: Vec<AudioDeviceInfo>,
}

pub fn list_devices_json() -> anyhow::Result<String> {
    let list = list_devices()?;
    Ok(serde_json::to_string(&list)?)
}

#[cfg(target_os = "macos")]
fn list_devices() -> anyhow::Result<AudioDeviceList> {
    Ok(AudioDeviceList {
        inputs: list_cpal_inputs()?,
    })
}

#[cfg(target_os = "linux")]
fn list_devices() -> anyhow::Result<AudioDeviceList> {
    Ok(AudioDeviceList {
        inputs: list_cpal_inputs()?,
    })
}

#[cfg(windows)]
fn list_devices() -> anyhow::Result<AudioDeviceList> {
    list_devices_windows()
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn list_cpal_inputs() -> anyhow::Result<Vec<AudioDeviceInfo>> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let mut inputs = Vec::new();
    for dev in host.input_devices()? {
        let name = dev.name()?;
        inputs.push(AudioDeviceInfo {
            id: name.clone(),
            name,
        });
    }
    Ok(inputs)
}

#[cfg(windows)]
fn list_devices_windows() -> anyhow::Result<AudioDeviceList> {
    use wasapi::*;

    initialize_mta().ok()?;

    let mut inputs = Vec::new();
    let cap = DeviceCollection::new(&Direction::Capture)?;
    let n_in = cap.get_nbr_devices()?;
    for i in 0..n_in {
        let dev = cap.get_device_at_index(i)?;
        let name = dev.get_friendlyname().unwrap_or_else(|_| format!("Capture {i}"));
        inputs.push(AudioDeviceInfo {
            id: name.clone(),
            name,
        });
    }

    Ok(AudioDeviceList { inputs })
}
