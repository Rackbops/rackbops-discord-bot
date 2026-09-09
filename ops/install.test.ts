// Isolated tests for ops/install.sh's resolve_deploy_identity() — the root/SUDO_UID decision
// logic issue #54 added. install.sh itself can't be spawned end-to-end here or in CI: it
// hardcodes real /opt/... paths, needs a real `sudo`, and fetches from the network. Instead, this
// dynamically extracts just resolve_deploy_identity()'s current body out of the real install.sh
// source (a regex over the live file, not a hand-copied duplicate — so editing the real function
// is what this test exercises, not a snapshot that can silently drift) and runs it in a tiny bash
// subprocess with a faked `id`. Needs bash on PATH; skips loudly (not vacuously) without one, same
// convention as ops/bot-ops.test.ts. On Windows, Git's own bash is used.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// A shape matching what install.sh's own STACKENV heredoc actually writes (install.sh:220-226),
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
      "DEPLOY_UID=1000",
      "DEPLOY_GID=1000",
      "TMP_FILES=()",
      'chown() { :; }', // real chown needs privileges/semantics this harness doesn't have or need
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
  const proc = Bun.spawn([BASH!, "-c", script], { stdout: "pipe", stderr: "pipe" });
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
    // to lean on) is untouched by #169 and must still carry its own prefix vars. NOTE (found while
    // writing this test, out of #169's scope, unrelated to this change): bash's unquoted `<<EOF`
    // heredoc splices every `\<newline>` in its body per the manual ("the character sequence
    // \newline is ignored"), confirmed with a two-line repro — so steps 3/4/5's own backslash
    // continuations, unchanged here, already collapse onto one run-on line with the source's
    // indentation left behind as inline whitespace, not the multi-line block the source layout
    // visually suggests. Still a valid single command to copy-paste (word-splitting doesn't care
    // whether words are separated by a newline+indent or a run of spaces), so not asserted as
    // multi-line here — just that step 3's prefix vars are still present, unlike step 2's.
    const step3 = out.slice(out.indexOf("3. Day-2 ops"), out.indexOf("4. Optional"));
    expect(step3).toContain("BOT_OPS_CONTAINER=rackbops-discord-bot-debug");
  });
});
