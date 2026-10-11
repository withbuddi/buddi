//! What the window shows, and when it changes: the dashboard while the
//! gateway answers, the app's own page ("Starting buddi…", stopped, not
//! installed) otherwise. Follows buddi.app's window (apps/mac/App/
//! MainWindowController.swift): when the gateway goes away the placeholder
//! comes back, and the page reloads on the same route with a fresh link once
//! it answers again.

use std::net::SocketAddr;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url, WebviewWindow};

use crate::buddi::{self, Failure};
use crate::{platform, tray};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    /// Asking for a link; the placeholder says "Starting buddi…".
    Starting,
    /// The command answered without a link, more than once.
    Attention,
    /// Stopped from the tray: nothing restarts it until Start.
    Stopped,
    /// No `buddi` command on this computer.
    Missing,
    /// Check for Updates → Update, or Advanced → the previous version: buddi
    /// restarts on its own; the gateway going away is expected.
    Updating,
    /// The dashboard is in the window.
    Dashboard,
}

pub struct Shell {
    inner: Mutex<Inner>,
}

struct Inner {
    phase: Phase,
    gateway: Option<SocketAddr>,
    /// The route to come back to (`#/chat/…`) after a reconnect.
    route: Option<String>,
    linking: bool,
    linked_at: Option<Instant>,
    /// What the placeholder shows now, so it is not reloaded for nothing.
    shown: Option<(String, String)>,
}

impl Shell {
    pub fn new() -> Self {
        Shell {
            inner: Mutex::new(Inner {
                phase: Phase::Starting,
                gateway: None,
                route: None,
                linking: false,
                linked_at: None,
                shown: None,
            }),
        }
    }
}

fn with<T>(app: &AppHandle, f: impl FnOnce(&mut Inner) -> T) -> T {
    let state = app.state::<Shell>();
    let mut inner = state.inner.lock().unwrap();
    f(&mut inner)
}

pub fn phase(app: &AppHandle) -> Phase {
    with(app, |s| s.phase)
}

pub fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

pub fn log(msg: impl AsRef<str>) {
    eprintln!("[buddi-desktop] {}", msg.as_ref());
}

/// The app's own page, `ui/index.html`, in one of its modes.
pub fn placeholder(app: &AppHandle, mode: &str, detail: &str) {
    let want = (mode.to_string(), detail.to_string());
    let same = with(app, |s| {
        let same = s.shown.as_ref() == Some(&want);
        s.shown = Some(want.clone());
        same
    });
    if same {
        return;
    }
    log(format!("showing the {mode} page"));
    if let Some(w) = main_window(app) {
        remember_route(app, &w);
        let mut url = platform::local_page();
        url.query_pairs_mut().append_pair("mode", mode).append_pair("detail", detail);
        let _ = w.navigate(url);
    }
}

fn remember_route(app: &AppHandle, w: &WebviewWindow) {
    if let Ok(url) = w.url() {
        if buddi::is_dashboard(&url) {
            if let Some(f) = url.fragment().filter(|f| !f.is_empty()) {
                let route = format!("#{f}");
                with(app, |s| s.route = Some(route));
            }
        }
    }
}

pub fn set_phase(app: &AppHandle, phase: Phase) {
    with(app, |s| s.phase = phase);
    tray::refresh(app);
}

/// Get a fresh sign-in link and load it, on the remembered route. Retries
/// quietly while buddi starts; says why when it keeps failing. `quiet` keeps
/// the dashboard on screen meanwhile (an expired session); `patient` first
/// waits for a gateway that went away by itself to come back.
pub fn connect(app: &AppHandle, quiet: bool, patient: bool) {
    let busy = with(app, |s| {
        if s.linking {
            return true;
        }
        s.linking = true;
        if s.phase != Phase::Dashboard || !quiet {
            s.phase = Phase::Starting;
        }
        false
    });
    if busy {
        return;
    }
    if !quiet {
        placeholder(app, "starting", "");
    }
    tray::refresh(app);
    let app = app.clone();
    thread::spawn(move || {
        let mut failures = 0u32;
        let mut patient = patient;
        loop {
            if phase(&app) == Phase::Stopped {
                break;
            }
            // A gateway that went away (a restart, an update) usually comes back by
            // itself: wait for its port before asking the command, which would start it.
            let gateway = with(&app, |s| s.gateway).filter(|_| patient);
            patient = false;
            if let Some(addr) = gateway {
                let since = Instant::now();
                while !buddi::answers(addr) && since.elapsed() < Duration::from_secs(45) {
                    if phase(&app) == Phase::Stopped {
                        break;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            }
            if phase(&app) == Phase::Stopped {
                break;
            }
            match buddi::dashboard_link() {
                Ok(link) => {
                    let route = with(&app, |s| {
                        s.gateway = buddi::gateway_addr(&link);
                        s.linked_at = Some(Instant::now());
                        s.shown = None;
                        s.phase = Phase::Dashboard;
                        s.route.take()
                    });
                    let mut link = link;
                    if let Some(r) = route {
                        link.set_fragment(Some(r.trim_start_matches('#')));
                    }
                    log(format!("dashboard at {}{}", link.origin().ascii_serialization(), link.fragment().map(|f| format!(" #{f}")).unwrap_or_default()));
                    if let Some(w) = main_window(&app) {
                        let _ = w.navigate(link);
                    }
                    tray::refresh(&app);
                    break;
                }
                Err(Failure::Missing) => {
                    set_phase(&app, Phase::Missing);
                    placeholder(&app, "missing", buddi::INSTALL_LINE);
                    thread::sleep(Duration::from_secs(10));
                }
                Err(Failure::NoLink(why)) => {
                    failures += 1;
                    log(format!("no dashboard link: {why}"));
                    if failures >= 2 {
                        set_phase(&app, Phase::Attention);
                        placeholder(&app, "attention", &why);
                    } else {
                        set_phase(&app, Phase::Starting);
                        placeholder(&app, "starting", "");
                    }
                    thread::sleep(Duration::from_secs(5));
                }
            }
        }
        with(&app, |s| s.linking = false);
    });
}

/// Watches the gateway's port while the dashboard is up: when it stops
/// answering, the placeholder comes back and a reconnect starts.
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let mut misses = 0;
        let mut ticks: u32 = 0;
        let mut was_up = false;
        loop {
            thread::sleep(Duration::from_secs(2));
            ticks = ticks.wrapping_add(1);
            let (phase, gateway) = with(&app, |s| (s.phase, s.gateway));
            let up = gateway.map(buddi::answers).unwrap_or(false);
            tray::set_running(&app, up, phase);
            // "Update to …" and the previous version for the menu: the
            // supervisor's cached answer, when buddi comes up and every five minutes.
            if up && (!was_up || ticks % 150 == 0) {
                let update = crate::supervisor::version().and_then(|v| v.latest.filter(|_| v.update_available));
                tray::set_update(&app, update);
            }
            was_up = up;
            if phase != Phase::Dashboard {
                misses = 0;
                continue;
            }
            misses = if up { 0 } else { misses + 1 };
            if misses >= 2 {
                misses = 0;
                log("the gateway stopped answering; waiting for it");
                connect(&app, false, true);
            }
        }
    });
}

/// The window came forward (tray, second launch): a dashboard whose session
/// lapsed while it was hidden gets a fresh link (the page's 401 says so, see
/// `session_expired`); a placeholder that gave up tries again.
pub fn reopened(app: &AppHandle) {
    match phase(app) {
        Phase::Dashboard => {
            if let Some(w) = main_window(app) {
                let _ = w.eval("fetch('/api/session', { credentials: 'same-origin' }).catch(() => {})");
            }
        }
        Phase::Attention | Phase::Missing => connect(app, false, false),
        Phase::Starting | Phase::Stopped | Phase::Updating => {}
    }
}

/// The dashboard got a 401 from its own API: the session expired. A fresh
/// link, on the same route, without the placeholder in between.
pub fn session_expired(app: &AppHandle) {
    let recent = with(app, |s| {
        s.phase != Phase::Dashboard || s.linked_at.map(|t| t.elapsed() < Duration::from_secs(20)).unwrap_or(false)
    });
    if recent {
        return;
    }
    log("the session expired; signing in again");
    if let Some(w) = main_window(app) {
        remember_route(app, &w);
    }
    connect(app, true, false);
}

pub fn start(app: &AppHandle) {
    set_phase(app, Phase::Starting);
    connect(app, false, false);
}

pub fn stop(app: &AppHandle) {
    set_phase(app, Phase::Stopped);
    placeholder(app, "stopped", "");
    let app = app.clone();
    thread::spawn(move || match buddi::service("stop") {
        Ok(_) => platform::notify(&app, "buddi is stopped", "Start it again from the buddi icon in the top bar."),
        Err(Failure::Missing) => connect(&app, false, false),
        Err(Failure::NoLink(why)) => {
            log(format!("buddi service stop: {why}"));
            platform::notify(&app, "buddi did not stop", &why);
        }
    });
}

/// Goes to a dashboard route (`#/settings`), now or once the dashboard is loaded.
pub fn go(app: &AppHandle, route: &str) {
    if phase(app) == Phase::Dashboard {
        if let Some(w) = main_window(app) {
            let _ = w.eval(&format!("location.hash = {}", serde_json::to_string(route).unwrap()));
        }
    } else {
        let route = route.to_string();
        with(app, |s| s.route = Some(route));
    }
}

/// Runs JavaScript in the dashboard once it is loaded (within a minute).
pub fn when_dashboard(app: &AppHandle, js: String) {
    let app = app.clone();
    thread::spawn(move || {
        for _ in 0..120 {
            if phase(&app) == Phase::Dashboard {
                // A fresh load needs a moment before its shortcuts are listening.
                thread::sleep(Duration::from_millis(800));
                if let Some(w) = main_window(&app) {
                    let _ = w.eval(&js);
                }
                return;
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

pub fn is_local_page(url: &Url) -> bool {
    let local = platform::local_page();
    url.scheme() == local.scheme() && url.host_str() == local.host_str()
}
