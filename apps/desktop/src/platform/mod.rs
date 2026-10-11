//! What differs per platform. Everything else (the command, the window's
//! phases, the tray menu) is shared. Linux (WebKitGTK) is the target today;
//! `windows.rs` holds the places a WebView2 build fills in (README.md).

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

// macOS has buddi.app (apps/mac); this only keeps `cargo check` working there.
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
mod other;
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
pub use other::*;

use tauri::{AppHandle, Url};

use crate::shell;

/// Brings the window forward (tray, second launch, a notification's click).
pub fn show_main(app: &AppHandle) {
    if let Some(w) = shell::main_window(app) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    shell::reopened(app);
}

/// A link off the dashboard: the default browser, never this window.
pub fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        shell::log(format!("opening in the browser: {}", url.origin().ascii_serialization()));
        if let Err(e) = open::that_detached(url.as_str()) {
            shell::log(format!("could not open the browser: {e}"));
        }
    }
}
