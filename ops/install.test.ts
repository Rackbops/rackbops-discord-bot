// Isolated tests for ops/install.sh's resolve_deploy_identity() — the root/SUDO_UID decision
// logic issue #54 added. install.sh itself can't be spawned end-to-end here or in CI: it
// hardcodes real /opt/... paths, needs a real `sudo`, and fetches from the network. Instead, this
// dynamically extracts just resolve_deploy_identity()'s current body out of the real install.sh
// source (a regex over the live file, not a hand-copied duplicate — so editing the real function
// is what this test exercises, not a snapshot that can silently drift) and runs it in a tiny bash
// subprocess with a faked `id`. Needs bash on PATH; skips loudly (not vacuously) without one, same
// convention as ops/bot-ops.test.ts. On Windows, Git's own bash is used.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL_SH = fileURLToPath(new URL("./install.sh", import.meta.url));
const installShSource = readFileSync(INSTALL_SH, "utf8");

function extractFunction(name: string): string {
  const match = installShSource.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  if (!match) {
    throw new Error(`ops/install.sh: couldn't find a ${name}() function to extract — did it get renamed or reshaped?`);
  }
  return match[0];
}

/** Same contract as extractFunction, for a bare top-level line rather than a function body. */
function extractLine(pattern: RegExp, what: string): string {
  const match = installShSource.match(pattern);
  if (!match) {
    throw new Error(`ops/install.sh: couldn't find ${what} — did it get removed or reshaped?`);
  }
  return match[0];
}

const RESOLVE_DEPLOY_IDENTITY = extractFunction("resolve_deploy_identity");

function resolveBash(): string | null {
  if (process.platform === "win32") {
    const git = Bun.which("git");
    if (git) {
      // <Git>/mingw64/bin/git.exe or <Git>/cmd/git.exe -> <Git>/usr/bin/bash.exe
      for (const gitRoot of [join(dirname(git), "..", ".."), join(dirname(git), "..")]) {
        const candidate = join(gitRoot, "usr", "bin", "bash.exe");
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return Bun.which("bash");
}
const BASH = resolveBash();
const runnable = BASH !== null;
if (!runnable) {
  console.warn(`[install.test] SKIPPING: needs bash (${BASH ?? "missing"}) on PATH`);
}

// die() and a faked id() are hand-written, not extracted like resolve_deploy_identity() — die()
// is a stable one-line "prefix and exit" helper (identical in ops/bot-ops.sh too) and isn't
// itself under test here; id() is the fake by design. FAKE_UID/FAKE_GID are deliberately
// independent knobs (not one shared value) so a test can use DIFFERENT numbers for each — a real
// host's primary gid doesn't always equal its uid (LDAP/AD, a shared group), and a copy-paste bug
// sourcing DEPLOY_GID from `id -u` instead of `id -g` would go undetected if every test happened
// to use the same number for both. INSTANCE is set the same way install.sh's real arg-parsing
// sets it before resolve_deploy_identity ever runs (its die message references $INSTANCE) —
// without it, `set -u` below would fail on the unbound var before reaching die().
const SCRIPT = [
  "set -euo pipefail",
  "INSTANCE=probe",
  'die() { echo "install: $*" >&2; exit 1; }',
  'id() { if [ "$1" = "-u" ]; then echo "${FAKE_UID:-1000}"; else echo "${FAKE_GID:-1000}"; fi; }',
  RESOLVE_DEPLOY_IDENTITY,
  "resolve_deploy_identity",
  'echo "DEPLOY_UID=$DEPLOY_UID DEPLOY_GID=$DEPLOY_GID"',
].join("\n");

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function run(overrides: Record<string, string | undefined>): Promise<Run> {
  const env: Record<string, string | undefined> = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const proc = Bun.spawn([BASH!, "-c", SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(!runnable)(
  "install.sh's resolve_deploy_identity resolves the real deploy user, not just id -u (issue #54)",
  () => {
    test("a normal non-root user: DEPLOY_UID/GID are its own uid/gid, not one value for both", async () => {
      // uid and gid deliberately differ (1000 vs 2000) so a DEPLOY_GID="$(id -u)" copy-paste
      // bug — sourcing the group id from the USER id call — would fail this, not pass it.
      const r = await run({ FAKE_UID: "1000", FAKE_GID: "2000", SUDO_UID: undefined, SUDO_GID: undefined });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("DEPLOY_UID=1000 DEPLOY_GID=2000");
    });

    test("sudo bash install.sh (SUDO_UID and SUDO_GID both set): DEPLOY_UID/GID take those, not root's own 0", async () => {
      const r = await run({ FAKE_UID: "0", FAKE_GID: "0", SUDO_UID: "1000", SUDO_GID: "1000" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("DEPLOY_UID=1000 DEPLOY_GID=1000");
    });

    test("SUDO_UID set but SUDO_GID unset: DEPLOY_GID falls back to SUDO_UID", async () => {
      const r = await run({ FAKE_UID: "0", FAKE_GID: "0", SUDO_UID: "1000", SUDO_GID: undefined });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("DEPLOY_UID=1000 DEPLOY_GID=1000");
    });

    test("root directly with no SUDO_UID at all: refuses outright instead of deploying as root", async () => {
      const r = await run({ FAKE_UID: "0", FAKE_GID: "0", SUDO_UID: undefined, SUDO_GID: undefined });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("don't run this as root directly");
      expect(r.stdout).not.toContain("DEPLOY_UID="); // died before ever reaching that line
    });
  },
);

// ---------------------------------------------------------------------------
// The temp-file sweep (issue #60, item 3)
// ---------------------------------------------------------------------------
// Same extraction discipline as above: the trap, the cleanup function and fetch() are all pulled
// from the live install.sh, so deleting any of them there fails these tests rather than silently
// leaving them unguarded. The abort is driven by a fake `curl` that exits 22 — curl -f's own code
// for an HTTP 4xx, which is exactly what a typo'd BRANCH produces: BRANCH is only checked against
// the remote by the `no branch '$BRANCH' found` guard, which sits *after* all three `fetch` calls,
// so the very first one 404s and set -e aborts there — the validation never runs. (Cited by the
// landmark rather than a line number on purpose: an earlier revision of this comment named
// :156/:169/:171 and went stale five lines out the moment install.sh grew a comment.) Hermetic: no
// network, no /opt, no sudo.
const TMP_FILES_DECL = extractLine(/^TMP_FILES=\(\)$/m, "the TMP_FILES=() declaration");
const CLEANUP_TMP_FILES = extractFunction("cleanup_tmp_files");
const CLEANUP_TRAP = extractLine(/^trap cleanup_tmp_files EXIT$/m, "the cleanup_tmp_files EXIT trap");
const FETCH = extractFunction("fetch");

interface Sweep {
  exitCode: number;
  /** Files still named tmp.* in the destination dir — i.e. stranded temp files. */
  leftovers: number;
  /** Whether fetch() completed its mv to the real destination. */
  destExists: boolean;
}

async function runSweep(o: { withTrap: boolean; curlExit: number }): Promise<Sweep> {
  const dir = mkdtempSync(join(tmpdir(), "install-sweep-"));
  try {
    const script = [
      "set -euo pipefail",
      `cd "${dir.replaceAll("\\", "/")}"`,
      TMP_FILES_DECL,
      CLEANUP_TMP_FILES,
      // The one knob under test. Omitted, the same run must strand a file — that is what makes
      // the passing case evidence of the trap rather than of mv having already moved the file.
      o.withTrap ? CLEANUP_TRAP : "# trap deliberately omitted (mutation control)",
      // Fakes: curl is the failure injector; chown can't work on a Windows/CI checkout and isn't
      // what's under test. chmod is real — it's harmless and keeps the extracted body honest.
      `curl() { return ${o.curlExit}; }`,
      "chown() { :; }",
      'RAW_BASE="http://example.invalid"; BRANCH="typo"; DEPLOY_UID=1000; DEPLOY_GID=1000',
      FETCH,
      'fetch "docker-compose.yml" 644 "./out.yml"',
    ].join("\n");
    const proc = Bun.spawn([BASH!, "-c", script], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const entries = readdirSync(dir);
    return { exitCode, leftovers: entries.filter((f) => f.startsWith("tmp.")).length, destExists: entries.includes("out.yml") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!runnable)("install.sh sweeps its temp files when a fetch aborts the script (issue #60)", () => {
  test("a failed download strands nothing in the destination directory", async () => {
    const r = await runSweep({ withTrap: true, curlExit: 22 });
    expect(r.exitCode).not.toBe(0); // set -e propagated curl -f's 404 exit
    expect(r.destExists).toBe(false); // it never got as far as the mv
    expect(r.leftovers).toBe(0); // ...and the trap took the mktemp file with it
  });

  test("without the trap that same failure DOES strand one, so the test above isn't vacuous", async () => {
    const r = await runSweep({ withTrap: false, curlExit: 22 });
    expect(r.exitCode).not.toBe(0);
    expect(r.leftovers).toBe(1);
  });

  test("on the success path the sweep can't eat the file fetch() already moved into place", async () => {
    const r = await runSweep({ withTrap: true, curlExit: 0 });
    expect(r.exitCode).toBe(0);
    expect(r.destExists).toBe(true);
    expect(r.leftovers).toBe(0);
  });
});

// The behavioural tests above drive fetch()'s mktemp only. install.sh's other mktemp — the one for
// $STACK_DIR/.env — sits mid-function behind git ls-remote and a populated $STACK_DIR, so running
// it would cost more harness than it guards. This is the anti-rot check instead: every mktemp in
// the script must register with TMP_FILES on the very next line, and the count is pinned so the
// scan can't quietly pass by matching nothing (the failure mode that made an earlier guard of mine
// vacuous). Adding a third mktemp without registering it fails here.
//
// Comment lines are blanked before the scan: matching them would fail *closed* (a comment merely
// mentioning mktemp would redden this test), which is only maintenance friction, but it is still a
// false alarm. The match stays the bare `\bmktemp\b` rather than `mktemp -p` so that a `mktemp`
// written without -p is still required to register — narrowing the regex would SKIP such a line
// entirely, letting an unregistered one through silently. What this scan does not check is the -p
// itself: a registered `mktemp` with no -p passes here (verified), and putting the temp file in
// /tmp rather than beside its destination is a separate defect — the EXDEV one #96 fixed in
// bot-ops.sh, argued for install.sh at ops/install.sh:117-120.
const CODE_LINES = installShSource.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l));

test("every mktemp in install.sh registers its temp file for the sweep", () => {
  let checked = 0;
  CODE_LINES.forEach((line, i) => {
    if (!/\bmktemp\b/.test(line)) return;
    checked += 1;
    expect(`${i + 1}: ${CODE_LINES[i + 1] ?? "<end of file>"}`).toMatch(/TMP_FILES\+=\(/);
  });
  expect(checked).toBe(2); // fetch()'s, and the one for $STACK_DIR/.env
});

// The behavioural tests run an extracted composite, never install.sh itself, so they cannot see a
// SECOND `trap ... EXIT` added elsewhere in the script — which would silently REPLACE the sweep
// rather than run alongside it. That is not hypothetical: the sibling script does exactly that at
// ops/bot-ops.sh:579 (`trap "rm -f \"$tmp\"" EXIT` inside a function), and it is the reason this
// change registers into an array instead of trapping per-function. Pinned as an exact list so both
// directions fail — a second trap, or the sweep's own trap going missing.
test("install.sh installs exactly one EXIT trap, so nothing can silently replace the sweep", () => {
  const traps = CODE_LINES.filter((l) => /\btrap\b/.test(l) && /\bEXIT\b/.test(l)).map((l) => l.trim());
  expect(traps).toEqual(["trap cleanup_tmp_files EXIT"]);
});
