# Ludo Arena developer entry point. Everything runs in Docker, for linux/amd64 (the device's architecture).
#
#   make check        lint + typecheck + server tests (real Postgres) + client tests + production build
#   make test         server and client tests only
#   make image        build the production image (ludo-arena:prod) for linux/amd64
#   make smoke        build the production image and run it end to end against a throw-away Postgres
#                     (migrate, seed, login, a scripted game from ping to settlement, SIGTERM shutdown)
#   make env          write a .env for the dev stack with freshly generated secrets (never overwrites)
#   make up | down    start / stop the dev stack (docker-compose.dev.yml)
#   make clean        remove this project's containers, volumes and images
#
# Compose project name: PROJECT (default ludo-dev). Secrets are generated per invocation, passed through the
# environment only, and never echoed or written to a file.

PROJECT ?= ludo-dev
export DOCKER_DEFAULT_PLATFORM ?= linux/amd64
export TEST_DB_PASSWORD := $(shell od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
export TEST_JWT_SECRET := $(shell od -An -N32 -tx1 /dev/urandom | tr -d ' \n')

TEST_COMPOSE := docker compose -p $(PROJECT)-test -f docker-compose.test.yml
DEV_COMPOSE  := docker compose -p $(PROJECT) -f docker-compose.dev.yml

.PHONY: check test lint typecheck image smoke env up down clean

check: _test-up
	@$(TEST_COMPOSE) run --rm check npm run check:all; status=$$?; $(TEST_COMPOSE) down -v --remove-orphans >/dev/null 2>&1; exit $$status

test: _test-up
	@$(TEST_COMPOSE) run --rm check npm run test; status=$$?; $(TEST_COMPOSE) down -v --remove-orphans >/dev/null 2>&1; exit $$status

lint: _test-up
	@$(TEST_COMPOSE) run --rm --no-deps check npm run lint; status=$$?; $(TEST_COMPOSE) down -v --remove-orphans >/dev/null 2>&1; exit $$status

typecheck: _test-up
	@$(TEST_COMPOSE) run --rm --no-deps check npm run typecheck; status=$$?; $(TEST_COMPOSE) down -v --remove-orphans >/dev/null 2>&1; exit $$status

_test-up:
	@$(TEST_COMPOSE) build check
	@$(TEST_COMPOSE) up -d --wait postgres

image:
	docker build --platform linux/amd64 --target production -t ludo-arena:prod .

smoke:
	sh scripts/smoke.sh $(PROJECT)-smoke

env:
	@test ! -e .env || { echo ".env already exists, not overwriting"; exit 1; }
	@umask 077; { \
	  echo "POSTGRES_PASSWORD=$$(openssl rand -hex 16)"; \
	  echo "JWT_SECRET=$$(openssl rand -hex 32)"; \
	  echo "ADMIN_USERNAME=admin"; \
	  echo "ADMIN_PASSWORD=$$(openssl rand -hex 12)"; \
	} > .env
	@echo ".env written (secrets generated; the admin password is in the file)"

up:
	@test -f .env || { echo "run 'make env' first"; exit 1; }
	$(DEV_COMPOSE) up -d --build --wait

down:
	$(DEV_COMPOSE) down

clean:
	-$(TEST_COMPOSE) down -v --remove-orphans
	-$(DEV_COMPOSE) down -v --remove-orphans
