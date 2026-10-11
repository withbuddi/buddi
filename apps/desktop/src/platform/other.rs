//! Neither Linux nor Windows: enough to compile, nothing more.

use tauri::{AppHandle, Url, WebviewWindow};

pub fn local_page() -> Url {
    Url::parse("tauri://localhost/index.html").unwrap()
}

pub fn tune_webview(_window: &WebviewWindow) {}

pub fn notify(_app: &AppHandle, title: &str, body: &str) {
    crate::shell::log(format!("notification: {title}: {body}"));
}

pub fn tray_wants_dark_ink() -> bool {
    true
}

pub fn tray_icon_dir() -> Option<std::path::PathBuf> {
    None
}

pub fn clock_text(at: std::time::SystemTime) -> String {
    let local: chrono::DateTime<chrono::Local> = at.into();
    local.format("%H:%M").to_string()
}

/// TODO(windows): a Run key or a Startup shortcut with --hidden, written by the installer.
pub fn autostart_enabled() -> bool {
    false
}

pub fn set_autostart(_on: bool) -> Result<(), String> {
    Err("Start at Login is not there yet on this system.".into())
}

pub fn launch(url: &str) -> Result<&'static str, String> {
    open::that_detached(url).map(|_| "open").map_err(|e| e.to_string())
}
