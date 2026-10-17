<!-- Plan for #529 bundle A2 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #529): the admin server's five Lows,
#464 items 2-6, after A1 (`529-A1-admin-server.md`, PR #583) has merged -- same file, `ops/admin/server.ts`, and A1
rewrites the `Bun.serve` call and the `/api/plugins` route this bundle sits beside. Written by the orchestrating session
on 2026-10-16; the inline `file:line` anchors below are `ea4fdda` numbering. A1 (#590, b040cca), T1 (#591, d823b3b:
`ops/admin` tsconfig unused-checks, `package.json`, `bun.lock`, two renames in `server.test.ts`) and R2 (#594,
239e389) have since moved lines in `server.ts`, `server.test.ts`, `CONTEXT.md`, `README.md` and `ops/README.md`: the
"Anchors at `239e389`" table right after this header gives the current numbering, and the rule stays "re-find each
anchor by symbol on the tree you work from". Audited read-only in TWO rounds before it was committed (a Sonnet agent, Step 1 and T1-T5 applied to a
scratch copy, the gzip-bomb claim reproduced: 400 MiB decoded from 400 KB on the wire, RSS +693 MiB before, +198 MiB
after); every finding was applied: the recreate remedy as first written (`docker compose --profile admin up -d
--force-recreate admin` from the stack dir) boots the admin with a BLANK `ADMIN_TOKEN` (those values come from the
invoking shell, `docker-compose.yml:109-112`; `server.ts:2140-2143` exits 1 and `restart: unless-stopped` loops it),
so every remedy text now says "re-run `install.sh` and then its printed step 4"; both stream fakes need
`highWaterMark: 0` (a default-HWM stream prefetches one pull: `Expected: 3, Received: 4`, and `pull` fires once before
any reader exists); `withAssetCache`'s `opts` needed its type; the page banner's own text and its pin were never in the
plan; six "once at startup" sites (one of them a recorded #230 decline this bundle reverses) were unlisted;
`createOutdatedRefresher` as first written classified a transient `version` failure as drift of both files, re-ran a
rejecting check on every call and lost the boot list on a first failure (it now seeds from the boot list, stamps `at`
in the catch, and treats a failed `version` run as "unknown: keep the last answer"); asset failures were not cached and
concurrent cold misses were not coalesced, so item 6's claim was false for both (a 30 s negative TTL and in-flight
coalescing added); item 5's inode half belongs to #486 (the #529 body says so), not #531; `server.test.ts:2677` (the
real M7 guard), five fake call sites and A1's `init.redirect` fakes were unlisted; six mutation holes gained tests
(recursion fixture, the four documented defaults, the TTL boundary, `adminStore: undefined`, the Content-Length
pre-check) and one equivalent mutant ("a success clears the failure window") was dropped; anchors corrected. Round 2
(at `239e389`; the code blocks compile under `ops/admin`'s tsconfig, T1/T4/T5 pass as worded, 18 mutants killed) found
three operator-facing defects, all applied: `classifySchemas` called a non-zero exit `unknown`, which would have hidden
exactly the swap-to-a-pre-#173-script case the #230 reversal rests on (a non-zero exit is drift, as at boot; only a
timeout or a rejecting probe is `unknown`); step 4 is `up -d --build admin` with no `--force-recreate`, and Compose
recreates only on a changed service config or image, so the remedy now says "step 4 with `--force-recreate` added";
1f named one string where there are two different ones (a sentence built for any file list, and a per-file button
label) and gave no text: the exact strings and the three pins at `server.test.ts:3935-3947` are now in 1f. Also
applied: T1's counted stream is finite, a test kills the `cache.delete(url)` survivor, the `runBotOps` call shape,
`ops/README.md:36` and the `serveAdminBundle` "no server-side cache is needed" comment added to the stale sites, the
fake count (six diagnostics, three edits), the status-route latency recorded. A3 (the
page: #405, #406, #467, #468, #469) follows and edits `index.html`; this bundle touches `index.html` in exactly ONE
place, the banner's remedy string (coordinate if A3 is in flight: the same line).
-->

**Anchors at `239e389`** (pre-edit numbering; `server.ts` unless noted; re-find by symbol if your tree differs):

| `ea4fdda` anchor in this plan | What | At `239e389` |
|---|---|---|
| `:410-428` | `logSchemaLine` | `:413-431` (remedy text `:428`) |
| `:441-457`, `:431` | `checkBotOpsSchemaStartup`, its "once at startup" doc | `:444-460` (the `version` call `:451`), `:434` |
| `:1223-1227`, `:1228-1250` | fetcher doc, `makeAdminAssetFetcher` | `:1256-1260`, `:1261-1292` (CL reject `:1279-1282`, `arrayBuffer` `:1283`) |
| `:1216` | `AssetResponse` | `:1249` |
| `:1164-`, `:1155-1158`, `:1930-1932`, `:1928-1930` | `serveAdminBundle`, its "public" comment, the `/api/` gate, its comment | `:1197-`, `:1189`, `:1970-1973`, `:1964`/`:1971`; the "no server-side cache is needed" comment `:1215-1216` |
| `:1467-1485` | `createPluginIndexLister` | `:1509-1527` |
| `:1541`/`:1546`/`:1553`, `:1547-1553` | `HandlerConfig` optionals, `outdatedFiles` doc | `:1583`/`:1588`/`:1595`, `:1589-1595` |
| `:1949-1957` | `allowedEmails` | `:1991-1997` |
| `:2127` | status route `mergeStatusOutdated` | `:2185` |
| `:2140-2143` | `ADMIN_TOKEN` exit | `:2256-2260` |
| `:2214`, `:2286`, `:2288-2291` | startup check, fetcher wiring, config literal | `:2331`, `:2403`, `:2405-2408` |
| `server.test.ts:402-412` | store-path pin | `:406-416` |
| `server.test.ts:2665`, `:2677` | bot-ops / compose remedy-line pins | `:2811`, `:2823` |
| `server.test.ts:3425-3430`, `:3434-3441`, `:3469-3475` | `res` helper, inline fakes | `:3657-3662`, `:3666-3674`, `:3737-3742` |
| `server.test.ts:3510-3521` | banner pin | `:3913-3950` (the three `toBe`s `:3935`, `:3938`, `:3946`) |
| `server.test.ts:5267-5310`, `:5273-5281`, `:5418-` | ratchet, extractor, static-assets pin | `:5703-5751`, `:5714-5722`, `:5859-` |
| `ops/install.sh:346-353`, `:393-405` | stack `.env` body, step 4 | `:339-347`, `:376-405` (the command `:396-405`) |
| `ops/README.md:110-112`, `:124`, `:127`, `:1366-1372` | re-run sentence, once-at-startup, naming, "frozen" | `:113-116`, `:128`, `:130`, `:1375-1379`; plus `:36` (the `version` row, "once at startup") |
| `CONTEXT.md:726-731`, `:1423`, `:1351-1352`, `:1356-1357` | #230 bullet, `version` row, ratchet sentences | `:734-738`, `:1436`, `:1393`, `:1398` (`:204` holds) |
| `index.html:3172`, `:4256`; `docker-compose.yml:109-112`, `:123`, `:124`, `:127` | banner, needs-attention label; env, mounts | hold |

## Implementation plan -- #529 A2: the asset cap is enforced while the bytes arrive, the entry point's wiring is pinned, the COPY ratchet sees every import form, the drift banner follows the files and names the real remedy, and the public bundle route stops refetching per hit

Children: **#464** (closes: items 2, 3, 4, 6 fixed; item 5's banner half fixed, its compose-inode half documented and
closed by reference to **#486**, which the #529 body names as its owner (`ops-install-compose-images-3`, the same root
cause; #531 repeats the pointer). If #486 lands first, check on your tree whether `docker-compose.yml` still mounts the
compose file as a SINGLE file (`:124` at `ea4fdda`) and word the README's inode sentence to what is true then). One PR,
branch `fix/529-A2-admin-server-lows`, worktree `S:\Repos\_wt\rdb-529-A2` cut from `origin/main` (A1 is on it since
b040cca). Behaviour
changes (a streamed cap, a re-checked banner, a cache in front of outbound fetches) -> the **three-reviewer gate**
applies; every changed production line mutation-tested in a scratch worktree. `ops/admin` is its own package
(`bun install --frozen-lockfile` there; `bun run check` there; tests from the repo root).

### What is wrong, verified at `ea4fdda`

- **Item 2 (`admin-server-2`: the "hard cap" is checked after the whole body is buffered).** `makeAdminAssetFetcher`
  (`server.ts:1228-1250`) rejects a too-large `Content-Length` early (`:1237-1240`), then `await res.arrayBuffer()`
  (`:1241`) and compares `byteLength` (`:1242`). A chunked or compressed response (whose `Content-Length` is the
  compressed size, or absent) is buffered and decoded whole before the check; the only bound meanwhile is the 5 s
  `AbortSignal.timeout` (`:1235`) times bandwidth. The docstring (`:1223-1224`) says "read bytes with a hard cap";
  `ADR-0005` and the README say "size-capped" (true: an oversized body IS rejected, late). The host is the allowlisted
  CDN, so this is comment drift plus a defence-in-depth gap, as the verifier said.
- **Item 3 (`admin-server-3`: the entry point's `HandlerConfig` literal is unpinned).** `server.ts:2288-2291` builds
  `config` from ten shorthand properties; `adminStore`, `verifyAccessJwt` and `outdatedFiles` are optional on
  `HandlerConfig` (`:1546`, `:1541`, `:1553`), so a refactor that drops one typechecks: without `adminStore`,
  `allowedEmails` stays `undefined` (`:1949-1957`) and every verified Access identity is authorized, `/api/admins`
  404s; without `verifyAccessJwt` SSO is off; without `outdatedFiles` the banner is gone. The repo pins other
  `import.meta.main` facts by source scan (`server.test.ts:402-412` the store paths; `:5418-` the assets; A1 adds the
  `Bun.serve({` literal), not this literal.
- **Item 4 (`admin-server-4`: the COPY ratchet matches two import forms, one file deep).** `extractLocalImportFilenames`
  (`server.test.ts:5273-5281`) matches `from "./x"` and `import("./x")` in `server.ts` only; a bare `import "./x"`, a
  `require("./x")`, an `export ... from "./x"` and an import inside a copied sibling (`admin-contract.ts`) pass it, while
  the image crash-loops at boot (the #128 class). `CONTEXT.md:1351-1352`'s "every relative local import" and
  `:1356-1357`'s "parses both files" overstate it. (Partly narrower than the review said: the existing `from "./x"`
  regex already matches `export * from "./x"` and `export {a} from "./x"`; what is unseen is a bare `import "./x"`, a
  `require("./x")`, a parent-relative specifier, and anything inside a copied sibling.) Today nothing exercises a gap:
  `server.ts` has one local import and `admin-contract.ts` none; `theme/build-theme.ts` is not imported by
  `server.ts` and is irrelevant to the ratchet.
- **Item 5 (`admin-server-5`: the banner is one-shot and its remedy does not clear it).** `checkBotOpsSchemaStartup`
  (`server.ts:441-457`) runs once at startup (`:2214`) and bakes `outdatedFiles` into the config (`:2290`);
  `logSchemaLine` (`:410-428`), the page banner (`ops/admin/public/index.html:3172` "re-run ops/install.sh; panel
  features may fail", `:4256` "Re-run ops/install.sh", pinned at `server.test.ts:3510-3521`) and `ops/README.md:110-112`
  tell the operator to re-run `ops/install.sh`. For `bot-ops.sh` the re-run is enough on disk (the shared `bin/`
  DIRECTORY is mounted, `docker-compose.yml:127`), but the banner stays until the admin restarts. For the compose file
  it is not: `install.sh` replaces it with `mv` (`ops/install.sh:165-168`, `:308`), which swaps the inode, while the
  admin service mounts that ONE FILE (`docker-compose.yml:124`; `:123` is the config-dir mount), so the running
  container keeps the old inode: `bot-ops.sh version` (`bot-ops.sh:98-100`, reading `$BOT_OPS_COMPOSE_FILE` inside the
  container) keeps reading the old stamp (the banner is then RIGHT to persist) and the panel's recreate runs `docker
  compose -f` against the stale file (the #178 class) until the admin container itself is recreated. The docs do not
  say the second half, and several say the check is startup-only as if that were a settled decision:
  `CONTEXT.md:726-731` ("still startup-only"; it records #230's decline of a live check, which this bundle REVERSES
  and must say so), `CONTEXT.md:1423` ("runs `version` once at startup"), `ops/README.md:124` ("checks BOTH once at
  startup"), `server.ts:431`, the `outdatedFiles` doc at `server.ts:1547-1553` ("Computed ONCE ... not per request")
  and the header line A1 added ("`version` once at startup"). (Docker's bind-mount inode behaviour is documented and
  not executed here.) The remedy must never be a bare `docker compose --profile admin up -d --force-recreate admin`:
  `ADMIN_TOKEN`, `CLOUDFLARE_ACCESS_*` and `ADMIN_ALLOWED_EMAILS` come from the invoking shell with blank defaults
  (`docker-compose.yml:109-112`; the stack `.env` holds none of them, `ops/install.sh:346-353`), so that command boots
  the admin with a blank token, `server.ts:2140-2143` exits 1 and `restart: unless-stopped` loops it;
  `ops/README.md:1366-1372` and `index.html:134` already say "re-run install.sh's step 4" for exactly this reason.
- **Item 6 (`admin-server-6`: the public bundle route refetches per hit).** `serveAdminBundle` (`:1164-`) is reached
  before the `/api/` auth gate (`:1930-1932`; public at this layer by design, `server.ts:1155-1158`, `:1928-1930` and
  `CONTEXT.md:204` say so -- ADR-0005 does not: the page loads it, Access already gated the origin); each hit calls `config.listPluginIndex()` -- which on a failed fetch retries the 5 s fetch every call
  (`createPluginIndexLister`, `:1467-1485`, caches successes only) -- and `config.fetchAdminAsset(url)` with no cache,
  so anyone reaching the origin can loop `GET /plugin-admin/x.js` into log lines and outbound fetches.

### Decisions (defaults, named so the gate can contest them)

1. **The cap is enforced on the bytes as they arrive.** `makeAdminAssetFetcher` reads `res.body` through a
   `ReadableStream` reader, summing decoded chunk lengths; past `maxBytes` it cancels the reader and answers the
   existing 502 ("asset exceeds N bytes"), so at most one chunk over the cap is ever held (a chunk's size is the
   transport's: real gzip chunks of 400-800 KB were seen, so "one chunk" can be most of a megabyte; said in the
   docstring). The early `Content-Length` reject stays (it saves the request entirely) and is pinned (M1c). The injected response type gains `body: ReadableStream<Uint8Array> | null`
   (a `null` body is an empty asset); every test fake moves from `arrayBuffer()` to `new Blob([bytes]).stream()` (or a
   hand-built stream whose `pull` is counted, for the cancel assertion). The docstring says what "hard cap" now means;
   the ADR and README stay as written ("size-capped" was true and is truer).
2. **The entry point's literal is pinned by source, as the repo pins its other boot facts:** the test extracts the
   text from `const config: HandlerConfig = {` to its closing `};` inside the `import.meta.main` block and asserts each
   of the ten keys appears as a property (a shorthand or `key:`), with a separate assertion for the three optional
   ones naming the failure mode each guards. Extracting `buildHandlerConfig(env)` (the issue's other option) is
   declined: it would move half the entry point into a unit under test for a regression that has never happened, and
   the scan is the pattern three other pins already use.
3. **The ratchet matches every import form and follows copied files:** `from "./x"`, bare `import "./x"`,
   `import("./x")`, `require("./x")`, `export ... from "./x"`; for each copied local file it recurses (so an import
   inside `admin-contract.ts` is checked too), with a visited set; a `../` specifier fails the test by name (outside
   the build context: no `COPY` can satisfy it). Unit cases for the extractor cover each form on fixture strings, so
   the ratchet's own blind spots are pinned, not only the current tree -- INCLUDING a recursion fixture with a fake
   `read` (an entry that imports a sibling, which imports a third file and the entry back: a cycle), because the real
   tree never recurses (`admin-contract.ts` imports nothing) and a ratchet whose recursion is deleted stays green on it.
   The image-level boot check (the issue's third option) is #83's `docker-build` job territory and is not added (and
   `docker-build` builds only; it never boots the image).
4. **Drift is re-checked, bounded, and the remedy is complete.** `HandlerConfig` gains `refreshOutdated?: () => Promise<string[]>`;
   `import.meta.main` builds it with `createOutdatedRefresher(check, boot, ttlMs = 60_000)`: it is SEEDED with the
   boot-time list (`boot`, the `outdatedFiles` the startup check produced, so a first-ever failure does not answer `[]`
   and erase the boot banner), re-runs `bot-ops.sh version` at most once a minute -- a failed run stamps `last.at` too,
   so a check that rejects is NOT retried on every call -- logs only when the list CHANGES, and keeps the last answer
   when the run could not tell. "Could not tell" is explicit: the classification inside `checkBotOpsSchemaStartup`
   (`:441-457`) is extracted into `classifySchemas(versionRun, requiredBotOps, requiredCompose)` returning
   `{ outdated: string[] } | { unknown: string }`. It is the BOOT decision exactly (`decideBotOpsSchema` /
   `decideComposeSchema`, `server.ts:375-390`: a non-zero exit with nothing parseable -- a pre-#173 script's usage
   error, or one swapped in by `--force-bin` -- and a 0-exit with an unexpected shape both count as drift, by #173's
   own design) with ONE exception: a run that TIMED OUT is `{ unknown: "version timed out" }`. A rejecting probe is
   `unknown` too (the refresher's catch). The boot path keeps reporting a timeout as drift of both files, as the existing
   tests pin (an operator must see something at boot), while the refresher keeps the last answer on `unknown` and logs
   the reason once per distinct reason (round 1's probe: one transient timeout turned the banner into "both files
   behind" with two spurious lines). Calling a non-zero exit `unknown` was rejected in round 2: a clean boot followed by
   a swap to a pre-#173 `bot-ops.sh` would keep `[]` forever, hiding exactly the case this live check exists for. A
   timed-out `version` run holds `/api/status` for up to `SUBPROCESS_TIMEOUT_MS` (90 s, `server.ts:595`) at most once a
   minute; accepted, because `version` only reads two files, and recorded rather than adding a stale-while-revalidate
   path. `/api/status` uses the refresher when present and the boot-time
   `outdatedFiles` otherwise (the type keeps both, so every existing test config compiles). This REVERSES #230's
   recorded decline of a live check (`CONTEXT.md:726-731`): say so there, with the reason (the re-run of `install.sh`
   is now the complete remedy for the `bot-ops.sh` half, so a one-shot banner would be stale right after the operator
   does what it says). The remedy, everywhere it is stated (the `logSchemaLine` compose line, the page banner's string
   at `index.html:3172` and `:4256`, `ops/README.md`): re-run `ops/install.sh`, and for `docker-compose.yml` ALSO
   recreate the admin container by re-running **`install.sh`'s printed step 4 with `--force-recreate` added** (step 4
   is the command that exports `ADMIN_TOKEN` and the Access values, so a bare `--force-recreate admin` boots a
   token-less admin that exits in a loop; and step 4 as printed is `up -d --build admin`, which Compose turns into a
   no-op when neither the admin's service config nor its image changed, `ops/install.sh:405`), because the admin mounts
   that one file and keeps its old inode until it is recreated; the panel's own recreate uses the file
   the admin sees. Mounting the stack DIRECTORY instead of the file (the lasting fix) is #486's
   (`ops-install-compose-images-3`, a compose-shape change with a schema bump); #464's item 5 closes here with that
   pointer.
5. **The bundle route is served from a bounded cache, with failures remembered briefly and misses coalesced.** A
   `withAssetCache` wrapper around the asset fetcher (keyed by the resolved URL; a success is kept `ttlMs` 10 min, a
   FAILURE `failureTtlMs` 30 s -- twenty hits on a URL that 404s upstream made twenty fetches and twenty `console.error`
   lines in the audit's probe, which is the loop the issue describes; `maxEntries` 32, oldest evicted; concurrent misses
   for one URL share ONE in-flight fetch, the way the refresher does -- twenty concurrent cold hits made twenty fetches)
   is wired in `import.meta.main` for both the bundle and the proxy routes (a pinned-version URL is immutable; an
   unpinned `adminUrl` can change, which the TTL covers); `createPluginIndexLister` remembers a failure for
   `failureTtlMs` (30 s) and answers `null` without refetching inside it (the window simply expires; there is no
   "success clears it" clause -- it was an equivalent mutant no test can see). Gating the route behind auth (the issue's
   third option) is declined: the page needs the bundle before it can call an API, and the route is public at this
   layer behind Access by design.

### Step 1 -- `ops/admin/server.ts`

1a. `AssetResponse` (find its declaration: Grep `AssetResponse =` / `interface AssetResponse`): add
`body: ReadableStream<Uint8Array> | null;` and drop `arrayBuffer` if nothing else uses it (Grep). `makeAdminAssetFetcher`
(`:1228-1250`): after the `Content-Length` reject,
```ts
      // #464: the cap is enforced as the bytes arrive -- a chunked or compressed body has no honest Content-Length, and
      // buffering it whole before measuring made the "hard cap" a soft one. Past the cap the stream is cancelled, so at
      // most one chunk over it is ever held.
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body !== null) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            // Not awaited: a cancel() that never settles would hang the request (probed: 300 ms on a stuck fake, 0 ms
            // on a real fetch body); the 502 goes out either way.
            void reader.cancel().catch(() => {});
            return { ok: false, status: 502, contentType: "", body: EMPTY, error: `asset exceeds ${maxBytes} bytes` };
          }
          chunks.push(value);
        }
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) { body.set(c, offset); offset += c.byteLength; }
      return { ok: true, status: 200, contentType: res.headers.get("content-type") ?? "", body };
```
The docstring (`:1223-1227`): "read the body as a stream and stop at the cap (at most one transport chunk over it is
held; a chunk can be most of a megabyte)". The reader's `value` needs no cast after `if (done) break`;
`new Blob([b]).stream()` is assignable to the new `body` type (both checked by the audit).

1b. `withAssetCache` beside it, exported. The `opts` parameter MUST carry its type (an untyped `opts = {}` is three
`TS2339`s):
```ts
/** #464: a bounded memory of asset fetches, keyed by the resolved URL, in front of the public bundle and proxy routes
 *  -- a pinned-version URL is immutable on the CDN, an unpinned one changes rarely (the TTL covers it), and the routes
 *  are public at this layer, so a loop on them must not become a loop of outbound fetches: a success is kept
 *  `ttlMs`, a failure `failureTtlMs` (long enough to blunt a loop, short enough that a CDN blip heals itself), and
 *  concurrent misses for one URL share one fetch. */
export function withAssetCache(
  fetcher: (url: string) => Promise<AdminAssetResult>,
  opts: { ttlMs?: number; failureTtlMs?: number; maxEntries?: number; now?: () => number } = {},
): (url: string) => Promise<AdminAssetResult> {
  const ttlMs = opts.ttlMs ?? 10 * 60 * 1000, failureTtlMs = opts.failureTtlMs ?? 30_000, maxEntries = opts.maxEntries ?? 32, now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; result: AdminAssetResult }>();
  const inFlight = new Map<string, Promise<AdminAssetResult>>();
  return (url) => {
    const hit = cache.get(url);
    if (hit && now() - hit.at < (hit.result.ok ? ttlMs : failureTtlMs)) return Promise.resolve(hit.result);
    const pending = inFlight.get(url);
    if (pending) return pending;
    const p = fetcher(url)
      .then((result) => {
        cache.delete(url);
        cache.set(url, { at: now(), result });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
        return result;
      })
      .finally(() => { inFlight.delete(url); });
    inFlight.set(url, p);
    return p;
  };
}
```
(A fetcher that REJECTS -- it should not; `makeAdminAssetFetcher` returns `ok: false` -- is not cached: the rejection
propagates as today.) `import.meta.main` (`:2286`): `const fetchAdminAsset = withAssetCache(makeAdminAssetFetcher(fetch));`.

1c. `createPluginIndexLister` (`:1467-1485`): `PluginIndexListerDeps` gains `failureTtlMs?: number` (default 30 s);
the closure keeps `lastFailureAt`; at the TOP of the call, before the env read (so a loop costs nothing; a URL change
is seen once the window ends), `if (lastFailureAt !== undefined && now() - lastFailureAt < failureTtlMs) return null;`;
the catch sets `lastFailureAt = now()`. Nothing clears it on success: the window expires on its own (a clearing line
would be an equivalent mutant: no test can observe it). The docstring says a failure is remembered for 30 s.

1d. Drift. First the classification: extract the decision inside `checkBotOpsSchemaStartup` (`:441-457`, re-find by
symbol) into
```ts
/** #464: what one `bot-ops.sh version` run says, by the same rules as boot (`decideBotOpsSchema`/
 *  `decideComposeSchema`: a non-zero exit or an unexpected shape is drift, #173), except that a run that timed out is
 *  `unknown` ("could not tell"): the boot path reports that as drift of both files (an operator must see something),
 *  the refresher keeps its last answer. */
export function classifySchemas(run: BotOpsResult, requiredBotOps: number, requiredCompose: number): { outdated: string[] } | { unknown: string }
```
(`BotOpsResult` or whatever `runBotOps` resolves to on your tree). Its body: `if (run.timedOut) return { unknown:
"version timed out" };` then the two existing `decide*` calls, returning the names whose `outdated` is true. One copy of
the classification: `classifySchemas` wraps the two `decide*` functions; `checkBotOpsSchemaStartup` keeps calling the
`decide*` functions itself for its log lines (they carry `got`, which `classifySchemas` does not return) and keeps its
contract byte for byte (its existing tests stay green: a timeout -> both files, with today's log lines). Then
`HandlerConfig` (`:1553`) gains `/** #464: re-checks the two files' schemas, at most once a minute; absent, the boot-time list stands. */ refreshOutdated?: () => Promise<string[]>;`
and
```ts
/** #464: `bot-ops.sh version` again, at most once per `ttlMs` (a failed run counts: it is not retried on every call),
 *  seeded with the boot-time list, logging only when the answer changes and keeping the last answer when a run could
 *  not tell -- so a re-run of ops/install.sh clears the bot-ops.sh half of the banner without an admin restart (the
 *  compose half needs the admin container recreated through install.sh's step 4 with --force-recreate: it mounts
 *  that one file and keeps
 *  its inode). */
export function createOutdatedRefresher(
  probe: () => Promise<{ outdated: string[] } | { unknown: string }>,
  boot: string[],
  ttlMs = 60_000,
  now: () => number = Date.now,
  log: (line: string) => void = console.log,
): () => Promise<string[]> {
  let last = { at: now(), files: boot };
  let lastUnknown: string | undefined;
  let inFlight: Promise<string[]> | undefined;
  return () => {
    if (now() - last.at < ttlMs) return Promise.resolve(last.files);
    if (inFlight) return inFlight;
    inFlight = probe()
      .then((r) => {
        if ("unknown" in r) {
          if (r.unknown !== lastUnknown) log(`[admin] schema re-check could not tell (${r.unknown}); keeping the last answer`);
          lastUnknown = r.unknown;
          last = { at: now(), files: last.files };
          return last.files;
        }
        lastUnknown = undefined;
        if (r.outdated.join(",") !== last.files.join(",")) log(`[admin] schema drift changed: ${r.outdated.length === 0 ? "both files current" : r.outdated.join(", ")}`);
        last = { at: now(), files: r.outdated };
        return r.outdated;
      })
      .catch((err) => {
        // A probe that throws is "could not tell" too, and is also rate-limited.
        const reason = err instanceof Error ? err.message : String(err);
        if (reason !== lastUnknown) log(`[admin] schema re-check failed (${reason}); keeping the last answer`);
        lastUnknown = reason;
        last = { at: now(), files: last.files };
        return last.files;
      })
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
```
The boundary is `<`: at exactly `ttlMs` since `last.at` a call re-probes (T4 pins the exact boundary, M9).
`import.meta.main`: `const refreshOutdated = createOutdatedRefresher(async () => classifySchemas(await runBotOps({ args: ["version"], contentType: "application/json" }), REQUIRED_BOT_OPS_SCHEMA, REQUIRED_COMPOSE_SCHEMA), outdatedFiles);`
(the invocation is the one `checkBotOpsSchemaStartup` makes, `server.ts:451` at `239e389`; use the required-schema
constants' real names on your tree; the once-at-boot call already logged both lines; the refresher logs changes) and `refreshOutdated` joins the config literal. The status
route (`:2127`): `mergeStatusOutdated(result.stdout, config.refreshOutdated ? await config.refreshOutdated() : (config.outdatedFiles ?? []))`.
`logSchemaLine` (`:424-427`; `:428` at `239e389`): the remedy is chosen by `fileLabel`. For `docker-compose.yml`
the full line is, exactly (no second parenthetical before the existing one):
`[admin] docker-compose.yml is OUT OF DATE — re-run ops/install.sh on this instance, then its printed step 4 with --force-recreate, since the admin mounts this one file; panel features may fail (schema unknown, panel needs 1; no schema reported)`
(for the `server.test.ts:2823` inputs); the `bot-ops.sh` line is unchanged, byte for byte: "re-run ops/install.sh on
this instance; panel features may fail (...)" (the shared `bin/` directory is mounted, so the re-run is enough;
`:2811` stays). `server.ts:431` and the `outdatedFiles` doc at `:1547-1553` ("Computed ONCE ... not per request") say the
boot list is the seed and the refresher re-checks; A1's header line ("`version` once at startup") says "at startup and
about once a minute after".

1e. The entry-point literal (`:2288-2291`): `refreshOutdated` added; otherwise unchanged (A1 may have restyled it).

1f. `ops/admin/public/index.html`, two different strings (the only `index.html` edits; if A3 is in flight on the same
lines when you cut, say so and I sequence it):
- `:3172`, inside `OUTDATED_BANNER_HELPERS` (`describeOutdatedBanner`, a sentence built for any file list): the
  remedy becomes per-list. Replace its `return` line with
  ```js
  const remedy = outdatedFiles.includes("docker-compose.yml")
    ? "re-run ops/install.sh, then its printed step 4 with --force-recreate"
    : "re-run ops/install.sh";
  return outdatedFiles.join(" and ") + " " + verb + " out of date on this instance — " + remedy + "; panel features may fail.";
  ```
  so the three pinned cases (`server.test.ts:3935`, `:3938`, `:3946` at `239e389`) become, exactly:
  `bot-ops.sh is out of date on this instance — re-run ops/install.sh; panel features may fail.` (unchanged);
  `docker-compose.yml is out of date on this instance — re-run ops/install.sh, then its printed step 4 with --force-recreate; panel features may fail.`;
  `bot-ops.sh and docker-compose.yml are out of date on this instance — re-run ops/install.sh, then its printed step 4 with --force-recreate; panel features may fail.`
  Rewrite the last two `toBe`s to these strings; the first stays.
- `:4256` (the needs-attention item, one per file): `fix: { label: file === "docker-compose.yml" ? "Re-run ops/install.sh, then step 4 with --force-recreate" : "Re-run ops/install.sh", go: "none" }`.
  Grep the tests for `Re-run ops/install.sh`; if a pin exists, add the compose case beside it, otherwise this label is
  covered by the lens-B audit only (name that in the PR).

### Step 2 -- `ops/admin/server.test.ts`

- **T0 (what stops compiling or goes stale, listed so none is discovered red):** at `239e389` there are SIX
  diagnostics once `AssetResponse` moves from `arrayBuffer` to `body` -- `server.test.ts(3666,55)`, `(3682,55)`,
  `(3688,55)`, `(3695,55)`, `(3703,43)`, `(3737,19)` -- and THREE edits fix them: the helper `res` (`:3657-3662`) and
  the inline fakes at `:3666-3674` and `:3737-3742`; the other three flow from the helper (A1's redirect test at
  `:3701` uses `res({bytes:1})`, so it has no fake of its own). After Step 1a alone two stale fakes pass VACUOUSLY
  (round 2: 943 pass / 2 fail; the oversized-body test hits a TypeError inside the `try` and "passes" on the 502), so
  convert every fake before trusting green. `server.test.ts:2823` (`:2677` pre-A1) pins the exact compose remedy line
  and is the real guard for M7: rewrite it to 1d's exact string (`:2811` stays); the banner pins at `:3938` and
  `:3946` follow 1f.
- **T1 (item 2):** the fetcher tests (Grep `makeAdminAssetFetcher`): fakes provide `body: new Blob([bytes]).stream()`;
  a response with NO `content-length` whose body is a hand-built `new ReadableStream({ pull, cancel }, { highWaterMark: 0 })`
  pulling 256 KiB chunks and counting pulls, FINITE (eight chunks, then `controller.close()`: an endless stream turns
  M1 into a 14 s runaway allocation instead of a fast count failure) -> with `maxBytes` 512 KiB the result is 502 `asset exceeds`, the pull count
  is EXACTLY 3 (the third chunk crossed the cap; no fourth pull) and `cancel` was called. `highWaterMark: 0` is
  load-bearing: the default (1) prefetches one pull, so a correct implementation reads 4 and the test is wrong, not the
  code (`Expected: 3, Received: 4`, 2,400 reruns at HWM 0 gave 3 every time). A body under the cap in several chunks ->
  `ok`, bytes concatenated in order; a `null` body -> `ok` with an empty body; **the `content-length` early reject
  (M1c):** a response whose `content-length` exceeds the cap -> 502 with the existing "(content-length)" wording AND the
  body was never read -- assert through a `getReader` spy, or a `pull` counter on an HWM-0 stream (with the default HWM
  `pull` fires once before any reader exists, so a `bodyRead` flag set in `pull` reads `true` on a correct
  implementation; probed).
- **T2 (item 3):** beside `:402-412`: slice the `import.meta.main` block, extract `const config: HandlerConfig = {` ...
  `};`, and assert the literal contains each of `adminToken`, `indexHtml`, `assets`, `listBranches`, `listPluginIndex`,
  `fetchAdminAsset`, `runBotOps`, `verifyAccessJwt`, `adminStore`, `outdatedFiles`, `refreshOutdated` as a shorthand or
  a `key:` followed by something other than `undefined` (a bare word-boundary scan lets `adminStore: undefined` through,
  M5b), with the four optional ones (`adminStore`, `verifyAccessJwt`, `outdatedFiles`, `refreshOutdated`) in their own
  `test` naming the fail-open each guards. (A1 made the server call `Bun.serve(serveOptions(config, PORT))`, pinned
  through `serveOptions` at `server.test.ts:3845`; that is not this literal.)
- **T3 (item 4):** the ratchet (`:5267-5310`): `extractLocalImportFilenames` becomes `localImportsOf(src)` covering the
  five forms (fixture tests: one string per form, plus `"../x"` -> the test throws a named error), and
  `transitiveLocalImports(entry: string, read: (file) => string)` recursing through copied files with a visited set;
  a FIXTURE test with a fake `read`: `entry.ts` imports `./a`, `a.ts` imports `./b` and `./entry` (a cycle), `b.ts`
  imports nothing -> the set is `{a, b}` and the call returns (no infinite loop); this fixture is the only thing that
  kills M6b, because the real tree never recurses. The ratchet test asserts every transitive import is a `COPY`
  source. Keep the "cannot pass vacuously" test.
- **T4 (item 5):** `classifySchemas`: both current -> `{ outdated: [] }`; one behind -> that file; a timed-out run
  (`timedOut: true`) -> `{ unknown: "version timed out" }`; a non-zero exit with a usage error on stderr and nothing
  on stdout (`{ exitCode: 1, stdout: "", stderr: "bot-ops: usage..." }`, a pre-#173 script) -> `{ outdated:
  ["bot-ops.sh", "docker-compose.yml"] }` (NOT `unknown`; M4g); a 0-exit with unparseable stdout -> both files, as at
  boot; and `checkBotOpsSchemaStartup`'s existing tests stay green unchanged. The swap case end to end: a refresher
  seeded `[]` whose probe is `classifySchemas` over that non-zero-exit result -> after the TTL, `["bot-ops.sh",
  "docker-compose.yml"]` and one "drift changed" line (M4g). `createOutdatedRefresher`: a fake clock; seeded with `["docker-compose.yml"]` and never probed
  -> that list; two calls within the TTL -> one probe; at EXACTLY `ttlMs` -> a second (M9); a changed answer -> one log
  line, an unchanged one -> none; a probe answering `unknown` -> the previous answer, one log line naming the reason,
  NO retry until the TTL has passed again (M4b, M4d: three calls one second apart = one probe), the same reason twice
  -> one line; a probe that rejects -> the same; concurrent calls share one in-flight probe; the DEFAULT `ttlMs`
  (construct without one, step the clock 59_999 then 60_000; M8c). The status route (Grep `mergeStatusOutdated` in
  the tests): a config with `refreshOutdated` returning `["bot-ops.sh"]` -> `outdatedFiles` in the response; with
  `outdatedFiles: ["x"]` and no refresher -> the boot list (today's tests). `logSchemaLine`'s compose line: assert the
  exact compose string from 1d, including "step 4 with --force-recreate" (M7, with `:2823`).
- **T5 (item 6):** `withAssetCache`: two calls for one URL -> one upstream call, the same bytes; a FAILURE is cached
  for `failureTtlMs` (two failing calls within it -> ONE upstream call; after it -> a second) while a success holds
  for `ttlMs` (M2: failures and successes given the same TTL -> the failure case refetches too early or the success too
  late; pin both at the boundary); after the TTL -> a refetch; 33 distinct URLs -> the first evicted (a 34th call for
  it refetches); a refetched entry moves to the newest slot (fill 32 URLs, step past the TTL, call URL 1 again so it
  refetches, then add a 33rd URL: URL 1 is served from the cache with no upstream call and URL 2 is the one evicted;
  this is the only test that kills dropping `cache.delete(url)` before `cache.set`, M2e); twenty CONCURRENT cold calls for one URL -> one upstream call (M2d); the DEFAULTS (construct with no
  options and a fake `now`: a success survives 599_999 ms and not 600_000, a failure 29_999 and not 30_000, the 33rd
  URL evicts; M8, M8b); and `createPluginIndexLister`'s negative cache: a throwing `fetchIndexText` -> `null`, then
  within 30 s `null` with NO second fetch, after 30 s a second fetch, the DEFAULT window pinned the same way (M8d). A
  source pin that `import.meta.main` wraps the fetcher: the entry block contains
  `withAssetCache(makeAdminAssetFetcher(fetch))` and `createOutdatedRefresher(`.

### Step 3 -- docs

- `ops/README.md`: `:36` (the `version` row, "The admin panel runs this once at startup") -> "at startup and about
  once a minute after"; `:124`'s "checks BOTH once at startup" (`:128` at `239e389`) -> "at startup and about once a
  minute after"; after "naming precisely which file(s) are behind" (`:127`), add: "The panel re-checks both files about
  once a minute, so a re-run of `ops/install.sh` clears the `bot-ops.sh` line on its own; `docker-compose.yml` is
  mounted into the admin container as a single file, which keeps the old copy until that container is recreated --
  re-run `install.sh`'s printed step 4 with `--force-recreate` added before `admin` for that (as printed, step 4 is
  `up -d --build admin`, which leaves an unchanged admin container running; and never a bare `--force-recreate admin`:
  the admin's token and Access values come from step 4's environment, see "frozen" below) -- and until then the
  panel's own Recreate also runs against the old file (#464; mounting the directory instead is #486's)." (`:110-112` is the existing re-run sentence; `:1366-1372` is the
  "frozen" paragraph: leave both, cross-reference.)
- `CONTEXT.md:726-731` (the #230 bullet, "still startup-only"): add that #464 (A2) reverses the live-check decline,
  and why. `CONTEXT.md:1423` ("runs `version` once at startup"): "at startup and about once a minute after".
- `CONTEXT.md:1351-1352` ("every relative local import") and `:1356-1357` ("parses both files"): "every relative local
  import, in every form (`from`, a bare `import`, `import()`, `require`, `export from`), of `server.ts` and of every
  local file it reaches (recursively, with a cycle guard)".
- `CONTEXT.md`'s `ops/admin/` row (`:204`), AFTER A1's `**#404/#465/#466/#514:**` clause (A1 appended to the same
  one-line row): append `` ; **#464:** the asset cap is enforced on the stream, asset fetches are cached (`withAssetCache`: a success 10 min, a failure 30 s, 32 entries, one in-flight fetch per URL) and a failed index load is remembered for 30 s, the drift banner is re-checked once a minute (`createOutdatedRefresher`, seeded from the boot list; a run that cannot tell keeps the last answer) and names install.sh's step 4 with `--force-recreate` for the compose half, the entry point's `HandlerConfig` literal is pinned by source ``.
- `server.ts`'s `serveAdminBundle` comment "the browser caches it, so no server-side cache is needed" (`:1215-1216` at
  `239e389`): it now says the fetch is cached server-side by `withAssetCache` (item 6) as well as by the browser.
- `docs/adr/0005-...`'s "size-capped" stays.

### Mutation table (scratch worktree; `bun test ops/admin/server.test.ts` per mutant; `cd ops/admin && bun run check`)

| # | Mutation | Test that must fail |
|---|---|---|
| M1 | 1a: the running total compared only after the loop | T1 (pull count 4+, no cancel) |
| M1b | 1a: `reader.cancel()` dropped | T1 (cancel not called) |
| M1c | 1a: the `Content-Length` pre-check dropped | T1's early-reject case (the body was read) |
| M2 | 1b: failures and successes given one TTL | T5's failure/success boundary cases |
| M2b | 1b: no eviction | T5 (33 URLs, no refetch) |
| M2c | 1b: TTL ignored | T5 (no refetch after the TTL) |
| M2d | 1b: in-flight coalescing dropped | T5's twenty concurrent cold calls |
| M2e | 1b: `cache.delete(url)` before `cache.set` dropped | T5's refetched-entry-moves-to-newest case |
| M3 | 1c: the negative cache dropped | T5's lister case (two fetches within 30 s) |
| M4 | 1d: the refresher ignores the TTL | T4 (two probes within it) |
| M4b | 1d: an `unknown` replaces the answer with `[]` | T4 (the previous answer lost) |
| M4c | 1d: the status route ignores `refreshOutdated` | T4's route case |
| M4d | 1d: `last.at` not stamped on `unknown`/rejection (retried every call) | T4's three-calls-one-second-apart case |
| M4e | 1d: the boot seed dropped (`last` starts empty) | T4's seeded-never-probed case |
| M4f | 1d: `classifySchemas` reports a timeout as `{ outdated: [both] }` to the refresher | T4's timeout case |
| M4g | 1d: `classifySchemas` reports a non-zero exit as `unknown` | T4's pre-#173 usage-error case and the end-to-end swap case |
| M5 | 1e: `adminStore` dropped from the literal (scratch only) | T2 |
| M5b | 1e: `adminStore: undefined` in the literal (scratch only) | T2 |
| M6 | 2: `localImportsOf` back to two forms | T3's fixture strings (the real-tree ratchet stays GREEN under this mutant: `server.ts` uses only the `from` form, so only the fixtures guard it) |
| M6b | 2: the recursion in `transitiveLocalImports` removed | T3's cycle fixture ONLY |
| M7 | 1d/1f: the compose remedy loses "step 4 with --force-recreate" | T4's `logSchemaLine` assertion, `server.test.ts:2823`, the banner pins `:3938`/`:3946` |
| M7b | 1f: the banner's remedy chosen by list length instead of by `includes("docker-compose.yml")` | the banner pins (`:3935` single bot-ops vs `:3938` single compose) |
| M8, M8b, M8c, M8d | the documented defaults changed (success TTL 10 min, `maxEntries` 32, refresher TTL 60 s, lister window 30 s) | the default-option cases in T4/T5 |
| M9 | 1d: `<` -> `<=` at the refresher boundary | T4's exactly-`ttlMs` case |

### Coverage table

| Bullet | Step(s) | Test | Mutation |
|---|---|---|---|
| #464-2: the cap is enforced while the bytes arrive; the early reject stays | 1a | T1 | M1, M1b, M1c |
| #464-3: the entry point's literal is pinned | 2 | T2 | M5, M5b |
| #464-4: the ratchet sees every import form and follows copied files | 2 | T3 | M6, M6b |
| #464-5: the banner follows the files (seeded, bounded, unknown keeps the last answer, a non-zero exit is still drift); every compose remedy names install.sh's step 4 with `--force-recreate`; the inode fix is #486's; the #230 reversal is recorded | 1d, 1f, 3 | T4, T0, lens-B audit | M4, M4b, M4c, M4d, M4e, M4f, M4g, M7, M7b, M8c, M9 |
| #464-6: the public route stops refetching per hit, for failures and bursts too | 1b, 1c | T5 | M2, M2b, M2c, M2d, M2e, M3, M8, M8b, M8d |

### Verification

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && bun run check && cd ../..
bunx tsc --noEmit -p ops/tsconfig.json
bun run check
bun test ops/admin/server.test.ts
bun test   # background
```

Not verifiable here: Docker's bind-mount inode behaviour (documented; the remedy is the standard one); jsDelivr's
caching of a pinned URL (immutable by its documentation); the step-4 remedy on a real host (Rod's nucbox batch
re-runs it).

### Acceptance to paste per issue

- **#464:** T0-T5 pass lines; M1-M9 failing output; the new log/README/banner remedy text; item 5's pointer to #486;
  the #230 reversal sentence from `CONTEXT.md`.

### PR

- Title: `fix(admin): enforce the asset cap on the stream, pin the entry point's config, widen the COPY ratchet, re-check the drift banner and name install.sh's step 4, and cache the public bundle route (#464)`.
- Body: the five items, Decisions 1-5, the output, the mutation table, the one `index.html` line. End with `Closes #464.`
- After merge: tick #464 on #529; comment on #486 pointing at the compose-mount half (and on #531, which repeats it).

### Out of scope, on purpose

- Mounting the stack directory instead of the compose file (#486).
- Gating `/plugin-admin` behind auth (Decision 5).
- `buildHandlerConfig(env)` (Decision 2).
- A3's page items.
