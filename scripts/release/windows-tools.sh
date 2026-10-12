#!/usr/bin/env bash
# What the Windows setup is built with, on a GitHub Windows runner (Git Bash):
#
#   - Inno Setup at a pinned version, checked against its sha256 before it
#     runs, installed for this user into $RUNNER_TEMP/inno (the image's own copy,
#     when there is one, moves with the image);
#   - the Visual C++ runtime the Postgres binaries import (vcruntime140.dll,
#     vcruntime140_1.dll, msvcp140.dll, x64), from the image's Visual Studio
#     redistributable folder (VC\Redist\MSVC\<version>\x64\Microsoft.VC14x.CRT):
#     the files Microsoft's licence lists as distributable code, which an
#     application may deploy app-local (scripts/release/windows-bundle.sh).
#
# Writes ISCC=<path> and VCRUNTIME_DIR=<dir> to $GITHUB_ENV (or prints them).
set -euo pipefail
# Git Bash rewrites an argument that starts with / into a path (/VERYSILENT → C:/Program Files/Git/VERYSILENT): not here.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"

INNO_VERSION=6.7.3
INNO_SHA256=9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732
INNO_URL="https://github.com/jrsoftware/issrc/releases/download/is-${INNO_VERSION//./_}/innosetup-$INNO_VERSION.exe"

die() { printf 'windows-tools: %s\n' "$*" >&2; exit 1; }
out() { if [ -n "${GITHUB_ENV:-}" ]; then echo "$1" >> "$GITHUB_ENV"; fi; echo "$1"; }

tmp="$(cygpath -u "${RUNNER_TEMP:-${TMPDIR:-/tmp}}")"
dir="$tmp/inno"
if [ ! -f "$dir/ISCC.exe" ]; then
  curl -fsSL "$INNO_URL" -o "$tmp/innosetup.exe"
  [ "$(sha256sum < "$tmp/innosetup.exe" | awk '{ print $1 }')" = "$INNO_SHA256" ] || die "innosetup-$INNO_VERSION.exe does not match its pinned sha256"
  "$tmp/innosetup.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CURRENTUSER "/DIR=$(cygpath -w "$dir")"
  [ -f "$dir/ISCC.exe" ] || die "Inno Setup $INNO_VERSION did not install into $dir"
fi
out "ISCC=$(cygpath -w "$dir/ISCC.exe")"

vswhere="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
[ -f "$vswhere" ] || die "no vswhere.exe: this runner has no Visual Studio to take the Visual C++ runtime from"
vs="$("$vswhere" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | tr -d '\r')"
[ -n "$vs" ] || die "vswhere found no Visual Studio with the C++ tools"
vs="$(cygpath -u "$vs")"
redist="$(tr -d '[:space:]' < "$vs/VC/Auxiliary/Build/Microsoft.VCRedistVersion.default.txt")"
crt="$(ls -d "$vs/VC/Redist/MSVC/$redist/x64/"Microsoft.VC*.CRT 2>/dev/null | head -n 1)"
[ -n "$crt" ] && [ -f "$crt/vcruntime140.dll" ] || die "no x64 Microsoft.VC*.CRT folder under $vs/VC/Redist/MSVC/$redist"
out "VCRUNTIME_DIR=$crt"
echo "Visual C++ runtime $redist from $crt" >&2
