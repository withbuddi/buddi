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

/// Dark ink on a light taskbar: `SystemUsesLightTheme` = 1. Windows 11's
/// default taskbar is dark (0, or no value).
pub fn dark_ink(system_uses_light_theme: Option<u32>) -> bool {
    system_uses_light_theme == Some(1)
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
        assert!(dark_ink(Some(1)) && !dark_ink(Some(0)) && !dark_ink(None));
        assert_eq!(clock_format(Some("h:mm tt")), "%-I:%M %p");
        assert_eq!(clock_format(Some("HH:mm")), "%H:%M");
        assert_eq!(clock_format(None), "%H:%M");
        assert!(same_path("C:\\A\\b\\", "c:/a/B") && !same_path("", ""));
    }
}
