#!/bin/sh
# Builds the production image for linux/amd64 and runs the whole stack once, end to end, on a throw-away
# compose project: migrate (from an old `db push` style database too), seed, start as non-root, scripted
# game over HTTP and sockets, SIGTERM drain. Secrets are generated here and live only in the environment.
#   sh scripts/smoke.sh <compose-project-name>
set -eu

PROJECT="${1:-ludo-verify-smoke}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export DOCKER_DEFAULT_PLATFORM=linux/amd64
export POSTGRES_PASSWORD="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
export JWT_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export ADMIN_USERNAME="smoke_admin"
export ADMIN_PASSWORD="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export SMOKE_IMAGE="${PROJECT}/app:smoke"

COMPOSE="docker compose -p $PROJECT -f docker-compose.smoke.yml"
cleanup() {
  $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build --platform linux/amd64 --target production -t "$SMOKE_IMAGE" .
docker build --platform linux/amd64 --target check -t "${PROJECT}/check:smoke" .
echo "image size: $(docker image inspect "$SMOKE_IMAGE" --format '{{.Size}}') bytes"

# An uploads volume from before the non-root user: files owned by root must become writable and readable.
docker run --rm -v "${PROJECT}_uploads_data:/u" alpine sh -c 'echo legacy > /u/legacy.txt && chmod 600 /u/legacy.txt'

$COMPOSE up -d --wait postgres
$COMPOSE up -d --wait app
echo "app healthy; running as: $($COMPOSE exec -T app sh -c 'ps -o user,comm | head -5' | tr '\n' ';')"
echo "legacy upload owner after start: $($COMPOSE exec -T app sh -c 'stat -c %U /app/uploads/legacy.txt')"
echo "root filesystem writable: $($COMPOSE exec -T app sh -c 'touch /app/probe 2>&1 | head -1; echo done' | tr '\n' ' ')"

NETWORK="${PROJECT}_default"
docker run --rm --network "$NETWORK" \
  -e BASE_URL=http://app:4002 -e ADMIN_USERNAME -e ADMIN_PASSWORD \
  -w /app/server "${PROJECT}/check:smoke" node scripts/smoke.mjs

START=$(date +%s)
$COMPOSE stop -t 15 app
END=$(date +%s)
echo "graceful stop took $((END - START)) s; exit code: $($COMPOSE ps -a --format '{{.ExitCode}}' app)"
$COMPOSE logs --no-color app | tail -15
