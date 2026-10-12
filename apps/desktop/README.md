# buddi-desktop (Linux and Windows)

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
  then `PATH`. That command decides the installation: its data folder (the
  wrapper's `DATA='…'` line) is the one the supervisor socket, the releases,
  Start at Login and the service actions use.
- **One origin.** The dashboard is the exact origin of the last sign-in link
  (scheme, host, port). Another port on this computer (the gateway's preview
  origin, any other local server) is not: it may load in a frame of the
  dashboard, but as the page it goes to the browser and the window goes back.
  Every command the pages can call checks the calling page's origin
  (`main.rs`), and the microphone is granted only to it.
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
  app: a click, not a frame loading (on Linux the app decides each navigation
  itself, `platform/linux.rs`, since WebKitGTK says whether a person clicked);
  http(s) only; at most four in ten seconds and the same address once; a
  launcher that fails is retried with gio and then said in a notification.
  A blank window the page never points anywhere is closed after a minute. Downloads go to `~/Downloads` (`name 2.ext` for a second copy), with a
  notification. The file picker is the system's.
- **Diagnostics**: `BUDDI_SHELL_DEBUG=1 buddi-desktop` forwards the page's
  console errors to stderr, turns on the inspector, and lets a second launch
  run JavaScript in the window: `buddi-desktop --eval '<js>'`. Without the
  variable, `--eval` is ignored. A second launch reaches the first over the
  session bus, so with the variable set any process of this user can run
  JavaScript in the signed-in dashboard: set it only by hand, in a terminal,
  never in a desktop or autostart entry.

## Build

Linux, with Rust (rustup) and:

```sh
sudo apt install build-essential file patchelf libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pulseaudio gstreamer1.0-pipewire
cd apps/desktop
npx @tauri-apps/cli@2.12.2 build       # .deb and AppImage under target/release/bundle/
npx @tauri-apps/cli@2.12.2 build --bundles deb
cargo test                             # the rules in src/policy.rs and the entry ownership
cargo build --release && ./target/release/buddi-desktop   # just the binary
```

`rust-toolchain.toml` pins Rust; the CLI version matches the `tauri` crates
in `Cargo.lock`. The AppImage carries GStreamer (`bundleMediaFramework`): without it the
microphone finds no device. That needs `patchelf` on the build machine.
`scripts/make-icons.sh` copies the app icon from buddi.app's asset catalog
(librsvg does not draw `app-icon.svg`'s figure: an earlier build shipped a
blank tile) and redraws the tray glyphs from `apps/mac/Design`.

The release workflow's `desktop` job builds both for x64 and arm64 on Ubuntu
22.04 from the tag and attaches them to the GitHub release
(`buddi-desktop-<version>-linux-<arch>.deb` / `.AppImage`, with `.sha256`).

## Packaging

- `.deb` `buddi-desktop` (a prerelease is versioned `0.1.0~pre.N`):
  `/usr/bin/buddi-desktop`, the app-grid entry (`linux/buddi-desktop.desktop`,
  Name=buddi, with New Conversation, Check for Updates and Lock), the icon in
  hicolor. No autostart for every user: Start at Login is per account, turned
  on at the first launch (unless an entry is there already) and from the
  menu. Started with `--hidden` and no buddi installed, or with no tray, the
  app exits instead of running unseen. Depends on the system's WebKitGTK 4.1
  and Ayatana AppIndicator.
- `install.sh` (no sudo) writes `~/.local/share/applications/buddi-desktop.desktop`
  (the same file name, so one "buddi" in the grid: it starts the desktop app
  when it is on PATH, else `buddi dashboard`) and, when the desktop app is on
  PATH, `~/.config/autostart/buddi-desktop.desktop`. Each entry names its
  installation (`X-Buddi-Data=<data folder>`). install.sh writes over only a
  marked entry (`X-Buddi-Linux-Install=true`) of the same installation, the
  app's Start at Login only an entry of its installation, neither through a
  link, and `buddi uninstall` removes exactly the entries naming its data
  folder: one the owner wrote, or another installation's, stays. A command
  path with characters Exec quotes is written escaped by the spec (and
  without the right-click actions).
- Updates: the .deb by the next .deb (an apt repository is not there yet), the
  AppImage by the next AppImage. The app rarely changes; buddi updates itself
  underneath it.

## Windows

The same Rust on WebView2; what differs is `src/platform/windows.rs`, its
rules as plain tested functions in `src/platform/windows_rules.rs`.

- **Shipped inside the Windows setup** (apps/windows/buddi.iss): one download,
  buddi and its window. `buddi-desktop.exe` sits in
  `%LOCALAPPDATA%\Programs\buddi` beside `bin\buddi.cmd`, which is the command
  it runs (then `$BUDDI_BIN`, the setup's `installer.json`, PATH); the data
  folder is the one `buddi.cmd` names. The Start menu's "buddi" opens the app
  (AppUserModelID `com.withbuddi.desktop`); a setup over a running app asks it
  to quit (`buddi-desktop.exe --quit`) and starts it again; the uninstaller
  quits it and removes it, its WebView2 profile and its Run entry. buddi's
  own service stays the Task Scheduler task: the app replaces nothing of it.
- **WebView2**: part of Windows 11; on Windows 10 without it the setup runs
  Microsoft's Evergreen bootstrapper (carried in the setup, checked to be
  signed by Microsoft when it is fetched).
- **Permissions**: WebView2's `PermissionRequested`, by the requesting
  frame's address: the microphone (and notifications) for the dashboard's
  exact origin, everything else denied without a prompt.
- **Notifications**: toasts under the AppUserModelID; a click brings the window.
- **Tray**: a left click opens the window, a right click the menu (the same
  menu as Linux, with "Uninstall buddi…" saying the app goes too). Ink from
  `HKCU\…\Themes\Personalize\SystemUsesLightTheme`, read at start.
- **Start at Login**: `HKCU\…\Run\buddi = "<exe>" --hidden`, on at the first
  start. What the app wrote, and for which data folder, is recorded in
  `HKCU\Software\buddi\Desktop`; the app changes, and the uninstaller removes,
  only a Run value that matches that record. Turning it on again clears a
  "disabled" switch in Settings → Apps → Startup.
- **The supervisor's control channel**: the named pipe whose random name and
  secret are in `<data>\supervisor.pipe`, used only while `supervisor.lock`
  names a live process, and an answer counts only when its
  `x-buddi-supervisor` header is that secret (packages/install/src/supervisor.ts).
  Check for Updates, the version, Restart buddi (`/restart`, then `buddi
  service restart` if the pipe does not answer) and the previous version
  (`/exit`, the junctions swapped under the releases lock, then started by the
  next sign-in link) go through it.
- **No console windows**: `buddi.cmd` runs with `CREATE_NO_WINDOW`; links go
  to the default browser through the shell.
- **Log**: `%LOCALAPPDATA%\com.withbuddi.desktop\desktop.log` (a windowed
  program has no stderr).
- **Build**: on Windows, `scripts/release/windows-desktop.sh <version>` (the
  pinned toolchain and CLI, `--no-bundle`); the release's `windows` job and
  `windows.yml` with `installer` on run it, with `cargo test` and clippy first.
  From a Mac: `cargo xwin build --release --target x86_64-pc-windows-msvc
  --features tauri/custom-protocol` (rustup's Windows target and cargo-xwin).
  x64 only: it runs emulated on Windows on Arm, as the bundled node does.
- **Signing**: the setup's one SignTool hook signs the app too (`signonce`).
