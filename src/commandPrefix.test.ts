import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_DATA_PREFIX } from "../test/sweep";

// A bot under a real, non-empty COMMAND_PREFIX, in a child process (test/prefixedInstance.ts). In this
// process COMMAND_PREFIX is empty -- config resolves it once, at import, and every test file shares
// that import -- so `bareName("pipupdate")` is "pipupdate", no core row matches it, and an in-process
// test can only drive a prefixed NAME through code that never sees a prefixed CONFIG. This is what a
// `pip` or `r` instance actually runs: its own registration, prefix stripping, dispatch and replies.
// Mutation: any reply naming a command other than the one typed -- a bare literal, or the name with
// the prefix stripped back off -- fails a test below.
const FIXTURE = join(import.meta.dir, "..", "test", "prefixedInstance.ts");
const CHILD_TIMEOUT_MS = 20_000;

interface PrefixedRun {
  prefix: string;
  registered: string[];
  refuseUpdate: string;
  refusePlugins: string;
  refuseReport: string;
  adminUpdate: string;
  adminPluginsNotReady: string;
  notInstalled: string;
  unknownSubcommand: string;
}

function runPrefixed(prefix: string): PrefixedRun {
  // Named like the suite's own data dirs (pid included), so test/setup.ts sweeps it if a crash
  // skips the `finally`.
  const dataDir = mkdtempSync(join(tmpdir(), `${TEST_DATA_PREFIX}${process.pid}-`));
  try {
    const child = Bun.spawnSync([process.execPath, FIXTURE], {
      cwd: join(import.meta.dir, ".."),
      // The child takes well under a second. A reply promise that never settles would otherwise
      // leave it waiting forever; this bounds it on its own, whatever the test runner does.
      timeout: CHILD_TIMEOUT_MS,
      env: {
        ...process.env,
        COMMAND_PREFIX: prefix,
        BOT_DATA_DIR: dataDir,
        ADMIN_USER_IDS: "",
        REPORT_ROLE_ID: "",
        GIT_SHA: "",
        PLUGINS: "",
        PLUGIN_INDEX_URL: "https://plugins.invalid/plugins.json",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (child.exitCode !== 0) {
      const why = child.exitedDueToTimeout
        ? `was killed after ${CHILD_TIMEOUT_MS}ms`
        : `exited ${child.exitCode} (signal ${child.signalCode ?? "none"})`;
      throw new Error(`fixture ${why}:\n${child.stderr.toString()}\n${child.stdout.toString()}`);
    }
    const last = child.stdout.toString().trim().split("\n").at(-1) ?? "";
    return JSON.parse(last) as PrefixedRun;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

for (const prefix of ["pip", "r"]) {
  describe(`a bot started with COMMAND_PREFIX=${prefix}`, () => {
    let run: PrefixedRun;
    beforeAll(() => {
      run = runPrefixed(prefix);
    }, CHILD_TIMEOUT_MS + 10_000); // longer than the child's own bound, so that bound is what fires

    test("registers every core command under the prefix", () => {
      expect(run.prefix).toBe(prefix);
      expect(run.registered).toEqual([`${prefix}report`, `${prefix}update`, `${prefix}plugins`]);
    });

    test("the admin refusal names the command the user typed", () => {
      expect(run.refuseUpdate).toBe(`⛔ No admins are configured — set \`ADMIN_USER_IDS\` to enable \`/${prefix}update\`.`);
      expect(run.refusePlugins).toBe(`⛔ No admins are configured — set \`ADMIN_USER_IDS\` to enable \`/${prefix}plugins\`.`);
    });

    test("the /report not-configured refusal names the command the user typed", () => {
      expect(run.refuseReport).toBe(
        `\`/${prefix}report\` isn't configured — an admin must set \`REPORT_ROLE_ID\` and \`GITHUB_TOKEN\`.`,
      );
    });

    test("the /plugins not-installed hint and unknown-subcommand reply name the command the user typed", () => {
      expect(run.notInstalled).toBe(`⚠️ **nope** isn't an installed plugin. See \`/${prefix}plugins list\`.`);
      expect(run.unknownSubcommand).toBe(`Unknown /${prefix}plugins subcommand: bogus`);
    });

    test("no reply names a bare core command", () => {
      for (const reply of [run.refuseUpdate, run.refusePlugins, run.refuseReport, run.notInstalled, run.unknownSubcommand]) {
        expect(reply).not.toMatch(/\/(report|update|plugins)\b/);
      }
    });

    // The row-swap guard for #206's table: as an admin, each admin-gated row does something only its
    // own body does, with no network. `/update` with no GIT_SHA answers "disabled" (checkForUpdate
    // returns before reading any sha, once its busy check passes -- and in a fresh process no handoff
    // or check is in flight); `/plugins update` refuses until the boot state.json write has landed.
    // Swapping the two rows' handle bodies fails this.
    test("each admin-gated row runs its own body", () => {
      expect(run.adminUpdate).toBe("⚠️ Self-update is disabled — this build has no `GIT_SHA` baked in.");
      expect(run.adminPluginsNotReady).toBe("⏳ The bot is still starting up — try that again in a moment.");
    });
  });
}
