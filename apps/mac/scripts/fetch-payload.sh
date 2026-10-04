#!/usr/bin/env bash
# Fetches what buddi.app carries inside Contents/Resources, into apps/mac/Payload:
#
#   Payload/runtime/node                     Node LTS, one universal (arm64 + x64) binary
#   Payload/runtime/npm, npx, lib/node_modules/npm
#                                            npm beside node: plugin installs use it
#   Payload/buddi/buddi-<version>/           the @withbuddi/buddi tarball npm serves, unpacked,
#                                            with BOTH @embedded-postgres/darwin-* packages
#   Payload/buddi/current -> buddi-<version>
#
# Every download is checked before it is unpacked: Node against its SHASUMS256.txt,
# every npm tarball against the sha512 integrity in its packument, and buddi's own
# against the signed provenance its release workflow published (from npmjs.com).
#
# Usage: scripts/fetch-payload.sh <buddi-version> [node-major]
set -euo pipefail

VERSION="${1:?usage: fetch-payload.sh <buddi-version> [node-major]}"
NODE_MAJOR="${2:-22}"
REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PAYLOAD="$HERE/Payload"
CACHE="$HERE/build/downloads"
mkdir -p "$CACHE" "$PAYLOAD"

say() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }
die() { printf 'fetch: %s\n' "$*" >&2; exit 1; }

# The packument of one version, cached; plutil reads JSON as well as plists.
packument() { # <name> <version> -> path
  local file
  file="$CACHE/$(echo "$1" | tr '/@' '__')-$2.json"
  [ -s "$file" ] || curl -fsSL "$REGISTRY/$(echo "$1" | sed 's|/|%2f|')/$2" -o "$file" \
    || die "$1@$2 is not on $REGISTRY"
  echo "$file"
}
field() { plutil -extract "$2" raw -o - "$1"; }

# Download an npm tarball and check it against the packument's integrity hash.
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

# ---------------------------------------------------------------- Node runtime
say "Node $NODE_MAJOR LTS (universal)"
SUMS="$CACHE/node-v$NODE_MAJOR-SHASUMS256.txt"
curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt" -o "$SUMS"
NODE_VERSION="$(sed -n 's/.*node-\(v[0-9.]*\)-darwin-arm64\.tar\.gz$/\1/p' "$SUMS")"
[ -n "$NODE_VERSION" ] || die "no darwin build listed for Node $NODE_MAJOR"
for arch in arm64 x64; do
  name="node-$NODE_VERSION-darwin-$arch.tar.gz"
  [ -s "$CACHE/$name" ] || curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$name" -o "$CACHE/$name"
  expected="$(awk -v n="$name" '$2 == n { print $1 }' "$SUMS")"
  actual="$(shasum -a 256 "$CACHE/$name" | awk '{ print $1 }')"
  [ "$expected" = "$actual" ] || { rm -f "$CACHE/$name"; die "$name: sha256 mismatch"; }
  rm -rf "$CACHE/node-$arch"; mkdir -p "$CACHE/node-$arch"
  tar -xzf "$CACHE/$name" -C "$CACHE/node-$arch" --strip-components 1
done
rm -rf "$PAYLOAD/runtime"; mkdir -p "$PAYLOAD/runtime/lib/node_modules"
lipo -create "$CACHE/node-arm64/bin/node" "$CACHE/node-x64/bin/node" -output "$PAYLOAD/runtime/node"
# lipo drops Node's own signatures. An ad-hoc one lets it run on Apple silicon in a
# local build; `make notarize` replaces it with the Developer ID one.
codesign --force --sign - "$PAYLOAD/runtime/node"
# npm is plain JavaScript: one copy serves both architectures.
cp -R "$CACHE/node-arm64/lib/node_modules/npm" "$PAYLOAD/runtime/lib/node_modules/npm"
ln -s lib/node_modules/npm/bin/npm-cli.js "$PAYLOAD/runtime/npm"
ln -s lib/node_modules/npm/bin/npx-cli.js "$PAYLOAD/runtime/npx"
echo "$NODE_VERSION" > "$PAYLOAD/runtime/VERSION"

# ---------------------------------------------------------------- buddi release
say "@withbuddi/buddi@$VERSION"
TGZ="$(npm_tarball @withbuddi/buddi "$VERSION")"

# Who built it, not only which bytes: the release baked into a signed DMG must carry
# the provenance withbuddi/buddi's release workflow published for this tag. The same
# check buddi.app makes before it installs an update (packages/install/src/provenance.ts:
# Fulcio chain, signature, subject sha512 = the integrity just checked, the workflow at
# refs/tags/v<version>), run with the Node going into the app. A registry of one's own
# serves no provenance and is let through with a warning, as the app does.
if [ "${REGISTRY%/}" = "https://registry.npmjs.org" ]; then
  say "provenance of @withbuddi/buddi@$VERSION"
  ATTESTATIONS="$CACHE/attestations-buddi-$VERSION.json"
  curl -fsSL "$REGISTRY/-/npm/v1/attestations/@withbuddi%2Fbuddi@$VERSION" -o "$ATTESTATIONS" \
    || die "$REGISTRY serves no provenance for @withbuddi/buddi@$VERSION; nothing was built"
  "$PAYLOAD/runtime/node" --no-warnings --experimental-strip-types "$HERE/../../packages/install/src/provenance.ts" \
    "$VERSION" "$(field "$(packument @withbuddi/buddi "$VERSION")" dist.integrity)" "$ATTESTATIONS" \
    || die "@withbuddi/buddi@$VERSION failed its provenance check; nothing was built"
else
  printf 'fetch: warning: %s serves no provenance; @withbuddi/buddi@%s is checked by integrity only\n' "$REGISTRY" "$VERSION" >&2
fi
rm -rf "$PAYLOAD/buddi"; mkdir -p "$PAYLOAD/buddi/buddi-$VERSION"
RELEASE="$PAYLOAD/buddi/buddi-$VERSION"
tar -xzf "$TGZ" -C "$RELEASE" --strip-components 1
ln -s "buddi-$VERSION" "$PAYLOAD/buddi/current"

# The tarball bundles every dependency (bundleDependencies) except the embedded
# Postgres, which npm picks per platform from optionalDependencies and finishes
# with its postinstall (hydrate-symlinks.js: the dylib links npm cannot pack).
# `npm install -g` would fetch only this Mac's architecture; the app carries both,
# so one DMG runs on Apple silicon and Intel alike.
for arch in arm64 x64; do
  pkg="@embedded-postgres/darwin-$arch"
  pg_version="$(field "$RELEASE/package.json" "optionalDependencies.$pkg")"
  say "$pkg@$pg_version"
  pg_tgz="$(npm_tarball "$pkg" "$pg_version")"
  dest="$RELEASE/node_modules/$pkg"
  rm -rf "$dest"; mkdir -p "$dest"
  tar -xzf "$pg_tgz" -C "$dest" --strip-components 1
  # Run its install script as npm would: from the package, with the bundled node.
  if [ -f "$dest/scripts/hydrate-symlinks.js" ]; then
    (cd "$dest" && PATH="$PAYLOAD/runtime:$PATH" "$PAYLOAD/runtime/node" scripts/hydrate-symlinks.js)
  fi
done

# A packaged installation upgrades itself with `npm install --prefix <dir above its
# root>`. Inside the app that would write into a signed bundle, so npm must never be
# pointed here: the app upgrades into <data>/releases instead (BUDDI_APP_LAYOUT,
# packages/install/src/app-layout.ts), and upgradeTarget refuses any root inside a
# .app. This named manifest is a second guard for an npm run by hand.
cat > "$PAYLOAD/buddi/package.json" <<JSON
{
  "name": "buddi-app-bundle",
  "private": true,
  "description": "buddi.app carries buddi here; the app updates it, not npm."
}
JSON

say "Payload ready: buddi $VERSION on Node $NODE_VERSION ($(du -sh "$PAYLOAD" | awk '{ print $1 }'))"
