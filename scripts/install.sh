#!/usr/bin/env bash
#
# buddi — fresh-machine install.
#
# Checks that git, node, pnpm and docker are there, installs the workspace,
# builds it, and links the single global `buddi` command. It installs no system
# software itself: if something is missing it says what and where to get it, and
# stops. Installing a package manager behind your back is not this script's job.
#
#   curl -fsSL .../scripts/install.sh | bash     (from inside a clone: ./scripts/install.sh)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_NODE_MAJOR=22

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; }

missing=0

need() {
  local cmd="$1" what="$2" where="$3"
  if command -v "$cmd" >/dev/null 2>&1; then
    printf '  %-8s %s\n' "$cmd" "$($cmd --version 2>&1 | head -n1)"
  else
    fail "  $cmd is not installed — $what"
    fail "      get it: $where"
    missing=1
  fi
}

bold "Checking what this machine has"
need git "buddi is installed from a clone" "https://git-scm.com/downloads (or: xcode-select --install)"
need node "buddi runs on Node $MIN_NODE_MAJOR or newer" "https://nodejs.org (or: brew install node)"
need pnpm "the workspace is a pnpm monorepo" "https://pnpm.io/installation (or: corepack enable pnpm)"
need docker "postgres runs in a container" "https://docs.docker.com/get-docker/ (or: brew install --cask docker)"

if [ "$missing" -ne 0 ]; then
  fail ""
  fail "Install what is listed above, then run this script again. Nothing was changed."
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
    fail "Node $(node -v) is too old — buddi needs $MIN_NODE_MAJOR or newer."
    exit 1
  fi
fi

echo
bold "Installing dependencies (pnpm install)"
(cd "$REPO_ROOT" && pnpm install)

echo
bold "Building (pnpm -r build)"
(cd "$REPO_ROOT" && pnpm -r build)

echo
bold "Linking the global command (pnpm run link)"
(cd "$REPO_ROOT" && pnpm run link)

echo
if command -v buddi >/dev/null 2>&1; then
  bold "buddi is on your PATH."
else
  fail "buddi is not on your PATH yet."
  dim "pnpm's global bin directory needs to be on PATH — run \`pnpm setup\`, open a new shell,"
  dim "then \`pnpm run link\` again. Until then, use \`pnpm buddi …\` from $REPO_ROOT."
fi

echo
bold "Next:  buddi init      — credentials, timezone, database, migrations"
echo "       buddi doctor    — check every moving part"
echo "       buddi service install && buddi telegram pair"
