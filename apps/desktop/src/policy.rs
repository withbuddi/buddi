//! The app's rules as plain functions, so they are tested without a window:
//! which origin is the dashboard, which links may leave for the browser and
//! how often, how a path goes into a desktop entry's Exec line, and where a
//! download lands.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Url;

/// The dashboard's exact origin (scheme, host, port), from the last sign-in
/// link. Nothing is the dashboard before the first link.
static ORIGIN: Mutex<Option<String>> = Mutex::new(None);

pub fn set_dashboard(link: &Url) {
    *ORIGIN.lock().unwrap() = Some(link.origin().ascii_serialization());
}

pub fn dashboard_origin() -> Option<String> {
    ORIGIN.lock().unwrap().clone()
}

/// Is `url` on the dashboard's own origin? Another port on this computer (a
/// preview the gateway serves on its second origin, any other local server)
/// is not.
pub fn is_dashboard(url: &Url) -> bool {
    same_origin(url, dashboard_origin().as_deref())
}

pub fn same_origin(url: &Url, origin: Option<&str>) -> bool {
    match origin {
        Some(o) => url.origin().is_tuple() && url.origin().ascii_serialization() == o,
        None => false,
    }
}

/// Another server on this computer (a preview the gateway serves on its
/// second origin): allowed in a frame of the dashboard, never as the page.
pub fn loopback(url: &Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]"))
}

/// Schemes that may leave for the default browser. (The dashboard links to
/// no mailto: or other handlers; anything else is dropped.)
pub fn may_hand_off(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
}

/// At most a few hand-offs in a short window, and the same address once:
/// a page cannot flood the browser with tabs.
pub struct HandOffs {
    recent: VecDeque<(Instant, String)>,
}

pub const HAND_OFF_WINDOW: Duration = Duration::from_secs(10);
pub const HAND_OFF_MAX: usize = 4;
pub const SAME_URL_GAP: Duration = Duration::from_secs(3);

impl HandOffs {
    pub const fn new() -> Self {
        HandOffs { recent: VecDeque::new() }
    }

    pub fn allow(&mut self, url: &str, now: Instant) -> bool {
        while self.recent.front().map(|(t, _)| now.duration_since(*t) > HAND_OFF_WINDOW).unwrap_or(false) {
            self.recent.pop_front();
        }
        if self.recent.iter().any(|(t, u)| u == url && now.duration_since(*t) < SAME_URL_GAP) {
            return false;
        }
        if self.recent.len() >= HAND_OFF_MAX {
            return false;
        }
        self.recent.push_back((now, url.to_string()));
        true
    }
}

/// One argument of a desktop entry's Exec key, per the spec's quoting rules
/// (https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html):
/// in double quotes, `"`, `` ` ``, `$` and `\` take a backslash, and since the
/// value is also an escaped string that backslash is written twice; `%` is
/// `%%`. A path with a control character is refused.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn exec_arg(path: &str) -> Option<String> {
    if path.chars().any(|c| c.is_control()) {
        return None;
    }
    let mut out = String::from("\"");
    for c in path.chars() {
        match c {
            '"' | '`' | '$' => {
                out.push_str("\\\\");
                out.push(c);
            }
            '\\' => out.push_str("\\\\\\\\"),
            '%' => out.push_str("%%"),
            _ => out.push(c),
        }
    }
    out.push('"');
    Some(out)
}

/// Where a download goes: `dir/name`, or `name 2.ext`, `name 3.ext`… when
/// taken (as on the Mac). Slashes in the suggested name do not leave `dir`.
pub fn downloads_path(dir: &Path, name: &str) -> PathBuf {
    let name = name.replace(['/', '\\'], "_");
    let name = if name.is_empty() || name == "." || name == ".." { "download".to_string() } else { name };
    let first = dir.join(&name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.clone(), String::new()),
    };
    (2..).map(|n| dir.join(format!("{stem} {n}{ext}"))).find(|p| !p.exists()).unwrap()
}

/// The command's words for the attention page and the log, without the
/// sign-in link (a ticket that opens the dashboard).
pub fn without_link(out: &str) -> String {
    out.lines()
        .filter(|l| !l.trim_start().starts_with("Dashboard:") && !l.contains("?t="))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dashboard_is_one_origin() {
        let o = Some("http://127.0.0.1:4317");
        assert!(same_origin(&Url::parse("http://127.0.0.1:4317/#/chat").unwrap(), o));
        assert!(!same_origin(&Url::parse("http://127.0.0.1:4318/preview/x").unwrap(), o));
        assert!(!same_origin(&Url::parse("http://localhost:4317/").unwrap(), o));
        assert!(!same_origin(&Url::parse("https://127.0.0.1:4317/").unwrap(), o));
        assert!(!same_origin(&Url::parse("http://127.0.0.1:4317/").unwrap(), None));
    }

    #[test]
    fn only_web_links_leave() {
        assert!(may_hand_off(&Url::parse("https://ollama.com/connect?x=1").unwrap()));
        assert!(may_hand_off(&Url::parse("http://example.com/").unwrap()));
        for u in ["mailto:a@b.c", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "ssh://host", "about:blank"] {
            assert!(!may_hand_off(&Url::parse(u).unwrap()), "{u}");
        }
    }

    #[test]
    fn hand_offs_are_rate_limited_and_deduplicated() {
        let mut h = HandOffs::new();
        let t = Instant::now();
        assert!(h.allow("https://a/", t));
        assert!(!h.allow("https://a/", t + Duration::from_secs(1)), "same address twice");
        assert!(h.allow("https://b/", t));
        assert!(h.allow("https://c/", t));
        assert!(h.allow("https://d/", t));
        assert!(!h.allow("https://e/", t), "a fifth within the window");
        assert!(h.allow("https://e/", t + HAND_OFF_WINDOW + Duration::from_secs(1)), "after the window");
        assert!(h.allow("https://a/", t + HAND_OFF_WINDOW + Duration::from_secs(1)));
    }

    #[test]
    fn exec_arguments_follow_the_spec() {
        assert_eq!(exec_arg("/home/a/bin/buddi").unwrap(), "\"/home/a/bin/buddi\"");
        assert_eq!(exec_arg("/a b/x").unwrap(), "\"/a b/x\"");
        assert_eq!(exec_arg("/a\"b").unwrap(), "\"/a\\\\\"b\"");
        assert_eq!(exec_arg("/a$b`c").unwrap(), "\"/a\\\\$b\\\\`c\"");
        assert_eq!(exec_arg("/a\\b").unwrap(), "\"/a\\\\\\\\b\"");
        assert_eq!(exec_arg("/100%/x").unwrap(), "\"/100%%/x\"");
        assert!(exec_arg("/a\nb").is_none());
    }

    #[test]
    fn downloads_never_overwrite_or_escape() {
        let dir = std::env::temp_dir().join(format!("buddi-desktop-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(downloads_path(&dir, "a.txt"), dir.join("a.txt"));
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        assert_eq!(downloads_path(&dir, "a.txt"), dir.join("a 2.txt"));
        std::fs::write(dir.join("a 2.txt"), "x").unwrap();
        assert_eq!(downloads_path(&dir, "a.txt"), dir.join("a 3.txt"));
        assert_eq!(downloads_path(&dir, "../../etc/passwd"), dir.join(".._.._etc_passwd"));
        assert_eq!(downloads_path(&dir, ".."), dir.join("download"));
        std::fs::write(dir.join("README"), "x").unwrap();
        assert_eq!(downloads_path(&dir, "README"), dir.join("README 2"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_link_stays_out_of_the_words() {
        let out = "Starting buddi.\nDashboard: http://127.0.0.1:4317/?t=secret\nThe link is good for five minutes.";
        assert_eq!(without_link(out), "Starting buddi.\nThe link is good for five minutes.");
    }
}
