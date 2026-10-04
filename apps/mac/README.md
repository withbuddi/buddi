# buddi.app (macOS)

A small native menu-bar app that runs buddi with nothing to install: it carries
Node, the `@withbuddi/buddi` release from npm and the embedded Postgres, and
supervises them. No Electron and no window: the dashboard opens in the default
browser. Spec: `buddi-planning/specs/distribution.md`. The recipe (XcodeGen,
Makefile, signing, notarizing, Sparkle) is copied from Shotcrisp.

This is **phase 1**: you can build it locally and run it. It is not distributed yet.

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
  Resources/buddi/package.json       a named manifest: it makes the supervisor refuse a
                                     self-upgrade with npm (that would write into the
                                     signed bundle); see "Updates" below
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
- **Open buddi** asks the same launcher for the dashboard link (`buddi --no-open
  --no-service`, the five-minute sign-in link `buddi` prints) and opens it. On a first
  run it opens by itself as soon as buddi is up, so the first-run chapters appear.
- **Quit** sends SIGTERM, the supervisor's orderly shutdown (gateway, then Postgres).

**Taking over from npm.** If the npm install's LaunchAgent exists for the same data
folder, the first launch asks once whether to take over. Yes runs `launchctl bootout`
on it, moves its plist to `<data>/launchagent-from-npm.plist`, waits for the old
supervisor to stop, and starts buddi from the app. Data is never touched. The dialog
says `npm rm -g @withbuddi/buddi` can be run later. No starts the app in "Needs
attention" (another buddi holds the folder), and the menu offers Take Over until it's done.

## Updates

- **The app**: Sparkle, with the feed at `https://withbuddi.com/appcast.xml`. It stays
  off until `SUPublicEDKey` in `project.yml` holds a real key. Generate the key pair once:
  `build/SourcePackages/artifacts/sparkle/Sparkle/bin/generate_keys` (after a build, which
  resolves the Sparkle package). It stores the private key in your login keychain and
  prints the public key. Then export the private key with `generate_keys -x <file>` into
  the `SPARKLE_PRIVATE_KEY` secret.
- **buddi itself**: Check for Updates calls the supervisor's `/version/check`, the same
  call Settings → System makes, and the menu shows "Update to <version>" when one is
  available. In phase 1 that item only explains that the next app build brings it: the
  release sits inside the signed bundle, and the supervisor's npm upgrade is refused
  there on purpose.

## Phase 2 (not built yet)

- A `mac-app` job in `.github/workflows/release.yml`, after the npm publish: `make fetch
  VERSION=<tag>`, import the Developer ID certificate, `make notarize`, `make dmg`, upload
  the DMG as a release asset, sign it with `sign_update` and publish `appcast.xml`. Same
  steps as Shotcrisp's workflow. If signing fails, the job fails and can be re-run; the
  npm release is already out.
- An in-app updater for buddi: download the next tarball, verify its integrity and
  provenance, unpack it outside the signed bundle (for example
  `~/Library/Application Support/buddi/releases/buddi-<v>`), point `current` there,
  restart. The supervisor's upgrade path and Settings → System need to know about it
  (today they refuse because of the guard manifest, with the wrong message).
- The CFBundleVersion scheme. Sparkle needs numbers and dots, and buddi versions look
  like `0.1.0-pre.38`.
- The site's "Download for Mac" button, a real app icon (today it's the web
  `apple-touch-icon` scaled up, as a placeholder), "Install command line tool"
  (`Contents/Resources/bin/buddi`), and a richer status line (agents, last update).
