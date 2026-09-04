// Isolated tests for ops/install.sh's resolve_deploy_identity() — the root/SUDO_UID decision
// logic issue #54 added. install.sh itself can't be spawned end-to-end here or in CI: it
// hardcodes real /opt/... paths, needs a real `sudo`, and fetches from the network. Instead, this
// dynamically extracts just resolve_deploy_identity()'s current body out of the real install.sh
// source (a regex over the live file, not a hand-copied duplicate — so editing the real function
// is what this test exercises, not a snapshot that can silently drift) and runs it in a tiny bash
// subprocess with a faked `id`. Needs bash on PATH; skips loudly (not vacuously) without one, same
// convention as ops/bot-ops.test.ts. On Windows, Git's own bash is used.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
