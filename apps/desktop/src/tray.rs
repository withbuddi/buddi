//! The tray icon (the top bar's indicator on Linux, the notification area on
//! Windows). Linux has no menu bar, so its menu is buddi.app's menu-bar glyph
//! menu and app menu in one, in the Mac's words and order
//! (apps/mac/MenuBar/StatusItemController.swift, App/MainMenu.swift):
//!
//!   Running since 11:19
//!   Open buddi · New Conversation · Settings…
//!   Update to <v> (when there is one) · Check for Updates…
//!   Restart buddi · Stop buddi / Start buddi · Lock buddi · Start at Login
//!   Advanced ▸ Open in Browser · Show Logs · Restart with the Previous Version…
//!   Help ▸ buddi Help · Report a Problem…
//!   About buddi · Uninstall buddi… · Quit

use std::sync::Mutex;
use std::time::SystemTime;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

use crate::shell::{self, Phase};
use crate::{actions, platform, supervisor};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Glyph {
    Running,
    Starting,
    Attention,
}

fn glyph_png(glyph: Glyph, dark_ink: bool) -> &'static [u8] {
    match (glyph, dark_ink) {
        (Glyph::Running, false) => include_bytes!("../icons/tray/running-light.png"),
        (Glyph::Starting, false) => include_bytes!("../icons/tray/starting-light.png"),
        (Glyph::Attention, false) => include_bytes!("../icons/tray/attention-light.png"),
        (Glyph::Running, true) => include_bytes!("../icons/tray/running-dark.png"),
        (Glyph::Starting, true) => include_bytes!("../icons/tray/starting-dark.png"),
        (Glyph::Attention, true) => include_bytes!("../icons/tray/attention-dark.png"),
    }
}

/// The items whose words or state change.
struct Items {
    status: MenuItem<Wry>,
    start_stop: MenuItem<Wry>,
    restart: MenuItem<Wry>,
    lock: MenuItem<Wry>,
    login: CheckMenuItem<Wry>,
    browser: MenuItem<Wry>,
}

struct State {
    up: bool,
    since: Option<SystemTime>,
    /// The newer version the supervisor knows of: "Update to …".
    update: Option<String>,
    /// The version `releases/previous` holds: "Restart with the Previous Version (…)…".
    previous: Option<String>,
    shown: Option<(String, Glyph, bool)>,
}

pub struct Tray {
    icon: TrayIcon<Wry>,
    items: Mutex<Items>,
    state: Mutex<State>,
    dark_ink: bool,
}

/// FNV-1a: a stable name for an icon's pixels.
fn fnv(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c9dc5u32, |h, b| (h ^ *b as u32).wrapping_mul(0x01000193))
}

fn menu(app: &AppHandle, update: Option<&str>, previous: Option<&str>) -> tauri::Result<(Menu<Wry>, Items)> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let sep = || PredefinedMenuItem::separator(app);
    let items = Items {
        status: MenuItem::with_id(app, "status", "Starting…", false, None::<&str>)?,
        start_stop: item("start-stop", "Stop buddi")?,
        restart: item("restart", "Restart buddi")?,
        lock: item("lock", "Lock buddi")?,
        login: CheckMenuItem::with_id(app, "login", "Start at Login", true, platform::autostart_enabled(), None::<&str>)?,
        browser: item("browser", "Open in Browser")?,
    };
    let previous_text = match previous {
        Some(v) => format!("Restart with the Previous Version ({v})…"),
        None => "Restart with the Previous Version…".into(),
    };
    let previous_item = MenuItem::with_id(app, "previous", previous_text, previous.is_some(), None::<&str>)?;
    let logs = item("logs", "Show Logs")?;
    let advanced = Submenu::with_items(app, "Advanced", true, &[&items.browser, &logs, &sep()?, &previous_item])?;
    let help = Submenu::with_items(app, "Help", true, &[&item("help", "buddi Help")?, &item("report", "Report a Problem…")?])?;
    let open = item("open", "Open buddi")?;
    let new_conversation = item("new-conversation", "New Conversation")?;
    let settings = item("settings", "Settings…")?;
    let check = item("check", "Check for Updates…")?;
    let about = item("about", "About buddi")?;
    let uninstall = item("uninstall", "Uninstall buddi…")?;
    // Not "Quit buddi": buddi keeps running in its service; this closes the app.
    let quit = item("quit", "Quit")?;
    let update_item = match update {
        Some(v) => Some(item("update", &format!("Update to {v}"))?),
        None => None,
    };
    let menu = Menu::new(app)?;
    menu.append_items(&[&items.status, &sep()?, &open, &new_conversation, &settings, &sep()?])?;
    if let Some(u) = &update_item {
        menu.append(u)?;
    }
    menu.append_items(&[
        &check,
        &sep()?,
        &items.restart,
        &items.start_stop,
        &items.lock,
        &items.login,
        &advanced,
        &help,
        &sep()?,
        &about,
        &uninstall,
        &quit,
    ])?;
    Ok((menu, items))
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let (menu, items) = menu(app, None, None)?;
    let dark_ink = platform::tray_wants_dark_ink();
    let first = glyph_png(Glyph::Starting, dark_ink);
    // The indicator gets the icon as a file; GNOME's AppIndicator extension
    // caches pictures by file name, so the name carries the pixels' hash: a new
    // glyph is a new name, never a stale picture (set_icon numbers its files).
    let mut builder = TrayIconBuilder::with_id(format!("buddi-{:08x}", fnv(first)))
        .icon(Image::from_bytes(first)?)
        .tooltip("buddi")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => platform::show_main(app),
            "new-conversation" => actions::new_conversation(app),
            "settings" => actions::settings(app),
            "update" => actions::update_from_menu(app),
            "check" => actions::check_for_updates(app),
            "restart" => actions::restart(app),
            "start-stop" => {
                if matches!(shell::phase(app), Phase::Stopped | Phase::Attention) {
                    shell::start(app)
                } else {
                    shell::stop(app)
                }
            }
            "lock" => {
                platform::show_main(app);
                actions::lock(app)
            }
            "login" => actions::start_at_login(app),
            "browser" => actions::open_in_browser(app),
            "logs" => actions::show_logs(),
            "previous" => actions::restart_with_previous(app),
            "help" => {
                let _ = open::that_detached(actions::DOCS);
            }
            "report" => {
                let _ = open::that_detached(actions::REPORT_PROBLEM);
            }
            "about" => actions::about(app),
            "uninstall" => actions::uninstall(app),
            "quit" => actions::quit(app),
            _ => {}
        });
    if let Some(dir) = platform::tray_icon_dir() {
        builder = builder.temp_dir_path(dir);
    }
    let icon = builder.build(app)?;
    app.manage(Tray {
        icon,
        items: Mutex::new(items),
        state: Mutex::new(State { up: false, since: None, update: None, previous: None, shown: None }),
        dark_ink,
    });
    Ok(())
}

/// The newer version, when the supervisor knows of one; the menu is rebuilt
/// when "Update to …" comes or goes (a tray menu item cannot hide).
pub fn set_update(app: &AppHandle, update: Option<String>) {
    let previous = supervisor::previous_release().map(|(_, v)| v);
    let Some(tray) = app.try_state::<Tray>() else { return };
    {
        let mut st = tray.state.lock().unwrap();
        if st.update == update && st.previous == previous {
            return;
        }
        st.update = update.clone();
        st.previous = previous.clone();
        st.shown = None;
    }
    if let Ok((menu, items)) = menu(app, update.as_deref(), previous.as_deref()) {
        let _ = tray.icon.set_menu(Some(menu));
        *tray.items.lock().unwrap() = items;
    }
    refresh(app);
}

fn since_text(since: SystemTime) -> String {
    platform::clock_text(since)
}

/// The monitor's reading: is the gateway answering, and what the window shows.
pub fn set_running(app: &AppHandle, up: bool, phase: Phase) {
    let Some(tray) = app.try_state::<Tray>() else { return };
    let mut st = tray.state.lock().unwrap();
    if up && !st.up {
        st.since = Some(SystemTime::now());
    }
    if !up {
        st.since = None;
    }
    st.up = up;
    let running = up && phase == Phase::Dashboard;
    let (text, glyph) = match phase {
        Phase::Missing => ("buddi is not installed".to_string(), Glyph::Attention),
        Phase::Stopped => ((if up { "Stopping…" } else { "Stopped" }).into(), Glyph::Starting),
        Phase::Updating => ("Updating…".into(), Glyph::Starting),
        Phase::Attention => ("Needs attention".into(), Glyph::Attention),
        Phase::Dashboard if up => (
            st.since.map(|s| format!("Running since {}", since_text(s))).unwrap_or_else(|| "Running".into()),
            Glyph::Running,
        ),
        Phase::Starting | Phase::Dashboard => ("Starting…".into(), Glyph::Starting),
    };
    let key = (text.clone(), glyph, running);
    if st.shown.as_ref() == Some(&key) {
        return;
    }
    let glyph_changed = st.shown.as_ref().map(|k| k.1) != Some(glyph);
    st.shown = Some(key);
    drop(st);
    let items = tray.items.lock().unwrap();
    let _ = items.status.set_text(&text);
    let stopped = matches!(phase, Phase::Stopped | Phase::Attention);
    let _ = items.start_stop.set_text(if stopped { "Start buddi" } else { "Stop buddi" });
    let _ = items.start_stop.set_enabled(stopped || running);
    let _ = items.restart.set_enabled(running);
    let _ = items.lock.set_enabled(running);
    let _ = items.browser.set_enabled(running);
    let _ = items.login.set_checked(platform::autostart_enabled());
    drop(items);
    if glyph_changed {
        if let Ok(image) = Image::from_bytes(glyph_png(glyph, tray.dark_ink)) {
            let _ = tray.icon.set_icon(Some(image));
        }
    }
    let _ = tray.icon.set_tooltip(Some(format!("buddi: {text}")));
}

/// Re-read after a phase change, with the last known gateway state.
pub fn refresh(app: &AppHandle) {
    let up = match app.try_state::<Tray>() {
        Some(t) => {
            let mut st = t.state.lock().unwrap();
            st.shown = None;
            st.up
        }
        None => return,
    };
    set_running(app, up, shell::phase(app));
}
