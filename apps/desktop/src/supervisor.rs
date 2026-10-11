//! buddi's supervisor, as buddi.app talks to it: its control socket
//! (`<data>/supervisor.sock`, packages/install/src/supervisor.ts) for the
//! version and the update check, and the release links in `<data>/releases`
//! for going back to the previous version. Everything else goes through the
//! `buddi` command (buddi.rs).

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

/// The data folder of the installation the selected command runs (buddi.rs).
pub fn data_dir() -> Option<PathBuf> {
    crate::buddi::data_dir()
}

/// The supervisor's `/version`: what runs, the newest, whether to update.
#[derive(Clone, Debug, Default)]
pub struct Version {
    pub current: String,
    pub latest: Option<String>,
    pub notes: Option<String>,
    pub update_available: bool,
    pub error: Option<String>,
}

impl Version {
    fn from(v: &Value) -> Option<Version> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
        Some(Version {
            current: s("current")?,
            latest: s("latest"),
            notes: s("latestNotes"),
            update_available: v.get("updateAvailable").and_then(Value::as_bool).unwrap_or(false),
            error: s("error"),
        })
    }
}

#[cfg(unix)]
fn request(method: &str, route: &str, timeout: Duration) -> Result<(u16, Value), String> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    let socket = data_dir().ok_or("no data folder")?.join("supervisor.sock");
    let mut stream = UnixStream::connect(&socket).map_err(|e| format!("{}: {e}", socket.display()))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    let body = if method == "POST" { "{}" } else { "" };
    write!(
        stream,
        "{method} {route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let (head, payload) = text.split_once("\r\n\r\n").ok_or("no answer")?;
    let status = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).ok_or("no status")?;
    Ok((status, serde_json::from_str(payload).unwrap_or(Value::Null)))
}

#[cfg(not(unix))]
fn request(_method: &str, _route: &str, _timeout: Duration) -> Result<(u16, Value), String> {
    Err("TODO(windows): the supervisor's control channel".into())
}

/// The cached answer (cheap; the daily check keeps it fresh).
pub fn version() -> Option<Version> {
    match request("GET", "/version", Duration::from_secs(5)) {
        Ok((200, v)) => Version::from(&v),
        _ => None,
    }
}

/// Check for Updates: the supervisor asks npm now (Settings → System's "Check now").
pub fn check() -> Result<Version, String> {
    match request("POST", "/version/check", Duration::from_secs(60))? {
        (200, v) => Version::from(&v).ok_or_else(|| "The answer had no version.".into()),
        (_, v) => Err(v.get("error").and_then(Value::as_str).unwrap_or("The service refused the check.").into()),
    }
}

/// The release `releases/previous` points at, when it is there and can run:
/// buddi.app's `rollbackTarget`.
pub fn previous_release() -> Option<(PathBuf, String)> {
    let releases = data_dir()?.join("releases");
    let previous = std::fs::canonicalize(releases.join("previous")).ok()?;
    let current = std::fs::canonicalize(releases.join("current")).ok();
    if Some(&previous) == current.as_ref() || !previous.join("packages/install/dist/launcher.js").is_file() {
        return None;
    }
    let version = std::fs::read_to_string(previous.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("version")?.as_str().map(String::from))
        .unwrap_or_else(|| previous.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
    Some((previous, version))
}

/// The systemd user unit that runs this data folder's `releases/current`
/// (install.sh's `unit_file`).
#[cfg(target_os = "linux")]
fn unit_name() -> Option<String> {
    let current = data_dir()?.join("releases").join("current");
    let dir = dirs::config_dir()?.join("systemd/user");
    std::fs::read_dir(dir).ok()?.flatten().find_map(|e| {
        let name = e.file_name().to_string_lossy().to_string();
        let ours = name.starts_with("com.buddi.install.")
            && name.ends_with(".service")
            && std::fs::read_to_string(e.path()).map(|t| t.contains(&*current.to_string_lossy())).unwrap_or(false);
        ours.then_some(name)
    })
}

#[cfg(target_os = "linux")]
fn point(link: &std::path::Path, at: &std::path::Path) -> std::io::Result<()> {
    let tmp = link.with_extension(format!("tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    #[cfg(unix)]
    std::os::unix::fs::symlink(at, &tmp)?;
    std::fs::rename(&tmp, link)
}

/// Advanced → Restart with the Previous Version: stop the service, make
/// `previous` current and what ran previous (buddi.app's `rollBack`), start.
#[cfg(target_os = "linux")]
pub fn restart_with_previous() -> Result<String, String> {
    let (target, version) = previous_release().ok_or("There is no previous version to go back to.")?;
    let unit = unit_name().ok_or("No buddi service runs this installation's releases/current.")?;
    let releases = data_dir().ok_or("no data folder")?.join("releases");
    let running = std::fs::canonicalize(releases.join("current")).map_err(|e| e.to_string())?;
    let systemctl = |verb: &str| {
        std::process::Command::new("systemctl")
            .args(["--user", verb, &unit])
            .status()
            .map_err(|e| e.to_string())
            .and_then(|s| if s.success() { Ok(()) } else { Err(format!("systemctl --user {verb} {unit} failed")) })
    };
    systemctl("stop")?;
    let switched = point(&releases.join("previous"), &running).and_then(|_| point(&releases.join("current"), &target));
    let started = systemctl("start");
    switched.map_err(|e| format!("buddi could not switch versions: {e}"))?;
    started?;
    Ok(version)
}

#[cfg(not(target_os = "linux"))]
pub fn restart_with_previous() -> Result<String, String> {
    Err("TODO(windows): going back a version".into())
}
