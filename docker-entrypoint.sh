#!/bin/sh
# Start-up sequence of the production image. Any failing step aborts the start (set -e): the app never
# runs against a database that is not migrated, and a container that fails here restarts visibly.
#
# Phase 1 (root, first call): fix ownership of the uploads volume when it predates the non-root user, then
# re-execute this script as `node` under tini. tini is PID 1 and runs as `node`, so it can deliver
# SIGTERM to the app without extra capabilities.
# Phase 2 (`node`, --run): migrate, ensure the admin, then replace the shell with the app.
set -e

if [ "${1:-}" = "--run" ]; then
  shift
  node dist/scripts/migrate.js
  node dist/scripts/seed.js
  exec "$@"
fi

if [ "$(id -u)" = "0" ]; then
  if [ "$(stat -c %u /app/uploads)" != "$(id -u node)" ]; then
    chown -R node:node /app/uploads
  fi
  exec su-exec node:node /sbin/tini -g -- "$0" --run "$@"
fi

exec /sbin/tini -g -- "$0" --run "$@"
