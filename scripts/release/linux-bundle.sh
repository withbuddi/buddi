#!/usr/bin/env bash
# Builds the self-contained Linux install: one tarball per architecture with
# what buddi.app carries inside Contents/Resources. scripts/install.sh moves
# runtime/ to ~/.local/share/buddi/node and release/ to releases/buddi-<version>:
#
#   buddi-<version>-linux-<arch>/
#     install.sh                         scripts/install.sh, so the tarball installs offline too
#     runtime/node                       Node at the version in apps/mac/NODE_VERSION (the app's pin)
#     runtime/npm, npx, lib/node_modules/npm
#                                        npm beside node: plugin installs and upgrades use it
#     runtime/VERSION                    the Node it holds (buddi doctor reads it)
#     release/                           an npm prefix, as packages/install/src/app-layout.ts stages one:
#       node_modules/@withbuddi/buddi/   the @withbuddi/buddi tarball npm serves, unpacked, with
#         node_modules/@embedded-postgres/linux-<arch>/   its Postgres, links hydrated
#       release.json                     how it was checked
#
# and beside the tarball `<name>.tar.gz.sha256` (sha256sum format), which
# install.sh checks before it unpacks anything.
#
# Every download is checked before it is unpacked, as apps/mac/scripts/fetch-payload.sh
# does: Node against its SHASUMS256.txt, every npm tarball against the sha512
# integrity in its packument, and buddi's own against the signed provenance its
# release workflow published (packages/install/src/provenance.ts).
#
# Usage: scripts/release/linux-bundle.sh <buddi-version> <x64|arm64> [out-dir]
#   BUDDI_TGZ=<path>  build around a local tarball (`pnpm release:pack`) instead of
#                     the registry's: for testing a branch on a VM. No provenance,
#                     and release.json says so.
#
# Runs on Linux (CI) and macOS (a local build): node, curl, tar, openssl.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${1:?usage: linux-bundle.sh <buddi-version> <x64|arm64> [out-dir]}"
ARCH="${2:?usage: linux-bundle.sh <buddi-version> <x64|arm64> [out-dir]}"
OUT="${3:-$ROOT/build/linux}"
NODE_VERSION="v$(tr -d '[:space:]' < "$ROOT/apps/mac/NODE_VERSION")"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
CACHE="$ROOT/build/linux/downloads"
NAME="buddi-$VERSION-linux-$ARCH"

say() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }
die() { printf 'linux-bundle: %s\n' "$*" >&2; exit 1; }

case "$ARCH" in x64|arm64) ;; *) die "architecture must be x64 or arm64, not \"$ARCH\"";; esac
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || die "\"$VERSION\" is not a version"
echo "$NODE_VERSION" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || die "apps/mac/NODE_VERSION must name one exact Node version like 22.23.3"
mkdir -p "$CACHE" "$OUT"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi; }
# One field of a JSON file, read with node (the build host's; nothing it runs ships).
field() { node -e 'const v=String(process.argv[2]).split(".").reduce((o,k)=>o?.[k],JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));if(v===undefined)process.exit(1);console.log(typeof v==="string"?v:JSON.stringify(v))' "$1" "$2"; }

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

# Extract without the build host's extended attributes (a macOS build would add ._ files).
untar() { # <archive> <dir> [tar args...]
  local archive="$1" dir="$2"; shift 2
  tar -xzf "$archive" -C "$dir" "$@"
}

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/buddi-linux-bundle.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
BUNDLE="$STAGE/$NAME"
mkdir -p "$BUNDLE"

# ---------------------------------------------------------------- Node runtime
say "Node $NODE_VERSION (linux-$ARCH)"
SUMS="$CACHE/node-$NODE_VERSION-SHASUMS256.txt"
[ -s "$SUMS" ] || curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$SUMS" \
  || die "nodejs.org has no Node $NODE_VERSION"
node_tgz="node-$NODE_VERSION-linux-$ARCH.tar.gz"
grep -q " $node_tgz\$" "$SUMS" || die "no linux-$ARCH build listed for Node $NODE_VERSION"
[ -s "$CACHE/$node_tgz" ] || curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$node_tgz" -o "$CACHE/$node_tgz"
expected="$(awk -v n="$node_tgz" '$2 == n { print $1 }' "$SUMS")"
[ "$expected" = "$(sha256 "$CACHE/$node_tgz")" ] || { rm -f "$CACHE/$node_tgz"; die "$node_tgz: sha256 mismatch"; }
mkdir -p "$STAGE/node"
untar "$CACHE/$node_tgz" "$STAGE/node" --strip-components 1
# The same runtime folder as buddi.app's (fetch-payload.sh): node, npm linked beside it, VERSION.
mkdir -p "$BUNDLE/runtime/lib/node_modules"
cp "$STAGE/node/bin/node" "$BUNDLE/runtime/node"
cp "$STAGE/node/LICENSE" "$BUNDLE/runtime/LICENSE"
cp -R "$STAGE/node/lib/node_modules/npm" "$BUNDLE/runtime/lib/node_modules/npm"
ln -s lib/node_modules/npm/bin/npm-cli.js "$BUNDLE/runtime/npm"
ln -s lib/node_modules/npm/bin/npx-cli.js "$BUNDLE/runtime/npx"
echo "$NODE_VERSION" > "$BUNDLE/runtime/VERSION"

# ---------------------------------------------------------------- buddi release
RELEASE="$BUNDLE/release"
PKG="$RELEASE/node_modules/@withbuddi/buddi"
mkdir -p "$PKG"
if [ -n "${BUDDI_TGZ:-}" ]; then
  say "@withbuddi/buddi from $BUDDI_TGZ (local: integrity and provenance not checked)"
  [ -s "$BUDDI_TGZ" ] || die "BUDDI_TGZ: $BUDDI_TGZ is not a file"
  untar "$BUDDI_TGZ" "$PKG" --strip-components 1
  [ "$(field "$PKG/package.json" version)" = "$VERSION" ] || die "$BUDDI_TGZ holds $(field "$PKG/package.json" version), not $VERSION"
  integrity="sha512-$(openssl dgst -sha512 -binary "$BUDDI_TGZ" | base64 | tr -d '\n')"
  provenance="{ \"verified\": false, \"reason\": \"built from a local tarball\" }"
else
  say "@withbuddi/buddi@$VERSION"
  TGZ="$(npm_tarball @withbuddi/buddi "$VERSION")"
  integrity="$(field "$(packument @withbuddi/buddi "$VERSION")" dist.integrity)"
  if [ "${REGISTRY%/}" = "https://registry.npmjs.org" ]; then
    # Who built it, not only which bytes: the check buddi itself makes before an update.
    say "provenance of @withbuddi/buddi@$VERSION"
    ATTESTATIONS="$CACHE/attestations-buddi-$VERSION.json"
    curl -fsSL "$REGISTRY/-/npm/v1/attestations/@withbuddi%2Fbuddi@$VERSION" -o "$ATTESTATIONS" \
      || die "$REGISTRY serves no provenance for @withbuddi/buddi@$VERSION; nothing was built"
    node --no-warnings --experimental-strip-types "$ROOT/packages/install/src/provenance.ts" \
      "$VERSION" "$integrity" "$ATTESTATIONS" \
      || die "@withbuddi/buddi@$VERSION failed its provenance check; nothing was built"
    provenance="{ \"verified\": true, \"url\": \"$REGISTRY/-/npm/v1/attestations/@withbuddi%2Fbuddi@$VERSION\", \"repository\": \"https://github.com/withbuddi/buddi\", \"workflow\": \".github/workflows/release.yml\" }"
  else
    printf 'linux-bundle: warning: %s serves no provenance; @withbuddi/buddi@%s is checked by integrity only\n' "$REGISTRY" "$VERSION" >&2
    provenance="{ \"verified\": false, \"reason\": \"$REGISTRY serves no provenance\" }"
  fi
  untar "$TGZ" "$PKG" --strip-components 1
fi

# The tarball bundles every dependency except the embedded Postgres, which npm
# picks per platform from optionalDependencies and finishes with its postinstall
# (hydrate-symlinks.js: the library links npm cannot pack). Run here, as npm would.
pg="@embedded-postgres/linux-$ARCH"
pg_version="$(field "$PKG/package.json" "optionalDependencies.$pg" 2>/dev/null)" || die "$PKG/package.json names no $pg"
say "$pg@$pg_version"
pg_tgz="$(npm_tarball "$pg" "$pg_version")"
dest="$PKG/node_modules/$pg"
rm -rf "$dest"; mkdir -p "$dest"
untar "$pg_tgz" "$dest" --strip-components 1
if [ -f "$dest/scripts/hydrate-symlinks.js" ]; then
  (cd "$dest" && node scripts/hydrate-symlinks.js)
fi
[ -x "$dest/native/bin/postgres" ] || die "$pg has no native/bin/postgres"

# npm's own kind of prefix manifest (no name: nobody's project), and the record
# app-layout.ts writes for a release it staged.
cat > "$RELEASE/package.json" <<JSON
{
  "private": true,
  "description": "A buddi release installed by scripts/install.sh."
}
JSON
cat > "$RELEASE/release.json" <<JSON
{
  "version": "$VERSION",
  "integrity": "$integrity",
  "provenance": $provenance,
  "stagedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "node": "$NODE_VERSION",
  "arch": "$ARCH"
}
JSON

cp "$ROOT/scripts/install.sh" "$BUNDLE/install.sh"
chmod 755 "$BUNDLE/install.sh"
echo "$VERSION" > "$BUNDLE/VERSION"

# ---------------------------------------------------------------- the tarball
say "Packing $NAME.tar.gz"
ARCHIVE="$OUT/$NAME.tar.gz"
# Plain ustar members, owned by nobody in particular, without macOS metadata.
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  tar -C "$STAGE" --owner=0 --group=0 --numeric-owner -czf "$ARCHIVE" "$NAME"
else
  COPYFILE_DISABLE=1 tar -C "$STAGE" --uid 0 --gid 0 --no-mac-metadata --no-xattrs -czf "$ARCHIVE" "$NAME"
fi
( cd "$OUT" && printf '%s  %s\n' "$(sha256 "$NAME.tar.gz")" "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
say "Built $ARCHIVE ($(du -h "$ARCHIVE" | awk '{ print $1 }')): buddi $VERSION on Node $NODE_VERSION, linux-$ARCH"
echo "$ARCHIVE"
