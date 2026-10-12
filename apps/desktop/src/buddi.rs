//! The `buddi` command this app wraps: where it is, the sign-in link it
//! prints, and `buddi service start|stop`. The app never runs a buddi of its
//! own; everything goes through the command, as a terminal would.

use std::io::Read;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::Url;

/// The line the installer prints, for the "not installed" page; on Windows
/// the page the setup is downloaded from.
#[cfg(not(windows))]
pub const INSTALL_LINE: &str = "curl -fsSL https://withbuddi.com/install.sh | sh";
#[cfg(windows)]
pub const INSTALL_LINE: &str = "https://withbuddi.com";

pub enum Failure {
    /// No `buddi` command anywhere this app looks.
    Missing,
    /// It ran and did not print a link: what it said instead.
    NoLink(String),
}

/// Where the command is: $BUDDI_BIN, then the one the Linux installer
/// recorded (`installer.json`), then ~/.local/bin/buddi, then PATH. On
/// Windows: $BUDDI_BIN, then `bin\buddi.cmd` beside this app (the setup
/// installs both), then the one the setup recorded, then PATH.
pub fn command() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("BUDDI_BIN").map(PathBuf::from) {
        return p.is_file().then_some(p);
    }
    #[cfg(target_os = "linux")]
    {
        let data = std::env::var_os("BUDDI_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::data_dir().map(|d| d.join("buddi")));
        if let Some(recorded) = data
            .and_then(|d| std::fs::read_to_string(d.join("installer.json")).ok())
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("command")?.as_str().map(PathBuf::from))
        {
            if recorded.is_file() {
                return Some(recorded);
            }
        }
        if let Some(local) = dirs::home_dir().map(|h| h.join(".local/bin/buddi")) {
            if local.is_file() {
                return Some(local);
            }
        }
    }
    #[cfg(windows)]
    {
        if let Some(cmd) = crate::platform::installed_command() {
            return Some(cmd);
        }
        let data = std::env::var_os("BUDDI_DATA_DIR")
            .map(PathBuf::from)
            .or_else(crate::platform::registered_data_dir)
            .or_else(|| dirs::data_local_dir().map(|d| d.join("buddi")));
        if let Some(recorded) = data
            .and_then(|d| std::fs::read_to_string(d.join("installer.json")).ok())
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("command")?.as_str().map(PathBuf::from))
        {
            if recorded.is_file() {
                return Some(recorded);
            }
        }
    }
    on_path(if cfg!(windows) { &["buddi.cmd", "buddi.exe"] } else { &["buddi"] })
}

/// The installation the selected command runs: its data folder, from the
/// command itself (install.sh's wrapper names it on its `DATA='…'` line, the
/// Windows setup's `buddi.cmd` on its `set "BUDDI_DATA_DIR=…"` line), else
/// $BUDDI_DATA_DIR, else the install's default. The dashboard, the
/// supervisor's socket or pipe, the releases and the service are all this one's.
pub fn data_dir() -> Option<PathBuf> {
    if let Some(data) = named_data_dir() {
        return Some(data);
    }
    #[cfg(windows)]
    let default = crate::platform::registered_data_dir().or_else(|| dirs::data_local_dir().map(|d| d.join("buddi")));
    #[cfg(not(windows))]
    let default = dirs::data_dir().map(|d| d.join("buddi"));
    std::env::var_os("BUDDI_DATA_DIR").map(PathBuf::from).or(default)
}

/// The data folder the command itself names (install.sh's wrapper, the
/// Windows setup's `buddi.cmd`); None for any other command.
pub fn named_data_dir() -> Option<PathBuf> {
    let text = command().and_then(|c| std::fs::read(c).ok()).map(|b| String::from_utf8_lossy(&b).to_string())?;
    if let Some(data) = wrapper_data(&text) {
        return Some(data);
    }
    #[cfg(windows)]
    if let Some(data) = crate::platform::windows_rules::command_data(&text) {
        return Some(data);
    }
    None
}

/// The `DATA='…'` line of a command install.sh wrote (packages/install/src/
/// linux-install.ts `commandData`): single-quoted, `'\''` for a quote.
pub fn wrapper_data(text: &str) -> Option<PathBuf> {
    if !text.contains("# buddi-linux-install") {
        return None;
    }
    let raw = text.lines().find_map(|l| l.strip_prefix("DATA="))?;
    let value = match raw.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')) {
        Some(inner) => inner.replace("'\\''", "'"),
        None => raw.to_string(),
    };
    (!value.is_empty()).then(|| PathBuf::from(value))
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

/// Runs `buddi <args>` with a deadline; Ok(output) on exit 0. Both pipes
/// are drained while it runs, so a chatty command cannot fill one and stall.
pub fn run(args: &[&str], timeout: Duration) -> Result<String, Failure> {
    let bin = command().ok_or(Failure::Missing)?;
    let mut cmd = Command::new(&bin);
    // buddi.cmd runs under cmd.exe: no console window for it, or for node under it.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, crate::platform::CREATE_NO_WINDOW);
    let mut child = cmd
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Failure::NoLink(format!("{} could not run: {e}", bin.display())))?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_string(&mut text);
            }
            text
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| Failure::NoLink(e.to_string()))? {
            break Some(status);
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let text = format!("{}{}", out.join().unwrap_or_default(), err.join().unwrap_or_default());
    match status {
        Some(s) if s.success() => Ok(text),
        Some(_) => Err(Failure::NoLink(tail(&text))),
        None => Err(Failure::NoLink(format!("No answer within {} seconds.", timeout.as_secs()))),
    }
}

/// The last words of the output, without the sign-in link (a ticket).
fn tail(s: &str) -> String {
    let s = crate::policy::without_link(s);
    let s = s.trim();
    let chars: Vec<char> = s.chars().collect();
    chars[chars.len().saturating_sub(600)..].iter().collect()
}

/// A fresh five-minute sign-in link: `buddi --no-open`, its "Dashboard:" line.
/// Like `buddi` in a terminal, this starts the service when it is not running
/// (through systemd on Linux); `--no-service` is not passed because, unlike
/// buddi.app, this app does not supervise buddi itself.
pub fn dashboard_link() -> Result<Url, Failure> {
    let out = run(&["--no-open"], Duration::from_secs(150))?;
    out.lines()
        .find_map(|l| l.strip_prefix("Dashboard: "))
        .and_then(|u| Url::parse(u.trim()).ok())
        .ok_or_else(|| Failure::NoLink(tail(&out)))
}

pub fn service(action: &str) -> Result<String, Failure> {
    run(&["service", action], Duration::from_secs(90))
}

/// Opens the dashboard in the default browser (`buddi dashboard`).
pub fn open_in_browser() -> Result<String, Failure> {
    run(&["dashboard"], Duration::from_secs(60))
}

/// Is this the dashboard's own origin (scheme, host and port of the last link)?
pub fn is_dashboard(url: &Url) -> bool {
    crate::policy::is_dashboard(url)
}

pub fn gateway_addr(url: &Url) -> Option<SocketAddr> {
    let host = match url.host_str()? {
        "localhost" => "127.0.0.1",
        h => h,
    };
    (host, url.port()?).to_socket_addrs().ok()?.next()
}

/// The gateway answers on its port (cheap: no process per check).
pub fn answers(addr: SocketAddr) -> bool {
    TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wrapper_names_its_data_folder() {
        let w = "#!/bin/sh\n# buddi-linux-install: written by https://withbuddi.com/install.sh\nDATA='/home/a/it'\\''s'\nexec x\n";
        assert_eq!(wrapper_data(w), Some(PathBuf::from("/home/a/it's")));
        assert_eq!(wrapper_data("#!/bin/sh\nDATA='/x'\n"), None);
    }
}
