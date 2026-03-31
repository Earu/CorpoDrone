// Console apps on Windows only; ignored on Linux/macOS.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

fn main() {
    corpo_drone_lib::run()
}
