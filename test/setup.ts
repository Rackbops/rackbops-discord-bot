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

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// Sweep PREVIOUS runs' dirs before making this one, rather than removing our own on the way out:
// bun's test runner does not run `process.on("exit")` or `"beforeExit"` handlers (measured on Bun
// 1.3.14 — neither fired), so an exit hook here would be dead code claiming a cleanup that never
// happens. Sweeping on entry runs for certain and bounds accumulation at one directory.
const TEST_DATA_PREFIX = "rackbops-bot-test-data-";
for (const entry of readdirSync(tmpdir())) {
  if (entry.startsWith(TEST_DATA_PREFIX)) {
    rmSync(join(tmpdir(), entry), { recursive: true, force: true });
  }
}
process.env.BOT_DATA_DIR = mkdtempSync(join(tmpdir(), TEST_DATA_PREFIX));

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

// The two vars `config.ts` requires at import time. Kept here so the nine test files that each
// repeated them don't have to — they resolve the same singleton either way.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
