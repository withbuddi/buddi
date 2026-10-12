#!/usr/bin/env bash
# The Windows setup on a clean runner account, the way the release ships it:
# a silent install, the command on the user PATH, the Start menu item and the
# Apps & Features entry, the bundled node and npm answering, the bundled
# Postgres running, optionally a newer setup run over it (the switch of
# `current`), then the silent uninstall from Settings → Apps, with nothing
# left behind.
#
# buddi itself is not started here: GitHub's runner account is an elevated
# administrator, and Postgres refuses to run with administrative rights (an
# owner's account runs unelevated). The full path (first start, the task,
# doctor, a backup before an upgrade, the dashboard's own upgrade, uninstall
# with data) is tried on a Windows VM before a release (docs/install.md §1.3).
#
# Usage: scripts/release/windows-smoke.sh <setup.exe> [<newer setup.exe>]
#
# Runs on Windows (Git Bash), in an account with no buddi.
set -euo pipefail
# Git Bash rewrites an argument that starts with / into a path (/VERYSILENT → C:/Program Files/Git/VERYSILENT):
# commands given /SWITCHES run with MSYS_NO_PATHCONV=1 and Windows paths (cygpath -w).

SETUP="${1:?usage: windows-smoke.sh <setup.exe> [<newer setup.exe>]}"
NEWER="${2:-}"
LOCAL="$(cygpath -u "$LOCALAPPDATA")"
APP="$LOCAL/Programs/buddi"
DATA="$LOCAL/buddi"
BUDDI="$APP/bin/buddi.cmd"
LOGS="$(cygpath -u "${RUNNER_TEMP:-/tmp}")/windows-smoke"
mkdir -p "$LOGS"

die() { printf '::error::%s\n' "$*"; exit 1; }
buddi() { MSYS_NO_PATHCONV=1 cmd /d /c call "$(cygpath -w "$BUDDI")" "$@"; }
setup() { # <exe> <log name>
  MSYS_NO_PATHCONV=1 "$1" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOSTART "/LOG=$(cygpath -w "$LOGS/$2.log")" \
    || { cat "$LOGS/$2.log"; cat "$DATA/logs/setup.log" 2>/dev/null || true; die "$(basename "$1") failed"; }
}
version_in() { basename "$1" | sed -E 's/^buddi-(.*)-windows-x64-setup\.exe$/\1/'; }
on_path() { MSYS_NO_PATHCONV=1 reg query 'HKCU\Environment' /v Path | grep -qi 'Programs\\buddi\\bin'; }

[ ! -e "$DATA" ] || die "$DATA exists already: run this on an account without buddi"
v1="$(version_in "$SETUP")"

echo "== install $v1"
setup "$SETUP" install
[ -f "$BUDDI" ] || die "the setup wrote no $BUDDI"
on_path || die "the user PATH does not name $APP/bin"
[ -f "$(cygpath -u "$APPDATA")/Microsoft/Windows/Start Menu/Programs/buddi.lnk" ] || die "no Start menu item"
MSYS_NO_PATHCONV=1 reg query 'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F1C9A52-3B7E-4D8A-9E25-B0D7C4F81A36}_is1' /v DisplayName | grep -q buddi || die "no Apps & Features entry"
buddi --version | tee "$LOGS/version.txt"
grep -q "buddi $v1" "$LOGS/version.txt" || die "buddi --version does not say $v1"

echo "== the runtime"
# doctor's runtime lines come first; the rest asks the supervisor, which is not running here.
buddi doctor > "$LOGS/doctor.txt" 2>&1 || true
cat "$LOGS/doctor.txt"
grep -q 'Runtime: Node v.*bundled with the Windows install' "$LOGS/doctor.txt" || die "buddi doctor does not report the bundled runtime"
grep -q '^npm: .* beside it' "$LOGS/doctor.txt" || die "no npm beside the bundled node"
grep -q '^From: the Windows install' "$LOGS/doctor.txt" || die "buddi doctor does not say this is the Windows install"
for dll in vcruntime140.dll vcruntime140_1.dll msvcp140.dll; do [ -f "$DATA/node/vcruntime/$dll" ] || die "no $dll in $DATA/node/vcruntime"; done
"$DATA/releases/current/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe" --version || die "the bundled Postgres does not run"

if [ -n "$NEWER" ]; then
  v2="$(version_in "$NEWER")"
  echo "== upgrade to $v2"
  setup "$NEWER" upgrade
  buddi --version | tee "$LOGS/version-2.txt"
  grep -q "buddi $v2" "$LOGS/version-2.txt" || die "buddi --version does not say $v2 after the upgrade"
  [ -d "$DATA/releases/buddi-$v1" ] && [ -d "$DATA/releases/buddi-$v2" ] || die "the releases are not $v1 and $v2 side by side"
fi

echo "== uninstall"
# The uninstaller hands over to a copy of itself and returns at once: wait for it to finish.
MSYS_NO_PATHCONV=1 "$APP/unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART "/LOG=$(cygpath -w "$LOGS/uninstall.log")"
for _ in $(seq 1 300); do [ -e "$APP/unins000.exe" ] || break; sleep 1; done
# Its last step removes the folder it ran from, a moment after the rest.
for _ in $(seq 1 60); do [ -e "$APP" ] || break; sleep 1; done
tail -n 30 "$LOGS/uninstall.log" 2>/dev/null || true
[ ! -e "$APP" ] || { ls -R "$APP"; die "the uninstall left $APP"; }
[ ! -e "$DATA" ] || { ls -R "$DATA" | head -50; die "the uninstall left $DATA"; }
if on_path; then die "the uninstall left $APP/bin on the user PATH"; fi
[ ! -e "$(cygpath -u "$APPDATA")/Microsoft/Windows/Start Menu/Programs/buddi.lnk" ] || die "the uninstall left the Start menu item"
echo "Windows setup: install, runtime${NEWER:+, upgrade} and uninstall passed."
