## Implementation plan — written by the orchestrating session, to be executed as written

One PR, branch `claude/routing-requests` cut from `origin/main` (#239 is merged as `1b22778`: this child calls its `applyRouting` / `refreshDiscovery` and reads its `discovery.json`), in an isolated worktree. Commit this plan as `docs/plans/epics/E236/03-routing-requests.md`. This PR also **closes #249** — it is the same function, and the new payloads are what make that bug reachable.

Read first: ADR-0006 (decisions 1 and 5), `src/plugins/requests.ts` in full with its header comment, and `src/routing/store.ts`'s comments on what `mutateRouting` does and does not inspect. The mailbox is a trust boundary and everything here keeps it one.

### Decided — not open for re-planning

- **The five update actions are untouched** in behaviour and validation. The routing actions live in their own module, `src/routing/requests.ts`; `src/plugins/requests.ts` only learns to dispatch to it.
- **Do not touch `src/plugins/contract.ts`.** rackbops-bot-plugins vendors it verbatim and its `check-contract` fails on any edit. The routing request types live in `src/routing/requests.ts`.
- **The payload shapes are #240's, already fixed** (`ops/bot-ops.sh plugin-request` writes the panel's JSON to the mailbox verbatim, so extra fields ride through):
  `{action:"routing-set", plugin, servers:{<guildId>:{commands, postTo?}}, requestedBy, id?}` · `{action:"webhook-add", url, requestedBy, id?}` · `{action:"webhook-remove", channelId, requestedBy, id?}` · `{action:"discovery-refresh", requestedBy, id?}`. Note `servers` is top-level — there is no `routing` wrapper.
- **The bot validates against what it can see.** A request naming a server or channel that is not in `discovery.json` is refused, whatever the panel or the script let through — after **one** `refreshDiscovery()` and re-check, so a server the bot joined two minutes ago is not refused for being missing from a fifteen-minute-old file.
- **A webhook URL is a secret from the moment it arrives.** Never logged, never part of a reason, never left in `rejected/`, written only by `mutateSecrets`.
- **The panel learns the outcome from `routing.json` itself**: a bounded `results` list keyed by an `id` the panel chose. #240's `routing-get` returns that file whole, so nothing in #240 changes.
- **One webhook per channel.** Adding a second for the same channel replaces the first.
- **A routing change is "applied" once `routing.json` is written.** A server that then refuses its commands is not a failed request — it shows against that server in `discovery.json`.
- **Every drain runs after `initRouting`.** `index.ts` registers commands before the boot drain and before `markPluginStateReady()`; do not reorder those.

### Known and accepted — so nobody spends a review round on it

The request file that carries a webhook URL exists in `data/plugins/requests/` at the container's default mode for at most one drain interval (about five seconds) before the bot deletes it. That is accepted: the volume is the bot's own. The writer-side half of this -- a write-then-rename so a reader never sees a half-written file, and `umask 077` so the file is owner-only from creation -- is being fixed in #240 (`bot-ops.sh`), not in this child. Until an instance re-runs `install.sh` it can run this bot with the old script, so the bot side keeps a small mitigation: a file that fails to PARSE is read once more, after a fixed short delay (250 ms, injected), before it is rejected, and a secret-bearing file is still deleted (never quarantined) after that. *(Edited by the implementer after the plan was posted, on the orchestrator's instruction; everything else in this file is the plan as written.)*

### Step 1 — the model gains `results` (`src/routing/model.ts`, `src/routing/resolve.ts`)

```ts
export interface RequestResult { id: string; action: string; plugin?: string; channelId?: string; ok: boolean; reason?: string; at: string }
export const MAX_RESULTS = 20;
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// RoutingFile gains:   results: RequestResult[]      -- newest last
export function withResult(file: RoutingFile, result: RequestResult): RoutingFile   // pure: append, keep the newest MAX_RESULTS
```
- `freshRouting()` returns `results: []`.
- `repairRouting` keeps an entry only when `id` matches `REQUEST_ID_RE`, `action` and `at` are strings and `ok` is a boolean; `plugin` is kept when it matches `PLUGIN_NAME_RE`; `channelId` when it matches `SNOWFLAKE_RE`; `reason` when it is a string, clipped to 300 characters; nothing else is copied. Then it keeps the newest `MAX_RESULTS`. A file written before this change has no `results` and repairs to `[]`. Update `repairRouting`'s doc comment.
- `resolve.ts`: `export` the existing `shown()` — Step 3 reuses it. No behaviour change there.

### Step 2 — `src/routing/requests.ts` (new)

```ts
export const ROUTING_ACTIONS: ReadonlySet<string>    // routing-set, webhook-add, webhook-remove, discovery-refresh
/** Same set of URLs #240's bash regex accepts. Groups: 1 = webhook id, 2 = token. */
export const WEBHOOK_URL_RE = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{5,25})\/([A-Za-z0-9_-]{20,})$/;
/** Replace anything webhook-URL-shaped (any scheme, any case, with or without a version segment) with "[webhook url]". */
export function redactWebhookUrls(text: string): string

export type RoutingRequest =
  | { action: "routing-set"; id?: string; plugin: string; servers: unknown; requestedBy: string }
  | { action: "webhook-add"; id?: string; url: string; requestedBy: string }
  | { action: "webhook-remove"; id?: string; channelId: string; requestedBy: string }
  | { action: "discovery-refresh"; id?: string; requestedBy: string };

/** Shape only -- nothing here needs discovery. Pure; cannot throw on any JSON value. */
export function parseRoutingRequest(raw: unknown): { ok: true; request: RoutingRequest } | { ok: false; reason: string }

/** An expected "no": the reason is shown to the operator as it is. Anything else thrown is a fault. */
export class RoutingRefusal extends Error {}

export interface RoutingRequestDeps {
  readDiscovery: () => Promise<DiscoveryFile | null>;
  readRouting: () => Promise<RoutingFile>;
  mutateRouting: (mutate: (current: RoutingFile) => RoutingFile) => Promise<void>;
  mutateSecrets: (mutate: (current: RoutingSecretsFile) => RoutingSecretsFile) => Promise<void>;
  fetchWebhook: (id: string, token: string) => Promise<{ ok: true; id: string; channelId: string; guildId: string } | { ok: false; reason: string }>;
  applyRouting: (reason: string) => Promise<unknown>;
  refreshDiscovery: () => Promise<void>;
  now: () => Date;
  log: Pick<Console, "warn">;
}
/** `channelId`: the channel a webhook-add landed on (Discord's answer) or a webhook-remove named -- recorded in the result so the panel can name it. */
export async function applyRoutingRequest(request: RoutingRequest, deps: RoutingRequestDeps): Promise<{ channelId?: string }>
export function liveFetchWebhook(fetchFn?: typeof fetch): RoutingRequestDeps["fetchWebhook"]
```

`parseRoutingRequest` — reasons, exactly:
- not an object → `not an object`; `requestedBy` not a non-empty string → `missing requestedBy` (keep it clipped to 200 characters on the parsed request).
- `id`: kept only when it is a string matching `REQUEST_ID_RE`; otherwise **dropped, not fatal** (the request proceeds and records no result).
- `routing-set`: `bad plugin name` (shape only, `PLUGIN_NAME_RE` — a plugin may be placed before it is enabled); `servers` not a plain object → `routing must be an object with a servers object` (the same words `validatePluginRouting` uses).
- `webhook-add`: `bad webhook url` — **no part of the value in the reason**, not even its length.
- `webhook-remove`: `bad channel id`.

`applyRoutingRequest`:
- `routing-set` → read discovery; `validatePluginRouting({ servers }, discovery)`; on a failure (or no discovery at all) → `refreshDiscovery()`, read again, validate again; still failing → `throw new RoutingRefusal(reason)` (no discovery → `the bot has not published what it can see yet`). Then `mutateRouting`: that plugin's entry becomes the validator's **clean `value`** (never the raw input), `updatedAt` / `updatedBy` stamped. Then `applyRouting("routing-set <plugin>")` — **a rejection from it is logged with `log.warn` and swallowed** (see Decided).
- `webhook-add` → match `WEBHOOK_URL_RE`, call `fetchWebhook(id, token)`; `ok:false` → refusal with its reason. The webhook's `guildId` must be a server in discovery and its `channelId` one of that server's channels — same one-refresh-and-recheck — else `that webhook posts to a server the bot is not in` / `that webhook posts to a channel the bot cannot see`. Then **`mutateSecrets` first** (channel id → the canonical `https://discord.com/api/webhooks/<id>/<token>`), **`mutateRouting` second** (`webhooks[channelId] = { id, guildId, addedAt, addedBy }`, which also clears any `broken`), so `routing.json` never names a webhook whose secret is missing.
- `webhook-remove` → `no webhook is registered for that channel` when `routing.webhooks` has no such key; else `mutateRouting` first, `mutateSecrets` second.
- `discovery-refresh` → `refreshDiscovery()`.

`liveFetchWebhook`: `GET https://discord.com/api/v10/webhooks/<id>/<token>` — **built from the two captured groups, never from the pasted string**, so the request can only ever go to discord.com — with `AbortSignal.timeout(10_000)`. 401 / 403 / 404 → `Discord does not know that webhook`; any other status, a thrown fetch, or a body without string `id` / `channel_id` / `guild_id` → `could not reach Discord`. The caught error is **dropped, not interpolated** (runtimes put the URL in fetch errors), and the body — which contains the token — is never logged or returned beyond the three ids.

### Step 3 — `src/plugins/requests.ts`: dispatch, results, and #249

- `PluginRequestDeps` gains `routing?: RoutingRequestDeps`. Absent → a routing action is rejected `routing is not available`.
- `drainOnce`, per file, in this order:
  1. read the **text**. `secretBearing` = the filename contains `webhook-add`, **or** the text matches `/discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\//i`.
  2. `JSON.parse`. On failure the reason is `unreadable JSON — <message>`, except for a `secretBearing` file, where it is just `unreadable JSON` (parser messages quote the input).
  3. a routing action (`ROUTING_ACTIONS.has(action)`) → `parseRoutingRequest`, then `applyRoutingRequest`; a `RoutingRefusal` rejects with its message, anything else with `apply failed — <message>`.
  4. anything else → **the index and state are loaded now if this drain has not loaded them yet** (once per drain, memoised; a throw from the load propagates out of the drain exactly as it does today, leaving the files queued), then `validate` **inside a `try`** — a throw becomes the rejection `validation threw — <message>` (#249) — then the existing `apply`, unchanged.
- Today `drainOnce` loads the Plugin Index — a network fetch with a five-second timeout — before it looks at a single file. Item 4 above is what keeps that off every routing change.
- `validate`'s five untrusted echoes (`JSON.stringify(action)`, `(r.plugin)`, `(r.version)`, `(r.at)`, `(r.days)`) become `shown(...)`. It cannot throw and is bounded. No test pins the old quoted form (they assert `.ok` only) and no doc quotes it — checked.
- **Every reason is passed through `redactWebhookUrls` before it is logged or recorded.** Belt and braces: no code path here should produce one.
- **A `secretBearing` file is never quarantined:** `reject` deletes it instead of moving it to `rejected/`, and if that delete fails, logs an error naming the file only.
- **Results:** after a routing request is applied or rejected, if it carried a valid `id`, `mutateRouting(withResult({ id, action, plugin?, channelId?, ok, reason?, at }))` — `channelId` is what `applyRoutingRequest` returned, so it is present on an applied `webhook-add` / `webhook-remove` and absent otherwise. A result write that fails is logged and swallowed — it must never turn an applied request into a rejected one. Update actions record nothing (their feedback is `state.json`, as today).
- Rewrite the file's header comment: the trust boundary now reads "the five update actions on an installed plugin, and the four routing actions against servers and channels the bot can see".

### Step 4 — drain every five seconds (`src/plugins/drain.ts`, new)

```ts
export const REQUEST_DRAIN_MS = 5_000;
export interface RequestDrainOptions {
  ready: () => boolean; restartPending: () => boolean; drain: () => Promise<void>;
  log: Pick<Console, "error">; intervalMs?: number;
  /** Test seam. Default: setInterval / clearInterval. */
  schedule?: (beat: () => void, ms: number) => () => void;
}
/** Returns a stop function. */
export function startRequestDrain(opts: RequestDrainOptions): () => void
```
A beat does nothing when `!ready()`, when `restartPending()`, or **while the drain it started last is still running** (a slow Discord lookup must not queue a backlog of drains behind itself); otherwise it runs `drain()` and logs a failure without stopping the interval.

Wiring — deliberately **not** in the tick machinery, which the Epic #235 workstream is editing:
- `src/index.ts`, right after `startScheduler(...)`: `startRequestDrain({ ready: isPluginStateReady, restartPending, drain: () => withCritical(() => consumePluginRequests(livePluginRequestDeps())), log: console })`.
- `src/announce.ts`: `livePluginRequestDeps()` gains the `routing` block — `readDiscovery` (#239 shipped `discoveryPath` and `writeDiscovery` but no reader — add `export async function readDiscovery(dataDir): Promise<DiscoveryFile | null>` to `src/routing/discovery.ts`: `readJsonOrFresh` with a `null` fresh value, and **`null` for anything without a `guilds` array**, so a hand-damaged file reads as "not published yet" instead of throwing inside validation; three tests there — missing, malformed, good), `readRouting` / `mutateRouting` / `mutateSecrets` from `src/routing/store.ts` bound to `DATA_DIR`, `applyRouting` / `refreshDiscovery` from `src/routing/live.ts`, `fetchWebhook: liveFetchWebhook()`, `now`, `log: console`. Reword the `pluginRequests` tick check's comment (the promise is now seconds; the tick check stays as the backstop). **Nothing else in this file** — a conflict inside the tick machinery is a stop-and-tell.

### Step 5 — tests

`src/routing/model.test.ts` (add) — `a file without results repairs to an empty list` · `malformed results are dropped and the list is trimmed to the newest 20` · `a result's reason is clipped and unknown keys are not carried` · `withResult appends and trims`.

`src/routing/requests.test.ts` —
parse: one test per reason above · `an id that is malformed is dropped, not fatal` · `a deeply nested value in any field is refused without throwing` (build the nesting in a loop, 100k deep) · `a bad webhook url is refused without echoing any of it`.
apply: `routing-set writes the validator's clean value, stamps updatedBy, then applies` (order asserted; an unknown key in the input is absent from the write) · `routing-set may place a plugin that is not loaded` · `a server missing from discovery is looked for once more after a refresh, then refused` · `… and accepted when the refresh finds it` · `with no discovery at all the request is refused` · `a re-registration that fails does not fail the request` · `webhook-add writes the secret before the metadata` · `webhook-add stores the canonical url` · `webhook-add for a channel that has one replaces it and clears broken` · `a webhook in a server the bot is not in is refused` · `… in a channel the bot cannot see is refused` · `a webhook Discord does not know is refused` · `webhook-remove deletes the metadata before the secret` · `webhook-remove for a channel with none is refused` · `discovery-refresh refreshes`.
lookup: `the lookup goes to discord.com whatever host was pasted` · `a 404 is "Discord does not know that webhook"` · `a thrown fetch is "could not reach Discord" and its text is dropped` · `a body missing an id is "could not reach Discord"`.
`redactWebhookUrls`: `redacts http, https, mixed case, versioned and discordapp forms` · `leaves other text alone`.

`src/plugins/requests.test.ts` (add) — `a routing action is dispatched and removed from the mailbox` · `with no routing deps a routing action is rejected` · `the five update actions validate and apply exactly as before` (re-assert two acceptances and two rejections through the drain) · `a request whose validation throws is rejected, and the next file in the drain is still applied` (#249 — make it throw with a getter or a fake, not by depth, now that the echo cannot) · `validate does not throw on a 100k-deep action, plugin, version, at or days` · `the Plugin Index is not loaded for a drain of routing requests only` · `… and is loaded once for a drain that mixes both` · `a rejected file that carries a webhook url is deleted, not moved to rejected/` · `an unparseable file named webhook-add is deleted and its reason carries no parser text` · `a reason that somehow contains a webhook url is redacted in the log and in the result` (a fake dep that throws one) · `an applied request records an ok result under its id` · `an applied webhook-add records the channel Discord named` · `a refused request records its reason` · `a request with no id records nothing` · `a failing result write does not fail the request`.

`src/routing/secrets-leak.test.ts` — **the acceptance test for the secret.** A real temp `dataDir`, the real `mutateRouting` / `mutateSecrets` / fs seam, a capturing `log` **and a captured `console`** (store.ts logs through it), a distinctive token. Run: an accepted `webhook-add`; one refused for its server; one Discord does not know; one with a malformed url; one unparseable file containing the url. Then read **every file under `dataDir`, recursively**, and **every captured line**: the token is in `routing.secrets.json` and nowhere else.

`src/index.test.ts` (add) — `the request drain starts after the scheduler, gated on plugin state and restarts, inside a critical section`: slice the `startRequestDrain({ … })` call's own text (as #239's `initBlock` does) and match `ready: isPluginStateReady`, `restartPending`, and `withCritical(() => consumePluginRequests(livePluginRequestDeps()))`; assert it sits after `startScheduler(client`.

`src/plugins/drain.test.ts` — through the `schedule` seam, no wall clock: `does nothing until ready` · `does nothing while a restart is pending` · `drains on each beat` · `skips a beat while the previous drain is still running` · `a drain that rejects is logged and the next beat still drains` · `stop stops it` · `the default interval is REQUEST_DRAIN_MS`.

### Step 6 — docs

`CONTEXT.md`: file-map rows for `src/routing/requests.ts` and `src/plugins/drain.ts`; the mailbox section gains the four actions, the lazy index load, the five-second drain and `results`; gotchas — *a request file that may carry a webhook URL is deleted on rejection, never quarantined*; *`routing.json`'s `results` is how the panel learns an outcome: keyed by the id the panel chose, newest 20*; *a routing request is "applied" when `routing.json` is written — a server refusing its commands shows in `discovery.json`, not as a rejection*. ADR-0006, decision 1: one sentence — the bot records each panel request's outcome in the same file. `ops/README.md`: the mailbox paragraph (`:64`) names the new actions and the optional `id`. Verify each sentence against the merged code.

### Coverage table

| Acceptance bullet | Steps | Test | Mutation that must make it fail |
|---|---|---|---|
| each action applied and removed; each invalid form rejected naming the field | 2, 3 | the per-reason parse tests; `a routing action is dispatched and removed…` | accept a missing `requestedBy`; skip `validatePluginRouting` |
| after `routing-set`: re-register, then discovery, no restart | 2 | `routing-set writes the validator's clean value, stamps updatedBy, then applies` (+ #239's `live.test.ts` for register-then-discovery inside `applyRouting`) | call `applyRouting` before `mutateRouting`; write the raw input instead of the clean value |
| the URL is only ever in the secrets file | 2, 3 | `secrets-leak.test.ts`; `…is deleted, not moved to rejected/`; `…carries no parser text`; `…is redacted in the log and in the result` | put the url in a reason; quarantine a secret-bearing reject; keep the parser message; drop the `redactWebhookUrls` call; interpolate the fetch error |
| secret before metadata | 2 | `webhook-add writes the secret before the metadata` | swap the two writes |
| two requests never interleave | 3, 4 | the existing single-flight test; `skips a beat while the previous drain is still running` | remove the in-flight guard; call `drainOnce` outside the chain |
| the five update actions unchanged | 3 | `the five update actions validate and apply exactly as before` | send `cancel` through the routing handler |
| #249 — a throwing validation cannot wedge the mailbox | 3 | `a request whose validation throws is rejected, and the next file…`; `validate does not throw on a 100k-deep…` | move `validate` back outside the `try`; restore one `JSON.stringify` echo |
| no index fetch for a routing-only drain | 3 | `the Plugin Index is not loaded for a drain of routing requests only` | load eagerly again |
| stale discovery does not refuse a real server | 2 | `… and accepted when the refresh finds it` | drop the refresh-and-recheck |
| the panel can see the outcome | 1, 3 | the four `results` tests; the `model.test.ts` additions | never call `withResult`; record under a malformed id; stop trimming |
| drained within seconds | 4 | `drain.test.ts` | remove the `ready` gate; remove the `restartPending` gate |
| the timer is actually started | 4 | `src/index.test.ts` (source pin, the file's own idiom): `the request drain starts after the scheduler, gated on plugin state and restarts, inside a critical section` | delete the `startRequestDrain` call; drop `withCritical` from its `drain`; pass `() => true` as `ready` |
| a panel change lands in seconds on a running bot | — | manual — proven on `debug` by the deploy child (#247) | — |

### Verification — paste the real output in the PR

```
bun run check
bun test
git grep -n "webhooks/" -- src ':!*.test.ts'     # every hit must be one of the two regexes, the canonical-url builder, the lookup url, or a comment -- say which
```

Mutation checks in a scratch worktree, one at a time, `bun test src/routing src/plugins/requests.test.ts src/plugins/drain.test.ts`.

**Run every `bun test` — yours, your reviewers', your mutation runs — with a private temp dir**, e.g. `TEMP=R:/repos/Scratch/tmp/bot-241 TMP=R:/repos/Scratch/tmp/bot-241 bun test` (create it first). `test/setup.ts` sweeps every `rackbops-bot-test-data-*` directory in the system temp dir at start-up (#252), so two suites running at once on this machine delete each other's data dir mid-run, and another subordinate is testing in this repo at the same time.

