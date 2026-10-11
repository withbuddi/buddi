//! The tray icon (the top bar's indicator on Linux, the notification area on
//! Windows): buddi's glyph per state, and Open, Open in Browser, Start, Stop,
//! Quit.

use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, Wry};

use crate::shell::{self, Phase};
use crate::{buddi, platform};

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

pub struct Tray {
    icon: TrayIcon<Wry>,
    status: MenuItem<Wry>,
    start: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    dark_ink: bool,
    last: Mutex<Option<(String, bool, bool, u8)>>,
    up: Mutex<bool>,
}

/// FNV-1a: a stable name for an icon's pixels.
fn fnv(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c9dc5u32, |h, b| (h ^ *b as u32).wrapping_mul(0x01000193))
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Starting buddi…", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open buddi", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, "browser", "Open in Browser", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Start buddi", false, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop buddi", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &browser,
            &PredefinedMenuItem::separator(app)?,
            &start,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let dark_ink = platform::tray_wants_dark_ink();
    let first = glyph_png(Glyph::Starting, dark_ink);
    // The indicator gets the icon as a file; GNOME's AppIndicator extension
    // caches pixels by file name, so the name carries the pixels' hash: a new
    // glyph is a new name, never a stale picture (set_icon numbers its files).
    let mut builder = TrayIconBuilder::with_id(format!("buddi-{:08x}", fnv(first)))
        .icon(Image::from_bytes(first)?)
        .tooltip("buddi")
        .title("buddi")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => platform::show_main(app),
            "browser" => {
                let app = app.clone();
                std::thread::spawn(move || {
                    if let Err(buddi::Failure::NoLink(why)) = buddi::open_in_browser() {
                        platform::notify(&app, "buddi did not open the browser", &why);
                    }
                });
            }
            "start" => shell::start(app),
            "stop" => shell::stop(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(dir) = platform::tray_icon_dir() {
        builder = builder.temp_dir_path(dir);
    }
    let icon = builder.build(app)?;
    app.manage(Tray { icon, status, start, stop, dark_ink, last: Mutex::new(None), up: Mutex::new(false) });
    Ok(())
}

/// The monitor's reading: is the gateway answering, and what the window shows.
pub fn set_running(app: &AppHandle, up: bool, phase: Phase) {
    let Some(tray) = app.try_state::<Tray>() else { return };
    *tray.up.lock().unwrap() = up;
    let (text, glyph, start, stop) = match (phase, up) {
        (Phase::Missing, _) => ("buddi is not installed", Glyph::Attention, false, false),
        (Phase::Stopped, false) => ("buddi is stopped", Glyph::Starting, true, false),
        (Phase::Stopped, true) => ("Stopping buddi…", Glyph::Starting, false, false),
        (Phase::Attention, _) => ("buddi needs attention", Glyph::Attention, true, up),
        (Phase::Dashboard, true) => ("buddi is running", Glyph::Running, false, true),
        (Phase::Starting, _) | (Phase::Dashboard, false) => ("Starting buddi…", Glyph::Starting, false, up),
    };
    let key = (text.to_string(), start, stop, glyph as u8);
    let mut last = tray.last.lock().unwrap();
    if last.as_ref() == Some(&key) {
        return;
    }
    let glyph_changed = last.as_ref().map(|l| l.3) != Some(glyph as u8);
    *last = Some(key);
    let _ = tray.status.set_text(text);
    let _ = tray.start.set_enabled(start);
    let _ = tray.stop.set_enabled(stop);
    if glyph_changed {
        if let Ok(image) = Image::from_bytes(glyph_png(glyph, tray.dark_ink)) {
            let _ = tray.icon.set_icon(Some(image));
        }
    }
    let _ = tray.icon.set_tooltip(Some(text));
}

/// Re-read after a phase change, with the last known gateway state.
pub fn refresh(app: &AppHandle) {
    let up = app.try_state::<Tray>().map(|t| *t.up.lock().unwrap()).unwrap_or(false);
    set_running(app, up, shell::phase(app));
}
