// Test preload — runs once, before any test file is imported (`bunfig.toml`'s `[test] preload`).
//
// Why a preload and not per-file priming (#139): Bun runs every test file in ONE process with ONE
// module registry, so the FIRST file to import a module is the only one whose `process.env` writes
// that module ever sees. Two files setting different values both get the first one's. Measured on
// Bun 1.3.14 — file A set /tmp/AAA, file B set /tmp/BBB, both observed /tmp/BBB. So per-file setup
// cannot work here: single-file and full runs would disagree, and one new unprimed file sorting
// first would silently revert the whole suite.
//
// `=`, not `??=`. The repo's existing env ritual uses `??=`, but an ambient BOT_DATA_DIR in a
// developer's shell — say one exported while debugging a deployment — would then silently disable
// the entire protection. Safety beats overridability for this one.

import { afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resetForTest, stateForTest } from "../src/restart";
import { restartLeakMessage, restartStateLeaks } from "./restartState";
import { isPidAlive, MAX_AGE_MS, sweepStaleTestDirs, TEST_DATA_PREFIX } from "./sweep";

// Sweep PREVIOUS runs' dirs before making this one, rather than removing our own on the way out:
// bun's test runner does not run `process.on("exit")` or `"beforeExit"` handlers (measured on Bun
// 1.3.14 — neither fired), so an exit hook here would be dead code claiming a cleanup that never
// happens. Sweeping on entry runs for certain.
//
// #252: bounded by LIVENESS AND AGE, not "at one directory" — a directory whose embedded pid is
// still alive and under an hour old is a concurrently running suite's own `BOT_DATA_DIR`, not a
// leftover, and sweeping it out from under that run (two `bun test` invocations on one machine,
// routine with several agent sessions working this repo) silently corrupted whatever it did next in
// a test that had nothing to do with the cause. See `test/sweep.ts` for the pure decision logic.
const tmp = tmpdir();
sweepStaleTestDirs({
  tmp,
  entries: readdirSync(tmp),
  now: Date.now(),
  mtimeOf: (name) => statSync(join(tmp, name)).mtimeMs,
  isAlive: isPidAlive,
  maxAgeMs: MAX_AGE_MS,
  remove: (name) => rmSync(join(tmp, name), { recursive: true, force: true }),
});
process.env.BOT_DATA_DIR = mkdtempSync(join(tmp, `${TEST_DATA_PREFIX}${process.pid}-`));

// Snapshot the checkout's real data files BEFORE anything can read or write them, so the guard
// test can prove they were left byte-identical. `null` means "absent", which is a valid snapshot
// and the important one on CI where no data/ exists: `saveStateTo` does mkdirSync + write, so a
// regression would CREATE the file, and asserting it stays absent catches that.
//
// Held on a global rather than in `process.env` deliberately: the preload shares a process with
// the tests, but `process.env` is inherited by every subprocess the suite spawns — and the
// `ops/*.test.ts` files spawn real `bash`, which rejects some values outright (a NUL-sentinel
// version of this failed exactly that way).
// Snapshots the WHOLE tree, not just state.json/handoff.json. Those two are what regressed, but
// the invariant is "the suite never touches the checkout's data/", and `links.json`,
// `characters/` and `plugins/` are equally exposed — `storage.ts` warns specifically that
// `src/plugins/*` is two hops from `data/` and is the likely site of the next wrong recompute.
// A file appearing where there was none is caught too, which is the CI case (no `data/` at all).
const repoDataDir = join(import.meta.dir, "..", "data");
const snapshots: Record<string, string | null> = {};
function snapshotTree(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) snapshotTree(p);
    else snapshots[relative(repoDataDir, p).replaceAll("\\", "/")] = readFileSync(p, "utf8");
  }
}
snapshotTree(repoDataDir);
(globalThis as { __repoDataSnapshots?: Record<string, string | null> }).__repoDataSnapshots = snapshots;

// The two vars `config.ts` requires at import time. The one place this is set (#136) -- every
// test file that transitively imports config/state used to repeat these two lines itself; all of
// them now rely on this preload instead.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";

// The restart-state guard. src/restart.ts keeps module-level state (a critical-section depth, a
// pending restart, an active handoff, ...) and every test file shares one copy of it, for the same
// one-process reason as above. A test that leaves some behind changes what every later file sees:
// #385's leaked handoff made update.test.ts's checkForUpdate answer `busy`, and only a randomized
// order ever showed it. A preload's afterEach runs after every test in every file, and after that
// file's own afterEach hooks (measured on Bun 1.4.2), so a leak fails the run whatever the order —
// on the test that leaked, except that one from an afterAll, from an afterEach that throws (Bun then
// skips this hook for that test) or from async work finishing late lands on the next test instead.
// It then resets the state, so one leak fails one test instead of every test after it.
afterEach(() => {
  const leaks = restartStateLeaks(stateForTest());
  if (leaks.length === 0) return;
  resetForTest();
  throw new Error(restartLeakMessage(leaks));
});
