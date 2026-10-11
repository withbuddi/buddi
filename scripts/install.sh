#!/bin/sh
# buddi — install on Linux, with nothing from the host but a shell and systemd.
#
#   curl -fsSL https://withbuddi.com/install.sh | sh
#   wget -qO- https://withbuddi.com/install.sh | sh     (Ubuntu desktop ships wget, not curl)
#
# Downloads the self-contained tarball for this machine (Node and npm, buddi,
# its embedded Postgres; scripts/release/linux-bundle.sh builds it), checks its
# sha256, and puts it where buddi.app's layout has it (packages/install/src/
# app-layout.ts), under your own account, no sudo:
#
#   ~/.local/share/buddi/node/               Node and npm (the host's node is never used)
#   ~/.local/share/buddi/releases/buddi-<v>/ the release; `current` and `previous` link into them
#   ~/.local/bin/buddi                       the command
#   ~/.config/systemd/user/com.buddi.install.<id>.service   the service (written by `buddi`)
#   ~/.local/share/applications/buddi-desktop.desktop       buddi in the app grid
#   ~/.config/autostart/buddi-desktop.desktop               the desktop app in the tray from
#                                                           login (only when it is installed)
#
# Running it again upgrades (or reinstalls) in place. Whenever there is data
# already, a new version starts only after a backup of it succeeded, and the
# switch is recorded the way buddi's own upgrade records it, so a failed
# migration says how to get back. buddi also upgrades itself from the
# dashboard or with `buddi upgrade`; this script is what also brings a newer
# Node. `buddi uninstall` removes it all.
#
# Settings, all optional:
#   BUDDI_VERSION=0.1.0-pre.53   a version instead of the newest
#   BUDDI_TARBALL=<file>         a tarball on disk instead of a download
#   BUDDI_DATA_DIR=<dir>         where buddi lives (default ~/.local/share/buddi)
#   BUDDI_BIN_DIR=<dir>          where the command goes (default ~/.local/bin)
#   BUDDI_WEB_PORT=<port>        the dashboard's port on a first install (default 4317)
#   BUDDI_NO_START=1             install, but leave the service alone
#   BUDDI_SKIP_BACKUP=1          go on without the backup of existing data (not advised)
#
# Everything runs from `main` on the last line: a download cut short runs nothing.
set -eu

REPO_URL="${BUDDI_DOWNLOAD_BASE:-https://github.com/withbuddi/buddi/releases/download}"
REGISTRY="${BUDDI_REGISTRY:-https://registry.npmjs.org}"
MARKER='# buddi-linux-install: written by https://withbuddi.com/install.sh'
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'

if [ -t 1 ]; then B=$(printf '\033[1m'); D=$(printf '\033[2m'); R=$(printf '\033[31m'); N=$(printf '\033[0m'); else B=''; D=''; R=''; N=''; fi
say() { printf '%s%s%s\n' "$B" "$*" "$N"; }
note() { printf '  %s\n' "$*"; }
dim() { printf '%s  %s%s\n' "$D" "$*" "$N"; }
die() { printf '%sbuddi install: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# A folder's real path (links resolved), or nothing when it is not there.
resolve() { (cd "$1" 2>/dev/null && pwd -P) || true; }
# Is <dir> (resolved) <root> or inside it?
inside() { [ -n "$1" ] && [ -n "$2" ] && case "$1/" in "$2"/*) true;; *) false;; esac; }
# A symlink replaced in one rename.
link() { ln -s "$1" "$2.tmp-$$" && mv -f -T "$2.tmp-$$" "$2"; }
# Is this path owned by this account?
owned() { [ "$(stat -c %u "$1" 2>/dev/null)" = "$(id -u)" ]; }
# sh's single quotes around a value.
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

fetch() { # <url> <file>
  case "$1" in https://*) https=1 ;; *) https=0 ;; esac
  if command -v curl >/dev/null 2>&1; then
    if [ "$https" = 1 ]; then curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1"; else curl -fsSL --retry 3 -o "$2" "$1"; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ "$https" = 1 ]; then wget -q --https-only --tries=3 -O "$2" "$1"; else wget -q --tries=3 -O "$2" "$1"; fi
  else die "curl or wget is needed to download buddi."; fi
}

# The desktop, without sudo. "buddi" in the app grid opens the desktop app
# (the buddi-desktop .deb or AppImage on PATH) when there is one, else the
# dashboard in the browser; the same file name as the .deb's own entry, so
# there is one buddi in the grid either way. With the desktop app installed,
# it also starts in the tray at login (the package starts nobody's by itself).
# Each entry names its installation (X-Buddi-Data=<data folder>). Only a
# marked entry of this installation (or an older marked one that names none)
# is written over, never through a link, so one the owner wrote or turned off,
# or another installation's, stays; `buddi uninstall` removes this one's.
DESKTOP_MARK='X-Buddi-Linux-Install=true'
write_entry() { # <file> <content>
  if [ -L "$1" ]; then return 0; fi
  if [ -e "$1" ]; then
    grep -qsx "$DESKTOP_MARK" "$1" || return 0
    if grep -qs '^X-Buddi-Data=' "$1" && ! grep -qsxF "X-Buddi-Data=$DATA" "$1"; then return 0; fi
  fi
  mkdir -p "$(dirname "$1")" && printf '%s\n' "$2" > "$1.tmp-$$" && mv -f "$1.tmp-$$" "$1"
}
# One argument of an Exec line, by the desktop entry spec's quoting rules:
# in double quotes, \ " ` $ take a backslash, written twice because the value
# is an escaped string as well; % is %%.
exec_arg() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\\\\\/g' -e 's/["`$]/\\\\&/g' -e 's/%/%%/g')"
}
desktop_entries() {
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  autostart="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
  case "$DATA$COMMAND" in *"
"*) note "the install folder has a line break in its name: no app-grid entry"; return 0 ;; esac
  # The right-click actions are the desktop app's (its .deb entry has the same).
  # A command path with anything unusual in it gets the plain entry: the
  # browser, through the command quoted for Exec (the sh -c line would need a
  # second, shell-level quoting).
  via() { printf 'Exec=sh -c "command -v buddi-desktop >/dev/null 2>&1 && exec buddi-desktop%s || exec %s dashboard"' "$1" "$COMMAND"; }
  case "$COMMAND" in
    *[!A-Za-z0-9/._+-]*) exec_line="Exec=$(exec_arg "$COMMAND") dashboard"; actions="" ;;
    *) exec_line=$(via "")
       actions="Actions=new-conversation;check-updates;lock;

[Desktop Action new-conversation]
Name=New Conversation
$(via " --new-conversation")

[Desktop Action check-updates]
Name=Check for Updates…
$(via " --check-updates")

[Desktop Action lock]
Name=Lock buddi
$(via " --lock")" ;;
  esac
  write_entry "$apps/buddi-desktop.desktop" "[Desktop Entry]
Type=Application
Name=buddi
Comment=Your personal agents, on this computer
$exec_line
Icon=$DATA/releases/current/packages/web/dist/icon-512.png
StartupWMClass=buddi-desktop
Terminal=false
Categories=Office;
Keywords=agent;assistant;ai;
$DESKTOP_MARK
X-Buddi-Data=$DATA
$actions" || note "could not add buddi to the app grid ($apps)"
  if command -v buddi-desktop >/dev/null 2>&1; then
    write_entry "$autostart/buddi-desktop.desktop" "[Desktop Entry]
Type=Application
Name=buddi
Comment=buddi in the tray, from login
Exec=buddi-desktop --hidden
TryExec=buddi-desktop
Icon=buddi-desktop
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
$DESKTOP_MARK
X-Buddi-Data=$DATA" || note "could not add the desktop app to autostart ($autostart)"
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$apps" 2>/dev/null || true
}

# The releases lock buddi's own upgrade takes too (app-layout.ts takeReleasesLock): a folder holding a pid.
LOCK=""
lock_take() {
  mkdir -p "$RELEASES"
  for _ in 1 2; do
    if mkdir "$RELEASES/.lock" 2>/dev/null; then echo "$$" > "$RELEASES/.lock/pid"; LOCK="$RELEASES/.lock"; return 0; fi
    holder=$(cat "$RELEASES/.lock/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      die "another install or upgrade is changing $RELEASES (pid $holder). Run this again when it has finished."
    fi
    rm -rf "$RELEASES/.lock"
  done
  die "could not take the lock in $RELEASES."
}

TMP=""
cleanup() {
  [ -z "$LOCK" ] || rm -rf "$LOCK"
  [ -z "$TMP" ] || rm -rf "$TMP"
}

main() {
  trap cleanup EXIT
  trap 'cleanup; exit 130' INT TERM

  # ---------------------------------------------------------- this machine
  [ "$(uname -s)" = "Linux" ] || die "this installer is for Linux. On a Mac, download buddi.app from https://withbuddi.com."
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) die "buddi runs on 64-bit Intel/AMD (x86_64) and 64-bit ARM (aarch64); this machine is $(uname -m)." ;;
  esac
  if [ "$(id -u)" = "0" ] && [ "${BUDDI_ALLOW_ROOT:-}" != "1" ]; then
    die "run this as your own user, not root (no sudo needed): buddi runs as a systemd user service in your account."
  fi
  [ -n "${HOME:-}" ] && [ -d "$HOME" ] || die "HOME is not set to a folder."
  # The bundled Node and Postgres are built against glibc.
  if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; then
    die "this system uses musl libc (Alpine and the like); buddi's bundled Node and Postgres need glibc 2.28 or newer. Use the Docker image instead."
  fi
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }' || true)
  if [ -n "$glibc" ]; then
    major=${glibc%%.*}; minor=${glibc#*.}; minor=${minor%%.*}
    if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 28 ]; }; then
      die "glibc $glibc is too old; buddi's bundled Node needs 2.28 or newer (Ubuntu 20.04, Debian 10, RHEL 8 and later)."
    fi
  fi
  for tool in tar gzip; do command -v "$tool" >/dev/null 2>&1 || die "$tool is missing; install it with your package manager and run this again."; done
  if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then SHA="shasum -a 256"
  else die "sha256sum is missing (coreutils); it checks the download."; fi
  sha256() { $SHA "$1" | awk '{ print $1 }'; }

  # ---------------------------------------------------------- where
  DATA="${BUDDI_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/buddi}"
  case "$DATA" in /*) ;; *) die "BUDDI_DATA_DIR must be an absolute path, not $DATA";; esac
  mkdir -p "$DATA" && chmod 700 "$DATA"
  # One spelling of the folder for everything below: its real path, unless an
  # existing installation names it another way that leads to the same place
  # (its service name and vault are derived from the name it was given).
  DATA_REAL=$(resolve "$DATA")
  named=$(sed -n 's/.*"dataDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DATA_REAL/installation.json" 2>/dev/null | head -n 1)
  if [ -n "$named" ] && [ "$(resolve "$named")" = "$DATA_REAL" ]; then DATA="$named"; else DATA="$DATA_REAL"; fi
  DATA="${DATA%/}"
  BIN_DIR="${BUDDI_BIN_DIR:-$HOME/.local/bin}"; BIN_DIR="${BIN_DIR%/}"
  COMMAND="$BIN_DIR/buddi"
  RELEASES="$DATA/releases"
  # The bundled Node (the tarball's runtime/, as buddi.app has it). Not <data>/runtime: buddi keeps its Postgres copy there.
  NODE_DIR="$DATA/node"
  TMP=$(mktemp -d "$DATA_REAL/.install-XXXXXX")

  # ---------------------------------------------------------- what to install
  VERSION="${BUDDI_VERSION:-}"
  if [ -n "${BUDDI_TARBALL:-}" ]; then
    [ -f "$BUDDI_TARBALL" ] || die "BUDDI_TARBALL: $BUDDI_TARBALL is not a file."
    TARBALL="$BUDDI_TARBALL"
    if [ -f "$BUDDI_TARBALL.sha256" ]; then
      [ "$(awk '{ print $1 }' "$BUDDI_TARBALL.sha256")" = "$(sha256 "$TARBALL")" ] || die "$TARBALL does not match its .sha256; nothing was changed."
    else
      dim "no $BUDDI_TARBALL.sha256 beside it: its sha256 is not checked."
    fi
    say "Installing buddi from $TARBALL"
  else
    if [ -z "$VERSION" ]; then
      fetch "$REGISTRY/-/package/@withbuddi/buddi/dist-tags" "$TMP/dist-tags.json" || die "could not ask $REGISTRY for the newest buddi. Check the connection, or set BUDDI_VERSION."
      VERSION=$(sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/dist-tags.json")
      [ -n "$VERSION" ] || die "$REGISTRY named no latest buddi."
    fi
    echo "$VERSION" | grep -Eq "$VERSION_RE" || die "\"$VERSION\" is not a buddi version."
    NAME="buddi-$VERSION-linux-$ARCH.tar.gz"
    say "Downloading buddi $VERSION for linux-$ARCH"
    fetch "$REPO_URL/v$VERSION/$NAME.sha256" "$TMP/$NAME.sha256" \
      || die "buddi $VERSION has no Linux build for $ARCH at $REPO_URL/v$VERSION/ (a release just published can take a few minutes). Nothing was changed."
    fetch "$REPO_URL/v$VERSION/$NAME" "$TMP/$NAME" || die "the download of $NAME failed. Nothing was changed."
    [ "$(awk '{ print $1 }' "$TMP/$NAME.sha256")" = "$(sha256 "$TMP/$NAME")" ] || die "$NAME does not match its published sha256. Nothing was changed."
    TARBALL="$TMP/$NAME"
  fi

  mkdir "$TMP/x"
  tar -xzf "$TARBALL" -C "$TMP/x"
  BUNDLE=$(find "$TMP/x" -mindepth 1 -maxdepth 1 -type d -name 'buddi-*-linux-*' | head -n 1)
  [ -n "$BUNDLE" ] && [ -x "$BUNDLE/runtime/node" ] && [ -f "$BUNDLE/release/node_modules/@withbuddi/buddi/packages/install/dist/launcher.js" ] \
    || die "the tarball is not a buddi Linux build. Nothing was changed."
  NEW_VERSION=$(tr -d '[:space:]' < "$BUNDLE/VERSION")
  echo "$NEW_VERSION" | grep -Eq "$VERSION_RE" || die "the tarball names no buddi version (\"$NEW_VERSION\"). Nothing was changed."
  [ -z "$VERSION" ] || [ "$VERSION" = "$NEW_VERSION" ] || die "the tarball holds buddi $NEW_VERSION, not the $VERSION asked for. Nothing was changed."
  case "$BUNDLE" in *"-linux-$ARCH") ;; *) die "the tarball is built for another architecture ($(basename "$BUNDLE")), this machine is linux-$ARCH.";; esac
  "$BUNDLE/runtime/node" -e 'process.exit(0)' 2>/dev/null || die "the bundled Node does not run on this machine ($("$BUNDLE/runtime/node" --version 2>&1 | head -n 1))."
  NEW_NODE="$BUNDLE/runtime/node"
  note "buddi $NEW_VERSION, Node $(cat "$BUNDLE/runtime/VERSION")"

  # ---------------------------------------------------------- what is there now
  version_of() { "$BUNDLE/runtime/node" -e 'try { console.log(require(process.argv[1]).version || "") } catch {}' "$1/package.json" 2>/dev/null || true; }
  OLD_ROOT=""; OLD_VERSION=""; OLD_PREV=""
  if [ -f "$RELEASES/current/packages/install/dist/launcher.js" ]; then
    OLD_ROOT=$(resolve "$RELEASES/current"); OLD_VERSION=$(version_of "$OLD_ROOT")
  fi
  [ ! -e "$RELEASES/previous" ] || OLD_PREV=$(resolve "$RELEASES/previous")
  EXISTING=0; [ ! -f "$DATA/installation.json" ] || EXISTING=1

  # npm's buddi (`npm install -g @withbuddi/buddi`) on PATH, and whether it is the one serving this data folder.
  NPM_BUDDI=""; NPM_PKG=""; NPM_PREFIX=""; NPM_SERVES=0; NPM_VERSION=""
  if command -v buddi >/dev/null 2>&1; then
    other=$(command -v buddi)
    if [ "$other" != "$COMMAND" ] && ! grep -q "buddi-linux-install" "$other" 2>/dev/null; then
      real=$(readlink -f "$other" 2>/dev/null || echo "$other")
      case "$real" in
        */lib/node_modules/@withbuddi/buddi/*)
          NPM_BUDDI="$other"; NPM_PREFIX="${real%%/lib/node_modules/@withbuddi/buddi/*}"; NPM_PKG="$NPM_PREFIX/lib/node_modules/@withbuddi/buddi"
          NPM_VERSION=$(version_of "$NPM_PKG")
          if [ "$EXISTING" = 1 ] && [ -z "$OLD_ROOT" ]; then
            if BUDDI_DATA_DIR="$DATA" "$NPM_BUDDI" service status --json </dev/null 2>/dev/null | grep -q "\"installRoot\": \"$(resolve "$NPM_PKG")\""; then NPM_SERVES=1
            elif grep -qs -e "$NPM_PKG" -e "$(resolve "$NPM_PKG")" "${XDG_CONFIG_HOME:-$HOME/.config}"/systemd/user/com.buddi.install.*.service \
              && grep -qs -e "BUDDI_DATA_DIR=$DATA\"" -e "BUDDI_DATA_DIR=$DATA_REAL\"" "${XDG_CONFIG_HOME:-$HOME/.config}"/systemd/user/com.buddi.install.*.service; then NPM_SERVES=1
            fi
          fi
          ;;
        *) dim "another buddi is on your PATH at $other; this one goes to $COMMAND." ;;
      esac
    fi
  fi

  # The buddi already serving this data folder, as a command: what takes the backup, and what a rollback starts again.
  old_buddi() {
    if [ -n "$OLD_ROOT" ]; then
      PATH="$NODE_DIR:$PATH" BUDDI_DATA_DIR="$DATA" BUDDI_APP_LAYOUT="$RELEASES" BUDDI_LINUX_INSTALL=1 npm_config_cache="$DATA/cache/npm" \
        "$NODE_DIR/node" "$OLD_ROOT/packages/install/dist/launcher.js" "$@" </dev/null
    else
      BUDDI_DATA_DIR="$DATA" "$NPM_BUDDI" "$@" </dev/null
    fi
  }
  HAVE_OLD=0; { [ -n "$OLD_ROOT" ] || [ "$NPM_SERVES" = 1 ]; } && HAVE_OLD=1
  FROM="$OLD_VERSION"; [ -n "$FROM" ] || [ "$NPM_SERVES" != 1 ] || FROM="$NPM_VERSION"

  NEW_ROOT="$RELEASES/buddi-$NEW_VERSION/node_modules/@withbuddi/buddi"
  SAME=0; [ -z "$OLD_ROOT" ] || [ "$OLD_ROOT" != "$(resolve "$NEW_ROOT")" ] || SAME=1
  if [ "$SAME" = 1 ]; then note "buddi $NEW_VERSION is installed already; refreshing the runtime, the command and the service"
  elif [ -n "$OLD_VERSION" ]; then say "Upgrading buddi $OLD_VERSION to $NEW_VERSION"
  elif [ "$EXISTING" = 1 ]; then say "Moving the buddi in $DATA onto this install; its data stays."
  fi

  # ---------------------------------------------------------- the backup, before anything changes
  ARCHIVE=""
  if [ "$EXISTING" = 1 ] && [ "$SAME" = 0 ]; then
    if [ "${BUDDI_SKIP_BACKUP:-}" = "1" ]; then
      dim "BUDDI_SKIP_BACKUP=1: no backup of $DATA before the switch."
    elif [ "$HAVE_OLD" = 0 ]; then
      die "$DATA holds a buddi installation, but no buddi here can back it up first (no release under $RELEASES, no npm copy serving it). Nothing was changed. To go on without a backup: BUDDI_SKIP_BACKUP=1"
    else
      BRIEF=0
      if ! old_buddi service status >/dev/null 2>&1; then
        note "starting the installed buddi briefly for the backup"
        old_buddi --no-service --no-open > "$TMP/brief.log" 2>&1 || { cat "$TMP/brief.log" >&2; die "the installed buddi would not start for the backup, so nothing was changed. To go on without one: BUDDI_SKIP_BACKUP=1"; }
        BRIEF=1
      fi
      note "taking a backup first"
      if ! old_buddi backup create > "$TMP/backup.log" 2>&1; then
        tail -n 5 "$TMP/backup.log" >&2
        die "the backup before the switch failed, so nothing was changed."
      fi
      for f in "$DATA"/backups/buddi-backup-*; do
        case "$f" in *.json|*.txt) continue;; esac
        [ -f "$f" ] || continue
        if [ -z "$ARCHIVE" ] || [ "$f" -nt "$ARCHIVE" ]; then ARCHIVE="$f"; fi
      done
      [ -z "$ARCHIVE" ] || note "backup: $ARCHIVE"
      if [ "$BRIEF" = 1 ]; then
        pid=$(cat "$DATA/supervisor.lock" 2>/dev/null || true)
        [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || true
        i=0; while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ "$i" -lt 120 ]; do sleep 0.5; i=$((i + 1)); done
      fi
    fi
  fi

  # ---------------------------------------------------------- put it in place
  lock_take
  DEST="$RELEASES/buddi-$NEW_VERSION"
  if [ "$SAME" = 0 ]; then
    # A copy `current` or `previous` uses is kept as it is; one nothing uses is replaced.
    dest_real=$(resolve "$DEST")
    if [ -n "$dest_real" ] && { inside "$OLD_ROOT" "$dest_real" || inside "$OLD_PREV" "$dest_real"; }; then :
    else
      rm -rf "$DEST"
      mv "$BUNDLE/release" "$DEST"
    fi
  fi

  # The runtime: swapped only when it holds another Node (a running buddi keeps the one it started with).
  RUNTIME_SWAPPED=0
  if [ ! -x "$NODE_DIR/node" ] || [ "$(cat "$NODE_DIR/VERSION" 2>/dev/null)" != "$(cat "$BUNDLE/runtime/VERSION")" ]; then
    rm -rf "$NODE_DIR.old"
    [ ! -e "$NODE_DIR" ] || { mv "$NODE_DIR" "$NODE_DIR.old"; RUNTIME_SWAPPED=1; }
    mv "$BUNDLE/runtime" "$NODE_DIR"
    NEW_NODE="$NODE_DIR/node"
  fi

  # The switch, recorded as buddi's own upgrade records it (installation.json's
  # `upgrade` marker): the new release's first start finishes it, and a failed
  # migration leaves `upgrade-failed` with the way back, as `buddi doctor` shows.
  if [ "$SAME" = 0 ] && [ "$EXISTING" = 1 ] && [ -n "$FROM" ]; then
    "$NEW_NODE" -e '
      const fs = require("fs"); const [file, from, to, backup] = process.argv.slice(1);
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      state.phase = "upgrading";
      state.upgrade = { from, to, startedAt: new Date().toISOString(), ...(backup ? { backup: require("path").basename(backup) } : {}) };
      fs.writeFileSync(file + ".tmp", JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(file + ".tmp", file);
    ' "$DATA/installation.json" "$FROM" "$NEW_VERSION" "$ARCHIVE"
  fi

  if [ "$SAME" = 0 ]; then
    [ -z "$OLD_ROOT" ] || link "$OLD_ROOT" "$RELEASES/previous"
    link "$NEW_ROOT" "$RELEASES/current"
  fi

  # The command: the bundled node, `current`, this data directory. It is never rewritten by an upgrade.
  mkdir -p "$BIN_DIR"
  cat > "$COMMAND.tmp-$$" <<EOF
#!/bin/sh
$MARKER
DATA=$(q "$DATA")
NODE="\$DATA/node/node"
LAUNCHER="\$DATA/releases/current/packages/install/dist/launcher.js"
if [ ! -x "\$NODE" ] || [ ! -f "\$LAUNCHER" ]; then
  echo "buddi: the installation in \$DATA is incomplete. Install it again: curl -fsSL https://withbuddi.com/install.sh | sh" >&2
  exit 127
fi
PATH="\$DATA/node:\$PATH" BUDDI_DATA_DIR="\$DATA" BUDDI_APP_LAYOUT="\$DATA/releases" BUDDI_LINUX_INSTALL=1 npm_config_cache="\$DATA/cache/npm" exec "\$NODE" "\$LAUNCHER" "\$@"
EOF
  chmod 755 "$COMMAND.tmp-$$"
  mv -f "$COMMAND.tmp-$$" "$COMMAND"

  # ---------------------------------------------------------- the service
  LINGER_BY_US=false
  if grep -qs '"linger"[[:space:]]*:[[:space:]]*true' "$DATA/installer.json"; then LINGER_BY_US=true; fi
  HAS_SYSTEMD=0
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then HAS_SYSTEMD=1; fi
  LINGER_LINE=""
  if [ "$HAS_SYSTEMD" = "1" ] && command -v loginctl >/dev/null 2>&1; then
    user=$(id -un)
    if [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" != "yes" ]; then
      if loginctl --no-ask-password enable-linger "$user" >/dev/null 2>&1 </dev/null && [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" = "yes" ]; then
        LINGER_BY_US=true
        note "lingering is on for $user: buddi keeps running after you log out and starts at boot"
      else
        LINGER_LINE="buddi stops when your last session ends. To keep it running and start it at boot, run once: sudo loginctl enable-linger $user"
      fi
    fi
  fi

  roll_back() {
    printf '%sbuddi install: %s did not start.%s\n' "$R" "$NEW_VERSION" "$N" >&2
    if [ "$SAME" = 0 ] && [ -n "$OLD_ROOT" ]; then
      link "$OLD_ROOT" "$RELEASES/current"
      if [ -n "$OLD_PREV" ]; then link "$OLD_PREV" "$RELEASES/previous"; else rm -f "$RELEASES/previous"; fi
    fi
    if [ "$RUNTIME_SWAPPED" = "1" ] && [ -d "$NODE_DIR.old" ]; then rm -rf "$NODE_DIR"; mv "$NODE_DIR.old" "$NODE_DIR"; fi
    if [ "$SAME" = 0 ] && [ "$HAVE_OLD" = 1 ]; then
      if old_buddi --no-open >/dev/null 2>&1 && old_buddi service status >/dev/null 2>&1; then
        printf 'buddi install: back on %s, running.\n' "${FROM:-the version before}" >&2
      else
        printf 'buddi install: %s did not come back either. See: %s service logs\n' "${FROM:-the version before}" "$COMMAND" >&2
      fi
      if [ -n "$ARCHIVE" ]; then
        printf 'buddi install: if %s changed the database before it failed, %s may refuse it; restore the backup taken first:\n  %s backup restore %s\n' "$NEW_VERSION" "${FROM:-the old version}" "$COMMAND" "$ARCHIVE" >&2
      fi
    elif [ "$SAME" = 1 ] && [ "$RUNTIME_SWAPPED" = "1" ]; then
      "$COMMAND" --no-open </dev/null >/dev/null 2>&1 || true
    fi
    die "buddi did not start. See: $COMMAND service logs (or $DATA/logs/supervisor.log)"
  }

  unit_file() { grep -ls "$DATA/releases/current" "${XDG_CONFIG_HOME:-$HOME/.config}"/systemd/user/com.buddi.install.*.service 2>/dev/null | head -n 1; }

  STARTED=0
  if [ "${BUDDI_NO_START:-}" = "1" ]; then
    say "Installed. Start it with: $COMMAND"
  elif [ "$HAS_SYSTEMD" = "1" ]; then
    say "Starting buddi"
    # `buddi` writes the systemd user unit (once more on an upgrade, to run the new release).
    # Its dashboard link is minted again at the very end, so it is the last thing on screen and still fresh.
    if "$COMMAND" --no-open </dev/null > "$TMP/start.log" 2>&1; then
      grep -v -e '^Dashboard: ' -e '^The link is good' -e '^Browser for agents' "$TMP/start.log" | sed 's/^/  /' || true
    else
      cat "$TMP/start.log" >&2
      roll_back
    fi
    # Same release, new Node: `buddi` sees its own release running and restarts nothing; systemd does.
    if [ "$SAME" = 1 ] && [ "$RUNTIME_SWAPPED" = 1 ] && [ -n "$(unit_file)" ]; then
      systemctl --user restart "$(basename "$(unit_file)")" || roll_back
      i=0; until "$COMMAND" service status </dev/null >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -lt 120 ] || roll_back; sleep 1; done
    fi
    STARTED=1
  else
    say "Installed, but this session has no systemd user manager (a container, or a shell without a login session)."
    note "Start buddi in the background without a service: $COMMAND --no-service"
  fi

  # Written once the install stands: what `buddi uninstall` reads (the command, the lingering it turned on).
  "$NODE_DIR/node" -e '
    const fs = require("fs"); const [file, version, arch, command, data, linger] = process.argv.slice(1);
    fs.writeFileSync(file, JSON.stringify({ version, arch, command, data, linger: linger === "true", installedAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  ' "$DATA/installer.json" "$NEW_VERSION" "linux-$ARCH" "$COMMAND" "$DATA" "$LINGER_BY_US"

  desktop_entries

  # What `current` and `previous` use stays; older releases and the old runtime go.
  # Staging folders belong to buddi's own upgrade, which cleans them itself.
  keep_cur=$(resolve "$RELEASES/current")
  keep_prev=$(resolve "$RELEASES/previous")
  for dir in "$RELEASES"/buddi-*; do
    [ -d "$dir" ] || continue
    dir_real=$(resolve "$dir")
    [ -n "$dir_real" ] || continue
    inside "$keep_cur" "$dir_real" && continue
    inside "$keep_prev" "$dir_real" && continue
    rm -rf "$dir"
  done
  rm -rf "$NODE_DIR.old"
  rm -rf "$LOCK"; LOCK=""

  # npm's copy would answer `buddi` instead of this one. Removed only once this
  # install serves the same data folder and runs; otherwise, and when root owns
  # it, the one line that removes it.
  NPM_LINE=""
  if [ -n "$NPM_BUDDI" ]; then
    if [ -x "$NPM_PREFIX/bin/npm" ]; then npm_rm="$NPM_PREFIX/bin/npm uninstall -g @withbuddi/buddi --prefix $NPM_PREFIX"
    elif command -v npm >/dev/null 2>&1; then npm_rm="npm uninstall -g @withbuddi/buddi --prefix $NPM_PREFIX"
    else npm_rm="rm -rf $NPM_PKG $NPM_BUDDI"; fi
    if [ "$STARTED" = 1 ] && [ "$NPM_SERVES" = 1 ] && owned "$NPM_PKG" && owned "$(dirname "$NPM_PKG")" && [ -w "$(dirname "$NPM_BUDDI")" ]; then
      if PATH="$NPM_PREFIX/bin:$PATH" sh -c "$npm_rm" >/dev/null 2>&1 || { rm -rf "$NPM_PKG" && rm -f "$NPM_BUDDI"; }; then
        note "removed the npm copy of buddi ($NPM_PKG): this install serves its data now"
      fi
    elif [ "$STARTED" = 1 ] && [ "$NPM_SERVES" = 1 ]; then
      NPM_LINE="The npm copy of buddi at $NPM_BUDDI comes first on your PATH, so \`buddi\` would run that old copy. Root owns it; remove it with: sudo $npm_rm"
    else
      NPM_LINE="An npm copy of buddi is at $NPM_BUDDI and comes first on your PATH. It was left alone (it may serve another installation, or this one has not taken over yet); once you no longer need it: $npm_rm"
    fi
  fi

  echo
  [ -z "$LINGER_LINE" ] || note "$LINGER_LINE"
  [ -z "$NPM_LINE" ] || note "$NPM_LINE"
  # Which `buddi` a shell finds now, and what to type until the next login.
  hash -r 2>/dev/null || true
  RUN="buddi"
  if [ "$(command -v buddi 2>/dev/null)" != "$COMMAND" ]; then
    RUN="$COMMAND"
    if grep -qs '\.local/bin' "$HOME/.profile" && [ "$BIN_DIR" = "$HOME/.local/bin" ]; then
      note "From your next login, buddi is on your PATH (~/.profile adds ~/.local/bin once it exists). Until then, in this terminal:"
    else
      note "$BIN_DIR is not on your PATH. Add this line to your shell's profile, and run it now in this terminal:"
    fi
    note "  export PATH=\"$BIN_DIR:\$PATH\""
  fi
  note "$RUN doctor checks the installation; $RUN uninstall removes it (keeping one last backup)."
  if [ "$STARTED" = "1" ]; then
    echo
    # A fresh five-minute link, last on screen; on a desktop it opens in the browser.
    "$COMMAND" </dev/null > "$TMP/link.log" 2>&1 || true
    grep -v -e '^Dashboard: ' -e '^The link is good' "$TMP/link.log" || true
    grep '^Dashboard: ' "$TMP/link.log" || { cat "$TMP/link.log"; true; }
    note "The link is good for five minutes. A fresh one any time: $RUN"
  fi
}

main "$@"
