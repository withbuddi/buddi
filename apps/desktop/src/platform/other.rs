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
