# rackbops-discord-bot — Discord bot with a plugin architecture (Bun + TypeScript)
# Requires: just, bun, docker compose

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

# Run all checks (typecheck + test) — no linter configured in this repo, so no lint step
check: typecheck test

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
