#!/usr/bin/env bash
# Wraps a Windows bundle (scripts/release/windows-bundle.sh) into
# buddi-<version>-windows-x64-setup.exe with Inno Setup (apps/windows/buddi.iss),
# and writes its .sha256 beside it.
#
# Usage: scripts/release/windows-setup.sh <buddi-version> <bundle.zip> [out-dir]
#   ISCC=<path>          Inno Setup's compiler (scripts/release/windows-tools.sh finds it)
#   DESKTOP_EXE=<path>   the desktop app (default <out-dir>/buddi-desktop.exe, from
#                        scripts/release/windows-desktop.sh)
#   WEBVIEW2_SETUP=<path> the WebView2 bootstrapper (default <out-dir>/MicrosoftEdgeWebview2Setup.exe
#                        when it is there; without it a Windows 10 with no WebView2 is told where to get it)
#
# Runs on Windows (Git Bash).
set -euo pipefail
# Git Bash rewrites an argument that starts with / into a path (/VERYSILENT → C:/Program Files/Git/VERYSILENT):
# commands given /SWITCHES run with MSYS_NO_PATHCONV=1 and Windows paths (cygpath -w).

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:?usage: windows-setup.sh <buddi-version> <bundle.zip> [out-dir]}"
ZIP="${2:?usage: windows-setup.sh <buddi-version> <bundle.zip> [out-dir]}"
OUT="${3:-$ROOT/build/windows}"
ISCC="${ISCC:-C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe}"

die() { printf 'windows-setup: %s\n' "$*" >&2; exit 1; }
[ -f "$ZIP" ] || die "$ZIP is not a file"
mkdir -p "$OUT"
DESKTOP_EXE="${DESKTOP_EXE:-$OUT/buddi-desktop.exe}"
[ -f "$DESKTOP_EXE" ] || die "no desktop app at $DESKTOP_EXE (scripts/release/windows-desktop.sh builds it)"
WEBVIEW2_SETUP="${WEBVIEW2_SETUP:-$OUT/MicrosoftEdgeWebview2Setup.exe}"
win() { cygpath -w "$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; }
extra=()
[ -f "$WEBVIEW2_SETUP" ] && extra+=("/DWebView2Setup=$(win "$WEBVIEW2_SETUP")")
info="$(node "$ROOT/scripts/release/bundle-version.mjs" "$VERSION")" || die "\"$VERSION\" has no four-number form"
MSYS_NO_PATHCONV=1 "$(cygpath -u "$ISCC")" /Q "/DAppVersion=$VERSION" "/DVersionInfo=$info" "/DBundleZip=$(cygpath -w "$(cd "$(dirname "$ZIP")" && pwd)/$(basename "$ZIP")")" \
  "/DDesktopExe=$(win "$DESKTOP_EXE")" ${extra[@]+"${extra[@]}"} \
  "/DOutputDir=$(cygpath -w "$(cd "$OUT" && pwd)")" "$(cygpath -w "$ROOT/apps/windows/buddi.iss")"
name="buddi-$VERSION-windows-x64-setup.exe"
[ -f "$OUT/$name" ] || die "Inno Setup wrote no $OUT/$name"
( cd "$OUT" && printf '%s  %s\n' "$(sha256sum "$name" | awk '{ print $1 }')" "$name" > "$name.sha256" )
echo "$OUT/$name"
