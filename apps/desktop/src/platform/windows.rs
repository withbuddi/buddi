//! Windows (WebView2): the microphone for the dashboard's own origin only,
//! toasts under the app's AppUserModelID (the setup's Start menu shortcut
//! carries it), the tray ink from the taskbar's theme, Start at Login as a Run
//! value this installation records as its own, and the supervisor's pipe.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Url, WebviewWindow};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

use super::windows_rules::{self as rules, RunRecord};
use crate::{buddi, shell};

/// The setup's Start menu shortcut names the app with this id
/// (apps/windows/buddi.iss); toasts are shown under it.
pub const APP_USER_MODEL_ID: &str = "com.withbuddi.desktop";

/// Where the tray icon lives, for the words the app says.
pub const TRAY_PLACE: &str = "the notification area";

/// What Uninstall buddi… says about this app: the setup installed both.
pub const APP_STAYS: &str = "This app goes with it.";

/// No console window for anything the app starts (`buddi.cmd` runs under cmd.exe).
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Tauri serves the app's own files from http://tauri.localhost on Windows.
pub fn local_page() -> Url {
    Url::parse("http://tauri.localhost/index.html").unwrap()
}

/// Before the first window: the process takes the shortcut's AppUserModelID,
/// so the taskbar groups it under the Start menu's "buddi" and toasts carry
/// its name and icon.
pub fn early_init() {
    use windows::core::HSTRING;
    let _ = unsafe { windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_USER_MODEL_ID)) };
}

/// WebView2's permission requests: the microphone (and notifications, which
/// the bridge answers first anyway) for the dashboard's exact origin, as the
/// requesting frame names it; everything else, for anyone, denied without a
/// prompt.
pub fn tune_webview(window: &WebviewWindow) {
    let _ = window.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::PermissionRequestedEventHandler;
        let Ok(core) = wv.controller().CoreWebView2() else {
            shell::log("no WebView2 to set permissions on");
            return;
        };
        let mut token = 0i64;
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let mut uri = windows::core::PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = webview2_com::take_pwstr(uri);
            let ours = Url::parse(&uri).map(|u| buddi::is_dashboard(&u)).unwrap_or(false);
            let (name, wanted) = match kind {
                COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => ("microphone", true),
                COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => ("notifications", true),
                COREWEBVIEW2_PERMISSION_KIND_CAMERA => ("camera", false),
                _ => ("other", false),
            };
            if ours && wanted {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            } else {
                shell::log(format!("refused a {name} request"));
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
            }
            Ok(())
        }));
        if let Err(e) = core.add_PermissionRequested(&handler, &mut token) {
            shell::log(format!("permission handler not set: {e}"));
        }
    });
}

/// A toast under the app's AppUserModelID; a click brings the window forward.
pub fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_winrt_notification::{Duration, Toast};
    let (app, title, body) = (app.clone(), title.to_string(), body.to_string());
    std::thread::spawn(move || {
        let opener = app.clone();
        let shown = Toast::new(APP_USER_MODEL_ID)
            .title(&title)
            .text1(&body)
            .duration(Duration::Short)
            .on_activated(move |_| {
                let app = opener.clone();
                let _ = opener.run_on_main_thread(move || super::show_main(&app));
                Ok(())
            })
            .show();
        if let Err(e) = shown {
            shell::log(format!("notification failed ({title}): {e}"));
        }
    });
}

fn hkcu(path: &str) -> Option<RegKey> {
    RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(path, KEY_READ).ok()
}

/// Dark ink for a light taskbar, light ink for a dark one (Windows 11's
/// default). BUDDI_TRAY_INK=dark|light overrides.
pub fn tray_wants_dark_ink() -> bool {
    match std::env::var("BUDDI_TRAY_INK").as_deref() {
        Ok("dark") => return true,
        Ok("light") => return false,
        _ => {}
    }
    let light = hkcu(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize").and_then(|k| k.get_value::<u32, _>("SystemUsesLightTheme").ok());
    rules::dark_ink(light)
}

/// Calls `changed` with the ink whenever the taskbar's theme changes: a
/// thread waits on the Personalize key (RegNotifyChangeKeyValue), no polling.
pub fn watch_tray_ink(changed: impl Fn(bool) + Send + 'static) {
    if std::env::var_os("BUDDI_TRAY_INK").is_some() {
        return;
    }
    std::thread::spawn(move || {
        use windows::Win32::System::Registry::{RegNotifyChangeKeyValue, HKEY, REG_NOTIFY_CHANGE_LAST_SET};
        let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", KEY_READ | winreg::enums::KEY_NOTIFY)
        else {
            return;
        };
        loop {
            let waited = unsafe { RegNotifyChangeKeyValue(HKEY(key.raw_handle() as _), false, REG_NOTIFY_CHANGE_LAST_SET, None, false) };
            if waited.is_err() {
                shell::log("not following the taskbar's theme: the registry did not say when it changes");
                return;
            }
            changed(tray_wants_dark_ink());
        }
    });
}

pub fn tray_icon_dir() -> Option<PathBuf> {
    None
}

/// "11:19" or "11:19 AM", as Region settings have the short time.
pub fn clock_text(at: std::time::SystemTime) -> String {
    static FORMAT: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    let format = FORMAT.get_or_init(|| {
        let short = hkcu(r"Control Panel\International").and_then(|k| k.get_value::<String, _>("sShortTime").ok());
        rules::clock_format(short.as_deref())
    });
    let local: chrono::DateTime<chrono::Local> = at.into();
    local.format(format).to_string()
}

/// The default browser, through the shell (no console, no cmd.exe parsing the address).
pub fn launch(url: &str) -> Result<&'static str, String> {
    open::that_detached(url).map(|_| "the default browser").map_err(|e| e.to_string())
}

/* Start at Login: HKCU\…\Run\buddi = "<this exe>" --hidden. The app records
 * what it wrote, and for which data folder, in HKCU\Software\buddi\Desktop; it
 * changes the Run value only when that record says it is its own (or there is
 * none), and the setup's uninstaller removes it on the same condition. */

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const RECORD_KEY: &str = r"Software\buddi\Desktop";
const RUN_VALUE: &str = "buddi";

fn run_value() -> Option<String> {
    hkcu(RUN_KEY).and_then(|k| k.get_value::<String, _>(RUN_VALUE).ok())
}

fn run_record() -> RunRecord {
    let key = hkcu(RECORD_KEY);
    let get = |name: &str| key.as_ref().and_then(|k| k.get_value::<String, _>(name).ok());
    RunRecord { command: get("RunCommand"), data: get("DataDir") }
}

fn data_text() -> Option<String> {
    buddi::data_dir().map(|d| d.to_string_lossy().to_string())
}

pub fn autostart_enabled() -> bool {
    let Some(value) = run_value() else { return false };
    let approved = hkcu(APPROVED_KEY).and_then(|k| k.get_raw_value(RUN_VALUE).ok()).map(|v| v.bytes);
    let ours = data_text().map(|d| rules::run_entry_ours(Some(&value), &run_record(), &d)).unwrap_or(false);
    ours && rules::startup_approved(approved.as_deref())
}

pub fn set_autostart(on: bool) -> Result<(), String> {
    let data = data_text().ok_or("no buddi installation")?;
    let existing = run_value();
    if !rules::run_entry_ours(existing.as_deref(), &run_record(), &data) {
        return Err("A \"buddi\" entry this installation did not write starts at sign-in; change it in Settings → Apps → Startup.".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let command = rules::run_command(&exe);
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = root.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
    if on {
        let (record, _) = root.create_subkey(RECORD_KEY).map_err(|e| e.to_string())?;
        record.set_value("RunCommand", &command).map_err(|e| e.to_string())?;
        record.set_value("DataDir", &data).map_err(|e| e.to_string())?;
        run.set_value(RUN_VALUE, &command).map_err(|e| e.to_string())?;
        // Turned off in Settings → Apps → Startup earlier: this is the owner turning it back on.
        if let Ok(approved) = root.open_subkey_with_flags(APPROVED_KEY, KEY_SET_VALUE) {
            let _ = approved.delete_value(RUN_VALUE);
        }
    } else if existing.is_some() {
        run.delete_value(RUN_VALUE).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The first launch turns Start at Login on (the setup leaves it to the app),
/// unless a "buddi" entry is there already; asked once.
pub fn offer_autostart_once(config: &Path) {
    let flag = config.join("autostart-offered");
    if flag.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(config);
    let _ = std::fs::write(&flag, "");
    if run_value().is_none() {
        if let Err(e) = set_autostart(true) {
            shell::log(format!("Start at Login not turned on: {e}"));
        }
    }
}

/* The supervisor's control channel (packages/install/src/supervisor.ts
 * `supervisorPipe`): a named pipe whose random name and secret are in
 * `<data>\supervisor.pipe`, valid only while `supervisor.lock` names a live
 * process. */

/// Is this pid a running process? (Access denied counts as alive, as Node's
/// `process.kill(pid, 0)` has EPERM.)
pub fn process_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, STILL_ACTIVE};
    use windows::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => {
                let mut code = 0u32;
                let alive = GetExitCodeProcess(handle, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
                let _ = CloseHandle(handle);
                alive
            }
            Err(e) => e.code() == ERROR_ACCESS_DENIED.to_hresult(),
        }
    }
}

/// When this computer started, in ms since the epoch (now less its uptime).
fn boot_ms() -> i64 {
    let uptime = unsafe { windows::Win32::System::SystemInformation::GetTickCount64() } as i64;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    now - uptime
}

/// The pid file's process is running (`supervisor.lock`, `postmaster.pid`).
/// For `supervisor.lock`, only a lock of this boot counts (`supervisor.boot` beside it).
pub fn pid_file_alive(file: &Path) -> bool {
    let Some(pid) = std::fs::read_to_string(file).ok().and_then(|t| rules::lock_pid(&t)) else { return false };
    if file.file_name().is_some_and(|n| n == "supervisor.lock") {
        let record = file.parent().and_then(|d| std::fs::read_to_string(d.join("supervisor.boot")).ok());
        if !rules::lock_of_this_boot(pid, record.as_deref(), boot_ms()) {
            return false;
        }
    }
    process_alive(pid)
}

/// The live supervisor's pipe path and secret, or None while none runs.
pub fn supervisor_pipe(data: &Path) -> Option<(String, String)> {
    if !pid_file_alive(&data.join("supervisor.lock")) {
        return None;
    }
    let (name, secret) = rules::pipe_file(&std::fs::read_to_string(data.join("supervisor.pipe")).ok()?)?;
    Some((format!(r"\\.\pipe\{name}"), secret))
}

/// Opens the pipe, waiting while every instance is busy (ERROR_PIPE_BUSY).
pub fn open_pipe(path: &str) -> Result<std::fs::File, String> {
    let started = std::time::Instant::now();
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(path) {
            Ok(f) => return Ok(f),
            Err(e) if e.raw_os_error() == Some(231) && started.elapsed() < std::time::Duration::from_secs(5) => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(format!("the supervisor's pipe: {e}")),
        }
    }
}

/// Points a junction at `target` in one step: a new junction beside it, then
/// renamed over (the setup's `pointAt`).
pub fn point(link: &Path, target: &Path) -> std::io::Result<()> {
    let tmp = link.with_extension(format!("tmp-{}", std::process::id()));
    let _ = std::fs::remove_dir(&tmp);
    junction::create(target, &tmp)?;
    if std::fs::symlink_metadata(link).is_ok() {
        std::fs::remove_dir(link)?;
    }
    std::fs::rename(&tmp, link)
}

/// The app's own log, beside its WebView2 data: a windowed program has no
/// stderr to read. Kept under half a megabyte.
pub fn log_line(line: &str) {
    use std::io::Write;
    let Some(dir) = dirs::data_local_dir().map(|d| d.join("com.withbuddi.desktop")) else { return };
    let file = dir.join("desktop.log");
    if std::fs::metadata(&file).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&file, dir.join("desktop.old.log"));
    }
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(f, "{now} {line}");
    }
}

/// The app is the setup's: `buddi.cmd` sits in `bin\` beside it.
pub fn installed_command() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let cmd = exe.parent()?.join("bin").join("buddi.cmd");
    cmd.is_file().then_some(cmd)
}

/// The data folder the setup recorded (`HKCU\Software\buddi\DataDir`).
pub fn registered_data_dir() -> Option<PathBuf> {
    hkcu(r"Software\buddi").and_then(|k| k.get_value::<String, _>("DataDir").ok()).filter(|d| !d.is_empty()).map(PathBuf::from)
}

