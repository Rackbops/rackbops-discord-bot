# Where a plugin lives is bot-owned data, applied live

Until Epic #236 every slash command was registered in one place — the guild `DISCORD_SERVER_ID`
names, or globally when it is unset (one `rest.put` in `src/index.ts`) — and every plugin's
`announce` posted to one channel (`ANNOUNCE_CHANNEL_ID`). Neither was a per-plugin setting, and the
admin panel could change each only as one instance-wide `.env` value, by pasting a Discord id. Going
live with the `music` plugin on 2026-09-20 made the cost concrete: its commands were wanted in a
second server the bot was already in, and the only way to get them there was a hand-made call to the
Discord API.

Three constraints shape the answer. The panel is a separate container that is **deliberately not
configured with the Discord token**: `docker-compose.yml`'s `admin` service has no `env_file:` for
the instance `.env`, so the token is not in its environment. That is a choice rather than a barrier —
the same service mounts the instance's config dir, which holds that `.env`, and `ops/admin/server.ts`
already reads a few non-Discord values out of it (the GitHub repo and token for the branch chooser,
the Plugin Index URL). This design keeps the choice: the panel never talks to Discord, so it cannot
ask which servers or channels exist. Configuration today is **flat `.env` scalars that only take
effect on a container recreate** (`ops/bot-ops.sh env-set`), which is the wrong shape and the wrong
latency for "this plugin, these servers, these channels". And `src/plugins/contract.ts` is a
**shipped contract**: changing `HostApi` affects every published plugin.

**Decision:** where a plugin lives is data the bot owns, in its data dir, changed through the
request mailbox and applied without a restart.

1. **`data/routing.json` is the record, and the bot is its only writer.** Per plugin, per server:
   where its commands work (`"all"`, or a list of channels) and the channel it posts to. The panel
   asks for a change by dropping a request in the mailbox (`src/plugins/requests.ts`), exactly as it
   already does for plugin updates; the bot validates it against what it can actually see, writes
   the file, re-registers commands and carries on. Nothing restarts. The bot records each request's
   outcome in the same file, under the id the panel chose, so the panel learns it by reading
   `routing.json` (#241).
2. **Routing is per plugin, not per command.** A plugin's whole command set goes where the plugin
   lives. Core commands (`report`, `update`, `plugins`) go to every server the bot is in; the two
   admin ones are already hidden from non-admins by `setDefaultMemberPermissions(0)`.
3. **A plugin nobody has placed lives in the home server.** `DISCORD_SERVER_ID` stops meaning "the
   only server" and becomes "the home server": a plugin with no entry in `routing.json` registers
   there and posts to `ANNOUNCE_CHANNEL_ID`, exactly as before. With no `routing.json` at all the
   bot makes byte-for-byte the registration call it makes today — to the home server when
   `DISCORD_SERVER_ID` is set, globally when it is not.
4. **The bot publishes what it can see, as `data/discovery.json`.** Its servers, their text
   channels and whether it can post in each, the outcome of the last command registration per
   server, and an invite URL carrying the `applications.commands` scope. The panel reads that file
   and offers names to pick from; nobody types a Discord id.
5. **Posting goes through the channel's webhook when one is registered, and as the bot when none
   is.** A webhook is an upgrade — its own name and avatar — never a requirement. A webhook URL is
   a secret: it is kept in `data/routing.secrets.json`, which is created owner-only, and never in
   `routing.json`, `discovery.json`, a log line or a rejected request. Two copies can exist under
   other names — a secrets file that will not parse is moved aside beside it, and a write that fails
   can leave its temp file — and both stay owner-only.
6. **`HostApi.announce(message)` does not change.** The host resolves a plugin's channels where it
   builds that plugin's `announce`; `HOST_API_VERSION` does not move and no published plugin is
   affected. *Amended by #219:* `announce(message, destination?)` gains an optional **named
   destination** — a name the plugin declares in its manifest (`destinations`), mapped by the operator
   to a channel per server in the same panel row (`servers[guild].destinations[name]`). A name mapped
   nowhere, or not declared, posts exactly where `announce(message)` would, so a destination is an
   option, never a requirement. Still additive: `HOST_API_VERSION` stays 1. The mapping is one-way
   in time: a bot or panel from before #219 rebuilds each server entry from the keys it knows, so
   rolling either back drops every `destinations` mapping on its next write (they have to be picked
   again after rolling forward).
7. **Channel restrictions are enforced by the bot at dispatch**, because a bot cannot edit
   Discord's per-channel command permissions (that needs a user's bearer token). A command used
   outside its channels gets a private reply naming the right ones; a thread counts as its parent.
8. **The panel may set plugin-declared secret keys, write-only.** A key the Plugin Index marks
   `secret: true` can be written through `env-set`, is never returned by `env-get`, and appears in
   `env-schema` only as `secret` + `isSet`. Core secrets stay uneditable. This loosens
   "secrets are never edited by ops tooling" deliberately: needing SSH to give a plugin its API key
   was half of what made adding one painful, and the panel is already behind Cloudflare Access, an
   email allow-list and the cross-site-write gate. A plugin's admin bundle already runs with the
   panel's authority (#226); write-only keeps a compromised one from *reading* a secret.

## Considered Options

- **Encode routing in `.env`** (a JSON value, or compound keys). Fits `env-set` with the least new
  plumbing, but every change costs a recreate — about twenty seconds offline to move a plugin into a
  channel — and a map of maps in an env var is unreviewable. Rejected.
- **Let the panel talk to Discord itself** — it could read the token from the mounted config dir,
  list servers and register commands. Rejected: it would put the one Discord credential to work in a
  second, root-equivalent process that has never needed it, and create a second writer of Discord
  state racing the bot. The bot already holds the gateway's view of its servers, channels and
  permissions; the panel would have to rebuild that over REST.
- **`announce(message, channelId?)`**, the plugin sourcing the id from its own env key (#219 as
  filed). Rejected for this case: it moves the pasted snowflake from one env key to many, makes every
  plugin re-implement "where do I post", and changes a shipped contract. Named destinations
  (`announce(message, "alerts")`, mapped to channels in the same panel row) remain a compatible
  later extension and stay open on #219 — since built, see decision 6's amendment.
- **Per-command routing.** Rejected as unneeded: the one apparently curated per-server command set
  in production turned out to be a stale registration, not a choice.
- **Global command registration.** Puts every command in every server, with up to an hour's
  propagation. Rejected: it is the opposite of choosing where a plugin lives.

## Consequences

- The bot manages the command list of **every** server it is in, not only the home server. A server
  no plugin lives in gets the core commands and nothing else, so a deployment must seed
  `routing.json` to mirror what is live before its first routed boot (#247).
- `ops/bot-ops.sh` gains a read of two more files and four request actions, and its schema number
  moves (#240); a deployed instance needs `ops/install.sh` re-run, which the panel's out-of-date
  banner already reports.
- Discovery is only as fresh as the bot's last write. The panel shows when it was generated and
  offers a refresh; it never guesses.
- Two bots in one server do not disturb each other: commands are scoped to the application, and
  `COMMAND_PREFIX` already keeps their names apart.
