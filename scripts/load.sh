#!/bin/sh
# Runs server/scripts/load.mjs against the production image under the production limits (app 900 MB and
# 1 CPU, Postgres 384 MB and 1 CPU) and samples both containers once a second.
#   sh scripts/load.sh <compose-project-name> [players]
# Secrets are generated here and live only in the environment.
set -eu

PROJECT="${1:-ludo-verify-load}"
PLAYERS="${2:-150}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export DOCKER_DEFAULT_PLATFORM=linux/amd64
export POSTGRES_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export JWT_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export ADMIN_USERNAME="load_admin"
export ADMIN_PASSWORD="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export SMOKE_IMAGE="${SMOKE_IMAGE:-${PROJECT}/app:load}"

COMPOSE="docker compose -p $PROJECT -f docker-compose.smoke.yml"
STATS="$(mktemp)"
cleanup() {
  [ -n "${SAMPLER:-}" ] && kill "$SAMPLER" 2>/dev/null || true
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$STATS"
}
trap cleanup EXIT INT TERM

if ! docker image inspect "$SMOKE_IMAGE" >/dev/null 2>&1; then
  docker build --platform linux/amd64 --target production -t "$SMOKE_IMAGE" .
fi
docker build --platform linux/amd64 --target check -t "${PROJECT}/check:load" . >/dev/null

$COMPOSE up -d --wait postgres
$COMPOSE up -d --wait app

# Sampler: "<name> <cpu%> <mem used>" once a second.
(
  while true; do
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' "${PROJECT}-app-1" "${PROJECT}-postgres-1" >> "$STATS" 2>/dev/null || true
    sleep 1
  done
) &
SAMPLER=$!

docker run --rm --network "${PROJECT}_default" \
  -e BASE_URL=http://app:4002 -e ADMIN_USERNAME -e ADMIN_PASSWORD -e PLAYERS="$PLAYERS" \
  -w /app/server "${PROJECT}/check:load" node scripts/load.mjs || RESULT=$?

kill "$SAMPLER" 2>/dev/null || true
SAMPLER=""
echo
echo "container samples (peak and mean CPU, peak memory):"
for name in "${PROJECT}-app-1" "${PROJECT}-postgres-1"; do
  grep "^$name " "$STATS" | awk -v n="$name" '
    { cpu=$2; sub("%","",cpu); mem=$3; u=mem; gsub(/[0-9.]/,"",u); v=mem; gsub(/[A-Za-z]/,"",v);
      if (u=="GiB") v=v*1024; else if (u=="KiB") v=v/1024; else if (u=="B") v=v/1048576;
      if (cpu+0>maxcpu) maxcpu=cpu+0; sum+=cpu; c++; if (v>maxmem) maxmem=v }
    END { printf "  %-28s samples %d, CPU peak %.0f%% mean %.0f%%, memory peak %.0f MiB\n", n, c, maxcpu, (c?sum/c:0), maxmem }'
done
echo "application errors in the log (first 5):"
$COMPOSE logs --no-color app 2>/dev/null | grep '"level":"error"' | head -5 | cut -c1-600 || true
echo "database lock waits and deadlocks in the Postgres log:"
$COMPOSE logs --no-color postgres 2>/dev/null | grep -ciE "deadlock detected|still waiting for" || true
exit "${RESULT:-0}"
