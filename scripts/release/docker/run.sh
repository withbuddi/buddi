#!/usr/bin/env bash
# Try the packaged install and the first-run wizard on a clean Linux system,
# from the browser of whatever machine is running Docker.
#
#   pnpm release:docker            # build the tarball and the image
#   scripts/release/docker/run.sh  # start it and print the dashboard link
#
# Ctrl-C stops the container. Data lives in the named volume `buddi-trial`
# between runs; `--reset` throws it away so the next start is a true first run.
set -euo pipefail

IMAGE=buddi-trial
CONTAINER=buddi-trial
VOLUME=buddi-trial
DATA=/home/node/.local/share/buddi
# The gateway's port inside the container. A fresh container has nothing on
# 4317, so `freePort(4317)` takes it, and the origin the browser sends then
# matches the gateway's own. See the assertion below.
INTERNAL=4317
HOST_PORT=${BUDDI_TRIAL_PORT:-4317}

if [ "${1:-}" = "--reset" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if docker volume rm "$VOLUME" >/dev/null 2>&1; then
    echo "Removed the $VOLUME volume: this is a true first run."
  else
    echo "No $VOLUME volume to remove: this is a true first run."
  fi
  shift
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "No $IMAGE image. Build it first: pnpm release:docker" >&2
  exit 1
fi

# The trial is only worth doing if the browser can send the origin the gateway
# expects, and that means the same port on both sides.
if nc -z 127.0.0.1 "$HOST_PORT" >/dev/null 2>&1; then
  cat >&2 <<EOF
Port $HOST_PORT is already listening on this machine — most likely your own
Buddi installation, which uses 4317 too.

The dashboard refuses writes whose Origin is not its own, and the browser's
origin is http://127.0.0.1:<host port> while the gateway's is
http://127.0.0.1:$INTERNAL. So a different host port gets you a dashboard you
can read and a wizard you cannot complete.

To try the wizard for real, stop your local Buddi and run this again. To look
around read-only, pick another port: BUDDI_TRIAL_PORT=4318 $0
EOF
  exit 1
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -p "127.0.0.1:$HOST_PORT:$INTERNAL" \
  -v "$VOLUME:$DATA" \
  -e BUDDI_VAULT=file \
  "$IMAGE" >/dev/null
cleanup() {
  [ -n "${follower:-}" ] && kill "$follower" 2>/dev/null
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup INT TERM EXIT

# A supervisor pid left in the volume was written in a previous container's pid
# namespace, where it meant something; in this one the same small number is some
# unrelated live process, so the lock's own staleness test would believe the
# installation is still supervised. Nothing in a container created one line ago
# is supervising anything, so the leftovers go.
docker exec "$CONTAINER" sh -c 'rm -f "$1/supervisor.lock" "$1/supervisor.sock"' sh "$DATA"

echo "Starting the packaged install inside the container. First run provisions Postgres; give it a minute."
# Linux has no service manager in this slice: the launcher says so, and
# --no-service is the detached supervisor it offers instead. --no-open because
# there is no browser in here to open anything with.
first=$(docker exec "$CONTAINER" buddi --no-service --no-open)
echo "$first" | sed 's/^/  /'

state=$(docker exec "$CONTAINER" cat "$DATA/installation.json")
webPort=$(printf '%s' "$state" | tr -d ' ' | sed -n 's/.*"webPort":\([0-9]*\).*/\1/p')
[ -n "$webPort" ] || { echo "Could not read webPort from installation.json." >&2; exit 1; }
if [ "$webPort" != "$INTERNAL" ]; then
  cat >&2 <<EOF
The gateway inside the container took port $webPort, not $INTERNAL. That only
happens when a persisted installation.json from an earlier run chose another
port, and it breaks the wizard: the browser would send Origin
http://127.0.0.1:$HOST_PORT while the gateway answers for
http://127.0.0.1:$webPort, and every write would be refused with 403.

Start over with a clean data directory: $0 --reset
EOF
  exit 1
fi

# The gateway stays on 127.0.0.1 inside the container. Docker publishes to the
# container's own address, so this is what joins the two.
ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER")
docker exec -d "$CONTAINER" socat "TCP-LISTEN:$INTERNAL,bind=$ip,fork,reuseaddr" "TCP:127.0.0.1:$webPort"

# The launcher's readiness probe is the installation-secret challenge at
# /_buddi/ready, not the login ticket, so the link printed above has not been
# spent and is the one to open.
link=$(printf '%s' "$first" | sed -n 's/^Dashboard: //p' | tail -1)
[ -n "$link" ] || { echo "The launcher printed no dashboard link." >&2; exit 1; }
link=${link/127.0.0.1:$webPort/127.0.0.1:$HOST_PORT}

echo
echo "Open this on your own machine:"
echo "  $link"
echo "The ticket expires in five minutes. For a fresh one:"
echo "  docker exec $CONTAINER buddi --no-service --no-open"
if [ "$HOST_PORT" != "$INTERNAL" ]; then
  echo
  echo "Note: the host port is $HOST_PORT but the gateway's is $INTERNAL, so the browser's"
  echo "origin is not the gateway's. You can read the dashboard; the wizard's writes will"
  echo "be refused with 403 until both sides are $INTERNAL."
fi
echo
echo "Supervisor log follows. Ctrl-C stops the container; the data volume survives."
echo
# In the background and waited on, not in the foreground: a shell blocked in a
# foreground child runs no trap until that child returns, and Ctrl-C has to
# take the container down even when the signal reaches only this script.
docker exec "$CONTAINER" tail -n +1 -f "$DATA/logs/supervisor.log" &
follower=$!
wait "$follower" || true
