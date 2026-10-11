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
        // Navigations, every frame's: a click to another site goes to the
        // browser; frames and redirects load (a preview's embed), and a main
        // frame that lands off the dashboard is sent back by main.rs's
        // page-load guard. (Tauri's on_navigation is not used here: it sees
        // only the address, not whether a person clicked.)
        view.connect_decide_policy(|_view, decision, kind| {
            use webkit2gtk::{NavigationPolicyDecision, NavigationPolicyDecisionExt, PolicyDecisionExt, PolicyDecisionType, URIRequestExt};
            if kind != PolicyDecisionType::NavigationAction {
                return false;
            }
            let Some(nav) = decision.downcast_ref::<NavigationPolicyDecision>() else { return false };
            let Some(action) = nav.navigation_action() else { return false };
            let Some(uri) = action.request().and_then(|r| r.uri()) else { return false };
            let Ok(url) = Url::parse(&uri) else {
                decision.ignore();
                return true;
            };
            if shell::may_show(&url) || crate::policy::loopback(&url) {
                return false;
            }
            if crate::policy::may_hand_off(&url) {
                if action.is_user_gesture() {
                    super::open_external(&url);
                    decision.ignore();
                    return true;
                }
                return false;
            }
            decision.ignore();
            true
        });
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

/// Hands a URL to the desktop's default browser: xdg-open, else gio, else the
/// `open` crate's own list. Waits for the launcher's answer (it returns once
/// the browser took the address).
pub fn launch(url: &str) -> Result<&'static str, String> {
    use std::process::{Command, Stdio};
    let mut problems = Vec::new();
    for (name, program, args) in [("xdg-open", "xdg-open", vec![url]), ("gio", "gio", vec!["open", url])] {
        let out = Command::new(program).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).output();
        match out {
            Ok(o) if o.status.success() => return Ok(name),
            Ok(o) => problems.push(format!("{name}: {} {}", o.status, String::from_utf8_lossy(&o.stderr).trim())),
            Err(e) => problems.push(format!("{name}: {e}")),
        }
    }
    open::that_detached(url).map(|_| "open").map_err(|e| format!("{}; open: {e}", problems.join("; ")))
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

/// install.sh's mark (scripts/install.sh, packages/install/src/linux-install.ts):
/// an entry install.sh keeps current and `buddi uninstall` removes.
const MARK: &str = "X-Buddi-Linux-Install=true";
/// Which installation an entry belongs to: its data folder.
const DATA_KEY: &str = "X-Buddi-Data=";

fn user_autostart() -> Option<PathBuf> {
    dirs::config_dir().map(|c| c.join("autostart").join("buddi-desktop.desktop"))
}

fn turned_off(entry: &str) -> bool {
    entry.lines().any(|l| matches!(l.trim(), "Hidden=true" | "X-GNOME-Autostart-enabled=false"))
}

/// An entry this app may change: one it (or install.sh) wrote for this
/// installation. One the owner wrote, or another installation's, is not.
pub fn owned_entry(entry: &str, data: &str) -> bool {
    let named = entry.lines().find_map(|l| l.strip_prefix(DATA_KEY));
    match named {
        Some(d) => d == data,
        // Written before entries named their installation: install.sh's mark decides.
        None => entry.lines().any(|l| l == MARK),
    }
}

/// Start at Login: this account's autostart entry, on unless it says off.
/// (The package ships none for every user: it is per account.)
pub fn autostart_enabled() -> bool {
    match user_autostart().and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(entry) => !turned_off(&entry),
        None => false,
    }
}

pub fn autostart_entry(on: bool, exec: &str, data: &str) -> String {
    if on {
        format!("[Desktop Entry]\nType=Application\nName=buddi\nComment=buddi in the tray, from login\nExec={exec} --hidden\nIcon=buddi-desktop\nTerminal=false\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n{MARK}\n{DATA_KEY}{data}\n")
    } else {
        // Not marked: install.sh leaves the owner's choice alone.
        format!("[Desktop Entry]\nType=Application\nName=buddi\nComment=Turned off in buddi's menu (Start at Login)\nExec={exec} --hidden\nNoDisplay=true\nHidden=true\nX-GNOME-Autostart-enabled=false\n{DATA_KEY}{data}\n")
    }
}

/// Turns Start at Login on or off. Never over an entry this installation did
/// not write, never through a link; the new entry replaces the old in one step.
pub fn set_autostart(on: bool) -> Result<(), String> {
    let file = user_autostart().ok_or("no config folder")?;
    let data = buddi::data_dir().ok_or("no buddi installation")?.to_string_lossy().to_string();
    if let Ok(meta) = std::fs::symlink_metadata(&file) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(format!("{} is not a plain file; buddi leaves it alone.", file.display()));
        }
        let entry = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
        if !owned_entry(&entry, &data) {
            return Err(format!("{} was not written by buddi for this installation; change it in your startup settings.", file.display()));
        }
    }
    let dir = file.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // An AppImage starts itself by its own path; the package by its command.
    let exec = match std::env::var("APPIMAGE") {
        Ok(p) => crate::policy::exec_arg(&p).ok_or("the AppImage's path cannot go into a desktop entry")?,
        Err(_) => "buddi-desktop".into(),
    };
    let tmp = dir.join(format!(".buddi-desktop.desktop.{}", std::process::id()));
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(autostart_entry(on, &exec, &data).as_bytes()).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// The first launch turns Start at Login on (the .deb no longer starts it for
/// every user), unless an entry is there already; asked once.
pub fn offer_autostart_once(config: &std::path::Path) {
    let flag = config.join("autostart-offered");
    if flag.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(config);
    let _ = std::fs::write(&flag, "");
    if user_autostart().map(|f| std::fs::symlink_metadata(f).is_err()).unwrap_or(false) {
        if let Err(e) = set_autostart(true) {
            shell::log(format!("Start at Login not turned on: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_installations_entries_are_ours() {
        let ours = autostart_entry(true, "buddi-desktop", "/home/a/.local/share/buddi");
        assert!(owned_entry(&ours, "/home/a/.local/share/buddi"));
        assert!(!owned_entry(&ours, "/tmp/other"));
        let off = autostart_entry(false, "buddi-desktop", "/home/a/.local/share/buddi");
        assert!(owned_entry(&off, "/home/a/.local/share/buddi") && turned_off(&off) && !off.contains(MARK));
        assert!(!owned_entry("[Desktop Entry]\nExec=buddi-desktop --hidden\n", "/home/a/.local/share/buddi"), "the owner's");
        assert!(owned_entry("[Desktop Entry]\nX-Buddi-Linux-Install=true\n", "/x"), "an older marked entry");
    }
}

/// Where the tray's icon files go: the session's runtime folder, not /tmp.
pub fn tray_icon_dir() -> Option<PathBuf> {
    dirs::runtime_dir().map(|d| d.join("buddi-desktop").join("tray"))
}
