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
    if !file.exists() {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&file, include_bytes!("../../icons/128x128.png")).ok()?;
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

/// Where the tray's icon files go: the session's runtime folder, not /tmp.
pub fn tray_icon_dir() -> Option<PathBuf> {
    dirs::runtime_dir().map(|d| d.join("buddi-desktop").join("tray"))
}
