<!-- Plan for Rackbops/rackbops-discord-bot#224 + #223 (Epic #235). Copy of the approved plan comment
(https://github.com/Rackbops/rackbops-discord-bot/issues/224#issuecomment-5768322245) with its
AMENDMENT (https://github.com/Rackbops/rackbops-discord-bot/issues/224#issuecomment-5768433046)
applied, plus the four rulings the orchestrating session made on the implementing subordinate's three
suggestions (all accepted as requirements) in the hand-off brief, and the implementer's "Deviations
from the plan" appended at the end. -->

## Implementation plan — written by the orchestrating session

Covers **#224 + #223** as one PR (Epic #235's declared bundle: both live in the `install.ts` extraction path). Written against `origin/main` @ `e1194e4`. Neither issue has an `## Acceptance` section, so this plan defines the observable outcome each one demands — execute those and paste the real output.

### Decisions taken (roshne: "your call on both")

- **#223 → reconcile and warn; refuse ONLY on a `hostApiVersion` mismatch.** A divergence in `commands` or `env` keys is a warning, not a refusal: the bundle still runs, and the host acts on the index for those anyway. A `hostApiVersion` divergence means the bundle was built against a different contract than the one the host is about to hand it, so it is refused like an integrity failure.
- **A missing or unparseable `package.json` NEVER refuses** — it warns and installs. This is load-bearing, not politeness: `fakeExtract` in the existing tests writes only `dist/plugin.js`, and version directories cached before this change have no reconciliation history. A refusal here would brick every already-installed plugin on the next boot.

### Step 1 — `src/plugins/install.ts`: extract into staging, then rename (#224)

In `tryInstallVersion`, the extract currently writes straight into the final `versionDir` (`await deps.extract(tarPath, versionDir)`), and the `catch` removes nothing — so a `tar` that dies part-way leaves `<versionDir>/dist/plugin.js`, which the fast path at the top of the function then reuses forever with no integrity check.

Replace it with the temp-then-rename shape used by `writeJsonAtomic`, the index cache and `ops/install.sh`'s own `fetch()`:

- `const pluginDir = join(dataDir, "plugins", name)` and a staging dir `join(pluginDir, ".staging-" + version + "-" + deps.now())`. Staging sits under `plugins/<name>/` so the rename stays within one filesystem.
- Extract into the staging dir. Keep the existing "extract produced no plugin.js" check, but test it against the staging copy.
- **Reconcile (Step 3) against the staging copy, before the rename** — a bundle refused on `hostApiVersion` must never land in the cache at all.
- `rmSync(versionDir, { recursive: true, force: true })` to clear any earlier partial, `mkdirSync(pluginDir, { recursive: true })`, then `renameSync(stagingDir, versionDir)`.
- A `finally` that does `rmSync(stagingDir, { recursive: true, force: true })` (a no-op after a successful rename) alongside the existing `rmSync(tarPath, { force: true })`.

Add `renameSync` to the `node:fs` import. Do not add `dirname` — `pluginDir` is already in hand.

### Step 2 — `newestCachedVersion` must never see a staging directory

Its filter excludes `tmp` only. A crashed process can leave a `.staging-*` directory that briefly contains `dist/plugin.js`, and `compareVersionsDesc` on such a name produces `NaN`, which `|| 0` silently turns into `0`. Add a `!e.name.startsWith(".")` clause to the filter. One clause, and it is mutation-testable.

### Step 3 — `reconcileManifest` (#223)

A new **exported** function in `install.ts` (exported so it unit-tests directly), taking the index entry, the version, the path to the extracted `package.json`, and the log; returning `{ ok: true }` or `{ ok: false, reason }`.

- File missing, unreadable, unparseable, or carrying no `botPlugin` block → warn naming the plugin and why, return ok.
- `botPlugin.hostApiVersion` present and not equal to `entry.hostApiVersion` → refuse, with a reason naming the package, the version, and **both** numbers.
- `commands` differing from `entry.commands` as a **set** (order-insensitive) → warn.
- `botPlugin.env` key set differing from `entry.env.map((e) => e.key)` → warn. Cross-reference the env-key-rename trap already documented in `ops/README.md`; do not restate it.
- Compare no other field. `version` is deliberately out of scope.

> **AMENDMENT applies here — see below.** The bullet above ("not equal to `entry.hostApiVersion`") is wrong; the amendment corrects it to compare against the host's own `HOST_API_VERSION`.

### Step 4 — call it from BOTH paths

This is the part the issue text understates. Reconciling only after an extract would never fire for the case #223 actually describes — a *pinned* bundle, which is served by the cache fast path on every boot and never re-extracted.

- **Cache fast path** (the `existsSync(bundlePath)` early return): reconcile against `join(versionDir, "package.json")`. On refusal return the failure instead of the plugin — with no fetch, exactly as today's early return does no fetch.
- **Post-extract path**: reconcile against the staging copy, before the rename (Step 1).

A refusal flows into `skips`, and a refused `/plugins update` **target** correctly triggers the existing #104 fallback to the last-good version. Do not special-case that — verify it.

`tarExtract` already pulls `package/package.json` (`install.ts:60`), so it needs no change.

### Step 5 — tests, in `src/plugins/install.test.ts`

The existing `fakeExtract` writes no `package.json`. Add a second stub rather than changing it, so the existing twelve tests stay untouched — they will now each emit one warn, which `noopLog` swallows. **Do not "fix" them.**

| # | Test name | Pins |
|---|---|---|
| 1 | `a part-way extract failure leaves no bundle behind, and the next attempt re-fetches` | extract writes `dist/plugin.js` then throws → skip recorded, the bundle path absent, **no `.staging-*` left under `plugins/demo`**, and a second run fetches the registry URL again |
| 2 | `a staging directory left behind is never treated as a cached version` | hand-seed `plugins/demo/.staging-9.9.9-1/dist/plugin.js`; no pin, no state → resolves to the index's `1.0.0` and fetches |
| 3 | `the bundle is extracted to a staging dir and moved into place, not written there directly` | capture the `destDir` passed to `deps.extract`; assert it is not `versionDir`, and the bundle exists at `versionDir` afterwards |
| 4 | `a bundle whose package.json declares a different hostApiVersion is refused and never lands` | extract writes plugin.js plus `botPlugin.hostApiVersion: 2`, index says 1 → skip reason names both numbers, **`versionDir` does not exist** (this is what proves reconciliation runs before the rename) |
| 5 | `a cached bundle whose package.json declares a different hostApiVersion is refused with no fetch` | pre-seed the version dir with plugin.js plus a mismatching package.json → skip, and no fetch was made |
| 6 | `divergent commands or env keys warn but still install` | package.json says `commands: ["other"]`, `env: [{key:"X"}]` → installed, warn names both fields |
| 7 | `a bundle with no package.json installs with a warning and is never refused` | the existing `fakeExtract` |
| 8 | `an unparseable package.json installs with a warning and is never refused` | write a single `{` |
| 9 | `a previous partial version directory is replaced, not merged` | seed `versionDir/leftover.txt` with no `dist/plugin.js`, then a successful install → `leftover.txt` is gone |

### Step 6 — docs

A `CONTEXT.md` gotcha covering both: the extraction path is atomic (staging + rename), so anything at `<version>/dist/plugin.js` came from a completed, integrity-verified extract — which is what licenses the fast path to reuse it without re-hashing; and the installed bundle's own `botPlugin` block is now reconciled against the index entry on both paths, warning on `commands`/`env` and refusing on `hostApiVersion`. Update `tryInstallVersion`'s and `installPlugins`' doc comments to match.

**Do not touch `src/plugins/contract.ts`** — it is vendored verbatim by `rackbops-bot-plugins` behind a CI drift check, and another subordinate is editing it in a separate paired PR right now.

### Coverage table

| Outcome demanded | Step | Test | Mutation that must fail it |
|---|---|---|---|
| #224: a part-way extract leaves nothing reusable | 1 | 1, 3 | extract into `versionDir` instead of the staging dir |
| #224: staging is cleaned up on failure | 1 | 1 | drop `rmSync(stagingDir)` from the `finally` |
| #224: an earlier partial is replaced | 1 | 9 | drop `rmSync(versionDir)` before the rename |
| #224: staging is never mistaken for a version | 2 | 2 | drop the `!e.name.startsWith(".")` clause |
| #223: a contract-mismatched bundle is refused | 3 | 4, 5 | `reconcileManifest` returns ok on a `hostApiVersion` mismatch |
| #223: refusal covers a cached bundle | 4 | 5 | remove the fast-path reconcile call |
| #223: refusal covers a freshly extracted bundle | 4 | 4 | remove the post-extract reconcile call |
| #223: a refused bundle never lands | 1, 4 | 4 | move the reconcile after the rename |
| #223: divergence warns, does not refuse | 3 | 6 | escalate `commands`/`env` divergence to a refusal |
| #223: an unreconcilable bundle still installs | 3 | 7, 8 | refuse on a missing `package.json` |
| #223 (ruling 1): a malformed manifest can never take `installPlugins` down | 3 | `reconcileManifest` direct tests (directory/null/non-object `botPlugin`/non-array `commands`/keyless `env` entry/string `hostApiVersion`) | remove the function's internal try/catch |
| #223 (ruling 2): a refused update target still falls back (#104) | 4 | the `#104, #223` fallback test | make the refusal throw instead of returning a reason |
| #223 (amendment): refusal is measured against the host, not the index entry | 3 | `#222` keepOlder test | compare against `entry.hostApiVersion` instead of `HOST_API_VERSION` |

### Acceptance — execute these, paste the real output

1. `bun test src/plugins/install.test.ts` — all green, with the nine tests above present.
2. `bun run check` — exit 0.
3. **#224's observable outcome:** with a stub `extract` that writes a truncated `dist/plugin.js` and then throws, `installPlugins` records a skip, `data/plugins/demo/1.0.0/dist/plugin.js` does not exist, and a second run fetches the registry URL again.
4. **#223's observable outcome:** with a bundle declaring `botPlugin.hostApiVersion: 2` against an index entry saying `1`, `installPlugins` skips it with a reason naming both numbers and leaves no version directory; with divergent `commands`, it installs and warns.

### PR

One PR, branch `claude/plugin-install-atomic-extract`, body carrying `Closes #224` and `Closes #223`, the plan committed as `docs/plans/epics/E235/01-install-extract.md`, acceptance output pasted. This is a behaviour change, so it gets the full review gate — two adversarial read-only reviewers with different lenses — and every changed line mutation-tested in a detached scratch worktree. **Never merge.**

---

## AMENDMENT to the implementation plan above — read this before executing Step 3

A defect in the plan, found by the implementing subordinate while reading `registry.ts` **before writing any code**, and verified against `origin/main` by the orchestrating session.

### The defect

Step 3 said: refuse when the bundle's `botPlugin.hostApiVersion` differs from **`entry.hostApiVersion`**. That is wrong, and it would break #222.

`selectPlugins` (`src/plugins/registry.ts:81-117`) has a `keepOlder` path that fires precisely when **`entry.hostApiVersion > hostApiVersion`** — the index's *current* version needs a newer host than this bot, so an older pinned or last-good version is kept instead, because the index's `hostApiVersion` describes `entry.version` and nothing else.

In exactly that state the plan refuses the bundle #222 exists to keep:

- host `HOST_API_VERSION` = 1
- index current = `2.0.0`, declaring `hostApiVersion: 2`
- kept version = `1.0.0`, whose own `package.json` declares `1`

Declared (`1`) differs from the entry's (`2`), so the plan refuses it — **on the cache fast path, every boot**, which is the path Step 4 deliberately added. The plugin would be permanently skipped on a deployment #222 was built to keep running.

The plan's own rationale points at the right answer: *"built against a different contract than the one the host is about to hand it."* The contract the host hands a plugin is the host's `HOST_API_VERSION` — not the index entry's claim about a different version.

### The correction

**`reconcileManifest` compares the bundle's declared `botPlugin.hostApiVersion` against the host's `HOST_API_VERSION`, not against `entry.hostApiVersion`.**

- Import `HOST_API_VERSION` from `./contract` in `install.ts`. That is a **value** import; the file currently imports only `type { PluginIndexEntry }`. This is safe here — in *this* repo `contract.ts` is a real module. (The "type-only, no runtime value" caveat applies to `rackbops-bot-plugins`'s vendored `contract.d.ts`, a different file.)
- Behaviour is **identical to the plan wherever `entry.hostApiVersion === HOST_API_VERSION`**, which is every normal deployment. It differs only in the `keepOlder` state — the case that matters.
- Everything else in Step 3 is unchanged: `commands` and `env` divergence still warn; a missing or unparseable `package.json` still warns and installs, never refuses.

### Additional test and mutant

| Test name | Pins |
|---|---|
| `a kept older bundle is not refused when the index entry needs a newer host (#222)` | host `HOST_API_VERSION` 1; entry `2.0.0` with `hostApiVersion: 2`, `intents: []`; pinned `1.0.0` whose `package.json` declares `1` → **installs**, no skip, and reconciliation still runs |

Coverage-table row: *#223's refusal is measured against the host, not the index entry* → Step 3 → that test → **mutation: compare against `entry.hostApiVersion` instead of `HOST_API_VERSION`.**

### Two claims this change makes false — fix them in the same PR

1. **`src/plugins/registry.ts:94-98`** — *"Nothing checks a kept version's own host API … a bundle built for another host API may still load."* After this change, something does check it. Rewrite it to say what is now true.
2. **`CONTEXT.md:909-911`** — carries the same claim; update it alongside.
3. **`src/plugins/registry.ts:85`** cites `install.ts:186-208` by line number, and those lines shift. Re-cite them.

### One simplification, accepted

Drop the plan's `mkdirSync(pluginDir, { recursive: true })` before the rename. It is dead: the staging directory lives *inside* `pluginDir`, and both `tarExtract` and the test stubs `mkdirSync` their destination recursively, so `pluginDir` already exists by then. The subordinate's test for keeping it was the right one — no mutant can kill that line.

---

## Rulings from the hand-off brief — all four are requirements, not suggestions

1. **`reconcileManifest` is total: it never throws.** Any read, parse or shape problem is a warn + `{ ok: true }`. Direct unit tests on the exported function for odd shapes: `package.json` is a directory (read throws), JSON `null`, `botPlugin` not an object, `commands` not an array, an `env` entry without a string `key`, `hostApiVersion` a string. Coverage row: *a malformed manifest can never take `installPlugins` down* → Step 3 → those tests → **mutation: remove the function's internal try/catch** (the directory case must then fail because the fast-path call sits outside `tryInstallVersion`'s `try` and the rejection would escape `installPlugins`).
2. **The #104 fallback of a refused update target is a test, not a claim:** a `targetVersion` whose bundle declares a mismatching `hostApiVersion` is refused, the recorded last-good `installedVersion` is installed instead, and `fallbacks[name].reason` is the refusal naming both numbers. Coverage row mutation: **make the refusal throw instead of returning a reason** (the fallback then never runs).
3. **Derive every host-API number in the new tests from `HOST_API_VERSION`** (`HOST_API_VERSION + 1` for the mismatch), never a literal 1 or 2.
4. The amendment's three doc corrections (`registry.ts:94-98` wording, `CONTEXT.md:909-911`, the `install.ts` line cite at `registry.ts:85`) are in scope and are NOT optional: a false factual claim is major.
5. `docs/plans/epics/E235/` does not exist yet — create it. `01-install-extract.md` (this file) = the plan comment + the amendment + the four rulings, with a "Deviations from the plan" section.
6. **Never touch `src/plugins/contract.ts`** — imported (`HOST_API_VERSION`) but never edited.

## Deviations from the plan (recorded at implementation)

None. `reconcileManifest` reads the plugin name off `entry.name` (already in hand) rather than taking a separate `name` parameter — a signature detail, not a behaviour change from the plan or its amendment. The three doc corrections (`registry.ts:94-98`, `registry.ts:85`'s line cite → `install.ts:306-328`, `CONTEXT.md:909-911`) are applied as the amendment specified, plus the `CONTEXT.md` gotcha entry and the `src/plugins/registry.ts`/`install.ts`/`install.test.ts` row updates Step 6 asked for.
