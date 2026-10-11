//! What the menu items do: the tray menu (Linux has no menu bar, so it is
//! buddi.app's app menu and menu-bar glyph menu in one), the launcher's
//! right-click actions (`--new-conversation`, `--check-updates`, `--lock`,
//! `--settings`) and a second launch. Wording follows apps/mac
//! (MenuBar/StatusItemController.swift, App/AppDelegate.swift).

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::buddi::{self, Failure};
use crate::shell::{self, Phase};
use crate::{platform, supervisor, tray};

pub const DOCS: &str = "https://withbuddi.com/docs/";
pub const REPORT_PROBLEM: &str = "https://github.com/withbuddi/buddi/issues/new";

fn info(app: &AppHandle, title: &str, text: &str) {
    app.dialog().message(text).title(title).kind(MessageDialogKind::Info).blocking_show();
}

fn ask(app: &AppHandle, title: &str, text: &str, yes: &str, no: &str) -> bool {
    app.dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
        .blocking_show()
}

/// File → New Conversation: the agent on screen, or the default one (buddi.app's script).
pub fn new_conversation(app: &AppHandle) {
    platform::show_main(app);
    if shell::phase(app) != Phase::Dashboard {
        shell::go(app, "#/chat");
        return;
    }
    shell::when_dashboard(
        app,
        r#"(async () => {
  const on = /^#\/chat\/(?!g\/)([^/?]+)/.exec(location.hash);
  let id = on ? decodeURIComponent(on[1]) : null;
  if (!id) {
    try {
      const res = await fetch('/api/chat/agents', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (res.ok) id = (await res.json()).defaultAgentId || null;
    } catch (_) {}
  }
  location.hash = id ? '#/chat/' + encodeURIComponent(id) + '/new' : '#/chat';
})();"#
            .into(),
    );
}

pub fn settings(app: &AppHandle) {
    platform::show_main(app);
    shell::go(app, "#/settings");
}

/// Lock: the dashboard's own shortcut (Ctrl+Alt+L off a Mac, packages/web/src/shell/lock.tsx);
/// without a PIN set it opens Settings → Lock screen, as the shortcut does.
pub fn lock(app: &AppHandle) {
    shell::when_dashboard(
        app,
        "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));".into(),
    );
}

/// Check for Updates…: the supervisor's own check (Settings → System's "Check now").
pub fn check_for_updates(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let view = match supervisor::check() {
            Ok(view) => view,
            Err(why) => {
                shell::log(format!("update check: {why}"));
                info(&app, "buddi could not check for updates", "The service did not answer. Try again in a moment.");
                return;
            }
        };
        tray::set_update(&app, view.update_available.then(|| view.latest.clone()).flatten());
        match (&view.latest, view.update_available) {
            (Some(latest), true) => {
                let mut text = format!(
                    "You have {}. Update takes a backup first, installs {latest} and restarts buddi; it takes a minute or two. You can also do it later from the menu.",
                    view.current
                );
                if let Some(notes) = view.notes.as_deref().filter(|n| !n.is_empty()) {
                    text.push_str("\n\nWhat changes:\n");
                    text.push_str(&notes.chars().take(1200).collect::<String>());
                }
                if ask(&app, &format!("buddi {latest} is available"), &text, "Update", "Later") {
                    update_to(&app, latest.clone());
                }
            }
            _ => {
                let text = match &view.error {
                    Some(e) => format!("The check did not finish: {e}"),
                    None => format!("You have {}, the latest version.", view.current),
                };
                info(&app, "buddi is up to date", &text);
            }
        }
    });
}

/// "Update to …" in the menu: asked once, with what changes.
pub fn update_from_menu(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let Some(view) = supervisor::version() else { return };
        let Some(latest) = view.latest.clone().filter(|_| view.update_available) else { return };
        let mut text = format!("You have {}. buddi takes a backup first, installs {latest} and restarts; it takes a minute or two.", view.current);
        if let Some(notes) = view.notes.as_deref().filter(|n| !n.is_empty()) {
            text.push_str("\n\nWhat changes:\n");
            text.push_str(&notes.chars().take(1200).collect::<String>());
        }
        if ask(&app, &format!("Update buddi to {latest}?"), &text, "Update", "Cancel") {
            update_to(&app, latest);
        }
    });
}

/// The same upgrade as Settings → System and `buddi upgrade`: download and
/// check the release, back up, switch, restart. The window says "Updating
/// buddi…" meanwhile; the result is a notification (or, on failure, a dialog).
fn update_to(app: &AppHandle, version: String) {
    shell::set_phase(app, Phase::Updating);
    shell::placeholder(app, "updating", &version);
    platform::notify(app, &format!("Updating buddi to {version}"), "A backup first, then the new version; buddi restarts on its own.");
    match buddi::run(&["upgrade", &version], Duration::from_secs(25 * 60)) {
        Ok(_) => platform::notify(app, "buddi is up to date", &format!("buddi is now on {version}.")),
        Err(Failure::NoLink(why)) => info(app, "buddi did not update", &why),
        Err(Failure::Missing) => {}
    }
    tray::set_update(app, None);
    shell::connect(app, false, true);
}

/// Restart buddi: the supervisor restarts the gateway; the window follows.
pub fn restart(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        if let Err(Failure::NoLink(why)) = buddi::service("restart") {
            info(&app, "buddi did not restart", &why);
        }
    });
}

/// Advanced → Restart with the Previous Version…
pub fn restart_with_previous(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let Some((_, previous)) = supervisor::previous_release() else { return };
        let text = format!(
            "buddi stops and starts again on {previous}. Your data stays as it is. If the newer version already changed the database, {previous} may refuse to start: then restore the backup the update took first, in Settings → Backups."
        );
        if !ask(&app, &format!("Restart buddi with {previous}?"), &text, &format!("Restart with {previous}"), "Cancel") {
            return;
        }
        shell::set_phase(&app, Phase::Updating);
        shell::placeholder(&app, "starting", "");
        if let Err(problem) = supervisor::restart_with_previous() {
            info(&app, "buddi did not switch versions", &problem);
        }
        shell::connect(&app, false, true);
    });
}

pub fn open_in_browser(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        if let Err(Failure::NoLink(why)) = buddi::open_in_browser() {
            platform::notify(&app, "buddi did not open the browser", &why);
        }
    });
}

pub fn show_logs() {
    if let Some(logs) = supervisor::data_dir().map(|d| d.join("logs")) {
        let _ = open::that_detached(logs);
    }
}

/// About buddi: the app's version and the buddi it runs, and where they are.
pub fn about(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let running = supervisor::version().map(|v| v.current);
        let mut text = format!("buddi desktop app {}\n", app.package_info().version);
        text.push_str(&match running {
            Some(v) => format!("buddi {v}\n"),
            None => "buddi is not running\n".into(),
        });
        if let Some(cmd) = buddi::command() {
            text.push_str(&format!("\nCommand: {}", cmd.display()));
        }
        if let Some(data) = supervisor::data_dir() {
            text.push_str(&format!("\nData: {}", data.display()));
        }
        text.push_str("\n\nwithbuddi.com · Apache-2.0");
        info(&app, "About buddi", &text);
    });
}

/// Uninstall buddi…: the dashboard's own removal (Settings → System), the one
/// that takes the last backup and shows its passphrase before anything goes,
/// as buddi.app's sheet does. The app itself is a package of its own.
pub fn uninstall(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        if shell::phase(&app) != Phase::Dashboard {
            info(
                &app,
                "buddi has to be running to uninstall it",
                "The last backup is taken before anything is removed, and that needs buddi running. Start buddi, then try again.",
            );
            return;
        }
        let text = "buddi takes a last backup and shows you the passphrase that opens it; nothing is removed before you have both. You choose in Settings → System whether your data goes too.\n\nThis app stays installed: remove it afterwards with sudo apt remove buddi-desktop.";
        if !ask(&app, "Remove buddi from this computer?", text, "Continue", "Cancel") {
            return;
        }
        platform::show_main(&app);
        shell::go(&app, "#/settings/system");
        shell::when_dashboard(
            &app,
            r#"(() => {
  let tries = 0;
  const t = setInterval(() => {
    const b = [...document.querySelectorAll('button')].find((el) => /^Remove buddi from this/.test(el.textContent.trim()));
    if (b) { clearInterval(t); b.scrollIntoView({ block: 'center' }); b.click(); }
    else if (++tries > 40) clearInterval(t);
  }, 250);
})();"#
                .into(),
        );
    });
}

pub fn start_at_login(app: &AppHandle) {
    let on = !platform::autostart_enabled();
    if let Err(why) = platform::set_autostart(on) {
        platform::notify(app, "buddi could not change Start at Login", &why);
    }
    tray::refresh(app);
}

/// A launcher action or a second launch's arguments.
pub fn run_args(app: &AppHandle, args: &[String]) -> bool {
    let mut handled = false;
    for arg in args {
        handled |= match arg.as_str() {
            "--new-conversation" => { new_conversation(app); true }
            "--settings" => { settings(app); true }
            "--check-updates" => { check_for_updates(app); true }
            "--lock" => { platform::show_main(app); lock(app); true }
            _ => false,
        };
    }
    handled
}

pub fn quit(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    app.exit(0);
}
