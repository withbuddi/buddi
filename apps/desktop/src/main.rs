//! buddi's desktop app (Linux today; README.md for Windows).
//!
//! A window and a tray icon around the buddi already installed on this
//! computer (scripts/install.sh): it asks the `buddi` command for the same
//! five-minute sign-in link a terminal gets and loads it. It never runs a
//! buddi of its own, so quitting it leaves buddi running.
//!
//!   buddi-desktop                      open the window (a second launch brings it forward)
//!   buddi-desktop --hidden             start in the tray only (the autostart entry)
//!   buddi-desktop --new-conversation   the launcher's right-click actions, as the
//!                 --check-updates      tray menu has them (actions.rs)
//!                 --lock
//!                 --settings
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod actions;
mod buddi;
mod platform;
mod shell;
mod supervisor;
mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

fn debug() -> bool {
    std::env::var("BUDDI_SHELL_DEBUG").as_deref() == Ok("1")
}

/// Runs in the dashboard (and only there). A 401 from its own API means the
/// session expired, and the app fetches a fresh link. `window.Notification`
/// is a bridge to desktop notifications, granted (as buddi.app's is): WebKitGTK
/// would only ask inside a click, and names them after the web process. With
/// BUDDI_SHELL_DEBUG=1 the page's console errors go to the app's stderr too.
fn init_script() -> String {
    let mut js = String::from(
        r#"(function () {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(location.href)) return;
  const invoke = (cmd, args) => { try { return window.__TAURI_INTERNALS__.invoke(cmd, args || {}).catch(() => {}); } catch (_) {} };
  const fetch0 = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await fetch0(...args);
    try {
      if (res.status === 401) {
        const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
        if (url.origin === location.origin && url.pathname.startsWith('/api/')) invoke('session_expired');
      }
    } catch (_) {}
    return res;
  };
  // window.open('') (the dashboard's sign-in tabs, opened inside the click and
  // pointed at the page after) reaches the app as about:blank; an empty URL
  // never does under WebKitGTK.
  const open0 = window.open.bind(window);
  window.open = (url, ...rest) => open0(url === undefined || url === '' ? 'about:blank' : url, ...rest);
  class Notification extends EventTarget {
    constructor(title, options) {
      super();
      this.title = String(title); this.body = String((options && options.body) || ''); this.tag = (options && options.tag) || '';
      this.onclick = null; this.onclose = null; this.onerror = null; this.onshow = null;
      invoke('notify', { title: this.title, body: this.body });
      setTimeout(() => { const e = new Event('show'); this.dispatchEvent(e); if (this.onshow) this.onshow(e); });
    }
    close() {}
    static get permission() { return 'granted'; }
    static requestPermission(callback) { if (callback) callback('granted'); return Promise.resolve('granted'); }
  }
  Object.defineProperty(window, 'Notification', { value: Notification, configurable: true, writable: true });
"#,
    );
    if debug() {
        js.push_str(
            r#"  const fmt = (a) => { try { return typeof a === 'string' ? a : (a instanceof Error ? (a.stack || String(a)) : JSON.stringify(a)); } catch (_) { return String(a); } };
  const send = (level, args) => invoke('shell_log', { level, msg: args.map(fmt).join(' ') });
  for (const level of ['error', 'warn']) { const o = console[level].bind(console); console[level] = (...a) => { send(level, a); o(...a); }; }
  addEventListener('error', (e) => send('error', [e.message + ' @ ' + e.filename + ':' + e.lineno]));
  addEventListener('unhandledrejection', (e) => send('error', ['unhandledrejection', fmt(e.reason)]));
  window.__shellLog = (...a) => send('probe', a);
"#,
        );
    }
    js.push_str("})();\n");
    js
}

#[tauri::command]
fn retry(app: AppHandle) {
    shell::connect(&app, false, false);
}

#[tauri::command]
fn start_buddi(app: AppHandle) {
    shell::start(&app);
}

#[tauri::command]
fn session_expired(app: AppHandle) {
    shell::session_expired(&app);
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    platform::notify(&app, &title, &body);
}

#[tauri::command]
fn shell_log(level: String, msg: String) {
    if debug() {
        eprintln!("[page:{level}] {msg}");
    }
}

fn downloads_path(name: &str) -> PathBuf {
    let dir = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Downloads")))
        .unwrap_or_else(std::env::temp_dir);
    let _ = std::fs::create_dir_all(&dir);
    let name = name.replace(['/', '\\'], "_");
    let first = dir.join(&name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    // A second copy is "name 2.ext", as on the Mac.
    (2..).map(|n| dir.join(format!("{stem} {n}{ext}"))).find(|p| !p.exists()).unwrap()
}

static POPUPS: AtomicU32 = AtomicU32::new(0);

/// The window the dashboard opens with `window.open('', '_blank')` inside a
/// click (so no popup blocker stops it) and then points at a sign-in page:
/// never shown; whatever it is sent to opens in the default browser.
fn popup(app: &AppHandle, features: tauri::webview::NewWindowFeatures) -> NewWindowResponse<tauri::Wry> {
    let label = format!("popup-{}", POPUPS.fetch_add(1, Ordering::Relaxed));
    let closer = app.clone();
    let name = label.clone();
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(Url::parse("about:blank").unwrap()))
        .window_features(features)
        .visible(false)
        .on_navigation(move |url| {
            if url.scheme() == "about" {
                return true;
            }
            platform::open_external(url);
            let (app, name) = (closer.clone(), name.clone());
            std::thread::spawn(move || {
                if let Some(w) = app.get_webview_window(&name) {
                    let _ = w.destroy();
                }
            });
            false
        })
        .build();
    match built {
        Ok(window) => NewWindowResponse::Create { window },
        Err(e) => {
            shell::log(format!("popup refused: {e}"));
            NewWindowResponse::Deny
        }
    }
}

fn build_window(app: &AppHandle, hidden: bool) -> tauri::Result<()> {
    let notify_app = app.clone();
    let popup_app = app.clone();
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("buddi")
        .inner_size(1180.0, 820.0)
        // One pixel above the dashboard's phone breakpoint: always the desktop layout.
        .min_inner_size(721.0, 560.0)
        .visible(!hidden)
        .initialization_script(&init_script())
        .on_navigation(|url| {
            // The dashboard and the app's own page stay; everything else is the browser's.
            let stay = buddi::is_dashboard(url)
                || shell::is_local_page(url)
                || matches!(url.scheme(), "about" | "blob" | "data");
            if !stay {
                platform::open_external(url);
            }
            stay
        })
        .on_new_window(move |url, features| {
            if url.scheme() == "about" {
                return popup(&popup_app, features);
            }
            // A link with target=_blank, the dashboard's own pages included: the
            // browser (a fresh tab there signs in with `buddi dashboard`).
            platform::open_external(&url);
            NewWindowResponse::Deny
        })
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    let name = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .filter(|n| !n.is_empty())
                        .or_else(|| url.path_segments().and_then(|mut s| s.next_back()).map(String::from))
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| "download".into());
                    *destination = downloads_path(&name);
                }
                DownloadEvent::Finished { path, success, .. } => {
                    match (path, success) {
                        (Some(p), true) => {
                            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                            platform::notify(&notify_app, "Downloaded", &format!("{name} is in your Downloads folder."));
                        }
                        _ => platform::notify(&notify_app, "The download failed", "Try again from the dashboard."),
                    }
                }
                _ => {}
            }
            true
        })
        .build()?;
    platform::tune_webview(&window);
    Ok(())
}

/// A second launch: its arguments, in the first instance.
fn second_launch(app: &AppHandle, argv: Vec<String>) {
    let mut args = argv.iter().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            // Diagnostics only: `BUDDI_SHELL_DEBUG=1 buddi-desktop` first, then
            // `buddi-desktop --eval '<js>'` runs JavaScript in its window.
            "--eval" if debug() => {
                if let (Some(js), Some(w)) = (args.next(), shell::main_window(app)) {
                    let _ = w.eval(js);
                }
                return;
            }
            "--hidden" => return,
            _ => {}
        }
    }
    let rest: Vec<String> = argv.into_iter().skip(1).collect();
    if !actions::run_args(app, &rest) {
        platform::show_main(app);
    }
}

fn main() {
    let hidden = std::env::args().any(|a| a == "--hidden");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| second_launch(app, argv)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Size, position and maximized are remembered; whether it shows is the app's call.
                .with_state_flags(StateFlags::all() - StateFlags::VISIBLE)
                .build(),
        )
        .manage(shell::Shell::new())
        .invoke_handler(tauri::generate_handler![retry, start_buddi, session_expired, notify, shell_log])
        .setup(move |app| {
            let handle = app.handle().clone();
            build_window(&handle, hidden)?;
            tray::build(&handle)?;
            shell::connect(&handle, false, false);
            shell::watch(&handle);
            let args: Vec<String> = std::env::args().skip(1).collect();
            actions::run_args(&handle, &args);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it; buddi and the tray stay.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.app_handle().save_window_state(StateFlags::all() - StateFlags::VISIBLE);
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("buddi-desktop failed to start")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = event {
                // The last window hidden is not a reason to quit; Quit in the tray is.
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
