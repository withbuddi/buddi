//! The `buddi` command this app wraps: where it is, the sign-in link it
//! prints, and `buddi service start|stop`. The app never runs a buddi of its
//! own; everything goes through the command, as a terminal would.

use std::io::Read;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::Url;

/// The line the installer prints, for the "not installed" page.
pub const INSTALL_LINE: &str = "curl -fsSL https://withbuddi.com/install.sh | sh";

pub enum Failure {
    /// No `buddi` command anywhere this app looks.
    Missing,
    /// It ran and did not print a link: what it said instead.
    NoLink(String),
}

/// Where the command is: $BUDDI_BIN, then the one the Linux installer
/// recorded (`installer.json`), then ~/.local/bin/buddi, then PATH.
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
    on_path(if cfg!(windows) { &["buddi.cmd", "buddi.exe"] } else { &["buddi"] })
}

fn on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

/// Runs `buddi <args>` with a deadline; Ok(output) on exit 0.
pub fn run(args: &[&str], timeout: Duration) -> Result<String, Failure> {
    let bin = command().ok_or(Failure::Missing)?;
    let mut child = Command::new(&bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| Failure::NoLink(format!("{} could not run: {e}", bin.display())))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| Failure::NoLink(e.to_string()))? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failure::NoLink(format!("No answer within {} seconds.", timeout.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let mut out = String::new();
    if let Some(mut s) = child.stdout.take() {
        let _ = s.read_to_string(&mut out);
    }
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_string(&mut out);
    }
    if status.success() {
        Ok(out)
    } else {
        Err(Failure::NoLink(tail(&out)))
    }
}

fn tail(s: &str) -> String {
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

/// Is this the dashboard's own origin (the local gateway)?
pub fn is_dashboard(url: &Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
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
