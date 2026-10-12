#!/usr/bin/env bash
# Builds the self-contained Windows install: one zip with what buddi.app
# carries inside Contents/Resources, for x64 (it runs on Windows on Arm too,
# emulated: Postgres has no Windows-on-Arm binaries). apps/windows/buddi.iss
# wraps it into buddi-<version>-windows-x64-setup.exe, whose program
# (packages/install/src/windows-setup.ts) moves runtime\ to <data>\node and
# release\ to <data>\releases\buddi-<version>:
#
#   buddi-<version>-windows-x64/
#     runtime\node.exe                   Node at the version in apps/mac/NODE_VERSION (the app's pin)
#     runtime\npm.cmd, npx.cmd, node_modules\npm
#                                        npm beside node: plugin installs and upgrades use it
#     runtime\VERSION                    the Node it holds (buddi doctor reads it)
#     runtime\vcruntime\                 vcruntime140.dll, vcruntime140_1.dll, msvcp140.dll: the
#                                        Visual C++ runtime the Postgres binaries import, which
#                                        buddi copies beside them (app-local, no administrator)
#     release\                           an npm prefix, as packages/install/src/app-layout.ts stages one:
#       node_modules\@withbuddi\buddi\   the @withbuddi/buddi tarball npm serves, unpacked, with
#         node_modules\@embedded-postgres\windows-x64\   its Postgres
#       release.json                     how it was checked
#     VERSION
#
# and beside the zip `<name>.zip.sha256` (sha256sum format).
#
# Every download is checked before it is unpacked, as linux-bundle.sh does:
# Node against its SHASUMS256.txt, every npm tarball against the sha512
# integrity in its packument, and buddi's own against the signed provenance
# its release workflow published (packages/install/src/provenance.ts).
#
# The Visual C++ runtime comes from a Visual Studio installation's
# redistributable folder (VC\Redist\MSVC\<version>\x64\Microsoft.VC14x.CRT),
# which the release job finds with vswhere on the Windows runner. These are
# the files Microsoft lists as distributable code for app-local deployment.
#
# Usage: scripts/release/windows-bundle.sh <buddi-version> [out-dir]
#   VCRUNTIME_DIR=<dir>  the folder holding the three DLLs (required)
#   BUDDI_TGZ=<path>     build around a local tarball (`pnpm release:pack`) instead of
#                        the registry's: for testing a branch on a VM. No provenance,
#                        and release.json says so.
#
# Runs on Windows (CI, Git Bash) and macOS: node, curl, openssl, and a bsdtar
# (Windows' own tar.exe, macOS's tar) for the zips.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:?usage: windows-bundle.sh <buddi-version> [out-dir]}"
OUT="${2:-$ROOT/build/windows}"
ARCH=x64
NODE_VERSION="v$(tr -d '[:space:]' < "$ROOT/apps/mac/NODE_VERSION")"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
CACHE="$ROOT/build/windows/downloads"
NAME="buddi-$VERSION-windows-$ARCH"
VC_DLLS="vcruntime140.dll vcruntime140_1.dll msvcp140.dll"

say() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }
die() { printf 'windows-bundle: %s\n' "$*" >&2; exit 1; }

echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || die "\"$VERSION\" is not a version"
echo "$NODE_VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || die "apps/mac/NODE_VERSION must name one exact Node version like 22.23.3"
[ -n "${VCRUNTIME_DIR:-}" ] || die "VCRUNTIME_DIR must name the folder with $VC_DLLS (Microsoft.VC14x.CRT from a Visual Studio redistributable folder)"
mkdir -p "$CACHE" "$OUT"

# On Windows (Git Bash) the zips go through Windows' own bsdtar, which takes Windows paths.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) WINDOWS=1; BSDTAR="$(cygpath -u "${SYSTEMROOT:-C:\\Windows}")/System32/tar.exe" ;;
  *) WINDOWS=0; BSDTAR="$(command -v bsdtar || command -v tar)" ;;
esac
if [ "$WINDOWS" = 1 ] && [ -n "${BUDDI_TGZ:-}" ]; then BUDDI_TGZ="$(cygpath -u "$BUDDI_TGZ")"; fi
"$BSDTAR" --version 2>/dev/null | grep -q bsdtar || die "a bsdtar is needed for the zips ($BSDTAR is not one)"
nat() { if [ "$WINDOWS" = 1 ]; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
# Extract with bsdtar: zip or tar.gz alike, without the build host's extended attributes.
unpack() { # <archive> <dir> [args...]
  local archive="$1" dir="$2"; shift 2
  "$BSDTAR" -xf "$(nat "$archive")" -C "$(nat "$dir")" "$@"
}

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum < "$1" | awk '{ print $1 }'; else shasum -a 256 < "$1" | awk '{ print $1 }'; fi; }
# One field of a JSON file, read with node (the build host's; nothing it runs ships).
field() { node -e 'const v=String(process.argv[2]).split(".").reduce((o,k)=>o?.[k],JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));if(v===undefined)process.exit(1);console.log(typeof v==="string"?v:JSON.stringify(v))' "$(nat "$1")" "$2"; }

packument() { # <name> <version> -> path
  local file
  file="$CACHE/$(echo "$1" | tr '/@' '__')-$2.json"
  [ -s "$file" ] || curl -fsSL "$REGISTRY/$(echo "$1" | sed 's|/|%2f|')/$2" -o "$file" \
    || die "$1@$2 is not on $REGISTRY"
  echo "$file"
}

npm_tarball() { # <name> <version> -> path of the verified .tgz
  local meta url integrity file actual
  meta="$(packument "$1" "$2")"
  url="$(field "$meta" dist.tarball)"
  integrity="$(field "$meta" dist.integrity)"
  case "$integrity" in sha512-*) ;; *) die "$1@$2 has no sha512 integrity ($integrity)";; esac
  file="$CACHE/$(basename "$url")"
  [ -s "$file" ] || curl -fsSL "$url" -o "$file"
  actual="sha512-$(openssl dgst -sha512 -binary "$file" | base64 | tr -d '\n')"
  [ "$actual" = "$integrity" ] || { rm -f "$file"; die "$1@$2: integrity mismatch (expected $integrity, got $actual)"; }
  echo "$file"
}

# A PE file built for x64 (machine 0x8664), not for Arm or x86.
pe_x64() { node -e 'const b=require("fs").readFileSync(process.argv[1]);if(b.readUInt16LE(0)!==0x5a4d)process.exit(1);const pe=b.readUInt32LE(0x3c);process.exit(b.readUInt32LE(pe)===0x4550&&b.readUInt16LE(pe+4)===0x8664?0:1)' "$(nat "$1")"; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/buddi-windows-bundle.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
BUNDLE="$STAGE/$NAME"
mkdir -p "$BUNDLE"

# ---------------------------------------------------------------- Node runtime
say "Node $NODE_VERSION (win-$ARCH)"
SUMS="$CACHE/node-$NODE_VERSION-SHASUMS256.txt"
[ -s "$SUMS" ] || curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$SUMS" \
  || die "nodejs.org has no Node $NODE_VERSION"
node_zip="node-$NODE_VERSION-win-$ARCH.zip"
grep -q " $node_zip\$" "$SUMS" || die "no win-$ARCH build listed for Node $NODE_VERSION"
[ -s "$CACHE/$node_zip" ] || curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$node_zip" -o "$CACHE/$node_zip"
expected="$(awk -v n="$node_zip" '$2 == n { print $1 }' "$SUMS")"
[ "$expected" = "$(sha256 "$CACHE/$node_zip")" ] || { rm -f "$CACHE/$node_zip"; die "$node_zip: sha256 mismatch"; }
mkdir -p "$STAGE/node"
unpack "$CACHE/$node_zip" "$STAGE/node" --strip-components 1
# The runtime folder buddi.app and the Linux install have: node, npm beside it, VERSION.
# npm's .cmd shims find node beside them and npm-cli.js under node_modules\npm (upgrade.ts npmInvocation).
mkdir -p "$BUNDLE/runtime/node_modules" "$BUNDLE/runtime/vcruntime"
for f in node.exe npm npm.cmd npx npx.cmd LICENSE; do cp "$STAGE/node/$f" "$BUNDLE/runtime/$f"; done
cp -R "$STAGE/node/node_modules/npm" "$BUNDLE/runtime/node_modules/npm"
pe_x64 "$BUNDLE/runtime/node.exe" || die "node.exe is not an x64 build"
echo "$NODE_VERSION" > "$BUNDLE/runtime/VERSION"

# ---------------------------------------------------------------- Visual C++ runtime
say "Visual C++ runtime from $VCRUNTIME_DIR"
for dll in $VC_DLLS; do
  src=""
  for candidate in "$VCRUNTIME_DIR"/*; do
    [ "$(basename "$candidate" | tr '[:upper:]' '[:lower:]')" = "$dll" ] && src="$candidate"
  done
  [ -n "$src" ] || die "$VCRUNTIME_DIR has no $dll"
  pe_x64 "$src" || die "$src is not the x64 build"
  cp "$src" "$BUNDLE/runtime/vcruntime/$dll"
done

# ---------------------------------------------------------------- buddi release
RELEASE="$BUNDLE/release"
PKG="$RELEASE/node_modules/@withbuddi/buddi"
mkdir -p "$PKG"
if [ -n "${BUDDI_TGZ:-}" ]; then
  say "@withbuddi/buddi from $BUDDI_TGZ (local: integrity and provenance not checked)"
  [ -s "$BUDDI_TGZ" ] || die "BUDDI_TGZ: $BUDDI_TGZ is not a file"
  unpack "$BUDDI_TGZ" "$PKG" --strip-components 1
  [ "$(field "$PKG/package.json" version)" = "$VERSION" ] || die "$BUDDI_TGZ holds $(field "$PKG/package.json" version), not $VERSION"
  integrity="sha512-$(openssl dgst -sha512 -binary "$BUDDI_TGZ" | base64 | tr -d '\n')"
  provenance="{ \"verified\": false, \"reason\": \"built from a local tarball\" }"
else
  say "@withbuddi/buddi@$VERSION"
  TGZ="$(npm_tarball @withbuddi/buddi "$VERSION")"
  integrity="$(field "$(packument @withbuddi/buddi "$VERSION")" dist.integrity)"
  if [ "${REGISTRY%/}" = "https://registry.npmjs.org" ]; then
    say "provenance of @withbuddi/buddi@$VERSION"
    ATTESTATIONS="$CACHE/attestations-buddi-$VERSION.json"
    curl -fsSL "$REGISTRY/-/npm/v1/attestations/@withbuddi%2Fbuddi@$VERSION" -o "$ATTESTATIONS" \
      || die "$REGISTRY serves no provenance for @withbuddi/buddi@$VERSION; nothing was built"
    node --no-warnings --experimental-strip-types "$(nat "$ROOT/packages/install/src/provenance.ts")" \
      "$VERSION" "$integrity" "$(nat "$ATTESTATIONS")" \
      || die "@withbuddi/buddi@$VERSION failed its provenance check; nothing was built"
    provenance="{ \"verified\": true, \"url\": \"$REGISTRY/-/npm/v1/attestations/@withbuddi%2Fbuddi@$VERSION\", \"repository\": \"https://github.com/withbuddi/buddi\", \"workflow\": \".github/workflows/release.yml\" }"
  else
    printf 'windows-bundle: warning: %s serves no provenance; @withbuddi/buddi@%s is checked by integrity only\n' "$REGISTRY" "$VERSION" >&2
    provenance="{ \"verified\": false, \"reason\": \"$REGISTRY serves no provenance\" }"
  fi
  unpack "$TGZ" "$PKG" --strip-components 1
fi
[ -f "$PKG/packages/install/dist/windows-setup.js" ] || die "@withbuddi/buddi@$VERSION has no packages/install/dist/windows-setup.js: it predates the Windows install"

# The tarball bundles every dependency except the embedded Postgres, which npm
# picks per platform from optionalDependencies. Windows' has no library links to hydrate.
pg="@embedded-postgres/windows-$ARCH"
pg_version="$(field "$PKG/package.json" "optionalDependencies.$pg" 2>/dev/null)" || die "$PKG/package.json names no $pg"
say "$pg@$pg_version"
pg_tgz="$(npm_tarball "$pg" "$pg_version")"
dest="$PKG/node_modules/$pg"
rm -rf "$dest"; mkdir -p "$dest"
unpack "$pg_tgz" "$dest" --strip-components 1
for exe in postgres initdb pg_ctl; do
  [ -f "$dest/native/bin/$exe.exe" ] || die "$pg has no native/bin/$exe.exe"
done

cat > "$RELEASE/package.json" <<JSON
{
  "private": true,
  "description": "A buddi release installed by the buddi setup for Windows."
}
JSON
cat > "$RELEASE/release.json" <<JSON
{
  "version": "$VERSION",
  "integrity": "$integrity",
  "provenance": $provenance,
  "stagedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "node": "$NODE_VERSION",
  "arch": "windows-$ARCH"
}
JSON
echo "$VERSION" > "$BUNDLE/VERSION"

# ---------------------------------------------------------------- the zip
say "Packing $NAME.zip"
ARCHIVE="$OUT/$NAME.zip"
rm -f "$ARCHIVE"
( cd "$STAGE" && "$BSDTAR" -a -cf "$(nat "$ARCHIVE")" "$NAME" )
( cd "$OUT" && printf '%s  %s\n' "$(sha256 "$NAME.zip")" "$NAME.zip" > "$NAME.zip.sha256" )
say "Built $ARCHIVE ($(du -h "$ARCHIVE" | awk '{ print $1 }')): buddi $VERSION on Node $NODE_VERSION, windows-$ARCH"
echo "$ARCHIVE"
