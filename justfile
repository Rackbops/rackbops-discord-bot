# rackbops-discord-bot — Discord bot with a plugin architecture (Bun + TypeScript)
# Requires: just, bun, docker compose
#
# This file combines two recipe groups: compose-lifecycle (build/up/down/reup/logs),
# for running the deployed stack, and the dev-workflow set
# (install/check/lint/typecheck/test/clean/fresh) docs/non-addon-repo-scaffold.md
# specifies for every non-addon repo. Kept together in this one file since both
# target this single service.

default:
    @just --list

# Install dependencies (root + ops/admin's own)
install:
    bun install
    cd ops/admin && bun install

# Run
run:
    bun run start

# Run in dev mode (auto-restart on change)
dev:
    bun run dev

# Build the bot image (bakes GIT_SHA so self-update can tell it's current)
build:
    GIT_SHA=$(git rev-parse HEAD) docker compose build

# Lint -- no linter is configured in this repo yet; nothing to run
lint:
    @echo "no linter configured in this repo yet"

# Run all checks (lint + typecheck + test)
check: lint typecheck test

# Type-check (root, plus ops/ and ops/admin/ separately — see CLAUDE.md)
typecheck:
    bun run check
    bunx tsc --noEmit -p ops/tsconfig.json
    cd ops/admin && bun run check

# Run tests (one unscoped run covers both the root and ops/admin suites)
test:
    bun test

# Build and start the stack
up:
    GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build

# Stop the stack
down:
    docker compose down

# Rebuild images and restart the stack
reup:
    GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build --force-recreate

# Tail container logs
logs:
    docker compose logs -f

# Remove installed dependencies
clean:
    rm -rf node_modules ops/admin/node_modules

# Reinstall from scratch
fresh: clean install
