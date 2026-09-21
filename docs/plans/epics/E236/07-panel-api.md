## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/panel-routing-api` cut from `origin/main` **now** (amended 2026-09-21: these routes call #240's `routing-get` subcommand and its four `plugin-request` actions, but only through the injected `runBotOps`, so they are built and tested against a fake and need none of #240's code; the contract below is fixed by #240's plan and #241 as merged), in an isolated worktree. **It merges after #240**, so the panel never calls a subcommand the deployed-script check does not yet require. #240 changes one line of `ops/admin/server.ts` (`REQUIRED_BOT_OPS_SCHEMA`) and its docs; when it lands, merge `main` -- anything but a clean auto-merge there is a stop-and-tell. Commit this plan as `docs/plans/epics/E236/07-panel-api.md`. Everything is in `ops/admin/server.ts`, `ops/admin/server.test.ts` and docs. It does **not** depend on #241: the panel only queues requests and reads files; what the bot does with them is the other chain.

Read first: the `POST /api/plugins/request` block in `handleRequest` (`server.ts:1637-1672`) and its tests (`server.test.ts`, `describe("POST /api/plugins/request (#105 panel producer)")`) — every route here follows that precedent.

### Scope change, decided — the preview route is dropped

The issue as filed had `POST /api/webhooks/preview`, where the panel asked Discord what a webhook points at. It is **out**: the epic and ADR-0006 both say the panel never talks to Discord, and the bot already does that lookup when it applies a `webhook-add` (#241). The panel learns the outcome — including which channel the webhook landed on — from `routing.results` (below), a few seconds later. One fewer place that handles the secret, and no second Discord client. The issue body has been amended to match.

### Decided — not open for re-planning

- **The contract with the bot** (fixed by #240 and #241's plan): a request is `{action, …, requestedBy, id}` written verbatim to the mailbox; the bot appends `{id, action, plugin?, channelId?, ok, reason?, at}` to `routing.results` (newest 20) when it has applied or refused it. The panel finds its own request there by `id`.
- **The server chooses `id`**, never the client: `config.newRequestId?.() ?? crypto.randomUUID()`. It is returned to the page so the page can poll for it.
- **`requestedBy` comes from the verified identity**, exactly as `/api/plugins/request` does it (`email:<email>` or `token`); a `requestedBy` or `id` in the body is dropped.
- **Every body is rebuilt from validated fields** — nothing from the client is forwarded as-is, so an unknown key can never reach the mailbox.
- **A webhook URL is a secret.** It travels body → parsed value → the JSON payload on `bot-ops.sh`'s stdin, and nowhere else: not `argv`, not a log line, not a response, not an error message. A `400` for a bad URL says `bad webhook url` and nothing more.
- The panel is its own package and cannot import `src/`; it keeps its own copies of the three patterns (plugin name, snowflake, webhook URL), the way it already mirrors the update-request patterns (`server.ts:1112-1116`).

### Step 1 — `GET /api/routing`

One more branch in `buildInvocation`: `GET /api/routing` → `{ args: ["routing-get"], contentType: "application/json" }`. It is a pure 1:1 read, so the generic path gives it the right `502` / `504` handling for free. Update `buildInvocation`'s doc comment (the list of subcommands it maps).

### Step 2 — parsers (pure, exported)

```ts
const ROUTING_SNOWFLAKE_RE = /^[0-9]{5,25}$/;
const ROUTING_WEBHOOK_URL_RE = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,}$/;

export interface RoutingSetInput { plugin: string; servers: Record<string, { commands: "all" | string[]; postTo?: string }> }
export function parseRoutingSetInput(raw: unknown): { ok: true; input: RoutingSetInput } | { ok: false; reason: string }
export function parseWebhookAddInput(raw: unknown): { ok: true; url: string } | { ok: false; reason: string }
/** Anything webhook-URL-shaped (any scheme, any case, with or without a version segment) becomes "[webhook url]". */
export function redactWebhookUrls(text: string): string
```
Reasons, exactly — **none echoes a value**:
- `parseRoutingSetInput`: `body is not a JSON object` · `bad plugin name` (reuse `REQUEST_PLUGIN_NAME_RE`) · `servers must be an object` · `bad server id` · `commands must be "all" or a non-empty list of channel ids` · `bad postTo`. The returned `servers` is rebuilt key by key (`commands`, and `postTo` only when present); an empty `servers: {}` is valid — it places the plugin nowhere. Build it on `Object.create(null)`-safe terms: test the key against the snowflake pattern **before** assigning, so `__proto__` can never be a key.
- `parseWebhookAddInput`: `body is not a JSON object` · `bad webhook url`. The value is trimmed first (a pasted URL often carries a newline); the trimmed string is what is returned.

### Step 3 — the four writing routes

In `handleRequest`, directly after the `/api/plugins/request` block, one shared helper and four thin routes:

```ts
async function queueRoutingRequest(
  config: HandlerConfig, auth: Authorization,
  request: { action: "routing-set" | "webhook-add" | "webhook-remove" | "discovery-refresh" } & Record<string, unknown>,
  describe: string,          // for the audit line -- NEVER built from a webhook url
): Promise<Response>
```
It adds `requestedBy` and `id`, runs `{ args: ["plugin-request"], stdin: JSON.stringify(payload), contentType: "application/json" }`, and:
- on success logs `[admin] plugin-request queued (<describe>) — requested by <actor>` and answers `{ ok: true, id, queued }` (`queued` from bot-ops' stdout when it parses, else omitted);
- on failure logs and answers with `redactWebhookUrls(result.stderr.trim())` — `504` `bot-ops.sh timed out` when `timedOut`, else `502` — the same shape as the existing route.

| Route | Body | `describe` | Payload |
|---|---|---|---|
| `POST /api/routing` | `{plugin, servers}` | `routing-set <plugin>` | `{action:"routing-set", plugin, servers}` |
| `POST /api/webhooks` | `{url}` | `webhook-add` | `{action:"webhook-add", url}` |
| `DELETE /api/webhooks/<channelId>` | — | `webhook-remove <channelId>` | `{action:"webhook-remove", channelId}` |
| `POST /api/discovery/refresh` | ignored | `discovery-refresh` | `{action:"discovery-refresh"}` |

`DELETE`: the id is `url.pathname.slice("/api/webhooks/".length)`; anything not matching the snowflake pattern is `400 bad channel id` (a percent-encoded or nested path simply fails the pattern). `POST` bodies: invalid JSON → `400 invalid JSON`; a parser failure → `400 <reason>`. Any other method on these paths falls through to the existing `404`.

`HandlerConfig` gains `newRequestId?: () => string` (doc: test seam; defaults to `crypto.randomUUID`).

All four are writes, so the existing `isCrossSiteWrite` gate (POST and DELETE) and the auth check already stand in front of them — do not add a second copy of either; pin them by test instead.

### Step 4 — tests (`ops/admin/server.test.ts`)

Reuse the `capturingBotOps` / `cfg` / `post` shape from the `/api/plugins/request` block (copy it into the new `describe`s; do not hoist it — another PR is editing that file's neighbours).

- `describe("buildInvocation")` (add): `GET /api/routing maps to routing-get` · `POST /api/routing is not a buildInvocation route`.
- `describe("parseRoutingSetInput (#242)")`: `accepts "all", a channel list, a postTo, and an empty servers object` · one test per reason above · `unknown keys at every level are dropped` · `a __proto__ server key is refused, not assigned` · `requestedBy and id in the body are dropped`.
- `describe("parseWebhookAddInput (#242)")`: `accepts discord.com, discordapp.com, canary, ptb and a versioned path` · `trims whitespace` · `refuses http, another host, a missing token, a query string, a non-string` · `the reason never contains the value`.
- `describe("redactWebhookUrls (#242)")`: `redacts http, https, mixed case, versioned and discordapp forms` · `leaves other text alone`.
- `describe("routing routes (#242)")` — for **each** of the four writing routes: `401 without auth, bot-ops never called` · `403 cross-site, bot-ops never called` · `runs plugin-request with the expected payload on stdin` (exact `toEqual` on the parsed stdin, with an injected `newRequestId`) · `answers { ok, id, queued }`. Plus: `400 invalid JSON` and `400 <reason>` for the two with bodies · `DELETE with a bad channel id is 400` · `DELETE with a percent-encoded id is 400` · `requestedBy is the verified email even when the body supplies another` · `an id in the body is ignored` · `a bot-ops failure is a 502 with its stderr` · `a timed-out bot-ops is a 504` · `GET on a writing path is 404` · `without newRequestId the id is a UUID`.
- `describe("a webhook url never leaves the stdin payload (#242)")` — spy on `console.log` **and** `console.error`; a distinctive token. Three runs: an accepted URL; a malformed one (`http://…` with the same token); an accepted one whose bot-ops result fails with a stderr that contains the URL. Assert the token appears in **no** response body, **no** captured console line, and **not** in `calls[0].args` — and that it **does** appear in `calls[0].stdin` for the accepted runs (so the test cannot pass by the route doing nothing).

### Step 5 — docs

`ops/README.md`: the API list gains the five routes, with the sentence that the panel never calls Discord and learns outcomes from `routing.results`. `CONTEXT.md`: the `server.ts` row and one gotcha — *the routing routes are server-native for the same reason `/api/plugins/request` is (identity from the session) plus one more: the server, not the page, mints the request id the page then polls for*. Verify each sentence against the merged code.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| each route: 401, 403, 400 naming the field, the expected invocation | 1–3 | the per-route tests; the parser reason tests | move a route above the auth check; drop one parser check; send the raw body as the payload |
| `requestedBy` is the verified identity | 3 | `requestedBy is the verified email even when the body supplies another` | spread the body after `requestedBy` |
| the id is the server's | 3 | `an id in the body is ignored`; `without newRequestId the id is a UUID` | take `id` from the body |
| a webhook URL is never returned, logged or put in an error | 2, 3 | `a webhook url never leaves the stdin payload` | echo the value in the `400`; log the payload; drop `redactWebhookUrls` from the failure path; build `describe` from the url |
| the URL reaches `bot-ops.sh` on stdin, never `argv` | 3 | same test (`args` is exactly `["plugin-request"]`) | pass the url as an argument |
| unknown keys never reach the mailbox | 2 | `unknown keys at every level are dropped`; `a __proto__ server key is refused…` | return the input object instead of the rebuilt one |
| `GET /api/routing` reads both files | 1 | `GET /api/routing maps to routing-get` | map it to `status` |

### Verification — paste the real output in the PR

```
bun run check                              # the root package
bun run --cwd ops/admin check              # ops/admin is its own package with its own tsconfig
bun test
git grep -n "webhooks/" -- ops/admin/server.ts      # every hit must be one of the two patterns, a route path, or a comment -- say which
```

Mutation checks in a scratch worktree, one at a time, `bun test ops/admin/server.test.ts`.

**Run every `bun test` — yours, your reviewers', your mutation runs — with a private temp dir**, e.g. `TEMP=R:/repos/Scratch/tmp/bot-242 TMP=R:/repos/Scratch/tmp/bot-242 bun test` (create it first). `test/setup.ts` sweeps every `rackbops-bot-test-data-*` directory in the system temp dir at start-up (#252), so two suites running at once on this machine delete each other's data dir mid-run, and another subordinate is testing in this repo at the same time.
