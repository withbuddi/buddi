#!/usr/bin/env bash
# The desktop app for the Windows setup (apps/desktop: Tauri on WebView2):
# buddi-desktop.exe, x64 (it runs emulated on Windows on Arm, as the bundled
# node does), versioned as the buddi it ships with, and the WebView2 Evergreen
# bootstrapper the setup runs on a Windows 10 that has no WebView2 (Windows 11
# has it), checked to be signed by Microsoft. apps/windows/buddi.iss carries both.
#
# Usage: scripts/release/windows-desktop.sh <buddi-version> [out-dir]
#
# Runs on Windows (Git Bash) with rustup and Node; the toolchain is the one
# apps/desktop/rust-toolchain.toml pins, the CLI the one the Linux build uses.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:?usage: windows-desktop.sh <buddi-version> [out-dir]}"
OUT="${2:-$ROOT/build/windows}"
WEBVIEW2_URL="https://go.microsoft.com/fwlink/p/?LinkId=2124703"

die() { printf 'windows-desktop: %s\n' "$*" >&2; exit 1; }
mkdir -p "$OUT"

(
  cd "$ROOT/apps/desktop"
  rustup toolchain install
  rustc --version
  # The tauri crates in Cargo.lock and this CLI move together (README.md, Build).
  # --locked after `--`: cargo builds from Cargo.lock as it is, never a rewritten one.
  npx --yes @tauri-apps/cli@2.12.2 build --no-bundle --ci --config "{\"version\":\"$VERSION\"}" -- --locked
)
exe="$ROOT/apps/desktop/target/release/buddi-desktop.exe"
[ -f "$exe" ] || die "the build wrote no $exe"
cp "$exe" "$OUT/buddi-desktop.exe"

boot="$OUT/MicrosoftEdgeWebview2Setup.exe"
curl -fsSL "$WEBVIEW2_URL" -o "$boot"
powershell.exe -NoProfile -NonInteractive -Command "\$s = Get-AuthenticodeSignature -LiteralPath '$(cygpath -w "$boot")'; if (\$s.Status -ne 'Valid' -or \$s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { Write-Error ('not signed by Microsoft: ' + \$s.Status + ' ' + \$s.SignerCertificate.Subject); exit 1 }" \
  || die "the WebView2 bootstrapper from $WEBVIEW2_URL is not signed by Microsoft"
# Its checksum beside it, so a release says exactly which bootstrapper it carries.
( cd "$OUT" && printf '%s  %s\n' "$(sha256sum MicrosoftEdgeWebview2Setup.exe | awk '{ print $1 }')" MicrosoftEdgeWebview2Setup.exe > MicrosoftEdgeWebview2Setup.exe.sha256 && cat MicrosoftEdgeWebview2Setup.exe.sha256 )
ls -l "$OUT/buddi-desktop.exe" "$boot"
