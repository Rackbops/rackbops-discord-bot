<!-- Plan for sub-epic #524 of Epic #516 (Rackbops/rackbops-discord-bot), bundle B1: the boot path. Written
by the orchestrating session on 2026-10-15 against `main` @ `c783ad0`. Every file:line below was read from
that tree; the implementer re-reads each one on the tree it works from and corrects any that moved. -->

## Implementation plan -- #524 bundle B1: `src/index.ts`'s ready handler, `src/bootLog.ts`, `src/dataDir.ts`

Children: **#435**, **#458**, plus #493 item 1, #495 item 15 and the `describeBoot` half of #495 item 14,
and #510 item 11. One PR. A behaviour change (the boot log's ordering guarantee, the `bun test` data-dir
guard, and a refactor of the `ClientReady` handler), so the **three-reviewer gate** applies: you plus two
read-only adversarial reviewers with different lenses, up to four rounds, then report. Every coverage row
is mutation-tested in a scratch worktree, real output pasted.

Bundle A (`524-A-storage-state.md`) edits `src/storage.ts` from `:71` down and `storage.test.ts` from `:86`
down. This bundle owns `storage.ts:20-69` and `storage.test.ts:30-64` and touches nothing else in those
two files. Bundle B2 owns `config.ts`, `clientIp.ts`, `registry.ts`, `http.test.ts` and the proxy block in
`index.ts` (`:322-346`); this bundle does not touch them.

### What is wrong, verified at `c783ad0`

- `src/index.ts:130-139`: the `ClientReady` handler clears `verifyTimer`, runs `takeOver` only when
  `mode === "standby"`, then `activate(c)`. The only test that names this (`src/index.test.ts:61-68`,
  "...after takeOver") checks that the one dynamic `import(` sits after `async function activate(`; swapping
  `:137` and `:138`, or dropping the `mode` gate, leaves every test green while a replacement attaches
  handlers, plugins, the HTTP listener and the scheduler beside the live original on the same token.
  (#435.)
- `src/storage.ts:36-37` and `CONTEXT.md:404-406` say `index.ts` logs the resolved data dir and
  `index.test.ts` pins it. The line is `src/bootLog.ts:57`; `index.test.ts:21-27` pins only that `./bootLog`
  is the first import; `bootLog.test.ts` drives only the pure formatters. Deleting `bootLog.ts:57` leaves
  every test green. (#458, which also carries `docs-context-md-9` and `boot-config-http-2`.)
- `bootLog.ts:50-56` puts the data-dir line behind `await import("./storage")`, a top-level await. Under
  ESM a module with a top-level await lets later siblings evaluate while it is suspended, so
  `./config`'s module-body throw (`index.ts:7`, `config.ts:174`) can end the process before `:57` runs: the
  line exists for the misconfigured boot and is the one case it can be lost in. `bootLog.ts:18-21` records
  that behaviour itself. (#493 item 1.)
- `bootLog.ts:36-41` `describeBoot` has no production caller (`bootLog.test.ts:39-50` only). (#495 item 14,
  the `describeBoot` half; the config row and the XFF sentence are B2's.)
- `logFormat.ts:5-8` and `CONTEXT.md:159` say one swap covers every host and plugin line; `installJsonConsole`
  (`logFormat.ts:40-54`) replaces `log/info/debug/warn/error` only. `console.trace/dir/table/assert/group`,
  `process.emitWarning` and a direct `process.stdout.write` stay plain. (#495 item 15.)
- `storage.ts:54` guards the checkout with `env.NODE_ENV === "test"`. Probed 2026-10-15 on Bun 1.4.2:
  `NODE_ENV=production bun test` leaves `process.env.NODE_ENV` at `production` (Bun sets `test` only when
  the shell exported nothing), so a developer shell exporting `NODE_ENV` plus a preload that fails to run
  falls through to the checkout `data/` silently. In the same probe `process.argv[1]` under `bun test` is
  the test file being run. (#510 item 11.)

### Decisions (defaults, named so the gate can contest them)

1. **Extract the ready handler** into `src/ready.ts` (`createReadyHandler`), driven by `ready.test.ts` with
   fakes, plus source pins in `index.test.ts` that `index.ts` wires it and nothing else calls `takeOver`.
   The issue's other option (more source-order regexes) keeps the pin textual; the repo's shape is pure
   functions with injected deps.
2. **Move `resolveDataDir` to a leaf module `src/dataDir.ts`** (imports `node:path` only) and have
   `bootLog.ts` call it synchronously inside a `try`; `storage.ts` re-exports it, so every existing import
   keeps working. A static import of `./storage` from `bootLog.ts` would evaluate `DATA_DIR = resolveDataDir()`
   before `bootLog`'s body and take both lines down (the reason `bootLog.ts:11-17` gives), and the dynamic
   import is the top-level await that breaks the ordering. With the leaf, `bootLog.ts` has no `await` at
   all, so ESM evaluates it to completion before `./config`.
3. **`resolveDataDir(env, entry = process.argv[1])` recognises `bun test` two ways:** `env.NODE_ENV ===
   "test"` (what Bun sets when the shell exported nothing) **or** the entry file matching Bun's own
   discovery names, `/[._](test|spec)\.[cm]?[jt]sx?$/` (what `process.argv[1]` is under `bun test`, per
   the probes: a test file -- the one named on the command line, or under a whole-directory run and
   `--randomize` the FIRST file Bun discovered, which every later file still sees; it is a test file either
   way, which is all the check needs). No documented runner flag exists: `typeof Bun.jest` is `"function"` and
   `import("bun:test")` succeeds under a plain `bun -e` too (probed), so neither tells the runner apart. A
   developer running `bun src/x.test.ts` directly also trips the heuristic, which is the safe side. The
   preload cannot be the signal, since the case to catch is the preload not running.
4. **Subprocess tests for the module body** (`Bun.spawnSync` of `bun src/bootLog.ts` and of
   `bun src/index.ts` with `DISCORD_TOKEN` blank), in the shape `src/commandPrefix.test.ts:29-63` already
   uses, with the same explicit timeout (`:70`). The `index.ts` run reaches `config.ts:174`'s throw after
   loading discord.js and before any network (`loadPluginIndex` is at `index.ts:69`, after the throw), so it
   needs no stub and ends in under a few seconds. Only `DISCORD_TOKEN` is blanked: `required()` runs for
   `ANNOUNCE_CHANNEL_ID` first (`config.ts:79`) and for `DISCORD_TOKEN` inside the return literal (`:154`), so
   blanking both would name the channel id; the child inherits the preload's `ANNOUNCE_CHANNEL_ID=100`
   (`test/setup.ts:72`) through `...process.env`.
5. **Documentation only for #495 item 15:** the five-method scope is stated in `logFormat.ts`,
   `CONTEXT.md:159` and `.env.example`; the consumer (the Clerk instance) already has to tolerate Bun's own
   plain-text crash output, so a wider swap buys little. The gate can contest this.
6. **`describeBoot` is deleted** with its two tests; nothing else reads it (grep of `src/`, `ops/`,
   `CONTEXT.md`: only `bootLog.test.ts`).
7. **Not in this bundle:** `#493` items 4-7 and `#495` item 14's config row and XFF sentence (B2); the ADR
   sentence for `#493` item 7 (B2, where ADR-0004 decision 3 is edited once for both intent findings).

### Step 1 -- `src/dataDir.ts` (new) and `src/storage.ts:20-69`

- Create `src/dataDir.ts` with the `resolveDataDir` docstring and body moved from `storage.ts:20-61`,
  changed as follows:
  - The sentence at `storage.ts:36-37` becomes "That is why `src/bootLog.ts` logs the resolved path on every
    boot, before `./config` can throw — it is the one thing that turns that into a one-line diagnosis — and
    `bootLog.test.ts` runs the module in a subprocess to pin it (#458)."
  - The paragraph at `:43-44` becomes "Under `bun test` an unset override is a hard error rather than a silent
    fall back to the checkout: without that, a preload that fails to run restores the corruption invisibly.
    `bun test` is recognised by `NODE_ENV=test` — which Bun sets only when the shell exported no `NODE_ENV`
    (measured on Bun 1.4.2: `NODE_ENV=production bun test` keeps `production`) — or by the entry file
    (`process.argv[1]`, the test file under `bun test`) being a `*.test.*` file; the preload itself cannot be
    the signal, since the case to catch is the preload not running (#510)."
  - A header comment: "A leaf: imports `node:path` only, so `src/bootLog.ts` can import it without evaluating
    `src/storage.ts`'s body (which computes `DATA_DIR` at load and would throw first, #493). `src/storage.ts`
    re-exports it; import it from there everywhere else."

  ```ts
  import { isAbsolute, join } from "node:path";

  // Bun's test discovery names: *.test.*, *_test.*, *.spec.*, *_spec.* over js/jsx/ts/tsx (and the c/m variants).
  const TEST_ENTRY = /[._](test|spec)\.[cm]?[jt]sx?$/;

  export function resolveDataDir(
    env: Record<string, string | undefined> = process.env,
    entry: string | undefined = process.argv[1],
  ): string {
    const override = env.BOT_DATA_DIR;
    if (override !== undefined && override !== "") {
      if (!isAbsolute(override)) {
        throw new Error(`BOT_DATA_DIR must be an absolute path, got "${override}"`);
      }
      return override;
    }
    if (env.NODE_ENV === "test" || (entry !== undefined && TEST_ENTRY.test(entry))) {
      throw new Error(
        "BOT_DATA_DIR must be set under `bun test` — refusing to read or write the checkout's data/ " +
          "(#139). The bunfig.toml preload sets it; if you are seeing this, the preload did not run.",
      );
    }
    return join(import.meta.dir, "..", "data");
  }
  ```

  `import.meta.dir` is `src/` in both files, so the default path is unchanged.
- `storage.ts:20-61` -> `import { resolveDataDir } from "./dataDir";` and `export { resolveDataDir };` with
  a two-line comment pointing at `dataDir.ts` for the docstring; keep `:63-69` (`DATA_DIR`) as is.
- `storage.ts:3` `import { dirname, isAbsolute, join } from "node:path";` -> `import { dirname } from
  "node:path";` -- `isAbsolute` and `join` are used only inside the moved function, and `tsconfig.json` sets
  `noUnusedLocals`, so leaving them fails `bun run check`. Bundle A edits the adjacent line `:2` (it adds
  `rmSync` to the `node:fs` import) and appends to the same `CONTEXT.md` `src/storage.ts` row you edit in
  step 4; **this bundle merges first**, and A merges `main` afterwards and makes its edits on top of
  yours. Nothing for you to resolve; say so in the PR body.

### Step 2 -- `src/bootLog.ts`

```ts
import { installJsonConsole, logFormatFrom } from "./logFormat";
import { resolveDataDir } from "./dataDir";

export function describeEnvFile(...)   // unchanged, :25-30
export function describeDataDir(...)   // unchanged, :32-34
// describeBoot (:36-41) deleted

const logFormat = logFormatFrom(process.env);
if (logFormat === "json") installJsonConsole(console, process.stdout, process.stderr);
else if (logFormat === "invalid") console.error(`[boot] LOG_FORMAT must be json or text, got "${process.env.LOG_FORMAT}" -- logging as text`);
console.log(describeEnvFile(process.env));
let dataDir: string;
try {
  dataDir = resolveDataDir();
} catch (err) {
  console.error(`[boot] couldn't resolve the data dir: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
console.log(describeDataDir(dataDir));
```

Rewrite the header (`:1-22`). Paragraph one keeps its point and adds: "This module is fully synchronous,
so ESM evaluates it to completion before `./config` (#493); both lines are therefore printed before
`resolveConfig` can throw, not just the first." Paragraph two replaces `:11-22`: "`resolveDataDir` comes
from `./dataDir`, a leaf over `node:path` whose import cannot throw; the call can (a relative
`BOT_DATA_DIR`, or no override under `bun test`), so it is made here, inside a `try`, after the env-file line
has printed — a bad data dir costs one line and `process.exit(1)`, never the env-file line. This used to be
a dynamic `import("./storage")` behind a top-level wait, which made this module async: a later sibling
import (`./config`) could then evaluate, and throw, while this one was suspended, losing the data-dir line
in exactly the misconfigured-boot case (#493; the auditor reproduced the loss 3 of 3 runs on Bun 1.4.2). A
static `import { DATA_DIR } from "./storage"` would be worse: `storage.ts`'s body computes `DATA_DIR` at load
and would take both lines down with it." Keep the `resolveAdminStorePathsOrExit` comparison. T11 strips
comments before it looks for the keyword, so the wording above is free, but keep the literal word out of
the header anyway. `CONTEXT.md:462`'s mention of `bootLog.ts`'s `dataDir` stays true (still set once at
load).

### Step 3 -- `src/ready.ts` (new) and `src/index.ts:130-139`

```ts
// #435: the ClientReady handler, extracted so its one invariant is driven by a test instead of read off
// index.ts's source: a standby takes over (retires the original) BEFORE anything that makes this process the
// bot is attached, and a normal boot never calls takeOver. Both instances hold the same DISCORD_TOKEN and
// Discord delivers every event to both sessions, so the other order doubles every reply and announcement.
export interface ReadyDeps<C> {
  mode: "standby" | "normal";
  /** `redeploy.ts`'s `takeOver`, already bound to the original's id. Crash-proof: a retire failure exits the
   *  process rather than returning, so a doomed handoff can never fall through to `activate`. */
  takeOver: () => Promise<void>;
  /** Everything that makes this process *the* bot (`index.ts`'s `activate`). */
  activate: (client: C) => Promise<void>;
  /** Cancels the standby's verify deadline; a no-op in normal mode. Cleared first: a completed login is the
   *  verification bar, whatever follows. */
  clearVerifyTimer: () => void;
  log: Pick<Console, "log">;
  describe: (client: C) => string;
}

export function createReadyHandler<C>(deps: ReadyDeps<C>): (client: C) => Promise<void> {
  return async (client) => {
    deps.log.log(deps.describe(client));
    deps.clearVerifyTimer();
    if (deps.mode === "standby") await deps.takeOver();
    await deps.activate(client);
  };
}
```

`index.ts:130-139` becomes (keep the comment at `:133-136` above it, now citing `ready.ts`):

```ts
client.once(
  Events.ClientReady,
  createReadyHandler({
    mode,
    takeOver: () => takeOver(process.env[HANDOFF_FROM_ENV]!),
    activate,
    clearVerifyTimer: () => clearTimeout(verifyTimer),
    log: console,
    describe: (c) => `Logged in as ${c.user.tag}`,
  }),
);
```

with `import { createReadyHandler } from "./ready";`. `activate` is declared at `:146` as a function
declaration, so it is hoisted; `verifyTimer` (`:467`) is read only when the handler runs, as today.

### Step 4 -- docs, in the same PR

- `CONTEXT.md:404-406`: "by `index.ts` logging the resolved path on every boot — that log is what turns the
  symptom into a one-line diagnosis, and `index.test.ts` pins it" -> "by `src/bootLog.ts` logging the
  resolved path on every boot, synchronously, before `./config` can throw — that log is what turns the
  symptom into a one-line diagnosis — and `bootLog.test.ts` runs the module in a subprocess to pin it
  (#458)".
- `CONTEXT.md` File Map: add rows for `src/dataDir.ts`, `src/ready.ts`, `src/ready.test.ts`, and — there is
  none today (grep `bootLog` finds only `:159` and `:462`) — for `src/bootLog.ts` and `src/bootLog.test.ts`,
  in the table's style. (There is no `src/index.test.ts` row either; do not add one — the missing test rows
  are #475's.) The `src/storage.ts` row (`:205`; grep `Shared atomic-JSON-file primitives`): the sentence
  "Also exports `resolveDataDir(env)` and the `DATA_DIR` it produces" -> "Also re-exports
  `resolveDataDir(env, entry)` from `src/dataDir.ts` (moved there in #493 so `bootLog.ts` can call it without
  evaluating this module's body) and exports the `DATA_DIR` it produces". The `src/index.ts` row (`:156`):
  "Then login, then `activate()` (after `takeOver()`): install + load" -> "Then login, then `activate()`
  (after `takeOver()` — the `ClientReady` handler is `createReadyHandler`, `src/ready.ts`, #435: clear the
  verify timer, `takeOver` only in standby, then `activate`): install + load". Grep each row on a short
  unique substring and anchor the Edit on it; do not Read a long row by line range. The quoted sentences at
  `CONTEXT.md:404-406` and `logFormat.ts:7-9` wrap across lines, so anchor each Edit on one line's worth of
  text, not the whole sentence.
- Cites that move with this PR, re-pointed in the same PR: `ops/README.md:1033` (cites `src/bootLog.ts:28`)
  and `:937` (cites `src/index.ts:130`, `:458-472`, `:354-359` — re-read each and point it at the new line or
  symbol); `ops/bot-ops.sh:313`'s comment "src/storage.ts: `test` makes an unset BOT_DATA_DIR a boot error"
  -> "src/dataDir.ts: under bun test (NODE_ENV=test, or a test-file entry) an unset BOT_DATA_DIR is a boot
  error"; `CONTEXT.md:413` "the `NODE_ENV=test` refusal" -> "the bun-test refusal (`NODE_ENV=test`, or a
  `*.test.*` entry file, `src/dataDir.ts`)"; `CONTEXT.md:609` "`src/storage.ts`'s `resolveDataDir`" ->
  "`src/dataDir.ts`'s `resolveDataDir`". Grep `resolveDataDir` and `NODE_ENV` across `CONTEXT.md`, `README.md`,
  `ops/README.md` and `ops/bot-ops.sh` for any other sentence that names the old location.
- `logFormat.ts:5-8`: after "so one swap covers them all, the boot lines included." add "Covered: the five
  methods below (`log`, `info`, `debug`, `warn`, `error`). Not covered, and left plain on purpose:
  `console.trace/dir/table/assert/group`, `process.emitWarning`, and anything written straight to
  `process.stdout`/`stderr` — a line-oriented consumer tolerates a non-JSON line, as it already must for
  Bun's own crash output (#495)." `CONTEXT.md:159`: same scope in one sentence after "One swap covers every
  host line and every plugin line, since a plugin's `host.log` wraps `console`" -> "... — for the five
  methods it swaps (`log/info/debug/warn/error`); `console.trace/dir/table/assert/group`, `process.emitWarning`
  and direct stdout writes stay plain (#495)". `.env.example`'s `LOG_FORMAT` comment (grep `# Log format:`):
  add "Only console.log/info/debug/warn/error are wrapped; console.trace/dir/table/assert/group and anything
  written straight to stdout stay plain, so a line-oriented reader must tolerate a non-JSON line."
- `bootLog.test.ts:4-8` header: it is false (the import at `:2` runs the body); rewrite to "The pure
  formatters are pinned directly below; the module body (the two lines, the JSON swap, the exit on a bad
  data dir, and the ordering against `./config`) is pinned by the subprocess tests at the end, since
  importing this file in-process runs the body once and cannot un-run it."

### Step 5 -- tests

`src/ready.test.ts` (new):

| # | Test | Pins |
|---|---|---|
| T1 | "standby: logs the login, clears the verify timer, takes over, then activates — in that order" | fakes push `"log"`, `"clear"`, `"takeOver"`, `"activate"`; `order` equals exactly that |
| T2 | "normal: never calls takeOver, and still clears the timer before activating" | `takeOver` throws if called; `order` `["log", "clear", "activate"]` |
| T3 | "a takeOver that rejects means activate never runs, and the rejection reaches the caller" | `await expect(handler(client)).rejects.toThrow("retire failed")`; `activate` not called |
| T4 | "activate receives the client the gateway handed over" | `toBe` the same object |

`src/index.test.ts`:

| # | Test | Pins |
|---|---|---|
| T5 | new `describe("the ClientReady handler is createReadyHandler (#435)")` / "index.ts wires mode, takeOver, activate, the verify timer, the console and the login line into one createReadyHandler call, and attaches nothing else to ClientReady" | `(source.match(/client\.once\(\s*Events\.ClientReady,/g) ?? []).length === 1` (the call spans lines); `source` does not match `/Events\.ClientReady,\s*async/`; the slice from `createReadyHandler({` to its closing `}),` contains `/\n\s*mode,\n/`, `takeOver: () => takeOver(process.env[HANDOFF_FROM_ENV]!),`, `/\n\s*activate,\n/`, `clearVerifyTimer: () => clearTimeout(verifyTimer),`, `log: console,` and ``describe: (c) => `Logged in as ${c.user.tag}`,`` (operators grep `Logged in as`, `ops/README.md:1024`); `(source.match(/takeOver\(process\.env\[HANDOFF_FROM_ENV\]!\)/g) ?? []).length === 1`; `source` does not match `/await takeOver\(/`; the import `from "./ready"` exists |
| T6 | `:61` retitled "no plugin code loads at module-eval — the bundle import() is inside activate()" with a comment that the takeOver-before-activate order is `ready.test.ts`'s | body unchanged |

`src/bootLog.test.ts` (new `describe("the module body, in a subprocess (#458, #493)")`; helper `run(file,
env)` = `Bun.spawnSync([process.execPath, file], { cwd: <repo root>, env: { ...process.env, LOG_FORMAT: "",
...env }, stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS })` with `CHILD_TIMEOUT_MS = 20_000`,
and each of T7-T10 given `CHILD_TIMEOUT_MS + 10_000` as its test timeout, as `commandPrefix.test.ts:70`
does; a temp dir per test named with `TEST_DATA_PREFIX` + pid as `commandPrefix.test.ts:32` does, removed in
`finally`):

| # | Test | Pins |
|---|---|---|
| T7 | "prints the env-file line, then the data-dir line, and exits 0" | `run("src/bootLog.ts", { BOT_DATA_DIR: tmp, BOT_ENV_FILE: "/x/.env" })`: exit 0; stdout lines `[describeEnvFile({ BOT_ENV_FILE: "/x/.env" }), describeDataDir(tmp)]` |
| T8 | "under LOG_FORMAT=json both lines are one JSON record each" | `LOG_FORMAT: "json"`: two lines, each `JSON.parse`s to `{ time, level: "info", msg }` with the two messages |
| T9 | "a relative BOT_DATA_DIR still prints the env-file line, then says why it stopped, and exits 1" | `BOT_DATA_DIR: "./data"`: stdout[0] is the env-file line and there is no data-dir line; stderr contains `couldn't resolve the data dir` and `absolute path`; exit 1 |
| T10 | "both boot lines print before ./config throws (#493)" | `run("src/index.ts", { BOT_DATA_DIR: tmp, DISCORD_TOKEN: "", PLUGINS: "", PLUGIN_INDEX_URL: "https://plugins.invalid/plugins.json" })` (only the token blank: `required("ANNOUNCE_CHANNEL_ID")` runs first, `config.ts:79`, and the child inherits the preload's `100`): exit non-zero; stdout contains a line starting `[boot] env file:` and the line `describeDataDir(tmp)`; stderr matches `/Missing required env var DISCORD_TOKEN/` |
| T11 | "bootLog.ts has no top-level await, which is what makes the ordering hold" | `const code = readFileSync(bootLog.ts, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");` `expect(code).not.toMatch(/\bawait\b/)` (comments stripped first; the file has no functions that await either) |
| T12 | `:39-50` (`describeBoot`) deleted | -- |

`src/storage.test.ts:30-64` (`resolveDataDir`):

| # | Test | Pins |
|---|---|---|
| T13 | `:34-36` and `:50-52` pass an explicit non-test entry: `resolveDataDir({}, "/app/src/index.ts")` | unchanged expectations |
| T14 | `:56-58` becomes "under bun test with no override it refuses — by NODE_ENV, or by the entry file whatever NODE_ENV says" | `resolveDataDir({ NODE_ENV: "test" }, "/app/src/index.ts")` throws `/BOT_DATA_DIR must be set/`; for each of `/x/foo.test.ts`, `C:\\x\\foo.test.tsx`, `/x/foo.spec.js`, `/x/foo_test.mts`, `/x/foo_spec.cjs`: `resolveDataDir({ NODE_ENV: "production" }, entry)` throws; for each of `/x/foo.ts`, `/x/test.ts`, `/x/testing.ts`, `/x/foo.test.md`: it returns the checkout path |
| T15 | "the live run is recognised through the default entry" | `resolveDataDir({ NODE_ENV: "production" })` (no entry argument: under `bun test` `process.argv[1]` is a test file -- this one, or the first discovered in a whole-suite run) throws; also `expect(process.argv[1]).toMatch(/[._](test|spec)\.[cm]?[jt]sx?$/)` so the assumption itself is pinned on every runner invocation |
| T16 | "an absolute override wins under bun test too" | `resolveDataDir({ BOT_DATA_DIR: abs, NODE_ENV: "test" })` returns `abs` |

### Coverage table

| Outcome | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| a standby takes over before it activates | 3 | T1 | M1: swap the `takeOver` and `activate` lines in `ready.ts` |
| a normal boot never calls takeOver | 3 | T2 | M2: drop the `mode === "standby"` gate |
| the verify timer is cleared first | 3 | T1, T2 | M3: move `clearVerifyTimer()` after `activate` |
| a failed takeOver never falls through to activate | 3 | T3 | M4: wrap `takeOver()` in a try that swallows |
| index.ts cannot bypass the handler | 3 | T5 | M5: restore the inline `async (c) => {...}` handler and delete the `createReadyHandler` call |
| the login line operators grep for is still logged, to the console | 3 | T5 | M13: change the `describe` template to `Ready as ...`; M14: `log: { log: () => {} }` |
| the data-dir line is printed, from bootLog.ts | 2 | T7 | M6: delete `console.log(describeDataDir(dataDir))` |
| the JSON swap covers the boot lines | 2 | T8 | M7: move `installJsonConsole(...)` below the two `console.log`s |
| a bad data dir exits 1 after the env-file line | 2 | T9 | M8: replace `process.exit(1)` with `dataDir = "?"` |
| both lines print before ./config throws | 1, 2 | T10, T11 | M9: reintroduce `({ DATA_DIR: dataDir } = await import("./storage"))` — T11 red for certain; T10 red too (the auditor lost the data-dir line 3 of 3 runs under the top-level wait on Bun 1.4.2; report your own count) |
| `bun test` is recognised by the entry file when NODE_ENV says otherwise | 1 | T14, T15 | M10: delete the `TEST_ENTRY.test(entry)` half; M10b: narrow the regex to `/\.test\.ts$/` (the `.spec.js`, `_test.mts` and `.tsx` cases go red) |
| `bun test` is recognised by NODE_ENV | 1 | T14 | M11: delete the `env.NODE_ENV === "test"` half |
| the override still wins | 1 | T16 | M12: move the `bun test` check above the override |
| the docs say what the code does | 4 | manual: reviewer B reads every edited sentence against the code | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the
tests or a reviewer are reading. T7-T10 spawn `bun`; each takes a second or two.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the repo root, then `bun test --randomize` once. Name CI's Linux run as the evidence for
  the `ops/*` suites that skip here. The PR is not ready until CI is green.
- Review gate: reviewer A on correctness and failure modes (ESM evaluation order with and without a
  top-level await; `process.exit` inside a module body under `bun test` — T9 must run in a child, never
  in-process; the `entry` heuristic's false positives; the generic `C` in `createReadyHandler` against
  `Client<true>`); reviewer B on claims-vs-code, walking the coverage table and every edited comment and doc
  line against the merged tree. Both read-only, both handed the merged tree and the issues. Fix or decline
  every evidenced finding in writing; re-run the gate on the whole merged state after a behaviour fix.
- Branch `fix/524-B1-boot-ready-datadir`; commit and PR title
  `fix(boot): pin takeOver-before-activate, print the data dir synchronously, and test the boot lines for real (#435, #458)`.
  Body: one line each `Closes #435`, `Closes #458`; `Part of #493 (item 1 here; 4-7 in bundle B2)`,
  `Part of #495 (item 15 and describeBoot here; the rest in B2)`, `Part of #510 (item 11 here; the rest in
  bundle A)`; the pasted checks; the mutation rows; the gate's rounds; decisions 1-7 named as assumptions
  taken. Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-524-B1 origin/main -b fix/524-B1-boot-ready-datadir
Issues: Rackbops/rackbops-discord-bot #435 #458, plus items of #493 #495 #510 (sub-epic #524 of Epic #516). Read each issue body first.
Plan: docs/plans/epics/E516/524-B1-boot-ready-datadir.md on branch claude/524-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/524-plans:docs/plans/epics/E516/524-B1-boot-ready-datadir.md
Behaviour change: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. Scratch files: task-unique names (pr-body-524B1.md, commit-msg-524B1.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds and any deviation. Do not merge. When B1's PR is open, start bundle B2 (524-B2-config-proxy-http.md) from origin/main in its own worktree without waiting for B1 to merge.
```
