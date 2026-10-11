# buddi-desktop (Linux; Windows later)

buddi's desktop app: the dashboard in a window of its own and a tray icon,
around the buddi that `scripts/install.sh` installed. Tauri v2 on the system
web view (WebKitGTK 4.1 on Linux, WebView2 on Windows), a few hundred lines of
Rust, no frontend framework. The Mac has its own, `apps/mac` (WKWebView, and it
carries buddi itself); this one never runs a buddi of its own.

## What it does

- **Signing in.** It runs `buddi --no-open` and loads the `Dashboard:` link,
  the five-minute ticket a terminal gets. Like `buddi` in a terminal, that
  starts the service when it is not running. The command is found at
  `$BUDDI_BIN`, then the one `installer.json` records, then `~/.local/bin/buddi`,
  then `PATH`.
- **The window's phases** (`src/shell.rs`), after buddi.app's
  `MainWindowController`: "Starting buddi…" while a link is on its way; the
  dashboard; back to "Starting buddi…" when the gateway's port stops answering
  (a restart, an upgrade), then the same route with a fresh link once it
  answers; "buddi needs attention" with the command's own words after two
  failed tries (Try Again, Start buddi); "buddi is stopped" after Stop; "buddi
  is not installed" with the install line when there is no command (it looks
  again every ten seconds). A 401 from the dashboard's own API (an expired
  session) gets a fresh link on the same route, without the placeholder.
- **Tray menu** (`src/tray.rs`, `src/actions.rs`). Linux has no menu bar, so
  the tray menu is buddi.app's menu-bar glyph menu and app menu in one, in the
  Mac's words and order: the status line (Running since 11:19, Starting…,
  Stopped, Updating…, Needs attention); Open buddi, New Conversation,
  Settings…; Update to <v> (when the supervisor knows of one) and Check for
  Updates… (the supervisor's `/version/check` on its control socket, then the
  same `buddi upgrade <v>` as Settings → System, with "Updating buddi…" in the
  window and the result as a notification); Restart buddi (`buddi service
  restart`), Stop/Start buddi, Lock buddi (the dashboard's own Ctrl+Alt+L:
  the lock screen, or Settings → Lock screen without a PIN), Start at Login
  (a check box over the autostart entry); Advanced ▸ Open in Browser, Show
  Logs, Restart with the Previous Version (<v>)… (`releases/previous`, as
  buddi.app's rollback: the service stopped, the links swapped, started);
  Help ▸ buddi Help, Report a Problem…; About buddi (both versions, the
  command and the data folder); Uninstall buddi… (after a confirm, the
  dashboard's own Settings → System removal: the last backup and its
  passphrase before anything goes); Quit (the app only: buddi keeps running).
  The launcher's right-click menu has New Conversation, Check for Updates and
  Lock buddi (`--new-conversation`, `--check-updates`, `--lock`; `--settings`
  too).
  - Not mirrored: Install Command Line Tool (the Linux install puts `buddi` in
    ~/.local/bin; About shows where), Take Over from npm Install (install.sh
    moves an npm install over), Services / Hide / Show All / Bring All to
    Front (macOS only), Edit and Find (the web view's own Ctrl+C/V/A/Z work;
    there is no find bar), View → Zoom and Full Screen (no menu bar to hold
    them; WebKitGTK has no zoom shortcuts by itself), and the Sparkle check for
    a new app (the .deb/AppImage is updated by the next .deb/AppImage).
- **Tray icon**: the glyph is buddi.app's menu-bar glyph per
  state (running, starting/stopped, attention), light ink for dark panels
  (GNOME, Pop!_OS, Ubuntu, COSMIC) and dark ink for light ones (KDE with a
  light scheme); `BUDDI_TRAY_INK=dark|light` overrides. The indicator gets
  the icon as a file and GNOME's AppIndicator extension caches pictures by file
  name, so the tray's id carries a hash of the pixels: a new glyph is a new
  name. (Tauri's tray takes pixels, not an icon-theme name, so there is no
  themed tray icon to install.)
- **Window**: closing hides it to the tray; size, position and maximized are
  remembered (`tauri-plugin-window-state`); one instance, a second launch
  brings the window forward; `--hidden` starts in the tray (the autostart
  entry).
- **Permissions**: the microphone (not the camera) for the dashboard's own
  origin, and nothing else for anyone. `window.Notification` in the dashboard
  is a bridge to desktop notifications named "buddi" (WebKitGTK would ask only
  inside a click and name them after its web process). Links off the
  dashboard, `target=_blank` and `window.open` (the sign-in tabs the dashboard
  opens blank and points afterwards) open in the default browser, never in the
  app. Downloads go to `~/Downloads` (`name 2.ext` for a second copy), with a
  notification. The file picker is the system's.
- **Diagnostics**: `BUDDI_SHELL_DEBUG=1 buddi-desktop` forwards the page's
  console errors to stderr, turns on the inspector, and lets a second launch
  run JavaScript in the window: `buddi-desktop --eval '<js>'`. Without the
  variable, `--eval` is ignored.

## Build

Linux, with Rust (rustup) and:

```sh
sudo apt install build-essential file patchelf libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pulseaudio gstreamer1.0-pipewire
cd apps/desktop
npx @tauri-apps/cli@2 build            # .deb and AppImage under target/release/bundle/
npx @tauri-apps/cli@2 build --bundles deb
cargo build --release && ./target/release/buddi-desktop   # just the binary
```

The AppImage carries GStreamer (`bundleMediaFramework`): without it the
microphone finds no device. That needs `patchelf` on the build machine.
`scripts/make-icons.sh` copies the app icon from buddi.app's asset catalog
(librsvg does not draw `app-icon.svg`'s figure: an earlier build shipped a
blank tile) and redraws the tray glyphs from `apps/mac/Design`.

The release workflow's `desktop` job builds both for x64 and arm64 on Ubuntu
22.04 from the tag and attaches them to the GitHub release
(`buddi-desktop-<version>-linux-<arch>.deb` / `.AppImage`, with `.sha256`).

## Packaging

- `.deb` `buddi-desktop`: `/usr/bin/buddi-desktop`, the app-grid entry
  (`linux/buddi-desktop.desktop`, Name=buddi), the autostart entry
  (`/etc/xdg/autostart/buddi-desktop.desktop`, `--hidden`, `TryExec`), the
  icon in hicolor. Depends on the system's WebKitGTK 4.1 and Ayatana
  AppIndicator.
- `install.sh` (no sudo) writes `~/.local/share/applications/buddi-desktop.desktop`
  (the same file name, so one "buddi" in the grid: it starts the desktop app
  when it is on PATH, else `buddi dashboard`) and, when the desktop app is on
  PATH, `~/.config/autostart/buddi-desktop.desktop`. Only files carrying
  `X-Buddi-Linux-Install=true` are written over or removed by `buddi
  uninstall`, so an entry the owner turned off stays off.
- Updates: the .deb by the next .deb (an apt repository is not there yet), the
  AppImage by the next AppImage. The app rarely changes; buddi updates itself
  underneath it.

## Windows

The Rust is split so a WebView2 build reuses it: `src/buddi.rs` (the
command), `src/shell.rs` (the phases), `src/tray.rs` and `src/main.rs` are
platform-free; what differs is in `src/platform/` (`linux.rs`, and
`windows.rs` with the gaps marked `TODO(windows)`). A Windows build needs:

- **buddi on Windows first**: a `buddi` command (`buddi.cmd` on PATH, or
  `$BUDDI_BIN`) and a service; the app only wraps it.
- **Permissions**: `ICoreWebView2::add_PermissionRequested` through
  `with_webview`, allowing MICROPHONE (and NOTIFICATIONS) for the dashboard's
  origin and denying the rest.
- **Notifications**: a toast under the app's AppUserModelID (set by the
  installer); `notify-rust` or `tauri-plugin-notification` do it.
- **Tray ink**: light or dark from
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\SystemUsesLightTheme`.
- **The local page** is `http://tauri.localhost/index.html` (done in `windows.rs`).
- **Packaging**: Tauri's NSIS or MSI bundle with the WebView2 bootstrapper,
  code-signed; autostart through the installer (a Run key or Startup shortcut
  with `--hidden`).
