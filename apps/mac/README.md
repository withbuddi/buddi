# buddi.app (macOS)

A small native Mac app that runs buddi with nothing to install: it carries
Node, the `@withbuddi/buddi` release from npm and the embedded Postgres, and
supervises them. The dashboard lives in the app's own window (WKWebView, what
Tauri does, without a second runtime); the menu-bar glyph shows the state. No Electron. Spec: `buddi-planning/specs/distribution.md`. The recipe (XcodeGen,
Makefile, signing, notarizing, Sparkle) is copied from Shotcrisp.

**Phase 2**: buddi updates itself from inside the app (outside the signed bundle), and
the release workflow builds, notarizes and publishes the DMG once the signing secrets
are in the repository. Until then you build it locally, as below.

## Build and run

Needs Xcode (macOS 14 SDK or newer), `brew install xcodegen`, `curl`, and `npm`
(only to look up the latest version).

```sh
cd apps/mac
make fetch VERSION=0.1.0-pre.38   # Node + the buddi release into Payload/ (about 700 MB)
make build                        # Debug build: build/Build/Products/Debug/buddi.app
make run                          # build, then open it from build/
```

`make run` uses the real data folder, `~/Library/Application Support/buddi`. To
try it next to a buddi that is already running, give it a scratch folder and a
free port. The port only counts on the first run, and the path must be short
(the control socket path has a 104-byte limit, so use `$TMPDIR`, not a deep folder):

```sh
make run BUDDI_DATA_DIR=$(mktemp -d) BUDDI_WEB_PORT=4517
make stop                          # quits the app, which stops buddi properly
```

A scratch folder gets its own keychain namespace (`buddi.install.<hash>`, named after
the folder), so its keychain items stay behind after you delete the folder.

`make help` lists every target. `make release`, `make notarize` and `make dmg` need
the signing environment below.

## The window

**Phase 3** (open question 4 in the spec): a regular app with a dock icon, the menu
bar and a main window that hosts the dashboard (`App/MainWindow*.swift`, `App/MainMenu.swift`).

- **What it loads**: the same five-minute sign-in link Open in Browser uses (`buddi
  --no-service --no-open`, `Supervisor.dashboardLink`), so first run and the lock
  screen are simply pages in it. When buddi opens the dashboard by itself (the first
  run), `Supervisor.presentDashboard` sends it to the window, never to a browser tab.
  The session cookie lives in WebKit's default data store, as in a browser.
- **Startup**: the window opens at launch on a native placeholder (the kit's `--bg`,
  the mascot from `packages/web/public/mascot/core.png`, "Starting buddi…") and loads
  the dashboard once the gateway answers. When the gateway goes away (a restart, an
  update) the placeholder comes back and the page reloads on the same route; "Needs
  attention" says why in a sentence, with Show Logs and Restart buddi.
- **The window**: title "buddi", full-size content view with the standard traffic
  lights over a strip of the kit's ground (the page starts below it), size and position
  remembered (`buddi.main` autosave), minimum 721 × 560 (one pixel above the dashboard's
  phone breakpoint, so it always gets the desktop layout), light and dark from the
  system. ⌘W and the close button hide it; the dock icon, the glyph's Open buddi and
  Window → buddi bring it back. Quit is in the app menu and the glyph.
- **The menu bar**: buddi (About, Check for Updates…, Settings… ⌘, → `#/settings`,
  Lock ⌃⌘L → the page's own lock shortcut, Services, Hide, Quit); File (New Conversation
  ⌘N → `#/chat/<agent>/new` for the agent on screen or the default one, Open in Browser
  ⌥⌘O); Edit (undo, cut/copy/paste, select all, Find ⌘F / ⌘G / ⇧⌘G, a native find bar
  over WKWebView's `find`); View (Reload ⌘R, Actual Size / Zoom In / Zoom Out, Enter
  Full Screen); Window (Minimize, Zoom, Bring All to Front); Help (buddi Help →
  withbuddi.com/docs, Report a Problem → GitHub issues).
- **The web view**: microphone and camera prompts (granted for the dashboard's origin;
  macOS asks once, with the usage strings in `project.yml`, and the hardened runtime
  needs `com.apple.security.device.audio-input` / `camera` in `App/buddi.entitlements`);
  downloads land in `~/Downloads` (a second copy is `name 2.ext`) and are shown in
  Finder; `<input type=file>` opens the standard panel; `alert`/`confirm`/`prompt` are
  sheets; `window.open` and links off the dashboard's origin open in the default browser
  (the dashboard's own popups get a plain window); the clipboard is WebKit's; page zoom
  is kept across launches. `window.Notification` is replaced by a small bridge to
  UNUserNotificationCenter (banners only while the window is not in front). The
  dashboard does not use Web Notifications today (it draws its own toasts, and a hidden
  window reads as away, so news goes to the channel), so the bridge is there for when it does.
- **The glyph**: still the state; Open buddi focuses the window, Advanced → Open in
  Browser opens the dashboard in the default browser as before.

What stays in Chrome by nature: the "your Chrome" route and its extension, and
third-party sign-ins (they open in the default browser).

Screenshots: `docs/window-*.png` (light and dark).

## Environment

The same names as Shotcrisp:

| Variable | Used by | What |
| --- | --- | --- |
| `DEVELOPMENT_TEAM` | build, release, notarize | Apple team id. Without it, `make build` signs ad-hoc ("Sign to Run Locally"). |
| `APPLE_ID` | notarize, dmg | Apple ID that submits to the notary service. |
| `NOTARIZE_PASSWORD` | notarize, dmg | App-specific password for that Apple ID. |

The "Developer ID Application" certificate must be in the keychain for `release`.

## What is in the bundle

```
buddi.app/Contents/
  MacOS/buddi                        the Swift supervisor (menu-bar item)
  Frameworks/Sparkle.framework       updates of the app itself
  Resources/runtime/node             Node 22 LTS, universal (lipo of the arm64 and x64 builds)
  Resources/runtime/npm, npx, lib/   npm beside node: plugin installs use it
  Resources/buddi/current            -> buddi-<version>/
  Resources/buddi/buddi-<version>/   the npm tarball, unpacked; its dependencies come
                                     bundled, plus @embedded-postgres/darwin-arm64 AND
                                     darwin-x64 (npm would fetch only this Mac's one),
                                     with their postinstall (hydrate-symlinks) run at fetch
  Resources/buddi/package.json       a named manifest: a second guard against npm ever
                                     writing into the signed bundle; upgrades go to
                                     <data>/releases (see "Updates" below)
```

`make fetch` checks every download before it unpacks it: Node against its
`SHASUMS256.txt`, each npm tarball against the sha512 `integrity` in its packument.

## How it runs buddi

The app is one more packaged installation, the same as `npm install -g @withbuddi/buddi`:

- It starts the command the npm install's LaunchAgent runs:
  `node <release>/packages/install/dist/launcher.js supervise`, with `BUDDI_DATA_DIR`,
  launchd's minimal environment and PATH, the data folder as working directory, and
  output appended to `logs/supervisor.log`.
- Same data folder (`~/Library/Application Support/buddi`), so the same keychain
  namespace and LaunchAgent label, both derived from the folder path.
- The supervisor keeps Postgres and the gateway running, as it always does. The app
  keeps the supervisor running: it restarts it after a crash with the supervisor's
  own backoff (4 s, 8 s, 16 s, then every 30 s) and reads `/status` from
  `<data>/supervisor.sock` every two seconds for the menu.
- **Open buddi** brings the window forward (see "The window"); Advanced → **Open in
  Browser** asks the same launcher for the dashboard link (`buddi --no-open
  --no-service`, the five-minute sign-in link `buddi` prints) and opens it in the
  default browser.
- **Quit** sends SIGTERM, the supervisor's orderly shutdown (gateway, then Postgres).

**Taking over from npm.** If the npm install's LaunchAgent exists for the same data
folder, the first launch asks once whether to take over. Yes runs `launchctl bootout`
on it, moves its plist to `<data>/launchagent-from-npm.plist`, waits for the old
supervisor to stop, and starts buddi from the app. Data is never touched. The dialog
says `npm rm -g @withbuddi/buddi` can be run later. No starts the app in "Needs
attention" (another buddi holds the folder), and the menu offers Take Over until it's done.

## Versions

The app is versioned as the buddi release it carries: `CFBundleShortVersionString` is
the buddi version (`0.1.0-pre.39`) and `CFBundleVersion`, which Sparkle compares and
which must be numbers and dots, comes from `scripts/release/bundle-version.mjs`:
`0.1.0-pre.39` → `0.1.0.39`, and a final `0.1.0` → `0.1.0.1000`, above every pre of
it. The Makefile reads the version from `Payload/buddi/current/package.json` and passes
both; `make version` prints them. The release workflow uses the same script, and
`ReleaseVersion` in `App/BundleLayout.swift` is the same mapping.

## Updates

Two layers, as in the spec.

**buddi itself**, from inside the app. The app starts its supervisor with
`BUDDI_APP_LAYOUT=<data>/releases`, and an upgrade (Settings → System, the menu's
"Update to …", or `buddi upgrade`) then never touches the signed bundle
(`packages/install/src/app-layout.ts`):

1. It reads the version's packument (the sha512 `integrity` and the provenance URL),
   runs `npm install --prefix <data>/releases/.staging-<v>-<random> @withbuddi/buddi@<v>
   --ignore-scripts` with the bundled npm, and checks that the integrity npm recorded
   in its lock is the registry's.
2. `npm audit signatures --include-attestations` verifies the registry signature and the
   sigstore bundles with npm's own sigstore client (Node 22's npm reports only what is
   invalid or missing). Then `provenance.ts` checks who signed: the SLSA bundle chains
   to Fulcio, its signature verifies, its subject is the tarball's sha512, and its
   certificate names `withbuddi/buddi`'s `release.yml` at this version's tag. From
   npmjs.com a release without provenance is refused. `release.json` records what was
   verified.
3. The new release's Postgres has to start (`postgres --version`, after hydrating its
   dylib links: the one install script the release needs). Only then is the staging
   folder renamed to `buddi-<v>`; a `buddi-<v>` that `current` or `previous` already
   points at (a retry after a rollback) is kept as it is.
4. Only then: the backup, the gateway stops, `<data>/releases/current` points at the new
   release and `previous` at the one that ran, release folders neither points at are
   removed, and the supervisor exits with status 75. The app starts whatever `current` points at;
   the new supervisor migrates and finishes the upgrade as on any packaged install.

Everything before step 4 happens with buddi still running, and a failure there changes
nothing. The bundle's own copy is never written to and stays the fallback: no
`current`, or a `current` that does not resolve, runs the bundle's copy. An app update
that carries a newer buddi than `current` (Sparkle, or a newer DMG) moves `current` to
the bundle's copy once, at its first launch.

**Going back**: Advanced → Restart with the Previous Version (`<v>`) stops buddi,
points `current` at `previous` (or at the bundle's copy) and starts it. The data is not
touched; if the newer version already migrated the database, the older one refuses
to start, and the backup the upgrade took is what goes back with it (Settings →
Backups).

**The app**: Sparkle, with the feed at `https://withbuddi.com/appcast.xml`. It stays
off until `SUPublicEDKey` in `project.yml` holds a real key. Generate the key pair once:
`build/SourcePackages/artifacts/sparkle/Sparkle/bin/generate_keys` (after a build, which
resolves the Sparkle package). It stores the private key in your login keychain and
prints the public key. Then export the private key with `generate_keys -x <file>` into
the `SPARKLE_PRIVATE_KEY` secret.

## Releasing

The `mac-app` job in `.github/workflows/release.yml` runs after the npm publish of a
tag: it waits until npm serves the tarball, `make fetch VERSION=<tag>`, imports the
Developer ID certificate, `make notarize`, `make dmg`, signs the DMG with Sparkle's
`sign_update`, writes `appcast.xml` and `latest.json` (`{version, file, sha256,
bundleVersion}`, `scripts/release/appcast.mjs`), attaches all three to the GitHub
release and uploads them to R2. The npm release is out by then, so a failed run is
repeated on its own: Actions → release → Run workflow, with the version.

| Secret | What |
| --- | --- |
| `MACOS_CERTIFICATE` | base64 of the "Developer ID Application" certificate (.p12) |
| `MACOS_CERTIFICATE_PASSWORD` | its password |
| `APPLE_ID`, `DEVELOPMENT_TEAM`, `NOTARIZE_PASSWORD` | as in the table above |
| `SPARKLE_PRIVATE_KEY` | `generate_keys -x` output |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | R2 write on the bucket; without them the DMG is on the GitHub release only |

Variable `R2_BUCKET` (optional, `buddi-releases` by default). Without the first six
secrets the job is skipped with a notice. In the bucket:

```
mac/buddi-<version>.dmg   every release
mac/latest.json           the newest one npm calls latest
mac/appcast.xml           its Sparkle feed
```

buddi-site's worker serves them: `withbuddi.com/download/mac` redirects to
`/download/mac/buddi-<version>.dmg` (from `latest.json`), and `/appcast.xml` is the
feed. A pre-release that npm puts under `next` (once a stable release exists) is
uploaded and attached, and neither pointer moves.

## Not built yet

- "Install command line tool" (`Contents/Resources/bin/buddi`) and a richer status
  line (agents, last update).
- A real app icon (today it's the web `apple-touch-icon` scaled up, as a placeholder).
- A release of buddi that needs a newer Node than the bundled one waits for an app
  update; the upgrade does not check `engines.node` yet.
