// Isolated tests for ops/install.sh's resolve_deploy_identity() — the root/SUDO_UID decision
// logic issue #54 added. install.sh itself can't be spawned end-to-end here or in CI: it
// hardcodes real /opt/... paths, needs a real `sudo`, and fetches from the network. Instead, this
// dynamically extracts just resolve_deploy_identity()'s current body out of the real install.sh
// source (a regex over the live file, not a hand-copied duplicate — so editing the real function
// is what this test exercises, not a snapshot that can silently drift) and runs it in a tiny bash
// subprocess with a faked `id`. Needs bash on PATH; skips loudly (not vacuously) without one, same
// convention as ops/bot-ops.test.ts. On Windows, Git's own bash is used.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
const CHECK_INSTANCE_NAME = extractFunction("check_instance_name");

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
// #514 (posthoc-1-2): on CI a skipped suite would pass vacuously; the runner has bash, jq and docker compose, so a
// missing one there is a broken job, not an environment to tolerate. GitHub sets CI=true in every job.
if (!runnable && process.env.CI) throw new Error("[install.test] bash is required on CI; refusing to skip");
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
// for an HTTP 4xx, which is exactly what a syntactically valid but typo'd BRANCH produces: its
// *existence* is only checked by the `no branch '$BRANCH' found` guard, which sits *after* all three
// `fetch` calls, so the first one 404s and set -e aborts there. The #232 syntax guard runs earlier
// but passes a value like "typo", so it doesn't change what this fake models. (Cited by the
// landmark rather than a line number on purpose: an earlier revision of this comment named
// :156/:169/:171 and went stale five lines out the moment install.sh grew a comment.) Hermetic: no
// network, no /opt, no sudo.
const TMP_FILES_DECL = extractLine(/^TMP_FILES=\(\)$/m, "the TMP_FILES=() declaration");
const CLEANUP_TMP_FILES = extractFunction("cleanup_tmp_files");
const CLEANUP_TRAP = extractLine(/^trap cleanup_tmp_files EXIT$/m, "the cleanup_tmp_files EXIT trap");
// fetch() no longer mktemps itself (issue #230 split it into download() + a plain mv) — any
// harness that extracts fetch() now needs download() alongside it, or fetch's own body is an
// undefined-function call away from doing anything.
const DOWNLOAD = extractFunction("download");
const FETCH = extractFunction("fetch");
const SCHEMA_OF = extractFunction("schema_of");
const INSTALL_SHARED_BIN = extractFunction("install_shared_bin");

interface Sweep {
  exitCode: number;
  /** Files still named tmp.* in the destination dir — i.e. stranded temp files. */
  leftovers: number;
  /** Whether fetch() completed its mv to the real destination. */
  destExists: boolean;
  /** Every chown the run made, as the `$*` it was called with (#425: all must be DEPLOY_UID:DEPLOY_GID = 4242:4343). */
  chownCalls: string[];
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
      // what's under test here. chmod is real — it's harmless and keeps the extracted body honest.
      // #425: chown is a RECORDER, not a no-op, and the ids are distinctive, so a chown to anything but
      // DEPLOY_UID:DEPLOY_GID (e.g. the running process's own ids) is visible to the E2 assertions below.
      `curl() { return ${o.curlExit}; }`,
      'chown() { echo "$*" >> chown.log; }',
      'RAW_BASE="http://example.invalid"; BRANCH="typo"; DEPLOY_UID=4242; DEPLOY_GID=4343',
      DOWNLOAD,
      FETCH,
      'fetch "docker-compose.yml" 644 "./out.yml"',
    ].join("\n");
    const proc = Bun.spawn([BASH!, "-c", script], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    const entries = readdirSync(dir);
    const chownCalls = entries.includes("chown.log") ? readFileSync(join(dir, "chown.log"), "utf8").trim().split("\n").filter(Boolean) : [];
    return { exitCode, leftovers: entries.filter((f) => f.startsWith("tmp.")).length, destExists: entries.includes("out.yml"), chownCalls };
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

  // #425 (E2 a): download()'s chown. A run that gets past curl chowns the temp file to the DEPLOY ids; a run
  // that dies in curl (exit 22) never reaches it, so the log is empty rather than wrong.
  test("download() chowns the file it fetched to DEPLOY_UID:DEPLOY_GID, not to the process's own ids (#425)", async () => {
    const r = await runSweep({ withTrap: true, curlExit: 0 });
    expect(r.chownCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of r.chownCalls) expect(c.startsWith("4242:4343 ")).toBe(true);
    const failed = await runSweep({ withTrap: true, curlExit: 22 });
    expect(failed.chownCalls).toEqual([]);
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
// bot-ops.sh, argued for install.sh at ops/install.sh:147-151.
const CODE_LINES = installShSource.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l));

// The registration must name the SAME variable the mktemp assigned. Requiring only "some
// TMP_FILES+= on the next line" is not enough, and the failure it misses is severe rather than
// cosmetic: registering `TMP_FILES+=("$CONFIG_DIR/.env")` next to a mktemp both strands the temp
// file AND makes the EXIT trap `rm -f` the instance's live secrets .env. That is a plausible
// copy-paste slip when adding a third mktemp, and it passed this scan before.
test("every mktemp in install.sh registers the temp file it just assigned", () => {
  let checked = 0;
  CODE_LINES.forEach((line, i) => {
    if (!/\bmktemp\b/.test(line)) return;
    checked += 1;
    // The variable this mktemp assigns to, e.g. `tmp` in `tmp="$(mktemp -p ...)"`.
    const assigned = line.match(/^\s*(?:local\s+)?([A-Za-z_][A-Za-z0-9_]*)=/)?.[1];
    const where = `install.sh:${i + 1} (${line.trim()})`;
    expect(assigned ?? `<no assignment at ${where}>`).toMatch(/^[A-Za-z_]/);
    expect(`${where} -> ${(CODE_LINES[i + 1] ?? "<end of file>").trim()}`).toBe(
      `${where} -> TMP_FILES+=("$${assigned}")`,
    );
  });
  expect(checked).toBe(2); // fetch()'s, and the one for $STACK_DIR/.env
});

// The scan above only looks forward from each mktemp, so a TMP_FILES+= written ANYWHERE ELSE was
// invisible to it. That is the more dangerous direction, and the more plausible spelling: adding
// `TMP_FILES+=("$dest")` beside an `mv` ("clean this up if we abort") registers a file that is
// meant to survive, and the EXIT trap then rm -f's it on every single run — the freshly installed
// compose file, bin/bot-ops.sh, or the instance's live secrets .env. Reproduced against the real
// cleanup_tmp_files body: a .env holding DISCORD_TOKEN was gone after a clean exit 0.
// So: every registration must also point back at an immediately preceding mktemp of that same
// variable. Together the two scans make the mktemp/registration pairing bidirectional.
test("every TMP_FILES registration in install.sh belongs to the mktemp right above it", () => {
  let checked = 0;
  CODE_LINES.forEach((line, i) => {
    const registered = line.match(/^\s*TMP_FILES\+=\("\$([A-Za-z_][A-Za-z0-9_]*)"\)\s*$/)?.[1];
    if (!/TMP_FILES\+=/.test(line)) return;
    checked += 1;
    const where = `install.sh:${i + 1} (${line.trim()})`;
    // Rejects a registration of anything but a bare "$VAR" — e.g. TMP_FILES+=("$CONFIG_DIR/.env").
    expect(registered ?? `<not a bare variable registration at ${where}>`).toMatch(/^[A-Za-z_]/);
    const prev = CODE_LINES[i - 1] ?? "<start of file>";
    expect(`${where} <- ${prev.trim()}`).toMatch(
      new RegExp(`<- .*\\b${registered}="\\$\\(mktemp\\b`),
    );
  });
  expect(checked).toBe(2); // exactly the two registrations the scan above accounts for
});

// The behavioural tests run an extracted composite, never install.sh itself, so they cannot see a
// SECOND `trap ... EXIT` added elsewhere in the script — which would silently REPLACE the sweep
// rather than run alongside it. That is not hypothetical: the sibling script does exactly that at
// ops/bot-ops.sh:579 (`trap "rm -f \"$tmp\"" EXIT` inside a function), and it is the reason this
// change registers into an array instead of trapping per-function. Pinned as an exact list so both
// directions fail — a second trap, or the sweep's own trap going missing.
//
// Matched on `trap` alone — NOT on the word EXIT, and NOT anchored to the start of the line.
// Both narrowings were tried and both were defeated:
//   - /\bEXIT\b/ misses `trap ':' 0`, because bash signal 0 *is* EXIT.
//   - /^\s*trap/ misses `[ -z "${KEEP_TMP:-}" ] || trap ':' 0`, and (a regression on the first
//     version) also misses a mid-line `|| trap ... EXIT` that the EXIT match would have caught.
// Verified, including that a trap set inside a function replaces it too — traps are process-global:
//   bash -c 'c(){ echo SWEEP; }; trap c EXIT; [ -n "$HOME" ] && trap ":" 0; echo body' -> body
//   bash -c 'c(){ echo SWEEP; }; trap c EXIT; f(){ trap ":" 0; }; f;        echo body' -> body
//   bash -c 'c(){ echo SWEEP; }; trap c EXIT;                              echo body' -> body SWEEP
// Listing every trap regardless of signal or position also means a future ERR/INT trap surfaces
// here to be considered rather than slipping in unnoticed. Comment lines are already blanked, and
// no non-comment line in either script contains the word otherwise, so it stays non-vacuous.
test("install.sh installs exactly one trap, so nothing can silently replace the sweep", () => {
  const traps = CODE_LINES.filter((l) => /\btrap\b/.test(l)).map((l) => l.trim());
  expect(traps).toEqual(["trap cleanup_tmp_files EXIT"]);
});

// ---------------------------------------------------------------------------
// validate_stack_env (issue #169) — the "render validates and fails loudly naming the exact
// field" half of the personal one-answer-file rule, applied to the generated stack .env.
// ---------------------------------------------------------------------------
const VALIDATE_STACK_ENV = extractFunction("validate_stack_env");

// validate_stack_env's absolute-path check is deliberately POSIX-only (`[[ == /* ]]`) — the real
// script only ever runs on a Linux host (install.sh's own header: git/curl/docker, no Windows
// target). On this Windows dev box, `mkdtempSync` returns a Windows-style `C:\Users\...` path,
// which correctly does NOT start with `/` and would wrongly fail the "valid file" test case too.
// Git Bash's own runtime (msys-2.0.dll) transparently resolves the MSYS form `/c/Users/...` for
// real filesystem syscalls, including `[ -d ]`, so that form is both POSIX-absolute (passes the
// check) and a real, `stat`-able path (works for the existence check) under the same BASH this
// harness already resolved via resolveBash(). A no-op on a real POSIX path (CI/Linux).
function toMsysPath(p: string): string {
  const m = p.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return p.replaceAll("\\", "/");
  return `/${m[1]!.toLowerCase()}/${m[2]!.replaceAll("\\", "/")}`;
}

async function runValidate(fileLines: string[]): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "install-validate-"));
  try {
    const file = join(dir, "stack.env");
    writeFileSync(file, fileLines.join("\n") + "\n");
    const script = ['set -euo pipefail', 'die() { echo "install: $*" >&2; exit 1; }', VALIDATE_STACK_ENV, 'validate_stack_env "$1"', 'echo VALID'].join(
      "\n",
    );
    const proc = Bun.spawn([BASH!, "-c", script, "_", file], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A shape matching what install.sh's own STACKENV heredoc actually writes (install.sh:339-347),
// with BOT_OPS_CONFIG_DIR pointed at a REAL directory (validDir) so the base case is genuinely
// valid end to end, not just absolute-looking.
function validStackEnv(validDir: string): string[] {
  const dir = toMsysPath(validDir);
  return [
    `BOT_ENV_FILE=${dir}/.env`,
    "BOT_OPS_CONTAINER=probe",
    "BOT_OPS_PROJECT=probe",
    `BOT_OPS_CONFIG_DIR=${dir}`,
    `BOT_OPS_COMPOSE_FILE=${dir}/docker-compose.yml`,
    "BOT_BUILD_CONTEXT=https://example.invalid/repo.git#main",
    "GIT_SHA=deadbeef",
  ];
}

describe.skipIf(!runnable)("install.sh's validate_stack_env catches a bad render, naming the field (#169)", () => {
  test("a well-formed generated file (matching the real STACKENV shape) passes", async () => {
    const validDir = mkdtempSync(join(tmpdir(), "install-validate-configdir-"));
    try {
      const r = await runValidate(validStackEnv(validDir));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("VALID");
    } finally {
      rmSync(validDir, { recursive: true, force: true });
    }
  });

  test("a relative BOT_ENV_FILE is rejected, naming BOT_ENV_FILE and the bad value", async () => {
    const validDir = mkdtempSync(join(tmpdir(), "install-validate-configdir-"));
    try {
      const lines = validStackEnv(validDir).map((l) => (l.startsWith("BOT_ENV_FILE=") ? "BOT_ENV_FILE=relative/secrets.env" : l));
      const r = await runValidate(lines);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('install: BOT_ENV_FILE must be an absolute path, got "relative/secrets.env"');
      expect(r.stdout).not.toContain("VALID");
    } finally {
      rmSync(validDir, { recursive: true, force: true });
    }
  });

  test("a relative BOT_OPS_COMPOSE_FILE is rejected, naming BOT_OPS_COMPOSE_FILE", async () => {
    const validDir = mkdtempSync(join(tmpdir(), "install-validate-configdir-"));
    try {
      const lines = validStackEnv(validDir).map((l) =>
        l.startsWith("BOT_OPS_COMPOSE_FILE=") ? "BOT_OPS_COMPOSE_FILE=relative/docker-compose.yml" : l,
      );
      const r = await runValidate(lines);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('install: BOT_OPS_COMPOSE_FILE must be an absolute path, got "relative/docker-compose.yml"');
    } finally {
      rmSync(validDir, { recursive: true, force: true });
    }
  });

  test("a relative BOT_OPS_CONFIG_DIR is rejected as non-absolute BEFORE the existence check ever runs", async () => {
    const validDir = mkdtempSync(join(tmpdir(), "install-validate-configdir-"));
    try {
      const lines = validStackEnv(validDir).map((l) => (l.startsWith("BOT_OPS_CONFIG_DIR=") ? "BOT_OPS_CONFIG_DIR=relative/dir" : l));
      const r = await runValidate(lines);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('install: BOT_OPS_CONFIG_DIR must be an absolute path, got "relative/dir"');
      expect(r.stderr).not.toContain("does not exist"); // died on the absolute-path check, never reached the existence one
    } finally {
      rmSync(validDir, { recursive: true, force: true });
    }
  });

  test("an absolute but missing BOT_OPS_CONFIG_DIR is rejected as not existing", async () => {
    const validDir = mkdtempSync(join(tmpdir(), "install-validate-configdir-"));
    try {
      const missing = toMsysPath(join(validDir, "does-not-exist-really"));
      const lines = validStackEnv(validDir).map((l) => (l.startsWith("BOT_OPS_CONFIG_DIR=") ? `BOT_OPS_CONFIG_DIR=${missing}` : l));
      const r = await runValidate(lines);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("install: BOT_OPS_CONFIG_DIR does not exist");
    } finally {
      rmSync(validDir, { recursive: true, force: true });
    }
  });

  // #486 item 2 (E3): a missing key line made the bare grep exit 1 under pipefail and the script ended with no
  // message at all. Each of the three keys, dropped in turn, must exit non-zero AND name itself.
  for (const key of ["BOT_ENV_FILE", "BOT_OPS_CONFIG_DIR", "BOT_OPS_COMPOSE_FILE"]) {
    test(`a stack .env with no ${key} line is rejected, naming ${key} (not a silent exit)`, async () => {
      const validDir = mkdtempSync(join(tmpdir(), "install-validate-configdir-"));
      try {
        const lines = validStackEnv(validDir).filter((l) => !l.startsWith(`${key}=`));
        const r = await runValidate(lines);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toContain(`install: ${key} is missing from`);
        expect(r.stdout).not.toContain("VALID");
      } finally {
        rmSync(validDir, { recursive: true, force: true });
      }
    });
  }

  test("an empty value (KEY=) reads as missing too", async () => {
    const validDir = mkdtempSync(join(tmpdir(), "install-validate-configdir-"));
    try {
      const lines = validStackEnv(validDir).map((l) => (l.startsWith("BOT_ENV_FILE=") ? "BOT_ENV_FILE=" : l));
      const r = await runValidate(lines);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("install: BOT_ENV_FILE is missing from");
    } finally {
      rmSync(validDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The CALL SITE (issue #169) — every test above only proves validate_stack_env works correctly in
// isolation; none of them would notice if main() stopped calling it at all. Extracted as a
// CONTIGUOUS SOURCE SLICE (not a function pulled by name) spanning from the STACKENV mktemp
// through the "wrote $STACK_DIR/.env" echo, so a future edit that removes the call — while leaving
// the function definition intact — shrinks THIS extraction too and is caught here, unlike a
// by-name function extraction which would keep passing against an orphaned, never-called function.
// ---------------------------------------------------------------------------
const STACK_ENV_WRITE_SEQUENCE = extractLine(
  /^ {2}STACK_ENV_TMP="\$\(mktemp -p "\$STACK_DIR"\)"[\s\S]*?\n {2}echo "install: wrote \$STACK_DIR\/\.env \(Dockge's own interpolation source — see ops\/README\.md\)"$/m,
  "the stack .env write-then-validate sequence (STACK_ENV_TMP mktemp through the wrote-echo)",
);

async function runWriteSequence(configDir: string | null): Promise<Run> {
  const stackDir = mkdtempSync(join(tmpdir(), "install-callsite-stack-"));
  try {
    const script = [
      "set -euo pipefail",
      `STACK_DIR="${toMsysPath(stackDir)}"`,
      `CONFIG_DIR="${configDir ?? "relative-config-dir-not-absolute"}"`,
      "PROJECT=probe",
      'REPO_URL="https://example.invalid/repo.git"',
      "BRANCH=main",
      "GIT_SHA=deadbeef",
      "DEPLOY_UID=4242",
      "DEPLOY_GID=4343",
      "TMP_FILES=()",
      // real chown needs privileges/semantics this harness doesn't have or need; #425: it records instead, as CHOWN:<args>
      'chown() { echo "CHOWN:$*"; }',
      'die() { echo "install: $*" >&2; exit 1; }',
      VALIDATE_STACK_ENV,
      STACK_ENV_WRITE_SEQUENCE,
      'echo POST_VALIDATE_OK', // proves execution actually reached past the extracted slice
    ].join("\n");
    const proc = Bun.spawn([BASH!, "-c", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    rmSync(stackDir, { recursive: true, force: true });
  }
}

describe.skipIf(!runnable)("validate_stack_env is actually wired into the real write sequence, not just callable in isolation (#169)", () => {
  test("a real CONFIG_DIR: the sequence writes the file, validates it, and execution continues past it", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "install-callsite-config-"));
    try {
      const r = await runWriteSequence(toMsysPath(configDir));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("install: wrote");
      expect(r.stdout).toContain("POST_VALIDATE_OK");
      // #425 (E2 a): the stack .env is chowned to the DEPLOY ids, on the final path
      expect(r.stdout).toMatch(/^CHOWN:4242:4343 \S+\/\.env$/m);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a non-absolute CONFIG_DIR (so BOT_ENV_FILE is non-absolute): the real sequence dies naming BOT_ENV_FILE before its own wrote-echo or anything after it", async () => {
    const r = await runWriteSequence(null); // relative CONFIG_DIR, not mkdtempSync'd — deliberately bad
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("install: BOT_ENV_FILE must be an absolute path");
    // Neither this slice's own success echo NOR anything after the extracted slice ran — proves
    // validate_stack_env's real call site position, not an assumption about it.
    expect(r.stdout).not.toContain("install: wrote");
    expect(r.stdout).not.toContain("POST_VALIDATE_OK");
  });
});

// ---------------------------------------------------------------------------
// The printed "next steps" block (issue #169) — proves the RENDERED output, not just the source
// text, since a probe grepping install.sh's literal lines could pass while the actual printed
// output still carried the old prefixes via some other path (a second, unnoticed copy). Extracted
// as a heredoc block (not a function — main()'s final `cat <<EOF ... EOF`), fed the same variable
// names install.sh's own main() resolves before reaching it, and run standalone.
// ---------------------------------------------------------------------------
const NEXT_STEPS_BLOCK = extractLine(/^  cat <<EOF[\s\S]*?\n^EOF$/m, "the printed next-steps heredoc block");

async function renderNextSteps(): Promise<string> {
  const script = [
    "set -euo pipefail",
    "INSTANCE=debug",
    "CONFIG_DIR=/opt/rackbops-discord-bot/debug",
    "BIN_DIR=/opt/rackbops-discord-bot/bin",
    "STACK_DIR=/opt/stacks/rackbops-discord-bot-debug",
    "PROJECT=rackbops-discord-bot-debug",
    "BRANCH=main",
    "GIT_SHA=deadbeefcafefeed",
    'REPO_URL="https://github.com/Rackbops/rackbops-discord-bot.git"',
    NEXT_STEPS_BLOCK,
  ].join("\n");
  // The script goes in on stdin (`bash -s`), not as a `-c` argument: on Windows Bun's argv quoting halves every `\`
  // in a `-c` argument, which spliced the heredoc's `\` continuations and misled an old NOTE here into blaming bash
  // itself (#486 item 8). stdin carries the script byte for byte on both platforms.
  const proc = Bun.spawn([BASH!, "-s"], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(exitCode).toBe(0);
  return stdout;
}

describe.skipIf(!runnable)("install.sh's printed step 2 no longer carries the four now-redundant prefix vars (#169)", () => {
  test("step 2's own block has no GIT_SHA=/BOT_ENV_FILE=/BOT_BUILD_CONTEXT=/BOT_OPS_CONTAINER= prefix lines, but step 3's block still does", async () => {
    const out = await renderNextSteps();
    const step2 = out.slice(out.indexOf("2. Bring it up"), out.indexOf("3. Day-2 ops"));
    for (const prefix of ["GIT_SHA=", "BOT_ENV_FILE=", "BOT_BUILD_CONTEXT=", "BOT_OPS_CONTAINER="]) {
      expect(step2).not.toContain(prefix);
    }
    expect(step2).toContain("docker compose -f /opt/stacks/rackbops-discord-bot-debug/docker-compose.yml -p rackbops-discord-bot-debug up -d --build");
    // Not vacuous: step 3 (bot-ops.sh — a plain script, not Compose, so it has no auto-.env-load
    // to lean on) is untouched by #169 and must still carry its own prefix vars. The source writes `\` before each
    // newline; an unquoted heredoc prints that as ONE backslash and keeps the newline, so the continuations stay
    // multi-line (N2 below asserts every one). The splice an earlier NOTE here described was Windows argv halving
    // under `bash -c`, fixed by feeding the script on stdin.
    const step3 = out.slice(out.indexOf("3. Day-2 ops"), out.indexOf("4. Optional"));
    expect(step3).toContain("BOT_OPS_CONTAINER=rackbops-discord-bot-debug");
  });

  // #486 item 8: every continuation of step 3's command prints as ` \` + newline, not spliced onto one line.
  test("N2: each of step 3's four prefix lines ends with a backslash continuation, and steps 4 and 5 keep theirs", async () => {
    const out = await renderNextSteps();
    const step3 = out.slice(out.indexOf("3. Day-2 ops"), out.indexOf("4. Optional"));
    const lines3 = step3.split("\n");
    for (const key of ["BOT_OPS_CONFIG_DIR=", "BOT_OPS_COMPOSE_FILE=", "BOT_OPS_PROJECT=", "BOT_OPS_CONTAINER="]) {
      const line = lines3.find((l) => l.trimStart().startsWith(key));
      expect(line, key).toBeDefined();
      expect(line!.endsWith(" \\"), `${key} line ends with a continuation`).toBe(true);
    }
    const step4 = out.slice(out.indexOf("4. Optional"), out.indexOf("5. Optional"));
    const step5 = out.slice(out.indexOf("5. Optional"));
    for (const [name, step] of [["step 4", step4], ["step 5", step5]] as const) {
      const lines = step.split("\n");
      expect(lines.some((l, n) => l.endsWith(" \\") && (lines[n + 1] ?? "").startsWith(" ")), `${name} keeps a continued line`).toBe(true);
    }
  });

  // #422: the printed tunnel step names the cloudflared service and passes --no-deps, so it can never build,
  // start or recreate the bot (cloudflared's depends_on would otherwise pull it in).
  test("N1: step 5 starts cloudflared with --no-deps and never builds; step 4 still ends up -d --build admin", async () => {
    const out = await renderNextSteps();
    const step4 = out.slice(out.indexOf("4. Optional"), out.indexOf("5. Optional"));
    const step5 = out.slice(out.indexOf("5. Optional"));
    expect(step5).toContain("--profile tunnel up -d --no-deps cloudflared");
    expect(step5).not.toContain("--build");
    expect(step4.trimEnd().endsWith("up -d --build admin")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The branch-argument guard (issue #232)
// ---------------------------------------------------------------------------
// install.sh interpolates BRANCH straight into fetch()'s raw.githubusercontent.com URL, and curl
// collapses `../` path segments per RFC 3986 before sending — so an unvalidated `../`-bearing branch
// climbs out of this repo's path prefix and fetches a FOREIGN bot-ops.sh (host-root, mode 755) and
// compose file before the `git ls-remote` existence check ever runs. The fix validates BRANCH up
// front, before the first fetch. Two guards, two tests: the predicate itself, and its POSITION
// (that a bad branch reaches no fetch at all — the issue's literal ask, "bot-ops.sh untouched").

// ---- The predicate, extracted as the two live lines (removing either fails the extract loudly) ---
const BRANCH_GUARD_LINES = extractLine(
  /^ {2}\[\[ "\$BRANCH" =~ [^\n]*\]\] \|\| die [^\n]*\n {2}\[\[ "\$BRANCH" != \*\.\.\* \]\] \|\| die [^\n]*$/m,
  "the two BRANCH validation lines",
);

async function runBranchPredicate(branch: string): Promise<Run> {
  // BRANCH is passed as $1 (never interpolated into the script text), so a hostile value like
  // "a;rm" is data under test, not something the harness itself could execute.
  const script = ["set -euo pipefail", 'die() { echo "install: $*" >&2; exit 1; }', 'BRANCH="$1"', BRANCH_GUARD_LINES, "echo OK"].join(
    "\n",
  );
  const proc = Bun.spawn([BASH!, "-c", script, "_", branch], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(!runnable)("install.sh's BRANCH guard accepts real branch names and rejects malformed ones (issue #232)", () => {
  // Legit git refs the fix must NOT break — dots, slashes, hyphens, underscores are all valid.
  for (const good of ["main", "claude/fix-232", "release/1.2.3", "a.b.c/d-e_f"]) {
    test(`accepts ${JSON.stringify(good)}`, async () => {
      const r = await runBranchPredicate(good);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("OK");
    });
  }
  // The traversal payload plus its two failure classes: a bare `..` (caught only by the *..* line,
  // not the char class, which permits both `.` and `/`) and a non-`..` bad char (caught only by the
  // char class). Deleting either guard line lets its case through — that is the mutation coverage.
  for (const bad of ["../../torvalds/linux/master", "foo..bar", "foo bar", "a;rm -rf x"]) {
    test(`rejects ${JSON.stringify(bad)}`, async () => {
      const r = await runBranchPredicate(bad);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("bad branch name");
      expect(r.stdout).not.toContain("OK");
    });
  }
  // The `{1,100}` upper bound (matched byte-for-byte to bot-ops.sh's BOT_BRANCH regex) pinned on
  // both edges, so narrowing the bound reddens the accept case and removing it (e.g. `+`) reddens
  // the reject case — otherwise the length is asserted but unguarded (found in the #232 review).
  test("accepts a 100-char all-valid branch (the bound's upper edge)", async () => {
    const r = await runBranchPredicate("a".repeat(100));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OK");
  });
  test("rejects a 101-char branch (one past the bound), even though every char is allowed", async () => {
    const r = await runBranchPredicate("a".repeat(101));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("bad branch name");
    expect(r.stdout).not.toContain("OK");
  });
});

// ---- The POSITION: a bad branch must die before ANY fetch (nothing lands on disk) ----------------
// Extracted as a CONTIGUOUS SLICE from arg-parsing through the bot-ops.sh fetch — the same
// discipline as STACK_ENV_WRITE_SEQUENCE above. A regression that MOVED the guard below the fetches
// (leaving the predicate itself intact, so the tests above would still pass) shrinks nothing here
// but makes a `..` branch reach the recording fetch — caught. Every side-effecting call the slice
// makes is stubbed; the recording `fetch` reports the `src` of each download it was asked to do.
// Re-anchored on install_shared_bin's call site (issue #230 replaced the bare
// `fetch "ops/bot-ops.sh" 755 "$BIN_DIR/bot-ops.sh"` line with a call to install_shared_bin) — the
// slice still ends at the same logical point, immediately before the compose-file fetch.
const BRANCH_GUARD_TO_FETCH = extractLine(
  /^ {2}INSTANCE="\$\{1:-\}"[\s\S]*?^ {2}install_shared_bin$/m,
  "the arg-parse-through-install_shared_bin slice",
);

interface FetchProbe {
  exitCode: number;
  /** The `src` argument of every fetch() the slice actually reached, in order. */
  fetches: string[];
  reachedEnd: boolean;
  stderr: string;
  /** FORCE_BIN as the slice's own arg-parsing left it — undefined if the slice died before
   *  reaching the trailing echo that reports it (issue #295's usage-error cases). */
  forceBin: string | undefined;
}

// thirdArg is optional (undefined) rather than "" — install.sh's own "${3:-}" default only ever
// sees a truly ABSENT $3 when this harness passes exactly two args, matching how a real
// `install.sh <instance> [branch]` invocation (no third word at all) looks from inside the script.
async function runBranchGate(branch: string, thirdArg?: string): Promise<FetchProbe> {
  const script = [
    "set -euo pipefail",
    'die() { echo "install: $*" >&2; exit 1; }',
    "need() { :; }",
    "resolve_deploy_identity() { DEPLOY_UID=1000; DEPLOY_GID=1000; }",
    "check_instance_name() { :; }", // #567: the slice calls it; unstubbed it is a 127 that fails the four tests below for the wrong reason
    "bootstrap_dir() { :; }", // E2 (#425) pins bootstrap_dir's and the chowns' ids; this harness's job is the branch guard
    "mkdir() { :; }", // stubbed: the real one would try to mkdir /opt/... without privileges
    "chown() { :; }",
    "sed() { :; }", // stubbed: the real ADMIN_TOKEN rewrite targets a file that doesn't exist here
    "random_token() { echo faketoken; }",
    'fetch() { echo "FETCH:$1"; }', // the probe: records each download's src instead of doing it
    'download() { echo "FETCH:$1"; DOWNLOADED=/dev/null; }', // #486: the .env block now downloads, patches, then moves
    "mv() { :; }",
    'install_shared_bin() { echo "FETCH:ops/bot-ops.sh"; }', // same probe shape, for the #230 call site
    BRANCH_GUARD_TO_FETCH,
    'echo "REACHED_END"',
    'echo "FORCE_BIN=$FORCE_BIN"', // issue #295: report what the slice's own arg-parsing decided
  ].join("\n");
  // $1 = INSTANCE (a valid name so its own guard passes), $2 = the BRANCH under test, $3 = the
  // optional third argument (issue #295's --force-bin-in-branch-position cases).
  const args = thirdArg !== undefined ? ["_", "probe", branch, thirdArg] : ["_", "probe", branch];
  const proc = Bun.spawn([BASH!, "-c", script, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    fetches: stdout.split("\n").filter((l) => l.startsWith("FETCH:")).map((l) => l.slice("FETCH:".length)),
    reachedEnd: stdout.includes("REACHED_END"),
    stderr,
    forceBin: /^FORCE_BIN=(\d)$/m.exec(stdout)?.[1],
  };
}

describe.skipIf(!runnable)("install.sh's BRANCH guard runs before the fetches, so a crafted branch writes nothing (issue #232)", () => {
  test("the traversal payload dies before any fetch — bot-ops.sh is never fetched", async () => {
    const r = await runBranchGate("../../torvalds/linux/master");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("bad branch name");
    expect(r.fetches).toEqual([]); // nothing downloaded — the foreign bot-ops.sh never lands
    expect(r.reachedEnd).toBe(false);
  });

  test("a non-`..` malformed branch (a space) also dies before any fetch", async () => {
    const r = await runBranchGate("foo bar");
    expect(r.exitCode).not.toBe(0);
    expect(r.fetches).toEqual([]);
  });

  // Non-vacuous control: a valid branch runs RIGHT THROUGH the guard to the bot-ops.sh fetch. Proven
  // against the pre-fix source too — there, the traversal payload reached this same fetch identically
  // to `main`, which is exactly the vulnerability this test now pins shut.
  test("a valid branch passes the guard and reaches the bot-ops.sh fetch", async () => {
    const r = await runBranchGate("main");
    expect(r.exitCode).toBe(0);
    expect(r.fetches).toContain(".env.example");
    expect(r.fetches).toContain("ops/bot-ops.sh");
    expect(r.reachedEnd).toBe(true);
  });

  test("a valid non-trivial branch (slashes, digits, hyphens) is accepted too", async () => {
    const r = await runBranchGate("claude/fix-232");
    expect(r.exitCode).toBe(0);
    expect(r.fetches).toContain("ops/bot-ops.sh");
  });
});

// ---------------------------------------------------------------------------
// install.sh's second argument cannot start with '-' (issue #295)
// ---------------------------------------------------------------------------
// Follow-up from #291's review gate: `install.sh debug --force-bin` (branch omitted) used to read
// `--force-bin` as BRANCH -- it passes the #232 char-class regex (which permits '-'), reaches the
// first fetch, and only dies on curl's own 404 against .../--force-bin/..., well after other setup
// and with no real diagnostic. The fix dies immediately, before any fetch, on a second argument
// that starts with '-'. Reuses runBranchGate/BRANCH_GUARD_TO_FETCH above (the new check sits inside
// that same slice), so a regression here shows up the same way #232's does: a fetch the guard
// should have prevented.
describe.skipIf(!runnable)("install.sh's second argument cannot start with '-' (issue #295)", () => {
  test("--force-bin in the branch position (branch omitted) dies before any fetch, naming the usage message", async () => {
    const r = await runBranchGate("--force-bin");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(
      "usage: install.sh <instance> [branch] [--force-bin] ('--force-bin' needs a branch; from main it changes nothing)",
    );
    expect(r.fetches).toEqual([]); // nothing downloaded
    expect(r.reachedEnd).toBe(false);
  });

  // Non-vacuous control: --force-bin as the THIRD argument (branch given) is unaffected -- it is
  // exactly what the usage line documents, and must still reach install_shared_bin with FORCE_BIN=1.
  test("main --force-bin (branch given) still reaches install_shared_bin, with FORCE_BIN=1", async () => {
    const r = await runBranchGate("main", "--force-bin");
    expect(r.exitCode).toBe(0);
    expect(r.fetches).toContain("ops/bot-ops.sh");
    expect(r.reachedEnd).toBe(true);
    expect(r.forceBin).toBe("1");
  });

  // Second non-vacuous control: an ordinary branch with no third argument at all still works exactly
  // as before -- this check must not fire on the common case.
  test("a plain branch with no third argument is unaffected, FORCE_BIN stays 0", async () => {
    const r = await runBranchGate("feature-x");
    expect(r.exitCode).toBe(0);
    expect(r.fetches).toContain("ops/bot-ops.sh");
    expect(r.reachedEnd).toBe(true);
    expect(r.forceBin).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// install.sh's third argument (issue #230)
// ---------------------------------------------------------------------------
// Extracted as a contiguous slice (BRANCH="${2:-main}" through esac) rather than a named
// function, same discipline as STACK_ENV_WRITE_SEQUENCE/BRANCH_GUARD_TO_FETCH above — main()'s
// arg-parsing has no function of its own to pull by name.
const ARG_PARSE_LINES = extractLine(
  /^ {2}BRANCH="\$\{2:-main\}"[\s\S]*?\n {2}esac$/m,
  "the BRANCH/FORCE_BIN argument-parse lines",
);

async function runArgParse(branch: string, thirdArg?: string): Promise<Run> {
  const script = [
    "set -euo pipefail",
    'die() { echo "install: $*" >&2; exit 1; }',
    ARG_PARSE_LINES,
    'echo "OK FORCE_BIN=$FORCE_BIN"',
  ].join("\n");
  // $1 = INSTANCE (unused by this slice), $2 = BRANCH, $3 = the argument under test.
  const args = thirdArg !== undefined ? ["_", "probe", branch, thirdArg] : ["_", "probe", branch];
  const proc = Bun.spawn([BASH!, "-c", script, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(!runnable)("install.sh's third argument (issue #230)", () => {
  test("a third argument is --force-bin or a usage error; --force-bin sets FORCE_BIN", async () => {
    const noThird = await runArgParse("main");
    expect(noThird.exitCode).toBe(0);
    expect(noThird.stdout).toContain("FORCE_BIN=0");

    const forced = await runArgParse("main", "--force-bin");
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("FORCE_BIN=1");

    const bad = await runArgParse("main", "--frobnicate");
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("--force-bin");
    expect(bad.stdout).not.toContain("FORCE_BIN=");
  });
});

// ---------------------------------------------------------------------------
// install_shared_bin (issue #230) — bin/bot-ops.sh is shared by every instance on the host, so a
// per-instance branch must not silently replace it with content main wouldn't have installed.
// ---------------------------------------------------------------------------
interface SharedBinRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** dest's content after the run, or null if dest was never (successfully) written. */
  destContent: string | null;
  /** Files still named tmp.* in BIN_DIR after the run — i.e. stranded temp files. */
  leftovers: number;
  /** The URL curl was invoked with, in call order — one entry per download() call reached. */
  curlLog: string[];
  /** The forward-slash BIN_DIR this run used, so a test can assert the dest path by name. */
  binDir: string;
  /** Every chown the run made, as the `$*` it was called with (#425: all must be 4242:4343). */
  chownCalls: string[];
}

async function runSharedBin(o: {
  branch: string;
  forceBin?: boolean;
  /** Pre-existing content at dest before the run, so a refusal's "untouched" claim is checked
   *  against something other than "the file never existed". */
  installed?: string;
  /** The bot-ops.sh content the fake curl serves for a given branch (called with "main" and, if
   *  different, the branch under test). */
  contentFor: (branch: string) => string;
  /** false reproduces the #60 sweep-control idiom: omit the trap and the same failure strands
   *  its temp files instead of them being swept, proving test 4 (with the trap) isn't vacuous. */
  withTrap?: boolean;
}): Promise<SharedBinRun> {
  const dir = mkdtempSync(join(tmpdir(), "install-sharedbin-"));
  // Forward-slash form only (not the full toMsysPath drive-letter rewrite) — same as runSweep's
  // own `cd "${dir.replaceAll("\\", "/")}"` above; nothing here is checked with `[[ == /* ]]`,
  // which is the only reason toMsysPath's fuller rewrite exists elsewhere in this file.
  const binDir = dir.replaceAll(/\\/g, "/");
  try {
    const dest = join(dir, "bot-ops.sh");
    if (o.installed !== undefined) writeFileSync(dest, o.installed);
    const curlLogFile = join(dir, "curl.log").replaceAll(/\\/g, "/");
    const escape = (s: string) => s.replaceAll("'", "'\\''");
    const mainContent = escape(o.contentFor("main"));
    const branchContent = escape(o.contentFor(o.branch));
    const withTrap = o.withTrap ?? true;
    const fakeCurl = [
      "curl() {",
      '  local url="$2" out="$4"',
      `  echo "$url" >> "${curlLogFile}"`,
      '  case "$url" in',
      `    */main/*) printf '%s' '${mainContent}' > "$out" ;;`,
      `    *) printf '%s' '${branchContent}' > "$out" ;;`,
      "  esac",
      "}",
    ].join("\n");
    const script = [
      "set -euo pipefail",
      `cd "${binDir}"`,
      TMP_FILES_DECL,
      CLEANUP_TMP_FILES,
      withTrap ? CLEANUP_TRAP : "# trap deliberately omitted (mutation control)",
      'die() { echo "install: $*" >&2; exit 1; }',
      // real chown needs privileges this harness doesn't have or need; #425: it records instead
      `chown() { echo "$*" >> "${curlLogFile.replace("curl.log", "chown.log")}"; }`,
      fakeCurl,
      `RAW_BASE="http://example.invalid"; BRANCH="${o.branch}"; FORCE_BIN=${o.forceBin ? 1 : 0}; DEPLOY_UID=4242; DEPLOY_GID=4343`,
      `BIN_DIR="${binDir}"`,
      DOWNLOAD,
      SCHEMA_OF,
      INSTALL_SHARED_BIN,
      "install_shared_bin",
    ].join("\n");
    const proc = Bun.spawn([BASH!, "-c", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const entries = readdirSync(dir);
    return {
      exitCode,
      stdout,
      stderr,
      destContent: existsSync(dest) ? readFileSync(dest, "utf8") : null,
      leftovers: entries.filter((f) => f.startsWith("tmp.")).length,
      curlLog: existsSync(join(dir, "curl.log"))
        ? readFileSync(join(dir, "curl.log"), "utf8").trim().split("\n").filter(Boolean)
        : [],
      binDir,
      chownCalls: existsSync(join(dir, "chown.log"))
        ? readFileSync(join(dir, "chown.log"), "utf8").trim().split("\n").filter(Boolean)
        : [],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!runnable)("install.sh's install_shared_bin guards the host-shared bot-ops.sh (issue #230)", () => {
  test("main refreshes the shared script with one download and no comparison", async () => {
    const r = await runSharedBin({
      branch: "main",
      installed: "OLD",
      contentFor: () => "readonly BOT_OPS_SCHEMA=5\n",
    });
    expect(r.exitCode).toBe(0);
    expect(r.destContent).toBe("readonly BOT_OPS_SCHEMA=5\n");
    expect(r.curlLog.length).toBe(1);
    expect(r.stdout).toContain("wrote");
    expect(r.stdout).toContain("from main (bot-ops schema 5)");
    expect(r.stdout).not.toContain("identical");
    // #425 (E2 a): the shared bot-ops.sh's temp file is chowned to the DEPLOY ids
    expect(r.chownCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of r.chownCalls) expect(c.startsWith("4242:4343 ")).toBe(true);
  });

  test("a branch whose bot-ops.sh is byte-identical to main's refreshes it and says so", async () => {
    const r = await runSharedBin({
      branch: "feature-same",
      installed: "OLD",
      contentFor: () => "readonly BOT_OPS_SCHEMA=7\n",
    });
    expect(r.exitCode).toBe(0);
    expect(r.destContent).toBe("readonly BOT_OPS_SCHEMA=7\n");
    expect(r.curlLog.length).toBe(2); // branch's copy AND main's, to compare them
    expect(r.stdout).toContain("from feature-same (bot-ops schema 7)");
    expect(r.stdout.trim().endsWith("(identical to main's)")).toBe(true);
  });

  test("a branch whose bot-ops.sh differs from main's is refused: both schemas named, the installed file untouched, no temp file stranded", async () => {
    const r = await runSharedBin({
      branch: "feature",
      installed: "OLD",
      contentFor: (b) => (b === "main" ? "readonly BOT_OPS_SCHEMA=5\n" : "readonly BOT_OPS_SCHEMA=9\n"),
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("schema 9");
    expect(r.stderr).toContain("main's 5");
    expect(r.stderr).toContain("--force-bin");
    expect(r.stderr).toContain(`${r.binDir}/bot-ops.sh`); // names the shared dest path
    expect(r.destContent).toBe("OLD"); // untouched
    expect(r.leftovers).toBe(0);
  });

  test("--force-bin installs the differing copy and says it differs from main", async () => {
    const r = await runSharedBin({
      branch: "feature",
      forceBin: true,
      installed: "OLD",
      contentFor: (b) => (b === "main" ? "readonly BOT_OPS_SCHEMA=5\n" : "readonly BOT_OPS_SCHEMA=9\n"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.destContent).toBe("readonly BOT_OPS_SCHEMA=9\n"); // the branch's own copy, not main's
    expect(r.stdout).toContain("--force-bin: differs from main's, schema 5");
  });

  test("without the trap, the refusal WOULD strand the two temps (so test 4 is not vacuous)", async () => {
    const r = await runSharedBin({
      branch: "feature",
      installed: "OLD",
      withTrap: false,
      contentFor: (b) => (b === "main" ? "readonly BOT_OPS_SCHEMA=5\n" : "readonly BOT_OPS_SCHEMA=9\n"),
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.leftovers).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// schema_of() is total (issue #295) — a fetched bot-ops.sh missing its BOT_OPS_SCHEMA line used to
// either abort the whole script under `set -o pipefail` (schema_of used as a plain assignment) or
// silently print nothing (schema_of embedded in a die/echo argument, where errexit isn't checked).
// Reuses the same runSharedBin harness as the #230 describe above — only contentFor changes, to
// content with no BOT_OPS_SCHEMA line at all.
// ---------------------------------------------------------------------------
describe.skipIf(!runnable)("install.sh's schema_of prints 'unknown' instead of aborting on a missing line (issue #295)", () => {
  test("main's own fetch lacks the schema line: the summary says '(bot-ops schema unknown)' and the run still succeeds", async () => {
    const r = await runSharedBin({
      branch: "main",
      installed: "OLD",
      contentFor: () => "# no BOT_OPS_SCHEMA line in this file\n",
    });
    expect(r.exitCode).toBe(0);
    expect(r.destContent).toBe("# no BOT_OPS_SCHEMA line in this file\n");
    expect(r.stdout).toContain("from main (bot-ops schema unknown)");
  });

  test("a differing branch whose OWN copy lacks the schema line: the refusal names 'unknown' for that side, 'main's 5' for the other", async () => {
    const r = await runSharedBin({
      branch: "feature",
      installed: "OLD",
      contentFor: (b) => (b === "main" ? "readonly BOT_OPS_SCHEMA=5\n" : "# no schema line here\n"),
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("schema unknown vs main's 5");
    expect(r.destContent).toBe("OLD"); // still refused and untouched, same as the #230 case
    expect(r.leftovers).toBe(0); // still swept, same as the #230 case
  });

  test("main's copy lacks the schema line, the differing branch has one: --force-bin's note names 'unknown' for main's side", async () => {
    const r = await runSharedBin({
      branch: "feature",
      forceBin: true,
      installed: "OLD",
      contentFor: (b) => (b === "main" ? "# no schema line here\n" : "readonly BOT_OPS_SCHEMA=9\n"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("--force-bin: differs from main's, schema unknown");
  });
});

// ---------------------------------------------------------------------------
// The compose-schema read is total too (issue #295) — same defect shape as schema_of(), one call
// site, extracted as the two contiguous code lines (the assignment and its echo) rather than a
// named function, same discipline as STACK_ENV_WRITE_SEQUENCE/BRANCH_GUARD_TO_FETCH above. Anchored
// on the two live lines only (not the surrounding comments), so a comment-only edit doesn't shrink
// or break the extraction.
// ---------------------------------------------------------------------------
const COMPOSE_SCHEMA_LINES = extractLine(
  /^ {2}compose_schema="\$\(\{ grep[\s\S]*?\n {2}echo "install: wrote \$STACK_DIR\/docker-compose\.yml from \$BRANCH \(Dockge will list this as a managed stack; compose schema \$\{compose_schema:-unknown\}\)"$/m,
  "the compose_schema read-and-summary lines",
);

async function runComposeSchema(composeContent: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "install-composeschema-"));
  try {
    writeFileSync(join(dir, "docker-compose.yml"), composeContent);
    const script = ["set -euo pipefail", `STACK_DIR="${toMsysPath(dir)}"`, "BRANCH=main", COMPOSE_SCHEMA_LINES].join("\n");
    const proc = Bun.spawn([BASH!, "-c", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!runnable)("install.sh's compose-schema read is total (issue #295)", () => {
  test("a compose file WITH x-rackbops-schema: prints its real value, unaffected", async () => {
    const r = await runComposeSchema("x-rackbops-schema: 4\nservices:\n  bot: {}\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("compose schema 4)");
  });

  test("a compose file WITHOUT x-rackbops-schema: prints 'compose schema unknown' and still succeeds", async () => {
    const r = await runComposeSchema("services:\n  bot: {}\n");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("compose schema unknown)");
  });
});

// ---------------------------------------------------------------------------
// install.sh's step 4 (issue #231) — the printed claim about docker inspect must be true.
// ---------------------------------------------------------------------------
describe.skipIf(!runnable)("install.sh's step 4 says docker inspect shows the four admin vars (issue #231)", () => {
  test("step 4 says docker inspect shows the four vars, and no longer says they are hidden from it", async () => {
    const out = await renderNextSteps();
    const step4 = out.slice(out.indexOf("4. Optional: the small web admin panel"), out.indexOf("5. Optional: expose"));
    expect(step4).toContain("docker inspect on this host shows them");
    expect(step4).not.toContain("or shown in docker");
    const step5 = out.slice(out.indexOf("5. Optional: expose"));
    // Unchanged sentence, not re-asserted verbatim — it spans a real line break in the rendered
    // heredoc (a plain prose line wrap, not a `\`-continued one), so \s+ stands in for that break.
    expect(step5).toMatch(/never gets the rest\s+of your secrets/);
  });
});

// ---------------------------------------------------------------------------
// docker-compose.yml's admin comment (issue #231) — read directly, not through bash: it's YAML
// comments, nothing to source.
// ---------------------------------------------------------------------------
test("docker-compose.yml's admin comment says scope, not secrecy (issue #231)", () => {
  const composePath = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));
  const compose = readFileSync(composePath, "utf8");
  const adminIdx = compose.indexOf("\n  admin:\n");
  expect(adminIdx).toBeGreaterThan(-1);
  const envIdx = compose.indexOf("\n    environment:\n", adminIdx);
  expect(envIdx).toBeGreaterThan(adminIdx);
  const adminBlock = compose.slice(adminIdx, envIdx);
  expect(adminBlock).toContain("Scope, not secrecy");
});

// ---------------------------------------------------------------------------
// #567: a NEW instance named `next` or `*-next` is refused; a re-run only warns; any run for `X` while an `X-next`
// exists warns. `<container>-next` is the name a self-update gives its replacement (src/redeploy.ts, replacementName), so
// instance `prod-next` owns the container name instance `prod`'s swap creates. check_instance_name is extracted from
// the live script like resolve_deploy_identity above; the "existing instance" and "sibling" facts are real
// directories in a temp dir, passed in as the paths main() would have derived.
// ---------------------------------------------------------------------------
const NAME_SCRIPT = [
  "set -euo pipefail",
  'die() { echo "install: $*" >&2; exit 1; }',
  'INSTANCE="$PROBE_INSTANCE"',
  'CONFIG_DIR="$PROBE_CONFIG_DIR"',
  'STACK_DIR="$PROBE_STACK_DIR"',
  'PROJECT="rackbops-discord-bot-$INSTANCE"',
  CHECK_INSTANCE_NAME,
  "check_instance_name",
  'echo "ok $INSTANCE"',
].join("\n");

interface NameDirs {
  configDir: string;
  stackDir: string;
}

async function runName(instance: string, dirs: NameDirs): Promise<Run> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PROBE_INSTANCE: instance,
    PROBE_CONFIG_DIR: dirs.configDir,
    PROBE_STACK_DIR: dirs.stackDir,
  };
  const proc = Bun.spawn([BASH!, "-c", NAME_SCRIPT], { stdout: "pipe", stderr: "pipe", env: env as Record<string, string> });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** A temp root with forward slashes (Git Bash on Windows reads those), and the two paths main() derives for `instance`. */
async function withInstanceDirs(instance: string, body: (dirs: NameDirs) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "install-name-")).replaceAll("\\", "/");
  try {
    await body({ configDir: `${root}/config/${instance}`, stackDir: `${root}/stacks/rackbops-discord-bot-${instance}` });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!runnable)("install.sh refuses a new instance named next or *-next, and warns otherwise (#567)", () => {
  test("a new prod-next (neither directory exists) dies, naming the container and the issue", async () => {
    await withInstanceDirs("prod-next", async (dirs) => {
      const r = await runName("prod-next", dirs);
      expect(r.exitCode).toBe(1);
      expect(r.stdout.trim()).toBe("");
      expect(r.stderr).toContain("would be 'rackbops-discord-bot-prod-next', which ends in -next");
      expect(r.stderr).toContain("the suffix the self-update reserves for its replacement (<container>-next)"); // the issue's acceptance: say WHY
      expect(r.stderr).toContain("pick another name");
      expect(r.stderr).toContain("(#567)");
    });
  });

  test("a re-run on an existing prod-next (config dir present) only warns and continues", async () => {
    await withInstanceDirs("prod-next", async (dirs) => {
      mkdirSync(dirs.configDir, { recursive: true });
      const r = await runName("prod-next", dirs);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("ok prod-next");
      expect(r.stderr).toContain("WARNING: the container 'rackbops-discord-bot-prod-next' ends in -next");
      // Quoted, so the unstripped name ('...-prod-next') cannot satisfy it: this is the container it collides WITH.
      expect(r.stderr).toContain("container is 'rackbops-discord-bot-prod'");
      expect(r.stderr).toContain("(#567)");
    });
  });

  test("a re-run with only the stack dir present is an existing instance too", async () => {
    await withInstanceDirs("prod-next", async (dirs) => {
      mkdirSync(dirs.stackDir, { recursive: true });
      const r = await runName("prod-next", dirs);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("ok prod-next");
      expect(r.stderr).toContain("WARNING: the container 'rackbops-discord-bot-prod-next' ends in -next");
      expect(r.stderr).toContain("container is 'rackbops-discord-bot-prod'");
      expect(r.stderr).toContain("(#567)");
    });
  });

  test("the bare name next is refused when new, and warned (naming rackbops-discord-bot) when it exists", async () => {
    await withInstanceDirs("next", async (dirs) => {
      const refused = await runName("next", dirs);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("would be 'rackbops-discord-bot-next'");
      mkdirSync(dirs.configDir, { recursive: true });
      const rerun = await runName("next", dirs);
      expect(rerun.exitCode).toBe(0);
      expect(rerun.stdout.trim()).toBe("ok next");
      expect(rerun.stderr).toContain("container is 'rackbops-discord-bot'");
    });
  });

  // `prodnext` tells `*-next` from `*next`; `prod-nextgen` and `my-next-app` tell it from `*-next*` (the suffix, only).
  test("only the suffix counts: prod, nextgen, prodnext, next-prod, prod-nextgen and my-next-app install silently", async () => {
    for (const name of ["prod", "nextgen", "prodnext", "next-prod", "prod-nextgen", "my-next-app"]) {
      await withInstanceDirs(name, async (dirs) => {
        const r = await runName(name, dirs);
        expect(r.exitCode, name).toBe(0);
        expect(r.stdout.trim(), name).toBe(`ok ${name}`);
        expect(r.stderr, name).toBe("");
      });
    }
  });

  test("prod beside a legacy prod-next (either of its directories) warns and continues, new or re-run", async () => {
    for (const sibling of ["config", "stack"] as const) {
      for (const rerun of [false, true]) {
        const label = `${sibling} sibling, ${rerun ? "re-run" : "new"}`;
        await withInstanceDirs("prod", async (dirs) => {
          mkdirSync(sibling === "config" ? `${dirs.configDir}-next` : `${dirs.stackDir}-next`, { recursive: true });
          if (rerun) mkdirSync(dirs.configDir, { recursive: true }); // prod itself already exists: still warned, still continues
          const r = await runName("prod", dirs);
          expect(r.exitCode, label).toBe(0);
          expect(r.stdout.trim(), label).toBe("ok prod");
          expect(r.stderr, label).toContain("WARNING: an instance 'prod-next' already exists");
          // What the collision costs: a stopped X-next is what X's self-update sweeps (src/redeploy.ts, the leftover sweep).
          expect(r.stderr, label).toContain("removes 'rackbops-discord-bot-prod-next' if that container is stopped");
          expect(r.stderr, label).toContain("(#567)");
        });
      }
    }
  });
});

// The CONSUMER boundary: main()'s own slice (the same BRANCH_GUARD_TO_FETCH the branch-gate tests run) with the REAL
// check_instance_name, every write stubbed to a recording line. A new `probe-next` must exit 1 before any WRITE, and a
// plain `probe` must reach the end with its writes (so the stubs prove the slice does get that far). The CONFIG_DIR the
// slice derives is the real /opt path, which no test machine has, so the instance is "new".
async function runNameGate(instance: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const script = [
    "set -euo pipefail",
    'die() { echo "install: $*" >&2; exit 1; }',
    "need() { :; }",
    "resolve_deploy_identity() { DEPLOY_UID=1000; DEPLOY_GID=1000; }",
    CHECK_INSTANCE_NAME,
    'bootstrap_dir() { echo "WRITE:bootstrap_dir $1"; }',
    'mkdir() { echo "WRITE:mkdir $*"; }',
    'chown() { echo "WRITE:chown $*"; }',
    'sed() { echo "WRITE:sed"; }',
    "random_token() { echo faketoken; }",
    'fetch() { echo "WRITE:fetch $1"; }',
    'download() { echo "WRITE:download $1"; DOWNLOADED=/dev/null; }', // #486: the .env block downloads, patches, then moves
    'mv() { echo "WRITE:mv $*"; }',
    'install_shared_bin() { echo "WRITE:install_shared_bin"; }',
    BRANCH_GUARD_TO_FETCH,
    'echo "REACHED_END"',
  ].join("\n");
  const proc = Bun.spawn([BASH!, "-c", script, "_", instance], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(!runnable)("install.sh's main() stops a new next/*-next instance before it writes anything (#567)", () => {
  test("control: a plain new instance reaches the end of the slice with its writes", async () => {
    const r = await runNameGate("probe");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("WRITE:bootstrap_dir /opt/rackbops-discord-bot/probe");
    expect(r.stdout).toContain("REACHED_END");
  });

  test("a new probe-next dies in the slice with no write at all", async () => {
    const r = await runNameGate("probe-next");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("would be 'rackbops-discord-bot-probe-next'");
    expect(r.stdout).not.toContain("WRITE:");
    expect(r.stdout).not.toContain("REACHED_END");
  });
});

// Source check, no bash needed: main() must call it after PROJECT is set (the message names it) and before anything
// is created (a refusal writes nothing). Searches for the call LINE, so the definition and the comments don't count.
test("install.sh calls check_instance_name after PROJECT is set and before anything is created (#567)", () => {
  const iProject = installShSource.indexOf('PROJECT="rackbops-discord-bot-$INSTANCE"');
  const iBoot = installShSource.indexOf('bootstrap_dir "$CONFIG_DIR"');
  const iCall = installShSource.search(/^ {2}check_instance_name$/m);
  for (const [name, i] of Object.entries({ iProject, iBoot, iCall })) expect(i, `${name} present`).toBeGreaterThan(-1);
  expect(iCall).toBeGreaterThan(iProject);
  expect(iCall).toBeLessThan(iBoot);
});

// ---------------------------------------------------------------------------
// #531 O1 (#424, #425, #486): the operator's existing .env, every chown, and the in-place compose refresh.
// ---------------------------------------------------------------------------
const RANDOM_TOKEN = extractFunction("random_token");
const BOOTSTRAP_DIR = extractFunction("bootstrap_dir");
const FETCH_IN_PLACE = extractFunction("fetch_in_place");
// From the backups/ mkdir (so the backups chown is in the slice) through the .env block's closing `fi`. Anchored on the
// "already exists" echo, NOT on the guard's `if` line: a regex anchored on the guard would throw at import under a mutant
// that rewrites the guard, erroring every test in the file instead of failing the one that pins it.
const ENV_BLOCK = extractLine(
  /^ {2}mkdir -p "\$CONFIG_DIR\/backups"[\s\S]*?already exists[\s\S]*?^ {2}fi$/m,
  "the backups mkdir through the .env block's closing fi",
);

interface EnvBlockRun extends Run {
  /** The .env after the run, or null if it does not exist. */
  env: string | null;
  mode: number | null;
  configDir: string;
}

async function runEnvBlock(o: { existing?: string }): Promise<EnvBlockRun> {
  const configDir = mkdtempSync(join(tmpdir(), "install-envblock-"));
  try {
    if (o.existing !== undefined) writeFileSync(join(configDir, ".env"), o.existing);
    const script = [
      "set -euo pipefail",
      'die() { echo "install: $*" >&2; exit 1; }',
      "TMP_FILES=()",
      "DEPLOY_UID=4242; DEPLOY_GID=4343",
      `CONFIG_DIR="${toMsysPath(configDir)}"`,
      RANDOM_TOKEN,
      // download() stand-in: writes a fixture .env.example beside the destination like the real one, applies the mode
      // and the DEPLOY chown to that temp file, and reports itself.
      'download() { echo "DOWNLOAD:$1"; local t; t="$(mktemp -p "$(dirname "$3")")"; printf "DISCORD_TOKEN=\\nADMIN_TOKEN=\\n" > "$t"; chmod "$2" "$t"; chown "$DEPLOY_UID:$DEPLOY_GID" "$t"; DOWNLOADED="$t"; }',
      'chown() { echo "CHOWN:$*"; }',
      // Reports the ADMIN_TOKEN line of whatever is being moved INTO PLACE, so a patch applied after the move is visible.
      'mv() { echo "MV_SRC_TOKEN:$(grep "^ADMIN_TOKEN=" "$1")"; command mv "$@"; }',
      ENV_BLOCK,
      'echo "ENV_BLOCK_DONE"',
    ].join("\n");
    const proc = Bun.spawn([BASH!, "-c", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const envPath = join(configDir, ".env");
    return {
      exitCode,
      stdout,
      stderr,
      env: existsSync(envPath) ? readFileSync(envPath, "utf8") : null,
      mode: existsSync(envPath) ? statSync(envPath).mode & 0o777 : null,
      configDir,
    };
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

describe.skipIf(!runnable)("install.sh leaves an operator's existing .env alone and never leaves a half-written one (#424, #486 item 9)", () => {
  test("E1 (a): an existing .env is byte-identical afterwards, nothing is downloaded, and the token is located, never printed", async () => {
    const existing = "DISCORD_TOKEN=keep\nADMIN_TOKEN=abc\n";
    const r = await runEnvBlock({ existing });
    expect(r.exitCode).toBe(0);
    expect(r.env).toBe(existing);
    expect(r.stdout).not.toContain("DOWNLOAD:");
    expect(r.stdout).toContain("already exists");
    expect(r.stdout).toContain("ADMIN_TOKEN is already set");
    expect(r.stdout).not.toContain("abc");
    expect(r.stdout).toContain("ENV_BLOCK_DONE");
  });

  test("E1 (b): an existing .env whose ADMIN_TOKEN is empty gets no 'already set' line", async () => {
    const existing = "DISCORD_TOKEN=keep\nADMIN_TOKEN=\n";
    const r = await runEnvBlock({ existing });
    expect(r.exitCode).toBe(0);
    expect(r.env).toBe(existing);
    expect(r.stdout).toContain("already exists");
    expect(r.stdout).not.toContain("ADMIN_TOKEN is already set");
  });

  test("E1 (c): a new .env gets a 64-hex token, printed once, patched BEFORE the move, and chowned to the deploy ids", async () => {
    const r = await runEnvBlock({});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("DOWNLOAD:.env.example");
    const token = /^ADMIN_TOKEN=([0-9a-f]{64})$/m.exec(r.env ?? "")?.[1];
    expect(token, "the written .env carries a 64-hex ADMIN_TOKEN").toBeDefined();
    expect(r.stdout).toContain(`install:   ${token}`);
    // the file being moved into place already carried the token: the final path never held an empty one
    expect(r.stdout).toContain(`MV_SRC_TOKEN:ADMIN_TOKEN=${token}`);
    // E2 (c): backups/ is chowned to the deploy ids (the .env temp-file chown below is this harness's own download
    // stand-in; the real download()'s chown is pinned by the sweep and shared-bin tests)
    expect(r.stdout).toMatch(/^CHOWN:4242:4343 \S+\/\.env$|^CHOWN:4242:4343 \S+\/tmp\.\w+$/m);
    expect(r.stdout).toMatch(/^CHOWN:4242:4343 \S+\/backups$/m);
    for (const l of r.stdout.split("\n").filter((x) => x.startsWith("CHOWN:"))) expect(l.startsWith("CHOWN:4242:4343 ")).toBe(true);
  });

  test.skipIf(process.platform === "win32")("E1 (c): the new .env is mode 0600", async () => {
    const r = await runEnvBlock({});
    expect(r.mode).toBe(0o600);
  });
});

describe.skipIf(!runnable)("install.sh chowns to DEPLOY_UID:DEPLOY_GID everywhere, never to the process's own ids (#425)", () => {
  test("E2 (b): bootstrap_dir sudo-creates and chowns a missing dir to the deploy ids, and does nothing for one we own", async () => {
    const root = mkdtempSync(join(tmpdir(), "install-bootstrap-"));
    try {
      const missing = `${toMsysPath(root)}/not-there`;
      const own = toMsysPath(root);
      const script = (dir: string) =>
        [
          "set -euo pipefail",
          'die() { echo "install: $*" >&2; exit 1; }',
          "DEPLOY_UID=4242; DEPLOY_GID=4343",
          'sudo() { echo "SUDO:$*"; }',
          BOOTSTRAP_DIR,
          `bootstrap_dir "${dir}"`,
        ].join("\n");
      const run1 = async (dir: string) => {
        const proc = Bun.spawn([BASH!, "-c", script(dir)], { stdout: "pipe", stderr: "pipe" });
        const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return { stdout, exitCode };
      };
      const a = await run1(missing);
      expect(a.exitCode).toBe(0);
      expect(a.stdout).toContain(`SUDO:mkdir -p ${missing}`);
      expect(a.stdout).toContain(`SUDO:chown 4242:4343 ${missing}`);
      const b = await run1(own);
      expect(b.exitCode).toBe(0);
      expect(b.stdout).not.toContain("SUDO:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---- fetch_in_place (#486 item 3): the compose file keeps its inode, so the admin's single-file mount sees a re-run ----
interface InPlaceRun extends Run {
  dest: string;
  chownCalls: string[];
}

/** Runs fetch_in_place for ./dest.yml in a fresh temp dir; `setup` prepares the destination first; `check` reads results before cleanup. */
async function withInPlace<T>(
  setup: (dir: string) => void,
  check: (dir: string, r: InPlaceRun) => T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "install-inplace-"));
  try {
    setup(dir);
    const script = [
      "set -euo pipefail",
      `cd "${dir.replaceAll("\\", "/")}"`,
      'die() { echo "install: $*" >&2; exit 1; }',
      "TMP_FILES=()",
      'curl() { printf "%s" "$NEW_CONTENT" > "$4"; }', // curl -fsSL URL -o PATH: $4 is the output path
      'chown() { echo "$*" >> chown.log; }',
      'RAW_BASE="http://example.invalid"; BRANCH=main; DEPLOY_UID=4242; DEPLOY_GID=4343',
      DOWNLOAD,
      FETCH,
      FETCH_IN_PLACE,
      'fetch_in_place "docker-compose.yml" 644 "./dest.yml"',
    ].join("\n");
    const proc = Bun.spawn([BASH!, "-c", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NEW_CONTENT: "NEW\n" } as Record<string, string>,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const log = join(dir, "chown.log");
    return check(dir, {
      exitCode,
      stdout,
      stderr,
      dest: join(dir, "dest.yml"),
      chownCalls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!runnable)("install.sh refreshes the compose file in place so a running admin's mount sees it (#486 item 3)", () => {
  test("E4 (a): an existing destination gets the new content under the SAME inode", async () => {
    let before = 0;
    await withInPlace(
      (dir) => {
        writeFileSync(join(dir, "dest.yml"), "OLD\n");
        before = statSync(join(dir, "dest.yml")).ino;
      },
      (_dir, r) => {
        expect(r.exitCode, r.stderr).toBe(0);
        expect(readFileSync(r.dest, "utf8")).toBe("NEW\n");
        expect(statSync(r.dest).ino).toBe(before);
      },
    );
  });

  test("E4 (b): no destination -> created with the content", async () => {
    await withInPlace(
      () => {},
      (_dir, r) => {
        expect(r.exitCode, r.stderr).toBe(0);
        expect(readFileSync(r.dest, "utf8")).toBe("NEW\n");
      },
    );
  });

  test.skipIf(process.platform === "win32")("E4 (c): a symlink destination is replaced by a regular file; the link's target is untouched", async () => {
    await withInPlace(
      (dir) => {
        writeFileSync(join(dir, "target.yml"), "TARGET\n");
        symlinkSync("target.yml", join(dir, "dest.yml"));
      },
      (dir, r) => {
        expect(r.exitCode, r.stderr).toBe(0);
        expect(lstatSync(r.dest).isSymbolicLink()).toBe(false);
        expect(readFileSync(r.dest, "utf8")).toBe("NEW\n");
        expect(readFileSync(join(dir, "target.yml"), "utf8")).toBe("TARGET\n");
      },
    );
  });

  test.skipIf(process.platform === "win32")("E4 (d): an existing 0600 destination ends 0644 under the same inode, chowned to the deploy ids", async () => {
    let before = 0;
    await withInPlace(
      (dir) => {
        writeFileSync(join(dir, "dest.yml"), "OLD\n");
        chmodSync(join(dir, "dest.yml"), 0o600);
        before = statSync(join(dir, "dest.yml")).ino;
      },
      (_dir, r) => {
        expect(r.exitCode, r.stderr).toBe(0);
        expect(statSync(r.dest).mode & 0o777).toBe(0o644);
        expect(statSync(r.dest).ino).toBe(before);
        expect(r.chownCalls).toContain("4242:4343 ./dest.yml");
      },
    );
  });

  test.skipIf(process.platform === "win32")("E4 (e): an owned but read-only (0444) destination is replaced via mv, not aborted on (CI Linux)", async () => {
    let before = 0;
    await withInPlace(
      (dir) => {
        writeFileSync(join(dir, "dest.yml"), "OLD\n");
        chmodSync(join(dir, "dest.yml"), 0o444);
        before = statSync(join(dir, "dest.yml")).ino;
      },
      (_dir, r) => {
        expect(r.exitCode, r.stderr).toBe(0);
        expect(readFileSync(r.dest, "utf8")).toBe("NEW\n");
        expect(statSync(r.dest).ino).not.toBe(before); // the mv branch: a new inode
      },
    );
  });

  test("E4 source pin: the in-place branch needs a regular non-symlink file we own (or root) that is writable; only the compose file uses it", () => {
    // each of the four conditions on its own, so a mutant dropping any one names it (the root clause has no
    // behavioural test: a non-root run cannot fake euid 0; -w and -L are also pinned by E4 (e) and (c) on CI Linux)
    expect(FETCH_IN_PLACE, "regular file").toContain('[ -f "$3" ]');
    expect(FETCH_IN_PLACE, "not a symlink").toContain('[ ! -L "$3" ]');
    expect(FETCH_IN_PLACE, "owned by us").toContain('[ -O "$3" ]');
    expect(FETCH_IN_PLACE, "or running as root").toContain('[ "$(id -u)" -eq 0 ]');
    expect(FETCH_IN_PLACE, "writable").toContain('[ -w "$3" ]');
    expect(FETCH_IN_PLACE).toContain('[ -f "$3" ] && [ ! -L "$3" ] && { [ -O "$3" ] || [ "$(id -u)" -eq 0 ]; } && [ -w "$3" ]');
    expect(installShSource).toMatch(/^ {2}fetch_in_place "docker-compose\.yml" 644 "\$STACK_DIR\/docker-compose\.yml"$/m);
    expect(installShSource).not.toMatch(/fetch_in_place "(\.env\.example|ops\/bot-ops\.sh)"/);
    expect(installShSource).not.toMatch(/^ {2}fetch "docker-compose\.yml"/m);
  });
});
