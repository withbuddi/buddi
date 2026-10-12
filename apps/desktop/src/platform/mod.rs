//! What differs per platform. Everything else (the command, the window's
//! phases, the tray menu) is shared: Linux (WebKitGTK, `linux.rs`) and
//! Windows (WebView2, `windows.rs`, its rules in `windows_rules.rs`).

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;
#[cfg(any(target_os = "windows", test))]
pub mod windows_rules;

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

static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// Remembered at start, so a failed hand-off to the browser can say so.
pub fn remember_app(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// A link off the dashboard: the default browser, never this window. The
/// hand-off is checked (a launcher that exits non-zero is retried another
/// way) and a failure is a notification, never silence: a sign-in page that
/// does not open looks to the owner like a button that does nothing.
pub fn open_external(url: &Url) {
    static RECENT: std::sync::Mutex<crate::policy::HandOffs> = std::sync::Mutex::new(crate::policy::HandOffs::new());
    if !crate::policy::may_hand_off(url) {
        shell::log(format!("not handed to the browser ({} link)", url.scheme()));
        return;
    }
    if !RECENT.lock().unwrap().allow(url.as_str(), std::time::Instant::now()) {
        shell::log("not handed to the browser: the same address again, or too many at once");
        return;
    }
    let url = url.clone();
    std::thread::spawn(move || {
        let shown = format!("{}{}", url.origin().ascii_serialization(), url.path());
        match launch(url.as_str()) {
            Ok(how) => shell::log(format!("opened in the browser ({how}): {shown}")),
            Err(why) => {
                shell::log(format!("could not open the browser for {shown}: {why}"));
                if let Some(app) = APP.get() {
                    notify(app, "buddi could not open your browser", &format!("Open this address yourself: {url}"));
                }
            }
        }
    });
}
