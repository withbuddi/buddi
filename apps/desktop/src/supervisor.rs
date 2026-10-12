//! buddi's supervisor, as buddi.app talks to it: its control socket
//! (`<data>/supervisor.sock`, packages/install/src/supervisor.ts; on Windows
//! the named pipe `<data>\supervisor.pipe` names, see `request`) for the
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

/// The request every control channel gets: HTTP/1.1, closed after one answer.
fn request_bytes(method: &str, route: &str) -> String {
    let body = if method == "POST" { "{}" } else { "" };
    format!(
        "{method} {route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// An answer: its status, its headers (names in lower case) and its JSON body.
pub struct Answer {
    pub status: u16,
    // Read on Windows, where the secret header is checked.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl Answer {
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

pub fn parse_answer(raw: &[u8]) -> Result<Answer, String> {
    let text = String::from_utf8_lossy(raw);
    let (head, payload) = text.split_once("\r\n\r\n").ok_or("no answer")?;
    let mut lines = head.split("\r\n");
    let status = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|c| c.parse().ok()).ok_or("no status")?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let chunked = headers.iter().any(|(k, v)| k == "transfer-encoding" && v.eq_ignore_ascii_case("chunked"));
    let body = if chunked { dechunk(payload) } else { payload.to_string() };
    Ok(Answer { status, headers, body: serde_json::from_str(&body).unwrap_or(Value::Null) })
}

fn dechunk(mut rest: &str) -> String {
    let mut out = String::new();
    while let Some((size, after)) = rest.split_once("\r\n") {
        let Ok(n) = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16) else { break };
        if n == 0 || after.len() < n {
            break;
        }
        out.push_str(&after[..n]);
        rest = after[n..].trim_start_matches("\r\n");
    }
    out
}

#[cfg(unix)]
fn request(method: &str, route: &str, timeout: Duration) -> Result<(u16, Value), String> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    let socket = data_dir().ok_or("no data folder")?.join("supervisor.sock");
    let mut stream = UnixStream::connect(&socket).map_err(|e| format!("{}: {e}", socket.display()))?;
    stream.set_read_timeout(Some(timeout)).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();
    stream.write_all(request_bytes(method, route).as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let answer = parse_answer(&raw)?;
    Ok((answer.status, answer.body))
}

/// Windows: the named pipe `<data>\supervisor.pipe` names while
/// `supervisor.lock` names a live supervisor, and only an answer carrying the
/// secret beside that name counts (supervisor.ts `answeredBySupervisor`):
/// a pipe someone else made answers nothing this app believes.
#[cfg(windows)]
fn request(method: &str, route: &str, timeout: Duration) -> Result<(u16, Value), String> {
    use std::io::{Read, Write};
    let data = data_dir().ok_or("no data folder")?;
    let (pipe, secret) = crate::platform::supervisor_pipe(&data).ok_or("buddi's supervisor is not running")?;
    let mut stream = crate::platform::open_pipe(&pipe)?;
    stream.write_all(request_bytes(method, route).as_bytes()).map_err(|e| e.to_string())?;
    // A pipe read has no timeout of its own: it runs aside, and on a timeout
    // its blocked read is cancelled, so the thread and the handle end too.
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut raw = Vec::new();
        let read = stream.read_to_end(&mut raw).map(|_| raw);
        let _ = tx.send(read);
    });
    let answer = rx.recv_timeout(timeout);
    if answer.is_err() {
        use std::os::windows::io::AsRawHandle;
        let thread = windows::Win32::Foundation::HANDLE(reader.as_raw_handle());
        let _ = unsafe { windows::Win32::System::IO::CancelSynchronousIo(thread) };
    }
    let raw = match answer {
        Ok(Ok(raw)) => raw,
        // The server closing its end is how an answer ends.
        Ok(Err(e)) if e.raw_os_error() == Some(109) => return Err("the supervisor closed the pipe without answering".into()),
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err(format!("no answer within {} seconds", timeout.as_secs())),
    };
    let answer = parse_answer(&raw)?;
    if answer.header("x-buddi-supervisor") != Some(secret.as_str()) {
        return Err("the answer on the pipe did not come from this installation's supervisor".into());
    }
    Ok((answer.status, answer.body))
}

#[cfg(not(any(unix, windows)))]
fn request(_method: &str, _route: &str, _timeout: Duration) -> Result<(u16, Value), String> {
    Err("no control channel on this system".into())
}

/// Restart buddi: the supervisor restarts the gateway (`buddi service restart`
/// asks the same).
pub fn restart() -> Result<(), String> {
    match request("POST", "/restart", Duration::from_secs(90))? {
        (200 | 202, _) => Ok(()),
        (_, v) => Err(v.get("error").and_then(Value::as_str).unwrap_or("The service refused to restart.").into()),
    }
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

/// Windows: the supervisor stops on its pipe (`/exit`, never a kill: that
/// skips the database's shutdown), the junctions are swapped under the
/// releases lock, and the next `buddi --no-open` starts the previous release
/// through the service's task (shell::connect, right after).
#[cfg(windows)]
pub fn restart_with_previous() -> Result<String, String> {
    use crate::platform::{pid_file_alive, point};
    let (target, version) = previous_release().ok_or("There is no previous version to go back to.")?;
    let data = data_dir().ok_or("no data folder")?;
    let releases = data.join("releases");
    let running = std::fs::canonicalize(releases.join("current")).map_err(|e| e.to_string())?;
    let lock = ReleasesLock::take(&releases)?;
    if pid_file_alive(&data.join("supervisor.lock")) {
        match request("POST", "/exit", Duration::from_secs(25))? {
            (200 | 202, _) => {}
            (_, v) => return Err(v.get("error").and_then(Value::as_str).unwrap_or("buddi did not stop.").into()),
        }
    }
    let since = std::time::Instant::now();
    while pid_file_alive(&data.join("supervisor.lock")) || pid_file_alive(&data.join("postgres").join("postmaster.pid")) {
        if since.elapsed() > Duration::from_secs(120) {
            return Err("buddi did not stop within two minutes, so nothing was changed.".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    point(&releases.join("previous"), &plain(&running))
        .and_then(|_| point(&releases.join("current"), &plain(&target)))
        .map_err(|e| format!("buddi could not switch versions: {e}"))?;
    drop(lock);
    Ok(version)
}

/// `canonicalize` gives `\\?\C:\…`; a junction wants the plain path.
#[cfg(windows)]
fn plain(p: &std::path::Path) -> PathBuf {
    let s = p.to_string_lossy();
    PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
}

/// `<releases>\.lock`, the folder an install or upgrade holds while it
/// changes the links (app-layout.ts `takeReleasesLock`).
#[cfg(windows)]
struct ReleasesLock(PathBuf);

#[cfg(windows)]
impl ReleasesLock {
    fn take(releases: &std::path::Path) -> Result<ReleasesLock, String> {
        let lock = releases.join(".lock");
        for _ in 0..2 {
            match std::fs::create_dir(&lock) {
                Ok(()) => {
                    let _ = std::fs::write(lock.join("pid"), format!("{}\n", std::process::id()));
                    return Ok(ReleasesLock(lock));
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if crate::platform::pid_file_alive(&lock.join("pid")) {
                        return Err("An install or upgrade is changing buddi right now; try again when it has finished.".into());
                    }
                    let _ = std::fs::remove_dir_all(&lock);
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("buddi could not take the releases lock.".into())
    }
}

#[cfg(windows)]
impl Drop for ReleasesLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn restart_with_previous() -> Result<String, String> {
    Err("Going back a version is not there on this system.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_are_read_with_their_headers() {
        let raw = b"HTTP/1.1 202 Accepted\r\nContent-Type: application/json\r\nX-Buddi-Supervisor: abc\r\n\r\n{\"gateway\":\"running\"}";
        let a = parse_answer(raw).unwrap();
        assert_eq!(a.status, 202);
        assert_eq!(a.header("x-buddi-supervisor"), Some("abc"));
        assert_eq!(a.body["gateway"], "running");
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n2\r\n1}\r\n0\r\n\r\n";
        assert_eq!(parse_answer(chunked).unwrap().body["a"], 1);
        assert!(parse_answer(b"garbage").is_err());
    }
}
