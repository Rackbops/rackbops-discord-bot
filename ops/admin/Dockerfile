FROM oven/bun:1-slim
WORKDIR /app

# ops/bot-ops.sh (which this image only ever shells out to, never reimplements) needs `docker`,
# `docker compose`, and `jq` — all three ship in Debian trixie's own repos, no need for Docker's
# official third-party apt repo here. `docker-cli` is the client only (verified: `docker.io`
# pulls in dockerd/docker-init too, which this image never runs — it only ever talks to the
# mounted host socket). `docker-compose` installs both the `docker compose` plugin form and the
# standalone `docker-compose` binary; only the former is used.
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker-cli docker-compose jq \
    && rm -rf /var/lib/apt/lists/*
RUN this-command-does-not-exist-83-breakage-test

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# server.ts imports ./admin-contract (the vendored ADMIN_API_VERSION + AdminApi types, #124), so it
# MUST be copied too — a missing local import crash-loops the container at boot (#128). Keep this in
# sync with server.ts's relative imports; guarded by server.test.ts's "Dockerfile COPY ratchet" (#163).
COPY server.ts admin-contract.ts ./
COPY public ./public

EXPOSE 8080
CMD ["bun", "run", "server.ts"]
