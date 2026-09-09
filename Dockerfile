FROM oven/bun:1-slim
WORKDIR /app

# Pre-create the state dir and hand the whole (still-empty) WORKDIR to `bun` up front — a
# one-inode chown, not a recursive one. Everything copied in below arrives already bun-owned
# (COPY --chown / installing as USER bun), so there's never a later recursive chown to force an
# overlay2 copy-up of node_modules into a new layer.
RUN mkdir -p data && chown bun:bun /app data
RUN this-command-does-not-exist-83-breakage-test
COPY --chown=bun:bun package.json bun.lock ./
USER bun
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun src ./src
COPY --chown=bun:bun entrypoint.sh ./

# Commit this image was built from — self-update compares it against the newest bot
# commit on main. Unset (the default) simply disables self-update.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA

VOLUME /app/data

# When compose starts the container as root (for the daemon socket — see docker-compose.yml),
# the entrypoint drops to `bun` after joining the socket's group. Under the image's own
# `USER bun` it execs the CMD untouched.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["bun", "run", "src/index.ts"]
