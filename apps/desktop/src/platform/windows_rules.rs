//! Windows' rules as plain functions, so they are tested on any machine:
//! which `buddi.cmd` names which data folder, what the supervisor's pipe file
//! says, which Start at Login entry is this installation's, and how the
//! taskbar's theme and clock are read. Compiled on Windows (windows.rs uses
//! them) and in every test build.

use std::path::{Path, PathBuf};

/// The marker line of a `buddi.cmd` the setup wrote (packages/install/src/
/// windows-install.ts, `WINDOWS_COMMAND_MARKER`).
pub const COMMAND_MARKER: &str = "rem buddi-windows-install";

/// The data folder a setup-written `buddi.cmd` runs: its `set "BUDDI_DATA_DIR=…"`
/// line, `%%` back to `%` (windows-install.ts `windowsCommandData`).
pub fn command_data(text: &str) -> Option<PathBuf> {
    if !text.contains(COMMAND_MARKER) {
        return None;
    }
    let line = text.lines().find_map(|l| l.strip_prefix("set \"BUDDI_DATA_DIR="))?;
    let value = line.strip_suffix('"')?.replace("%%", "%");
    (!value.is_empty()).then(|| PathBuf::from(value))
}

/// `<data>\supervisor.pipe`: the pipe's random name and the secret every
/// answer carries (supervisor.ts `nameSupervisorPipe`), both checked.
pub fn pipe_file(text: &str) -> Option<(String, String)> {
    let mut lines = text.lines().map(str::trim);
    let name = lines.next()?;
    let secret = lines.next()?;
    let hex = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let id = name.strip_prefix("buddi-supervisor-")?;
    (hex(id, 32) && hex(secret, 64)).then(|| (name.to_string(), secret.to_string()))
}

/// The pid `supervisor.lock` names, when it is one.
pub fn lock_pid(text: &str) -> Option<u32> {
    text.lines().next()?.trim().parse().ok().filter(|p| *p > 0)
}

/// `<data>\supervisor.boot` (environment.ts `LOCK_BOOT_FILE`): `<pid> <boot ms>`.
/// A lock taken in an earlier boot is stale even when its pid runs again
/// (Windows reuses pids quickly); a lock with no record is judged by its pid.
pub fn lock_of_this_boot(pid: u32, boot_file: Option<&str>, boot_now_ms: i64) -> bool {
    let Some(text) = boot_file else { return true };
    let mut parts = text.split_whitespace();
    let (Some(p), Some(b)) = (parts.next().and_then(|p| p.parse::<u32>().ok()), parts.next().and_then(|b| b.parse::<f64>().ok())) else {
        return true;
    };
    p != pid || (boot_now_ms as f64 - b).abs() <= 120_000.0
}

/// Two Windows paths name the same folder: case and a trailing backslash aside.
pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase();
    !a.is_empty() && norm(a) == norm(b)
}

/// The Run value the app writes: itself, started in the tray.
pub fn run_command(exe: &Path) -> String {
    format!("\"{}\" --hidden", exe.display())
}

/// What the app recorded when it last wrote Start at Login
/// (`HKCU\Software\buddi\Desktop`): the command it wrote and for which data folder.
#[derive(Default, Clone, Debug)]
pub struct RunRecord {
    pub command: Option<String>,
    pub data: Option<String>,
}

/// May this installation change the Run value? When there is none, yes; when
/// there is one, only the very command this app recorded writing for this
/// data folder. Anything else (the owner's own, another copy's) stays.
pub fn run_entry_ours(value: Option<&str>, record: &RunRecord, data: &str) -> bool {
    match value {
        None => true,
        Some(v) => {
            record.command.as_deref() == Some(v) && record.data.as_deref().map(|d| same_path(d, data)).unwrap_or(false)
        }
    }
}

/// Settings → Apps → Startup (and Task Manager) keep a switch per Run value in
/// `…\Explorer\StartupApproved\Run`: an even first byte is on, odd is off; no
/// value is on.
pub fn startup_approved(bytes: Option<&[u8]>) -> bool {
    match bytes.and_then(|b| b.first()) {
        Some(b) => b % 2 == 0,
        None => true,
    }
}

/// The tray icon cut for a display's DPI (96 = 100 %): the nearest of 16, 20, 24 and 32 px, never smaller.
pub fn tray_px(dpi: u32) -> u32 {
    let want = 16 * dpi.max(96) / 96;
    [16, 20, 24, 32].into_iter().find(|s| *s >= want).unwrap_or(32)
}

/// The clock as the taskbar shows it: `sShortTime` (Control Panel →
/// Region) with `h` is 12-hour, `H` 24-hour.
pub fn clock_format(short_time: Option<&str>) -> &'static str {
    match short_time {
        Some(f) if f.contains('h') && !f.contains('H') => "%-I:%M %p",
        _ => "%H:%M",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_names_its_data_folder() {
        let cmd = "@echo off\r\nrem buddi-windows-install: written by the buddi setup.\r\nsetlocal DisableDelayedExpansion\r\nset \"BUDDI_DATA_DIR=C:\\Users\\a\\100%%\\buddi\"\r\nset \"BUDDI_NODE=x\"\r\n";
        assert_eq!(command_data(cmd), Some(PathBuf::from("C:\\Users\\a\\100%\\buddi")));
        assert_eq!(command_data("@echo off\r\nset \"BUDDI_DATA_DIR=C:\\x\"\r\n"), None, "not the setup's");
        assert_eq!(command_data("rem buddi-windows-install\r\nset \"BUDDI_DATA_DIR=\"\r\n"), None);
    }

    #[test]
    fn the_pipe_file_is_checked() {
        let name = format!("buddi-supervisor-{}", "0123456789abcdef".repeat(2));
        let secret = "ab".repeat(32);
        assert_eq!(pipe_file(&format!("{name}\r\n{secret}\r\n")), Some((name.clone(), secret.clone())));
        assert_eq!(pipe_file(&format!("{name}\n")), None, "no secret");
        assert_eq!(pipe_file(&format!("{name}\n{}\n", "AB".repeat(32))), None, "upper case");
        assert_eq!(pipe_file(&format!("evil-pipe\n{secret}\n")), None);
        assert_eq!(pipe_file(&format!("buddi-supervisor-..\\..\\x\n{secret}\n")), None);
        assert_eq!(lock_pid("4242\n"), Some(4242));
        assert_eq!(lock_pid("0"), None);
        assert_eq!(lock_pid("x"), None);
    }

    #[test]
    fn a_lock_of_an_earlier_boot_is_stale() {
        assert!(lock_of_this_boot(42, None, 5), "no record: the pid decides");
        assert!(lock_of_this_boot(42, Some("42 1000000\n"), 1_060_000), "this boot, a minute of drift");
        assert!(!lock_of_this_boot(42, Some("42 1000000"), 9_000_000), "an earlier boot");
        assert!(lock_of_this_boot(42, Some("43 1"), 9_000_000), "another lock's record");
        assert!(lock_of_this_boot(42, Some("junk"), 9_000_000));
    }

    #[test]
    fn only_this_installations_run_entry_is_ours() {
        let data = "C:\\Users\\a\\AppData\\Local\\buddi";
        let cmd = run_command(Path::new("C:\\Users\\a\\AppData\\Local\\Programs\\buddi\\buddi-desktop.exe"));
        assert_eq!(cmd, "\"C:\\Users\\a\\AppData\\Local\\Programs\\buddi\\buddi-desktop.exe\" --hidden");
        let record = RunRecord { command: Some(cmd.clone()), data: Some(format!("{}\\", data.to_uppercase())) };
        assert!(run_entry_ours(None, &RunRecord::default(), data), "nothing there yet");
        assert!(run_entry_ours(Some(&cmd), &record, data));
        assert!(!run_entry_ours(Some(&cmd), &record, "D:\\other"), "another installation's");
        assert!(!run_entry_ours(Some("\"C:\\mine.exe\""), &record, data), "the owner's own");
        assert!(!run_entry_ours(Some(&cmd), &RunRecord::default(), data), "never recorded");
    }

    #[test]
    fn startup_switches_theme_and_clock() {
        assert!(startup_approved(None));
        assert!(startup_approved(Some(&[2, 0, 0])));
        assert!(startup_approved(Some(&[6])));
        assert!(!startup_approved(Some(&[3, 0, 0])));
        assert_eq!((tray_px(96), tray_px(120), tray_px(144), tray_px(192), tray_px(288), tray_px(0)), (16, 20, 24, 32, 32, 16));
        assert_eq!(clock_format(Some("h:mm tt")), "%-I:%M %p");
        assert_eq!(clock_format(Some("HH:mm")), "%H:%M");
        assert_eq!(clock_format(None), "%H:%M");
        assert!(same_path("C:\\A\\b\\", "c:/a/B") && !same_path("", ""));
    }
}
