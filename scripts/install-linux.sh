#!/usr/bin/env bash
#
# buddi — packaged install on Linux, from a GitHub release.
#
# The distribution is `npm install -g buddi` (docs/install.md §1). Until the
# package is on npmjs.org, the same tarball is attached to a GitHub release, and
# this script is the `curl | bash` in front of it: it checks Node, fetches the
# newest release's tarball with `gh` (the repository is private) and installs
# it globally. Nothing is cloned and nothing is built here.
#
#   gh release download v0.1.0-pre.1 -R withbuddi/buddi -p install-linux.sh -O - | bash
#
# Optional: BUDDI_RELEASE=<tag> installs that release instead of the newest.
set -euo pipefail

REPO=${BUDDI_REPO:-withbuddi/buddi}
MIN_NODE_MAJOR=22

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; }

bold "Checking what this machine has"
for cmd in gh node npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    case "$cmd" in
      gh) fail "  gh is not installed — the release is fetched with it (the repository is private): https://cli.github.com";;
      *) fail "  $cmd is not installed — buddi runs on Node $MIN_NODE_MAJOR or newer: https://nodejs.org (or: https://github.com/nvm-sh/nvm)";;
    esac
    exit 1
  fi
done
printf '  node     %s\n' "$(node --version)"
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
  fail "  Node $MIN_NODE_MAJOR or newer is needed, this is $(node --version)."
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  fail "  gh is not signed in. Run: gh auth login"
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bold "Fetching the release tarball from $REPO"
# The newest release, pre-releases included: `gh release download` with no
# tag skips pre-releases, and every trial release is one.
tag=${BUDDI_RELEASE:-$(gh release list -R "$REPO" --limit 1 --json tagName -q '.[0].tagName')}
if [ -z "$tag" ]; then fail "  $REPO has no release to install."; exit 1; fi
printf '  release  %s\n' "$tag"
gh release download "$tag" -R "$REPO" -p 'buddi-*.tgz' -D "$tmp"
tgz=$(ls "$tmp"/buddi-*.tgz | head -n1)
printf '  %s\n' "$(basename "$tgz")"

bold "Installing buddi globally (npm install -g)"
# The optional @embedded-postgres/linux-<arch> package is the managed Postgres
# for this machine; it comes from npmjs.org, so optional dependencies stay on.
npm install -g --no-audit --no-fund "$tgz"

if ! command -v buddi >/dev/null 2>&1; then
  fail "npm installed it, but 'buddi' is not on PATH. Add npm's global bin directory: $(npm prefix -g)/bin"
  exit 1
fi
bold "Installed: $(buddi --version 2>/dev/null || echo buddi)"
echo
echo "Next: run 'buddi' — the first run sets up the data directory, the vault"
echo "and Postgres, and ends in the wizard on http://127.0.0.1:4317/."
echo "It installs a systemd user unit so buddi starts at login and survives a"
echo "reboot; run 'loginctl enable-linger $USER' once so it also survives logout."
echo "The dashboard binds 127.0.0.1 only. From another machine, forward the port"
echo "over SSH (ssh -L 4317:127.0.0.1:4317 <host>) or sign in through Tailscale."
echo "Another port, now or later: BUDDI_WEB_PORT=4417 buddi"
