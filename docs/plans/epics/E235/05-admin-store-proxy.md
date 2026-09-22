## Implementation plan — written by the orchestrating session, to be executed as written

Covers **#228 + #229**, plus **#226's one code fix** (the env-key-shape check the epic's triage decision routes into this PR), as one PR in Epic #235's `ops/admin/server.ts` bundle. Written 2026-09-21 against `origin/main` @ `310e260`; every cite read from source that day (line numbers as of that sha — cite by construct when you search). **Cut only after #244 (one card per plugin) has merged**: it edits `server.ts`'s `mergePluginsView`, `index.html` and `server.test.ts`, and Step 3 below applies to the `env` rows #244 adds. None of the three issues has an `## Acceptance` section; this plan defines the observable outcomes — execute them and paste the real output. **#226 stays open**: this PR carries its code fix only, never `Closes #226`; write nothing that GitHub's keyword parser could read as closing it.

**Files:** `ops/admin/server.ts`, `ops/admin/server.test.ts`, `ops/admin/public/index.html` (the `PLUGIN_ADMIN_HELPERS` block only), `CONTEXT.md`, `ops/README.md` if a sentence there describes the admin list's write or the proxy. Nothing under `src/`, nothing in `ops/bot-ops.sh` (#227's lane), no `ADMIN_API_VERSION` or schema bump (no wire shape changes for a bundle: `AdminApi` is untouched).

### Decided — not open for re-planning

**#228 — `admins.json` writes are serialised, and the temp name is unique.**

1. `handleAdmins` (`server.ts:1594`) does read → decide → write with `store.readDynamic()` then `store.writeDynamic(dynamic)` (`:1617-1621`, `:1638`), so two concurrent adds each write the full list they read and the loser's entry is dropped silently; and the real store's `writeDynamic` (`:2013-2017`, inside `import.meta.main`) uses ONE fixed temp path `${adminsFile}.tmp`, so one writer can rename a file another is still writing. The fix is the shape `src/storage.ts` already uses (#154): **the whole read-modify-write is serialised through a promise chain**, and **the temp name is per process and per call** (`${adminsFile}.${process.pid}.${++counter}.tmp`).
2. `AdminStore` (`:116-119`) gains `mutateDynamic<R>(fn: (current: Set<string>) => { next?: Set<string>; result: R }): Promise<R>`: read fresh, call `fn` with a copy, write `next` if returned, resolve `result` — every call queued behind the previous one on that store. `readDynamic` stays (the per-request auth check reads it fresh, `:1765`); `writeDynamic` stays on the interface only as what the mutator writes through. The queue lives in an exported helper `serializeAdminMutations(store: Pick<AdminStore, "readDynamic" | "writeDynamic">): AdminStore["mutateDynamic"]`, so the real store and the tests' `makeStore` (`server.test.ts:79`) both get it from the one implementation, and the queue itself is unit-tested with a store whose read is held open.
3. **The decisions move inside the serialised turn.** `handleAdmins`' POST no-op check (`!bootstrap.has && !dynamic.has`), DELETE's `adminRemovalError` and the last-admin floor check (`:1627-1636`) all run inside `fn` against the fresh set, never against a set read before the queue. Two concurrent DELETEs of the last two dynamic admins with no env floor must end with exactly one 400 and one removal, not two removals. The responses (`list()` after a mutation, the 400 texts, the audit line) are unchanged in wording.
4. **The real store's write becomes an exported `writeAdminsFile(adminsFile, emails)`** with the unique temp name and the same `renameSync`, called from the `import.meta.main` store, so the write itself is testable against a temp directory.

**#229 — the asset proxy carries bytes, not text.**

5. `AdminAssetResult.body: string` (`:910`) becomes `body: Uint8Array`; `makeAdminAssetFetcher` (`:1102`) returns `new Uint8Array(buf)` and its failure results carry `new Uint8Array(0)`; `serveAdminBundle` (`:1046`) and `servePluginProxy` (`:1069`) pass `asset.body` to `new Response(...)` unchanged (a `Uint8Array` body is served byte for byte). Nothing decodes. Any other consumer `tsc` finds is converted the same way — name it in the PR. The JS bundle route is unaffected in behaviour (JS is ASCII-safe either way), and its test's `okAsset(body: string)` helper encodes with `TextEncoder`.

**#226's fix — an env key from the index has one shape.**

6. Wherever the panel reads an env key from the Plugin Index it is accepted only if it matches `^[A-Z][A-Z0-9_]*$`: `mergePluginsView`'s `envKeys` (`:882-884`) and the `env` rows #244 added beside it (a malformed key is dropped from both, so the bridge's `scopeToPluginKeys` never sees it and no card is drawn for it); and `buildSetEnvBody` (`index.html:544-553`) refuses a key that does not match, the way it already refuses a value with a line break, with `{ error: "key <k> is not a valid setting name" }` — the message names the key only when it is printable (mirror `bot-ops.sh`'s `echo_key` rule: otherwise `(not shown)`). A newline in a key can therefore no longer produce two `env-set` lines from one bridge call. `bot-ops.sh`'s own line check (`:910`) stays the last line of defence and is not touched here.

### Step 1 — `server.ts`: the store

- `AdminStore`: add `mutateDynamic`, with the doc comment saying why (decision 1-3). Export `serializeAdminMutations` beside it: `let chain = Promise.resolve(); return (fn) => { const turn = chain.then(async () => { const current = await store.readDynamic(); const { next, result } = fn(new Set(current)); if (next) await store.writeDynamic(next); return result; }); chain = turn.then(() => undefined, () => undefined); return turn; }` — a rejected turn (a broken `admins.json`, a failed write) rejects that caller and does not poison the chain, like `createJsonWriter` (`src/storage.ts:146-158`).
- `handleAdmins`: POST → `store.mutateDynamic((dynamic) => { if (!store.bootstrap.has(email) && !dynamic.has(email)) { dynamic.add(email); return { next: dynamic, result: "added" }; } return { result: "unchanged" }; })`, then the audit line only on `"added"`, then `list()`. DELETE → the same shape with `adminRemovalError` and the floor check inside `fn`, returning `{ result: <400 text> }` without `next` for a refusal. The `try` around both keeps its 502 mapping.
- Export `writeAdminsFile(adminsFile: string, emails: Set<string>): Promise<void>` (unique temp + `renameSync`, a module-level counter as in `src/storage.ts:73`); the `import.meta.main` store becomes `{ bootstrap, readDynamic, writeDynamic: (emails) => writeAdminsFile(adminsFile!, emails), mutateDynamic: serializeAdminMutations(...) }` — build the object once so the chain is one per process.

### Step 2 — `server.ts`: bytes through the proxy

Decision 5 verbatim. Update `AdminAssetResult`'s doc comment (`:904-905`) and `makeAdminAssetFetcher`'s (`:1083-1085`) to say the body is bytes and why (#229: a PNG, a font, a `.wasm`, gzipped JSON).

### Step 3 — the key shape

Decision 6 verbatim: one exported `ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/` in `server.ts`, used by `mergePluginsView` for `envKeys` and for #244's `env` rows; and the same literal in `index.html`'s `PLUGIN_ADMIN_HELPERS` block for `buildSetEnvBody`, with a comment naming the server constant it mirrors (the page cannot import it) and a source-pin test that the two literals are equal.

### Step 4 — tests (`ops/admin/server.test.ts`)

`makeStore` (`:79`) gains `mutateDynamic: serializeAdminMutations({ readDynamic, writeDynamic })` and an optional `holdReads: () => Promise<void>` so a test can keep a read open.

| # | Test name | Pins |
|---|---|---|
| 1 | `serializeAdminMutations: two mutations started at once are applied in order, the second seeing the first's write` | a store whose first read is held; two `mutateDynamic` calls adding different emails; release; the set holds both |
| 2 | `serializeAdminMutations: a rejected turn rejects its caller and the next turn still runs` | first `fn` throws / write rejects; second call resolves |
| 3 | `handleAdmins: two POSTs of different emails at once both persist (#228)` | held read; `Promise.all` of two POSTs; `store.dynamic` has both; both responses list both |
| 4 | `handleAdmins: two DELETEs of the last two dynamic admins at once end with exactly one refusal and one admin left` | bootstrap empty, dynamic `[a, b]`, held read → one 200, one 400 with the floor text; `store.dynamic.size === 1` |
| 5 | `handleAdmins: the POST no-op check runs inside the serialised turn` | two POSTs of the SAME email at once → one audit line, one entry |
| 6 | `writeAdminsFile: two concurrent writes both resolve, the file is valid JSON holding the last write, and no temp file remains` | a temp dir; `Promise.all` of two writes; parse; `readdirSync` shows one file |
| 7 | `writeAdminsFile: the temp name carries the pid and a counter, so two processes cannot share it` | spy through a fake `Bun.write`? No — read the directory DURING a held write: make the test call the exported function with a `writeImpl` seam (`writeAdminsFile(file, emails, write = Bun.write)`) that records the temp path; assert `/\.\d+\.\d+\.tmp$/` and that two calls' paths differ |
| 8 | `makeAdminAssetFetcher returns the bytes unchanged, including bytes that are not UTF-8 (#229)` | `arrayBuffer` yields `[0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]`; `out.body` equals them byte for byte |
| 9 | `servePluginProxy serves a binary asset byte for byte with the upstream content type` | `fetchAdminAsset` returns those bytes as `image/png`; `new Uint8Array(await res.arrayBuffer())` equals them; `Content-Type: image/png` |
| 10 | `serveAdminBundle still serves the JS bundle as text` | the existing tests, with `okAsset` encoding |
| 11 | `mergePluginsView drops an env key that is not ^[A-Z][A-Z0-9_]*$, from envKeys and from env (#226)` | keys `GOOD_KEY`, `bad key`, `X\nY=1`, `lower`, `_UNDER` → only `GOOD_KEY` survives in both |
| 12 | `buildSetEnvBody refuses a key that is not a valid setting name, naming it only when printable (#226)` (lifted-block test, the file's idiom) | `{ "X\nY=1": "v" }` scoped to that key → `{ error: … (not shown) … }`; `{ "bad key": "v" }` → error names it? (no: a space is not printable-safe under `echo_key`'s rule — decide by that rule and say so); `{ GOOD_KEY: "v" }` → a body |
| 13 | `the page's key regex is the server's ENV_KEY_RE` (source pin) | the literal in `index.html` equals `ENV_KEY_RE.source` |

### Coverage table

| Outcome demanded | Step | Test | Mutation that must fail it |
|---|---|---|---|
| #228: concurrent adds are never lost | 1 | 1, 3 | `mutateDynamic` runs `fn` without queueing (call read/fn/write directly) |
| #228: the guardrails see the fresh set | 1 | 4, 5 | move the floor check / the no-op check back outside `fn` |
| #228: no shared temp path | 1 | 6, 7 | a fixed `${adminsFile}.tmp` |
| #228: a failed turn does not wedge the queue | 1 | 2 | `chain = turn` without the catch |
| #229: bytes survive the proxy | 2 | 8, 9 | `new TextDecoder().decode(buf)` |
| #229: the bundle route is unchanged | 2 | 10 | — (regression only) |
| #226: a malformed index key never reaches the bridge or a card | 3 | 11 | drop the filter from `envKeys`; drop it from `env` |
| #226: the bridge refuses a malformed key | 3 | 12, 13 | drop the key check in `buildSetEnvBody`; change one literal |
| docs | 5 | — single read against the merged code | — |

### Step 5 — docs

`CONTEXT.md`: the `ops/admin/server.ts` row (Grep it on a short substring) and gotchas: **`admins.json` is written through one serialised mutator per process, with a per-call temp name (#228)** — the `src/storage.ts` parallel, why the decisions sit inside the turn; **the asset proxy is bytes end to end (#229)**; **an env key from the index has one shape, checked on the server and in the bridge (#226)**. `ops/README.md`: the admin-list paragraph if it describes the write; the proxy sentence if it says "text".

### Acceptance — execute these, paste the real output

```
bun run --cwd ops/admin check
bun test ops/admin/server.test.ts --timeout 20000        # one run at a time on this box; private TEMP/TMP
```

Plus, pasted: test 3's and test 4's assertions with the held read (the concurrency claims, measured); test 9's byte comparison. Nothing here is CI-only, but name that no real `admins.json` on a host was exercised.

### PR

Branch `claude/admin-store-serialised` from `origin/main` **after #244 has merged**, isolated worktree; title `fix(admin): serialise admins.json writes with a unique temp name, proxy assets as bytes, and check an env key's shape (#228, #229)`; body with `Closes #228` and `Closes #229`, a sentence "carries #226's env-key-shape check; #226 stays open for its posture decision's remaining follow-through" (no closing keyword near #226), the plan committed as `docs/plans/epics/E235/05-admin-store-proxy.md` (with a "Deviations from the plan" section), deviations, the acceptance output, the mutation table, the round list with dispositions. Behaviour change on a privileged surface: the full gate — two adversarial read-only reviewers with different lenses (A: correctness and failure modes — the chain under a rejected read, the floor check under concurrency, the `Uint8Array` `Response` body in Bun, what the bridge shows for a refused key; B: claims-vs-code and test quality — every coverage-row mutant really fails only the test it names). Mutation-test every changed line in a detached scratch worktree, one mutant at a time. Subordinate #2 will be running `server.test.ts` for #245 at the same time: one run at a time on this box, and whichever of the two PRs merges second merges `origin/main` in (different functions; expected clean). At most four rounds, then stop and tell the orchestrator. **Never merge.**

---

## Deviations from the plan

1. **`writeDynamic`'s guard preserved, not dropped.** Step 1's shorthand pseudocode for the `import.meta.main` store (`writeDynamic: (emails) => writeAdminsFile(adminsFile!, emails)`) elides the pre-existing `if (!adminsFile) throw new Error("BOT_OPS_CONFIG_DIR is not set — nowhere to persist admin changes")` guard. Implemented WITH the guard kept, wrapping the call: dropping it would have `adminsFile!` silently cast `undefined` to a string, producing a bogus `"undefined.<pid>.<n>.tmp"` temp path and a `renameSync` to a file literally named `"undefined"` instead of failing loudly — a real regression the plan's non-null-assertion shorthand wasn't asking for.

2. **`writeAdminsFile` also preserves the pre-existing deploy-user `chownSync` ownership step**, not mentioned in the plan's `writeAdminsFile(adminsFile, emails): Promise<void>` signature but present in the code the plan is replacing (issue #20's fix: the container runs as root, so a fresh `admins.json` would otherwise be root-owned and unreachable by the deploy user over SSH). Folded into `writeAdminsFile` itself, deriving the directory to `statSync` via `dirname(adminsFile)` rather than threading a separate `configDir` parameter through — equivalent to the original's `configDir` in production (`adminsFile === "${configDir}/admins.json"`), and keeps the exported function's signature exactly as specified.

3. **`node:fs`'s `chownSync`/`renameSync`/`statSync` and `node:path`'s `dirname` moved from a dynamic `await import("node:fs")` inside `import.meta.main` to a static top-level import.** `writeAdminsFile` is now an exported, module-scope function that tests 6 and 7 call directly — it needs these at module scope, not only reachable from inside `import.meta.main`'s dynamic-import closure. No behavioural difference (a built-in Node module's dynamic vs. static import has no meaningful side effect); noted because the rest of the file deliberately keeps `node:fs` out of its top-level imports.

4. **`list()` (used by GET, and by POST/DELETE's own response) now reads through `store.mutateDynamic` as a no-op turn (`(dynamic) => ({ result: dynamic })`), not a bare `store.readDynamic()`.** Not spelled out in the plan's Step 1 pseudocode, but required to satisfy the plan's OWN test 3 ("both responses list both"): running that test against a `list()` that called `readDynamic()` directly showed a genuine race — a POST's own post-mutation `list()` call could resolve before a SIBLING already-queued `mutateDynamic` turn had finished writing, so that response's `dynamic` array was momentarily missing the sibling's entry (`store.dynamic`, the persisted state, was always correct — only the immediate HTTP response could be stale). Routing `list()` through the same queue guarantees it always waits for everything already queued ahead of it, closing the race. Documented in `server.ts`'s own comment on `list()` and on the `AdminStore` interface doc comment.

5. **`ops/README.md`: no edit made.** Read the admin allow-list paragraph and the plugin-admin-tabs/proxy paragraphs; neither describes `admins.json`'s write mechanics (the serialization/temp-naming this PR changes) nor claims the asset proxy serves "text". The plan's own instruction was conditional ("if a sentence there describes...") and the condition doesn't hold.

No other deviations. Test 12's exact assertions follow the plan's own explicit instruction verbatim (a key failing `ENV_KEY_RE` always fails the identical-character-class printability check too, so both the newline and the `"bad key"` case resolve to `"(not shown)"`).
