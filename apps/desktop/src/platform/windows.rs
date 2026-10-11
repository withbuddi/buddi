//! Windows (WebView2): the places a Windows build fills in. Compiles today;
//! see README.md, "Windows", for what each needs.

use tauri::{AppHandle, Url, WebviewWindow};

/// Tauri serves the app's own files from http://tauri.localhost on Windows.
pub fn local_page() -> Url {
    Url::parse("http://tauri.localhost/index.html").unwrap()
}

/// TODO(windows): `with_webview` → `ICoreWebView2::add_PermissionRequested`:
/// allow COREWEBVIEW2_PERMISSION_KIND_MICROPHONE and _NOTIFICATIONS for the
/// dashboard's origin only, deny the rest (what linux.rs does for WebKitGTK).
/// Downloads and the file picker work through Tauri/WebView2 as they are.
pub fn tune_webview(_window: &WebviewWindow) {}

/// TODO(windows): a toast with the app's AppUserModelID (set by the
/// installer); `tauri-plugin-notification` or `notify-rust` both do it.
pub fn notify(_app: &AppHandle, title: &str, body: &str) {
    crate::shell::log(format!("notification: {title}: {body}"));
}

/// The notification area follows the taskbar's light or dark theme.
/// TODO(windows): read HKCU\...\Themes\Personalize\SystemUsesLightTheme.
pub fn tray_wants_dark_ink() -> bool {
    false
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
