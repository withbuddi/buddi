#!/usr/bin/env bash
# The Windows setup on a clean runner account, the way the release ships it:
# a silent install (buddi left stopped: a runner has no interactive sign-in for
# the Task Scheduler task), the bundled node and npm answering, buddi started
# without a service and checked, optionally a newer setup run over it (the
# upgrade: a backup first, the switch, the migration on the next start), then
# the silent uninstall from Settings → Apps, and nothing left but the last backup.
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
LOGS="${RUNNER_TEMP:-/tmp}/windows-smoke"
mkdir -p "$LOGS"

die() { printf '::error::%s\n' "$*"; exit 1; }
buddi() { MSYS_NO_PATHCONV=1 cmd /d /c call "$(cygpath -w "$BUDDI")" "$@"; }
setup() { # <exe> <log name>
  MSYS_NO_PATHCONV=1 "$1" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOSTART "/LOG=$(cygpath -w "$LOGS/$2.log")" \
    || { cat "$LOGS/$2.log"; cat "$DATA/logs/setup.log" 2>/dev/null || true; die "$(basename "$1") failed"; }
}

[ ! -e "$DATA" ] || die "$DATA exists already: run this on an account without buddi"
v1="$(basename "$SETUP" | sed -E 's/^buddi-(.*)-windows-x64-setup\.exe$/\1/')"

echo "== install $v1"
setup "$SETUP" install
[ -f "$BUDDI" ] || die "the setup wrote no $BUDDI"
MSYS_NO_PATHCONV=1 reg query 'HKCU\Environment' /v Path | grep -qi 'Programs\\buddi\\bin' || die "the user PATH does not name $APP/bin"
[ -f "$(cygpath -u "$APPDATA")/Microsoft/Windows/Start Menu/Programs/buddi.lnk" ] || die "no Start menu item"
buddi --version | tee "$LOGS/version.txt"
grep -q "buddi $v1" "$LOGS/version.txt" || die "buddi --version does not say $v1"

echo "== start without a service, doctor"
buddi --no-service --no-open
buddi doctor | tee "$LOGS/doctor.txt"
grep -q 'Runtime: Node v.*bundled with the Windows install' "$LOGS/doctor.txt" || die "buddi doctor does not report the bundled runtime"
grep -q '^npm: .* beside it' "$LOGS/doctor.txt" || die "no npm beside the bundled node"
grep -q '^From: the Windows install' "$LOGS/doctor.txt" || die "buddi doctor does not say this is the Windows install"
ls "$DATA"/runtime/postgres-*/bin/vcruntime140.dll >/dev/null || die "the Visual C++ runtime is not beside the Postgres binaries"

if [ -n "$NEWER" ]; then
  v2="$(basename "$NEWER" | sed -E 's/^buddi-(.*)-windows-x64-setup\.exe$/\1/')"
  echo "== upgrade to $v2 (buddi running)"
  setup "$NEWER" upgrade
  ls "$DATA"/backups/buddi-backup-* >/dev/null 2>&1 || die "no backup was taken before the upgrade"
  [ "$(readlink -f "$DATA/releases/previous")" != "" ] || die "no previous release after the upgrade"
  buddi --no-service --no-open
  buddi doctor | tee "$LOGS/doctor-2.txt"
  grep -q "^Version: $v2" "$LOGS/doctor-2.txt" || die "buddi doctor does not say $v2 after the upgrade"
  grep -q "^Last upgrade: $v1 to $v2, done" "$LOGS/doctor-2.txt" || die "the upgrade to $v2 is not recorded as done"
fi

echo "== uninstall"
# The uninstaller hands over to a copy of itself and returns at once: wait for it to finish.
MSYS_NO_PATHCONV=1 "$APP/unins000.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART "/LOG=$(cygpath -w "$LOGS/uninstall.log")"
for _ in $(seq 1 300); do [ -e "$APP/unins000.exe" ] || break; sleep 1; done
sleep 2
[ ! -e "$APP" ] || { ls -R "$APP"; cat "$LOGS/uninstall.log"; die "the uninstall left $APP"; }
[ ! -e "$DATA" ] || { ls "$DATA"; cat "$LOGS/uninstall.log"; die "the uninstall left $DATA"; }
MSYS_NO_PATHCONV=1 reg query 'HKCU\Environment' /v Path | grep -qi 'Programs\\buddi\\bin' && die "the uninstall left $APP/bin on the user PATH"
ls "$(cygpath -u "$USERPROFILE")/buddi-backups" | tee "$LOGS/kept.txt"
grep -q '^buddi-backup-' "$LOGS/kept.txt" || die "no last backup kept in buddi-backups"
MSYS_NO_PATHCONV=1 schtasks /Query /FO LIST | grep -qi 'com.buddi.install' && die "a buddi task is still registered"
echo "Windows setup: install, start, doctor${NEWER:+, upgrade}, uninstall all passed."
