// Console apps on Windows only; ignored on Linux/macOS.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// WebKitGTK's DMABUF renderer crashes the webview at startup on Wayland with
// NVIDIA's proprietary driver ("Error 71 (Protocol error) dispatching to Wayland
// display"), because WebKit's ANGLE and nvidia egl-wayland disagree over the
// explicit sync protocol (https://bugs.webkit.org/show_bug.cgi?id=280210, open).
// Opting the NVIDIA driver out of explicit sync avoids it and keeps the fast
// rendering path. Only the NVIDIA driver reads this variable, so it is inert on
// AMD and Intel. Must run before GTK init.
#[cfg(target_os = "linux")]
fn apply_wayland_webkit_workaround() {
    const VAR: &str = "__NV_DISABLE_EXPLICIT_SYNC";
    if std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os(VAR).is_none() {
        std::env::set_var(VAR, "1");
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    apply_wayland_webkit_workaround();

    corpo_drone_lib::run()
}
