//! Linux: WebKitGTK's settings and permission prompts, desktop
//! notifications over D-Bus, and which tray glyph suits the panel.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, Url, WebviewWindow};

use crate::{buddi, shell};

pub fn local_page() -> Url {
    Url::parse("tauri://localhost/index.html").unwrap()
}

/// The microphone for the dashboard's own origin, nothing for anyone else.
pub fn tune_webview(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let _ = window.with_webview(move |wv| {
        use webkit2gtk::glib::prelude::*;
        use webkit2gtk::{
            NotificationExt, PermissionRequestExt, SettingsExt, UserMediaPermissionRequestExt, WebViewExt,
        };
        let view = wv.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            // getUserMedia is off in WebKitGTK unless asked for; voice needs it.
            settings.set_enable_media_stream(true);
            settings.set_enable_mediasource(true);
            settings.set_enable_webrtc(true);
            settings.set_media_playback_requires_user_gesture(false);
            if std::env::var("BUDDI_SHELL_DEBUG").as_deref() == Ok("1") {
                settings.set_enable_developer_extras(true);
                // So `--eval` can exercise window.open without a real click.
                settings.set_javascript_can_open_windows_automatically(true);
            }
        }
        view.connect_permission_request(|view, req| {
            let ours = view.uri().and_then(|u| Url::parse(&u).ok()).map(|u| buddi::is_dashboard(&u)).unwrap_or(false);
            let (kind, wanted) = if let Some(media) = req.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>() {
                // The microphone only: a camera (or a screen) is not something the dashboard is given.
                ("microphone", media.is_for_audio_device() && !media.is_for_video_device())
            } else if req.is::<webkit2gtk::NotificationPermissionRequest>() {
                // Answered by the bridge before WebKit is asked; granted for the dashboard all the same.
                ("notifications", true)
            } else if req.is::<webkit2gtk::DeviceInfoPermissionRequest>() {
                // The microphone's name in the picker; part of the microphone.
                ("device names", true)
            } else {
                ("other", false)
            };
            if ours && wanted {
                req.allow();
            } else {
                shell::log(format!("refused a {kind} request"));
                req.deny();
            }
            true
        });
        // The dashboard's window.Notification is the app's bridge (main.rs); a
        // notification WebKit shows by itself still goes the same way.
        let notify_app = app.clone();
        view.connect_show_notification(move |_view, n| {
            let title = n.title().map(|t| t.to_string()).unwrap_or_else(|| "buddi".into());
            let body = n.body().map(|b| b.to_string()).unwrap_or_default();
            notify(&notify_app, &title, &body);
            true
        });
    });
}

/// The app's icon as a file, for notification servers that want a path
/// (the AppImage has no icon theme of its own).
fn icon_file() -> Option<PathBuf> {
    let dir = dirs::runtime_dir().or_else(dirs::cache_dir)?.join("buddi-desktop");
    let file = dir.join("buddi.png");
    let icon: &[u8] = include_bytes!("../../icons/128x128.png");
    if std::fs::metadata(&file).map(|m| m.len() != icon.len() as u64).unwrap_or(true) {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&file, icon).ok()?;
    }
    Some(file)
}

/// A desktop notification named "buddi"; a click brings the window forward.
pub fn notify(app: &AppHandle, title: &str, body: &str) {
    let (app, title, body) = (app.clone(), title.to_string(), body.to_string());
    std::thread::spawn(move || {
        let mut n = notify_rust::Notification::new();
        n.appname("buddi")
            .summary(&title)
            .body(&body)
            .hint(notify_rust::Hint::DesktopEntry("buddi-desktop".into()))
            .action("default", "Open buddi");
        if let Some(icon) = icon_file() {
            n.icon(&icon.to_string_lossy());
        }
        match n.show() {
            Ok(handle) => handle.wait_for_action(|action| {
                if action == "default" {
                    super::show_main(&app);
                }
            }),
            Err(e) => shell::log(format!("notification failed: {e}")),
        }
    });
}

/// Dark ink for a light panel, light ink for a dark one. GNOME's top bar
/// (Ubuntu, Pop!_OS) and COSMIC's are dark whatever the theme; elsewhere the
/// theme decides. BUDDI_TRAY_INK=dark|light overrides.
pub fn tray_wants_dark_ink() -> bool {
    match std::env::var("BUDDI_TRAY_INK").as_deref() {
        Ok("dark") => return true,
        Ok("light") => return false,
        _ => {}
    }
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default().to_ascii_lowercase();
    if ["gnome", "unity", "cosmic", "pantheon", "budgie"].iter().any(|d| desktop.contains(d)) {
        return false;
    }
    if desktop.contains("kde") {
        let globals = dirs::config_dir().and_then(|c| std::fs::read_to_string(c.join("kdeglobals")).ok()).unwrap_or_default();
        return !globals.lines().any(|l| l.starts_with("ColorScheme=") && l.to_ascii_lowercase().contains("dark"));
    }
    false
}

/// "11:19" or "11:19 AM", as the top bar's clock has it (GNOME's clock-format).
pub fn clock_text(at: std::time::SystemTime) -> String {
    static TWELVE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let twelve = *TWELVE.get_or_init(|| {
        std::process::Command::new("gsettings")
            .args(["get", "org.gnome.desktop.interface", "clock-format"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("12h"))
            .unwrap_or(false)
    });
    let local: chrono::DateTime<chrono::Local> = at.into();
    local.format(if twelve { "%-I:%M %p" } else { "%H:%M" }).to_string()
}

const SYSTEM_AUTOSTART: &str = "/etc/xdg/autostart/buddi-desktop.desktop";
/// install.sh's mark (scripts/install.sh, packages/install/src/linux-install.ts).
const MARK: &str = "X-Buddi-Linux-Install=true";

fn user_autostart() -> Option<PathBuf> {
    dirs::config_dir().map(|c| c.join("autostart").join("buddi-desktop.desktop"))
}

fn turned_off(entry: &str) -> bool {
    entry.lines().any(|l| matches!(l.trim(), "Hidden=true" | "X-GNOME-Autostart-enabled=false"))
}

/// Start at Login: this account's entry decides when there is one (it shadows
/// the package's /etc/xdg/autostart entry, same file name); else the package's.
pub fn autostart_enabled() -> bool {
    match user_autostart().and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(entry) => !turned_off(&entry),
        None => std::path::Path::new(SYSTEM_AUTOSTART).exists(),
    }
}

/// On: this account's entry, marked as install.sh's (kept current by it,
/// removed by `buddi uninstall`). Off: an entry that says so, unmarked, so
/// install.sh leaves the owner's choice alone.
pub fn set_autostart(on: bool) -> Result<(), String> {
    let file = user_autostart().ok_or("no config folder")?;
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    // An AppImage starts itself by its own path; the package by its command.
    let exec = std::env::var("APPIMAGE").map(|p| format!("\"{p}\"")).unwrap_or_else(|_| "buddi-desktop".into());
    let entry = if on {
        format!("[Desktop Entry]\nType=Application\nName=buddi\nComment=buddi in the tray, from login\nExec={exec} --hidden\nIcon=buddi-desktop\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n{MARK}\n")
    } else {
        format!("[Desktop Entry]\nType=Application\nName=buddi\nComment=Turned off in buddi's menu (Start at Login)\nExec={exec} --hidden\nNoDisplay=true\nHidden=true\nX-GNOME-Autostart-enabled=false\n")
    };
    std::fs::write(&file, entry).map_err(|e| e.to_string())
}

/// Where the tray's icon files go: the session's runtime folder, not /tmp.
pub fn tray_icon_dir() -> Option<PathBuf> {
    dirs::runtime_dir().map(|d| d.join("buddi-desktop").join("tray"))
}
