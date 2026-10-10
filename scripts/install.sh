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
#
# Running it again upgrades (or reinstalls) in place, with a backup first.
# buddi also upgrades itself from the dashboard or with `buddi upgrade`; this
# script is what also brings a newer Node. `buddi uninstall` removes it all.
#
# Settings, all optional:
#   BUDDI_VERSION=0.1.0-pre.53   a version instead of the newest
#   BUDDI_TARBALL=<file>         a tarball on disk instead of a download
#   BUDDI_DATA_DIR=<dir>         where buddi lives (default ~/.local/share/buddi)
#   BUDDI_BIN_DIR=<dir>          where the command goes (default ~/.local/bin)
#   BUDDI_WEB_PORT=<port>        the dashboard's port on a first install (default 4317)
#   BUDDI_NO_START=1             install, but leave the service alone
set -eu

REPO_URL="${BUDDI_DOWNLOAD_BASE:-https://github.com/withbuddi/buddi/releases/download}"
REGISTRY="${BUDDI_REGISTRY:-https://registry.npmjs.org}"
MARKER='# buddi-linux-install: written by https://withbuddi.com/install.sh'

if [ -t 1 ]; then B=$(printf '\033[1m'); D=$(printf '\033[2m'); R=$(printf '\033[31m'); N=$(printf '\033[0m'); else B=''; D=''; R=''; N=''; fi
say() { printf '%s%s%s\n' "$B" "$*" "$N"; }
note() { printf '  %s\n' "$*"; }
dim() { printf '%s  %s%s\n' "$D" "$*" "$N"; }
die() { printf '%sbuddi install: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# ------------------------------------------------------------ this machine
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
if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | awk '{ print $1 }'; }
elif command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | awk '{ print $1 }'; }
else die "sha256sum is missing (coreutils); it checks the download."; fi
fetch() { # <url> <file>
  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "curl or wget is needed to download buddi."; fi
}

DATA="${BUDDI_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/buddi}"
case "$DATA" in /*) ;; *) die "BUDDI_DATA_DIR must be an absolute path, not $DATA";; esac
BIN_DIR="${BUDDI_BIN_DIR:-$HOME/.local/bin}"
COMMAND="$BIN_DIR/buddi"
RELEASES="$DATA/releases"
# The bundled Node (the tarball's runtime/, as buddi.app has it). Not <data>/runtime: buddi keeps its Postgres copy there.
NODE_DIR="$DATA/node"

# ------------------------------------------------------------ what to install
TMP=""
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }
trap cleanup EXIT INT TERM
mkdir -p "$DATA" && chmod 700 "$DATA"
TMP=$(mktemp -d "$DATA/.install-XXXXXX")

if [ -n "${BUDDI_TARBALL:-}" ]; then
  [ -f "$BUDDI_TARBALL" ] || die "BUDDI_TARBALL: $BUDDI_TARBALL is not a file."
  TARBALL="$BUDDI_TARBALL"
  if [ -f "$BUDDI_TARBALL.sha256" ]; then
    [ "$(awk '{ print $1 }' "$BUDDI_TARBALL.sha256")" = "$(sha256 "$TARBALL")" ] || die "$TARBALL does not match its .sha256; nothing was changed."
  else
    dim "no $BUDDI_TARBALL.sha256 beside it: the tarball is not checked."
  fi
  say "Installing buddi from $TARBALL"
else
  VERSION="${BUDDI_VERSION:-}"
  if [ -z "$VERSION" ]; then
    fetch "$REGISTRY/-/package/@withbuddi/buddi/dist-tags" "$TMP/dist-tags.json" || die "could not ask $REGISTRY for the newest buddi. Check the connection, or set BUDDI_VERSION."
    VERSION=$(sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP/dist-tags.json")
    [ -n "$VERSION" ] || die "$REGISTRY named no latest buddi."
  fi
  echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || die "\"$VERSION\" is not a buddi version."
  NAME="buddi-$VERSION-linux-$ARCH.tar.gz"
  say "Downloading buddi $VERSION for linux-$ARCH"
  fetch "$REPO_URL/v$VERSION/$NAME.sha256" "$TMP/$NAME.sha256" \
    || die "buddi $VERSION has no Linux build for $ARCH at $REPO_URL/v$VERSION/ (a release just published can take a few minutes). Nothing was changed."
  fetch "$REPO_URL/v$VERSION/$NAME" "$TMP/$NAME" || die "the download of $NAME failed. Nothing was changed."
  [ "$(awk '{ print $1 }' "$TMP/$NAME.sha256")" = "$(sha256 "$TMP/$NAME")" ] || die "$NAME does not match its published sha256. Nothing was changed."
  TARBALL="$TMP/$NAME"
fi

tar -xzf "$TARBALL" -C "$TMP"
BUNDLE=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d -name 'buddi-*-linux-*' | head -n 1)
[ -n "$BUNDLE" ] && [ -x "$BUNDLE/runtime/node" ] && [ -f "$BUNDLE/release/node_modules/@withbuddi/buddi/packages/install/dist/launcher.js" ] \
  || die "the tarball is not a buddi Linux build. Nothing was changed."
NEW_VERSION=$(tr -d '[:space:]' < "$BUNDLE/VERSION")
case "$BUNDLE" in *"-linux-$ARCH") ;; *) die "the tarball is built for another architecture ($(basename "$BUNDLE")), this machine is linux-$ARCH.";; esac
"$BUNDLE/runtime/node" -e 'process.exit(0)' 2>/dev/null || die "the bundled Node does not run on this machine ($("$BUNDLE/runtime/node" --version 2>&1 | head -n 1))."
note "buddi $NEW_VERSION, Node $(cat "$BUNDLE/runtime/VERSION")"

# ------------------------------------------------------------ what is there now
current_version() { sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -n 1; }
OLD_ROOT=""; OLD_VERSION=""
if [ -f "$RELEASES/current/packages/install/dist/launcher.js" ]; then
  OLD_ROOT=$(cd "$RELEASES/current" && pwd -P)
  OLD_VERSION=$(current_version "$OLD_ROOT")
fi
# Another buddi on PATH: npm's (`npm install -g @withbuddi/buddi`) is replaced once this one runs; anything else is named.
NPM_BUDDI=""; NPM_PKG=""
if command -v buddi >/dev/null 2>&1; then
  other=$(command -v buddi)
  if [ "$other" != "$COMMAND" ] && ! grep -q "buddi-linux-install" "$other" 2>/dev/null; then
    real=$(readlink -f "$other" 2>/dev/null || echo "$other")
    case "$real" in
      */node_modules/@withbuddi/buddi/*) NPM_BUDDI="$other"; NPM_PKG="${real%%/node_modules/@withbuddi/buddi/*}/node_modules/@withbuddi/buddi" ;;
      *) dim "another buddi is on your PATH at $other; this one goes to $COMMAND." ;;
    esac
  fi
fi
if [ -z "$OLD_ROOT" ] && [ -f "$DATA/installation.json" ]; then
  # An installation from npm (or a checkout) in the same folder: its data, vault and service label carry over.
  say "Moving the buddi in $DATA onto this install; its data stays."
fi
SERVED=0
if [ -n "$OLD_ROOT" ] && [ -x "$COMMAND" ] && "$COMMAND" service status >/dev/null 2>&1; then SERVED=1; fi

# A backup before anything changes, when there is a buddi running to take it.
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
  say "Upgrading buddi $OLD_VERSION to $NEW_VERSION"
  if [ "$SERVED" = "1" ]; then
    note "taking a backup first"
    "$COMMAND" backup create >/dev/null || die "the backup before the upgrade failed, so nothing was changed. See: buddi service logs"
  fi
fi

# ------------------------------------------------------------ put it in place
mkdir -p "$RELEASES" && chmod 700 "$RELEASES"
link() { # <target> <link>: replaced in one rename
  ln -s "$1" "$2.tmp-$$" && mv -f -T "$2.tmp-$$" "$2"
}
DEST="$RELEASES/buddi-$NEW_VERSION"
NEW_ROOT="$DEST/node_modules/@withbuddi/buddi"
if [ "$OLD_ROOT" = "$NEW_ROOT" ]; then
  note "buddi $NEW_VERSION is installed already; refreshing the runtime, the command and the service"
else
  # A copy nothing runs is replaced; one `previous` points at is kept as it is.
  PREV_ROOT=$( [ -e "$RELEASES/previous" ] && cd "$RELEASES/previous" 2>/dev/null && pwd -P || true)
  if [ -d "$DEST" ] && [ "$PREV_ROOT" = "$NEW_ROOT" ]; then :
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
fi

if [ "$OLD_ROOT" != "$NEW_ROOT" ]; then
  [ -z "$OLD_ROOT" ] || link "$OLD_ROOT" "$RELEASES/previous"
  link "$NEW_ROOT" "$RELEASES/current"
fi

# The command: the bundled node, `current`, this data directory. It is never rewritten by an upgrade.
mkdir -p "$BIN_DIR"
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
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

# ------------------------------------------------------------ the service
LINGER_BY_US=false
if grep -q '"linger"[[:space:]]*:[[:space:]]*true' "$DATA/installer.json" 2>/dev/null; then LINGER_BY_US=true; fi
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

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$DATA/installer.json" <<EOF
{
  "version": "$NEW_VERSION",
  "arch": "linux-$ARCH",
  "command": "$COMMAND",
  "linger": $LINGER_BY_US,
  "installedAt": "$now"
}
EOF
chmod 600 "$DATA/installer.json"

roll_back() {
  if [ -n "$OLD_ROOT" ] && [ "$OLD_ROOT" != "$NEW_ROOT" ]; then
    link "$OLD_ROOT" "$RELEASES/current"
    if [ "$RUNTIME_SWAPPED" = "1" ] && [ -d "$NODE_DIR.old" ]; then rm -rf "$NODE_DIR"; mv "$NODE_DIR.old" "$NODE_DIR"; fi
    printf '%sbuddi install: %s did not start; going back to %s.%s\n' "$R" "$NEW_VERSION" "$OLD_VERSION" "$N" >&2
    "$COMMAND" --no-open >/dev/null 2>&1 || true
  fi
  die "buddi did not start. See: $COMMAND service logs (or $DATA/logs/supervisor.log)"
}

STARTED=0
if [ "${BUDDI_NO_START:-}" = "1" ]; then
  say "Installed. Start it with: $COMMAND"
elif [ "$HAS_SYSTEMD" = "1" ]; then
  say "Starting buddi"
  # `buddi` writes the systemd user unit (once more on an upgrade, to run the new release) and prints the dashboard link.
  # The link it prints is minted again at the end, so it is the last thing on screen and still fresh.
  if "$COMMAND" --no-open > "$TMP/start.log" 2>&1; then
    grep -v -e '^Dashboard: ' -e '^The link is good' -e '^Browser for agents' "$TMP/start.log" | sed 's/^/  /' || true
  else
    cat "$TMP/start.log" >&2
    roll_back
  fi
  STARTED=1
else
  say "Installed, but this session has no systemd user manager (a container, or a shell without a login session)."
  note "Start buddi in the background without a service: $COMMAND --no-service"
fi

# What only `current` and `previous` use stays; older releases and the old runtime go.
keep_cur=$(cd "$RELEASES/current" 2>/dev/null && pwd -P || true)
keep_prev=$(cd "$RELEASES/previous" 2>/dev/null && pwd -P || true)
for dir in "$RELEASES"/buddi-* "$RELEASES"/.staging-*; do
  [ -d "$dir" ] || continue
  case "$keep_cur/" in "$dir"/*) continue;; esac
  case "$keep_prev/" in "$dir"/*) continue;; esac
  rm -rf "$dir"
done
rm -rf "$NODE_DIR.old"

# npm's copy would answer `buddi` instead of this one: removed when this account may, else the one line that does.
if [ -n "$NPM_BUDDI" ]; then
  if [ -w "$(dirname "$NPM_PKG")" ] && [ -w "$(dirname "$NPM_BUDDI")" ]; then
    rm -rf "$NPM_PKG" && rm -f "$NPM_BUDDI"
    note "removed the npm copy of buddi ($NPM_PKG): this install replaces it"
  else
    NPM_LINE="The npm copy of buddi is still at $NPM_BUDDI and comes first on your PATH, so \`buddi\` would run that old copy. It is owned by root; remove it with: sudo rm -rf $NPM_PKG $NPM_BUDDI"
  fi
fi

echo
[ -z "$LINGER_LINE" ] || note "$LINGER_LINE"
[ -z "${NPM_LINE:-}" ] || note "$NPM_LINE"
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
  [ -z "${NPM_LINE:-}" ] || RUN="$COMMAND"
fi
note "$RUN doctor checks the installation; $RUN uninstall removes it (keeping one last backup)."
if [ "$STARTED" = "1" ]; then
  echo
  # A fresh five-minute link, last on screen; on a desktop it opens in the browser.
  "$COMMAND" > "$TMP/link.log" 2>&1 || true
  grep -v -e '^Dashboard: ' -e '^The link is good' "$TMP/link.log" || true
  grep '^Dashboard: ' "$TMP/link.log" || { cat "$TMP/link.log"; true; }
  note "The link is good for five minutes. A fresh one any time: $RUN"
fi
