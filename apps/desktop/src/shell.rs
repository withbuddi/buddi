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
    /// The owner confirmed "Remove buddi" in the dashboard: nothing reconnects
    /// (`buddi --no-open` would start buddi again under the removal).
    Removing,
    /// buddi is gone (the Windows setup's uninstaller said so with
    /// `--removed`, or the command went): a last page until the owner closes it.
    Removed,
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
    removing_since: Option<Instant>,
    removal_went_down: bool,
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
                removing_since: None,
                removal_went_down: false,
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
    // A windowed program has no stderr anyone reads: a file too.
    #[cfg(windows)]
    platform::log_line(msg.as_ref());
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

/// Tries before a reconnect stops asking until Try Again, Start or a reopen.
const GIVE_UP_AFTER: u32 = 8;

/// 5 s, 10 s, 20 s, 40 s, then a minute between tries.
fn backoff(failures: u32) -> Duration {
    Duration::from_secs((5u64 << failures.saturating_sub(1).min(4)).min(60))
}

/// Get a fresh sign-in link and load it, on the remembered route. Retries
/// quietly while buddi starts; says why when it keeps failing. `quiet` keeps
/// the dashboard on screen meanwhile (an expired session); `patient` first
/// waits for a gateway that went away by itself to come back.
pub fn connect(app: &AppHandle, quiet: bool, patient: bool) {
    let busy = with(app, |s| {
        // Under a removal nothing reconnects: `buddi --no-open` would set buddi up again.
        if s.linking || matches!(s.phase, Phase::Removing | Phase::Removed) {
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
            if halted(&app) {
                break;
            }
            // A gateway that went away (a restart, an update) usually comes back by
            // itself: wait for its port before asking the command, which would start it.
            let gateway = with(&app, |s| s.gateway).filter(|_| patient);
            patient = false;
            if let Some(addr) = gateway {
                let since = Instant::now();
                while !buddi::answers(addr) && since.elapsed() < Duration::from_secs(45) {
                    if halted(&app) {
                        break;
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            }
            if halted(&app) {
                break;
            }
            // buddi was here (a dashboard was shown) and its installation is gone: it
            // was removed (`buddi uninstall` from a terminal, say). Asking the command
            // now would set up a new buddi under the removal.
            if gateway_seen(&app) && !installation_present() {
                removed(&app);
                break;
            }
            let answer = buddi::dashboard_link();
            // Stop pressed while the command was answering: the link is not loaded.
            if halted(&app) {
                break;
            }
            match answer {
                Ok(link) => {
                    crate::policy::set_dashboard(&link);
                    let route = with(&app, |s| {
                        // A removal began while the command answered: the link is not loaded.
                        if matches!(s.phase, Phase::Removing | Phase::Removed | Phase::Stopped) {
                            return Err(());
                        }
                        s.gateway = buddi::gateway_addr(&link);
                        s.linked_at = Some(Instant::now());
                        s.shown = None;
                        s.phase = Phase::Dashboard;
                        Ok(s.route.take())
                    });
                    let Ok(route) = route else { break };
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
                    failures += 1;
                    set_phase(&app, Phase::Missing);
                    placeholder(&app, "missing", buddi::INSTALL_LINE);
                    if failures >= GIVE_UP_AFTER {
                        log("still no buddi command; looking again when the window is reopened");
                        break;
                    }
                    thread::sleep(backoff(failures));
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
                    if failures >= GIVE_UP_AFTER {
                        log("giving up until Try Again, Start buddi or the window is reopened");
                        break;
                    }
                    thread::sleep(backoff(failures));
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
            if up && (!was_up || ticks.is_multiple_of(150)) {
                let update = crate::supervisor::version().and_then(|v| v.latest.filter(|_| v.update_available));
                tray::set_update(&app, update);
            }
            was_up = up;
            if phase == Phase::Removing {
                removal_tick(&app, up);
                continue;
            }
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

fn gateway_seen(app: &AppHandle) -> bool {
    with(app, |s| s.gateway.is_some())
}

/// The installation's own record (`installation.json`), there while buddi is
/// installed; judged only for a command that names its data folder (the
/// installs), never by a guess.
fn installation_present() -> bool {
    buddi::named_data_dir().map(|d| d.join("installation.json").is_file()).unwrap_or(true)
}

/// Stop asking for links: stopped, or buddi is being (or was) removed.
fn halted(app: &AppHandle) -> bool {
    matches!(phase(app), Phase::Stopped | Phase::Removing | Phase::Removed)
}

/// Where the last backup of a removal is (product-uninstall.ts: `~/buddi-backups`).
fn backups_dir() -> String {
    dirs::home_dir().map(|h| h.join("buddi-backups").display().to_string()).unwrap_or_default()
}

/// The dashboard's "Remove buddi" was confirmed (its `removing` call): the app
/// stops reconnecting and follows the removal.
pub fn removing(app: &AppHandle) {
    if matches!(phase(app), Phase::Removing | Phase::Removed) {
        return;
    }
    log("buddi is being removed; not reconnecting");
    with(app, |s| {
        s.removing_since = Some(Instant::now());
        s.removal_went_down = false;
    });
    set_phase(app, Phase::Removing);
}

/// While buddi is removed: the "Removing buddi…" page once the dashboard goes;
/// the last page once the command is gone (Linux; on Windows the setup's
/// uninstaller says `--removed`). A removal that never happens (it failed, and
/// the dashboard says why) gives the window back after five minutes.
fn removal_tick(app: &AppHandle, up: bool) {
    let (since, seen_down) = with(app, |s| {
        if !up {
            s.removal_went_down = true;
        }
        (s.removing_since.map(|t| t.elapsed()).unwrap_or_default(), s.removal_went_down)
    });
    if !up {
        placeholder(app, "removing", &backups_dir());
    }
    if buddi::command().is_none() || (seen_down && !installation_present()) {
        removed(app);
        return;
    }
    if !seen_down && since > Duration::from_secs(120) {
        // The dashboard never went away: the removal did not begin (it says why).
        log("the removal did not begin; the dashboard stays");
        set_phase(app, Phase::Dashboard);
        return;
    }
    // Down, then back up, with buddi still installed: the removal stopped
    // (it puts the service back when it cannot finish). The uninstall's own
    // deadline is half an hour.
    if seen_down && (up || since > Duration::from_secs(30 * 60)) {
        log("buddi is still installed after its removal stopped; back to it");
        set_phase(app, Phase::Starting);
        connect(app, false, false);
    }
}

/// buddi is removed: the last page, with where the backup and its passphrase
/// are, until the owner closes the window (which then quits the app).
pub fn removed(app: &AppHandle) {
    set_phase(app, Phase::Removed);
    with(app, |s| s.shown = None);
    placeholder(app, "removed", &backups_dir());
    platform::show_main(app);
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
        Phase::Starting | Phase::Stopped | Phase::Updating | Phase::Removing | Phase::Removed => {}
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
    placeholder(app, "stopped", platform::TRAY_PLACE);
    let app = app.clone();
    thread::spawn(move || match buddi::service("stop") {
        Ok(_) => platform::notify(&app, "buddi is stopped", &format!("Start it again from the buddi icon in {}.", platform::TRAY_PLACE)),
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
            let _ = w.eval(format!("location.hash = {}", serde_json::to_string(route).unwrap()));
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

/// The main window left for a page it may not show: back to the dashboard
/// (its root; the session cookie still signs in), or the app's own page.
pub fn back_to_dashboard(app: &AppHandle) {
    let target = crate::policy::dashboard_origin().filter(|_| phase(app) == Phase::Dashboard);
    if let (Some(origin), Some(w)) = (target, main_window(app)) {
        if let Ok(url) = Url::parse(&format!("{origin}/")) {
            let _ = w.navigate(url);
        }
    } else {
        with(app, |s| s.shown = None);
        let (mode, detail) = match phase(app) {
            Phase::Stopped => ("stopped", platform::TRAY_PLACE.to_string()),
            Phase::Missing => ("missing", buddi::INSTALL_LINE.to_string()),
            _ => ("starting", String::new()),
        };
        placeholder(app, mode, &detail);
    }
}

/// What the main window may show as its page: the dashboard (its exact
/// origin), the app's own page, and the browser's own empty or local kinds.
pub fn may_show(url: &Url) -> bool {
    crate::policy::is_dashboard(url) || is_local_page(url) || matches!(url.scheme(), "about" | "blob" | "data")
}

pub fn is_local_page(url: &Url) -> bool {
    let local = platform::local_page();
    url.scheme() == local.scheme() && url.host_str() == local.host_str()
}
