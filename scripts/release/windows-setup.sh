#!/usr/bin/env bash
# Wraps a Windows bundle (scripts/release/windows-bundle.sh) into
# buddi-<version>-windows-x64-setup.exe with Inno Setup (apps/windows/buddi.iss),
# and writes its .sha256 beside it.
#
# Usage: scripts/release/windows-setup.sh <buddi-version> <bundle.zip> [out-dir]
#   ISCC=<path>   Inno Setup's compiler (scripts/release/windows-tools.sh finds it)
#
# Runs on Windows (Git Bash).
set -euo pipefail
# Git Bash rewrites an argument that starts with / into a path (/VERYSILENT → C:/Program Files/Git/VERYSILENT): not here.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:?usage: windows-setup.sh <buddi-version> <bundle.zip> [out-dir]}"
ZIP="${2:?usage: windows-setup.sh <buddi-version> <bundle.zip> [out-dir]}"
OUT="${3:-$ROOT/build/windows}"
ISCC="${ISCC:-C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe}"

die() { printf 'windows-setup: %s\n' "$*" >&2; exit 1; }
[ -f "$ZIP" ] || die "$ZIP is not a file"
mkdir -p "$OUT"
info="$(node "$(cygpath -w "$ROOT/scripts/release/bundle-version.mjs")" "$VERSION")" || die "\"$VERSION\" has no four-number form"
"$(cygpath -u "$ISCC")" /Q "/DAppVersion=$VERSION" "/DVersionInfo=$info" "/DBundleZip=$(cygpath -w "$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")")" \
  "/DOutputDir=$(cygpath -w "$(cd "$OUT" && pwd)")" "$(cygpath -w "$ROOT/apps/windows/buddi.iss")"
name="buddi-$VERSION-windows-x64-setup.exe"
[ -f "$OUT/$name" ] || die "Inno Setup wrote no $OUT/$name"
( cd "$OUT" && printf '%s  %s\n' "$(sha256sum "$name" | awk '{ print $1 }')" "$name" > "$name.sha256" )
echo "$OUT/$name"
