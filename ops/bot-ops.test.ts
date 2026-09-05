// Real-bash tests for ops/bot-ops.sh's env-get / env-set: the script is spawned as-is against a
// throwaway config dir, with a fake `docker` shim first on PATH (it logs its argv and exits 0, so
// `up -d --force-recreate` never reaches a daemon) and `jq` from the host. Discovered by the root
// `bun test` the same way ops/admin/server.test.ts is. Needs bash + jq on PATH; on a box without
// them the whole file skips LOUDLY rather than passing vacuously. On Windows, Git's own bash is
// used — a WSL bash.exe earlier on PATH would run the script against a different filesystem.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BOT_OPS_SH = fileURLToPath(new URL("./bot-ops.sh", import.meta.url));

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
const JQ = Bun.which("jq");
const runnable = BASH !== null && JQ !== null;
if (!runnable) {
  console.warn(`[bot-ops.test] SKIPPING: needs bash (${BASH ?? "missing"}) and jq (${JQ ?? "missing"}) on PATH`);
}

/** A path as the spawned bash (MSYS on Windows) should see it: C:\a\b -> /c/a/b. */
function bashPath(p: string): string {
  if (process.platform !== "win32") return p;
  return p.replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
}

interface Fixture {
  root: string;
  cfg: string;
  bin: string;
  envFile: string;
  compose: string;
}
const fixtures: Fixture[] = [];

function setup(
  envText: string,
  opts: {
    nextRunning?: boolean;
    /** The simulated canonical-named container's real docker state:
     *  - "running": the swap is genuinely unresolved (the default whenever nextRunning is set) —
     *    matches a bare `docker ps` (no `-a`) AND `docker ps -a`, same as a real running container.
     *  - "stopped": past retireOriginal's stop but its remove failed (round-1's actual bug —
     *    a stopped-but-not-removed corpse) — matches ONLY `docker ps -a`, not a bare `docker ps`,
     *    same as a real stopped-but-present container. The guard must NOT refuse in this state
     *    (issue #51 item 5), which is exactly what would break if a future edit accidentally added
     *    `-a` to the guard's running-check — this state is what catches that regression.
     *  - "gone": fully removed. Matches neither.
     *  Ignored unless nextRunning is set. */
    originalState?: "running" | "stopped" | "gone";
    /** Fixture JSON the fake `docker exec … cat` returns for the bot's cached Plugin Index
     *  (`/app/data/plugins/index.json` — the CachedPluginIndex wrapper `{writtenAt, index}`) and
     *  Plugin State (`/app/data/plugins/state.json`). Absent → the shim prints nothing for that
     *  path, i.e. the file isn't there in the container (index unavailable / no state). */
    pluginIndex?: string;
    pluginState?: string;
  } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "bot-ops-44-"));
  const cfg = join(root, "cfg");
  const bin = join(root, "bin");
  mkdirSync(cfg);
  mkdirSync(bin);
  const originalState = opts.originalState ?? "running";
  // `ps` only answers specially when opts.nextRunning simulates a `<container>-next` (issue #51
  // item 5's guard) — every other invocation (build, create, up -d --force-recreate, ...) never
  // matches `$1`, so it stays silent for them, same as before this option existed. The guard makes
  // two `ps` calls with different filters: one for "-next" (always answered when nextRunning is
  // set, with `-a` so it sees even a not-yet-started replacement), one for the bare canonical name.
  // That second query's `-a` (or lack of it) has to be respected for real, not just its filter
  // text — that's the exact flag the guard's whole self-heal/no-lockout design rests on, so the
  // shim tracks it explicitly rather than answering the same way regardless.
  const hasDashA = `[[ " $* " == *" -a "* ]]`;
  const answersCanonicalQuery =
    originalState === "running" ? "true" : originalState === "stopped" ? hasDashA : "false";
  // The plugin fixtures the shim serves for `docker exec <container> cat <path>` — the same
  // docker-exec read bot-ops.sh uses for the cached index and plugin state. Written to host files
  // the shim `cat`s (bash-visible paths); absent options leave that `if` out, so the read comes
  // back empty (file not present in the container).
  const pluginIndexFile = join(root, "plugin-index.json");
  const pluginStateFile = join(root, "plugin-state.json");
  if (opts.pluginIndex !== undefined) writeFileSync(pluginIndexFile, opts.pluginIndex);
  if (opts.pluginState !== undefined) writeFileSync(pluginStateFile, opts.pluginState);
  const execHandler = [
    opts.pluginIndex !== undefined
      ? `if [[ "$1" == "exec" ]] && [[ "$*" == *"/app/data/plugins/index.json"* ]]; then cat ${JSON.stringify(bashPath(pluginIndexFile))}; fi`
      : "",
    opts.pluginState !== undefined
      ? `if [[ "$1" == "exec" ]] && [[ "$*" == *"/app/data/plugins/state.json"* ]]; then cat ${JSON.stringify(bashPath(pluginStateFile))}; fi`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(
    join(bin, "docker"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "docker $*" >> "$(dirname "$0")/docker.log"`,
      opts.nextRunning
        ? [
            `if [[ "$1" == "ps" ]] && [[ "$*" == *"-next"* ]]; then`,
            `  printf '%s\\n' "probe-container-next"`,
            `elif [[ "$1" == "ps" ]] && [[ "$*" == *"probe-container"* ]]; then`,
            `  if ${answersCanonicalQuery}; then printf '%s\\n' "probe-container"; fi`,
            `fi`,
          ].join("\n")
        : "",
      execHandler,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const compose = join(root, "compose.yml");
  writeFileSync(compose, "services:\n  bot:\n    image: x\n");
  const envFile = join(cfg, ".env");
  writeFileSync(envFile, envText);
  const fx = { root, cfg, bin, envFile, compose };
  fixtures.push(fx);
  return fx;
}

afterEach(() => {
  for (const fx of fixtures.splice(0)) rmSync(fx.root, { recursive: true, force: true });
});

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

async function botOps(
  fx: Fixture,
  args: string[],
  stdin?: string,
  // Overrides applied on top of the default identity below — `undefined` unsets a key entirely
  // rather than passing the literal string "undefined", so a test can exercise bot-ops.sh's own
  // required-var checks (issue #41) instead of always running with a valid identity.
  identityOverrides: Record<string, string | undefined> = {},
): Promise<Run> {
  // Windows spells the variable `Path`; setting a second `PATH` beside it would be ambiguous.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const env: Record<string, string | undefined> = {
    ...process.env,
    [pathKey]: fx.bin + delimiter + (process.env[pathKey] ?? ""),
    BOT_OPS_PROJECT: "probe-project",
    BOT_OPS_CONTAINER: "probe-container",
    BOT_OPS_CONFIG_DIR: bashPath(fx.cfg),
    BOT_OPS_COMPOSE_FILE: bashPath(fx.compose),
    ...identityOverrides,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const proc = Bun.spawn([BASH!, bashPath(BOT_OPS_SH), ...args], {
    stdin: stdin !== undefined ? Buffer.from(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: env as Record<string, string>,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* not JSON — an error path, asserted on stderr/exit code instead */
  }
  return { exitCode, stdout, stderr, json };
}

const envGet = async (fx: Fixture): Promise<Record<string, string>> => {
  const run = await botOps(fx, ["env-get"]);
  expect(run.exitCode).toBe(0);
  return run.json as Record<string, string>;
};
const dockerCalls = (fx: Fixture): string[] => {
  const log = join(fx.bin, "docker.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
};
const envText = (fx: Fixture): string => readFileSync(fx.envFile, "utf8");

/** The pre-#44 panel body — every env-get key echoed back, `overrides` applied — which a
 *  hand-rolled caller may still send, so env-set has to cope with it. */
async function fullBody(fx: Fixture, overrides: Record<string, string>): Promise<string> {
  const env = { ...(await envGet(fx)), ...overrides };
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

// issue #41: BOT_OPS_PROJECT/BOT_OPS_CONTAINER have no fallback — a caller that forgets either
// must get a named, immediate die, never a silent guess. This is the precondition every other
// subcommand depends on, so it's checked before any of them (using "status" here is arbitrary).
describe.skipIf(!runnable)("bot-ops.sh requires BOT_OPS_PROJECT/BOT_OPS_CONTAINER, no fallback (issue #41)", () => {
  test("BOT_OPS_PROJECT unset dies naming it, before touching docker", async () => {
    const fx = setup("");
    const run = await botOps(fx, ["status"], undefined, { BOT_OPS_PROJECT: undefined });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("BOT_OPS_PROJECT not set");
    expect(dockerCalls(fx)).toHaveLength(0);
  });

  test("BOT_OPS_CONTAINER unset (PROJECT valid) dies naming it", async () => {
    const fx = setup("");
    const run = await botOps(fx, ["status"], undefined, { BOT_OPS_CONTAINER: undefined });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("BOT_OPS_CONTAINER not set");
    expect(dockerCalls(fx)).toHaveLength(0);
  });

  test("both unset dies naming BOT_OPS_PROJECT specifically (checked first)", async () => {
    const fx = setup("");
    const run = await botOps(fx, ["status"], undefined, {
      BOT_OPS_PROJECT: undefined,
      BOT_OPS_CONTAINER: undefined,
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("BOT_OPS_PROJECT not set");
  });

  test("a BOT_OPS_PROJECT outside the safe charset dies as invalid, not interpolated", async () => {
    const fx = setup("");
    const run = await botOps(fx, ["status"], undefined, { BOT_OPS_PROJECT: "bad project" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("invalid BOT_OPS_PROJECT");
    expect(dockerCalls(fx)).toHaveLength(0);
  });

  test("a BOT_OPS_CONTAINER outside the safe charset dies as invalid, not interpolated", async () => {
    const fx = setup("");
    const run = await botOps(fx, ["status"], undefined, { BOT_OPS_CONTAINER: "bad;container" });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("invalid BOT_OPS_CONTAINER");
    expect(dockerCalls(fx)).toHaveLength(0);
  });
});

describe.skipIf(!runnable)("bot-ops.sh env-get reads .env the way compose's env_file loader does (issue #44)", () => {
  test("the LAST occurrence of a duplicated key wins, not the first", async () => {
    const fx = setup("WOW_REGION=us\nWOW_REGION=eu\n");
    expect((await envGet(fx)).WOW_REGION).toBe("eu");
  });

  test("one layer of matching quotes is stripped; a mismatched or lone quote is left alone", async () => {
    // Compose refuses to load a file with an unterminated quote at all ("unterminated quoted
    // value", verified with `docker compose config`), so there is no effective value to mirror
    // there: the raw text is the honest reading, and saving that key from the panel rewrites it
    // unquoted — which repairs the file.
    const fx = setup(`WOW_REALM="stormrage"\nDMF_TIMEZONE='UTC'\nCOMMAND_PREFIX="abc\nBOT_BRANCH="\nWATCHED_REPOS='"'\n`);
    const env = await envGet(fx);
    expect(env.WOW_REALM).toBe("stormrage");
    expect(env.DMF_TIMEZONE).toBe("UTC");
    expect(env.COMMAND_PREFIX).toBe('"abc');
    expect(env.BOT_BRANCH).toBe('"');
    expect(env.WATCHED_REPOS).toBe('"'); // the outer single-quote pair goes, the inner char stays
  });

  test("a CRLF-saved file yields values without the trailing CR", async () => {
    const fx = setup('ANNOUNCE_CHANNEL_ID=11111\r\nWOW_REGION=us\r\nWOW_REALM="hyjal"\r\n');
    const env = await envGet(fx);
    expect(env.ANNOUNCE_CHANNEL_ID).toBe("11111");
    expect(env.WOW_REGION).toBe("us");
    expect(env.WOW_REALM).toBe("hyjal");
  });

  test("an `export KEY=` line defines the key", async () => {
    const fx = setup("export WOW_REGION=eu\n");
    expect((await envGet(fx)).WOW_REGION).toBe("eu");
  });

  test("an indented line defines the key too, as it does for compose", async () => {
    const fx = setup("  WOW_REGION=eu\n\texport BOT_BRANCH=dev\n");
    const env = await envGet(fx);
    expect(env.WOW_REGION).toBe("eu");
    expect(env.BOT_BRANCH).toBe("dev");
  });

  test("whitespace around an unquoted value is trimmed; inside quotes it is kept", async () => {
    const fx = setup('WOW_REGION=  eu \t\nCOMMAND_PREFIX="  r_  "\n');
    const env = await envGet(fx);
    expect(env.WOW_REGION).toBe("eu");
    expect(env.COMMAND_PREFIX).toBe("  r_  ");
  });

  test("a longer key and a commented-out line don't define the key; an absent key is empty", async () => {
    const fx = setup("WOW_REGIONX=eu\n# WOW_REGION=eu\n\n");
    const env = await envGet(fx);
    expect(env.WOW_REGION).toBe("");
    expect(env.ANNOUNCE_CHANNEL_ID).toBe("");
    expect(Object.keys(env)).not.toContain("WOW_REGIONX"); // not whitelisted, so never reported
  });
});

describe.skipIf(!runnable)("bot-ops.sh env-set diffs against the effective value BEFORE validating (issue #44)", () => {
  test("a stored value the whitelist rejects no longer blocks saving an unrelated key", async () => {
    // ADMIN_USER_IDS with a space: config.ts trims it, the regex here doesn't. WOW_REALM quoted:
    // compose strips the quotes, the old env_value didn't. Both used to fail EVERY panel save.
    const stored = 'ADMIN_USER_IDS=123456, 234567\nWOW_REALM="stormrage"\nANNOUNCE_CHANNEL_ID=11111\n';
    const fx = setup(stored);
    const body = await fullBody(fx, { ANNOUNCE_CHANNEL_ID: "22222" });
    // 14 static whitelisted keys now (#101 dropped WARBANDEER_INGEST_PORT, added PLUGINS +
    // PLUGIN_INDEX_URL); no PLUGINS set here, so no plugin keys are merged in.
    expect(body.split("\n")).toHaveLength(14); // every whitelisted key echoed, like the old panel
    const run = await botOps(fx, ["env-set"], body);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["ANNOUNCE_CHANNEL_ID"], recreated: true });
    expect(envText(fx)).toBe('ADMIN_USER_IDS=123456, 234567\nWOW_REALM="stormrage"\nANNOUNCE_CHANNEL_ID=22222\n');
    // The #51-item-5 guard's `docker ps` check runs first, then the real recreate.
    expect(dockerCalls(fx)).toEqual([
      expect.stringContaining("ps -a --filter"),
      expect.stringContaining("up -d --force-recreate"),
    ]);
  });

  test("the issue's literal case — a 3-segment DMF_TIMEZONE stored — keeps working (regex widened by #69)", async () => {
    const fx = setup("DMF_TIMEZONE=America/Indiana/Indianapolis\nANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], await fullBody(fx, { ANNOUNCE_CHANNEL_ID: "22222" }));
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["ANNOUNCE_CHANNEL_ID"] });
    expect(envText(fx)).toBe("DMF_TIMEZONE=America/Indiana/Indianapolis\nANNOUNCE_CHANNEL_ID=22222\n");
  });

  test("a value that IS changing is still validated: invalid -> exit 1 naming the key, nothing touched", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=not-a-snowflake\n");
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("env-set: value for 'ANNOUNCE_CHANNEL_ID' is invalid");
    expect(envText(fx)).toBe("ANNOUNCE_CHANNEL_ID=11111\n");
    expect(existsSync(join(fx.cfg, "backups"))).toBe(false);
    // Only the #51-item-5 guard's own `docker ps` check ran — the invalid value never reached
    // the recreate step.
    expect(dockerCalls(fx)).toEqual([expect.stringContaining("ps -a --filter")]);
  });

  test("validation runs only over CHANGED keys, and names the first invalid one in submission order", async () => {
    // The stored WOW_REGION=US is itself regex-invalid (uppercase): submitted unchanged it must never
    // be judged — the old validate-everything order named it. The two changed-and-invalid lines are
    // named in the order they were sent, whichever comes first.
    const fx = setup("WOW_REGION=US\n");
    const a = await botOps(fx, ["env-set"], "WOW_REGION=US\nAUTO_UPDATE=maybe\nBOT_BRANCH=bad branch\n");
    expect(a.exitCode).toBe(1);
    expect(a.stderr).toContain("value for 'AUTO_UPDATE' is invalid");
    const b = await botOps(fx, ["env-set"], "WOW_REGION=US\nBOT_BRANCH=bad branch\nAUTO_UPDATE=maybe\n");
    expect(b.exitCode).toBe(1);
    expect(b.stderr).toContain("value for 'BOT_BRANCH' is invalid");
    expect(envText(fx)).toBe("WOW_REGION=US\n");
  });

  test("a key repeated on stdin: the last value wins, like .env itself, and only it is judged", async () => {
    const fx = setup("AUTO_UPDATE=false\n");
    const run = await botOps(fx, ["env-set"], "AUTO_UPDATE=maybe\nAUTO_UPDATE=true\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["AUTO_UPDATE"] });
    expect(envText(fx)).toBe("AUTO_UPDATE=true\n");
  });

  test("an empty value is accepted without the regex and clears the key", async () => {
    const fx = setup("BOT_BRANCH=dev\n");
    const run = await botOps(fx, ["env-set"], "BOT_BRANCH=\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["BOT_BRANCH"] });
    expect(envText(fx)).toBe("BOT_BRANCH=\n");
    expect((await envGet(fx)).BOT_BRANCH).toBe("");
  });

  test("a key outside the whitelist is refused up front, changed or not", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\nDISCORD_TOKEN=secret\n");
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=11111\nDISCORD_TOKEN=secret\n");
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("'DISCORD_TOKEN' is not an editable key");
    expect(dockerCalls(fx)).toEqual([expect.stringContaining("ps -a --filter")]);
  });

  test("a malformed line is refused as such — including an empty or non-key-shaped key", async () => {
    const fx = setup("");
    for (const bad of ["NOEQUALS\n", "=value\n", "a b=1\n", "1KEY=1\n", " WOW_REGION=eu\n"]) {
      const run = await botOps(fx, ["env-set"], bad);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("malformed input line");
      expect(run.stderr).not.toContain("bad array subscript"); // the raw bash error `=value` used to trip
    }
  });

  test("submitting the stored value spelled differently (quotes, CR, export, duplicate) is a no-op", async () => {
    const stored = 'WOW_REALM="stormrage"\r\nexport WOW_REGION=eu\nBOT_BRANCH=main\nBOT_BRANCH=dev\n';
    const fx = setup(stored);
    const run = await botOps(fx, ["env-set"], "WOW_REALM=stormrage\nWOW_REGION=eu\nBOT_BRANCH=dev\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ ok: true, changed: [], recreated: false, note: "no changes" });
    expect(envText(fx)).toBe(stored); // byte-identical: no rewrite, quotes and CR left alone
    expect(dockerCalls(fx)).toEqual([expect.stringContaining("ps -a --filter")]);
  });

  test("a duplicated key is diffed against its LAST (effective) value, and every copy is rewritten", async () => {
    const fx = setup("WOW_REGION=us\nWOW_REGION=eu\n");
    const run = await botOps(fx, ["env-set"], "WOW_REGION=us\n"); // equals the first copy, not the effective one
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["WOW_REGION"] });
    expect(envText(fx)).toBe("WOW_REGION=us\nWOW_REGION=us\n");
    expect((await envGet(fx)).WOW_REGION).toBe("us");
  });

  test("changing an exported or indented key rewrites that line in place — no duplicate appended", async () => {
    const fx = setup("export WOW_REGION=eu\n  BOT_BRANCH=dev\nANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], "WOW_REGION=us\nBOT_BRANCH=main\n");
    expect(run.exitCode).toBe(0);
    expect(envText(fx)).toBe("WOW_REGION=us\nBOT_BRANCH=main\nANNOUNCE_CHANNEL_ID=11111\n");
    expect(dockerCalls(fx)).toHaveLength(2); // the #51-item-5 guard's `ps` check, then the recreate
  });

  test("a .env whose LAST line has no trailing newline is still read by load_env_values", async () => {
    // The whitelisted key is deliberately the unterminated last line: load_env_values (env-get,
    // and env-set's diff) is a SEPARATE read loop from the rewrite loop below, and a fixture that
    // only puts the no-newline line in an unwhitelisted key would never exercise this one — env-get
    // only reports ALLOWED_ORDER keys, so a dropped unwhitelisted line is invisible either way.
    const fx = setup("DISCORD_TOKEN=secret\nWOW_REGION=us"); // no final \n — writeFileSync writes it raw
    expect(readFileSync(fx.envFile, "utf8").endsWith("\n")).toBe(false);
    expect((await envGet(fx)).WOW_REGION).toBe("us");
    // And the diff sees it too: submitting the same value is a no-op, not a "was empty" false change.
    const run = await botOps(fx, ["env-set"], "WOW_REGION=us\n");
    expect(run.json).toEqual({ ok: true, changed: [], recreated: false, note: "no changes" });
  });

  test("a real change preserves an untouched, no-trailing-newline LAST line through the rewrite", async () => {
    // Here the no-newline last line is the one the rewrite loop (a separate read loop again) must
    // carry through untouched while a DIFFERENT key is the one being changed.
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\nWOW_REGION=us"); // no final \n
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).toBe(0);
    expect(envText(fx)).toBe("ANNOUNCE_CHANNEL_ID=22222\nWOW_REGION=us\n"); // survives, gains its \n
  });

  test("a real change to a CRLF file leaves the untouched lines' CR in place", async () => {
    const fx = setup("WOW_REGION=us\r\nexport DMF_TIMEZONE=UTC\r\nANNOUNCE_CHANNEL_ID=11111\r\n");
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).toBe(0);
    expect(envText(fx)).toBe("WOW_REGION=us\r\nexport DMF_TIMEZONE=UTC\r\nANNOUNCE_CHANNEL_ID=22222\n");
  });

  test("saving a key whose stored value has an unterminated quote rewrites it clean (repairs the file)", async () => {
    const fx = setup('WOW_REALM="abc\n');
    expect((await envGet(fx)).WOW_REALM).toBe('"abc');
    const run = await botOps(fx, ["env-set"], "WOW_REALM=abc\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["WOW_REALM"] });
    expect(envText(fx)).toBe("WOW_REALM=abc\n");
  });

  test("a real change backs up, rewrites only the changed lines, appends a new key, recreates once", async () => {
    const stored = "# comment kept\nDISCORD_TOKEN=secret\nANNOUNCE_CHANNEL_ID=11111\n";
    const fx = setup(stored);
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\nWOW_REGION=eu\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, recreated: true });
    expect([...(run.json!.changed as string[])].sort()).toEqual(["ANNOUNCE_CHANNEL_ID", "WOW_REGION"]);
    expect(envText(fx)).toBe("# comment kept\nDISCORD_TOKEN=secret\nANNOUNCE_CHANNEL_ID=22222\nWOW_REGION=eu\n");
    const backups = readdirSync(join(fx.cfg, "backups"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(fx.cfg, "backups", backups[0]!), "utf8")).toBe(stored);
    expect(dockerCalls(fx)).toEqual([
      expect.stringContaining("ps -a --filter"),
      expect.stringContaining("-p probe-project up -d --force-recreate"),
    ]);
  });

  test("a chmod failure after .env is rewritten still prints the JSON result and recreates (issue #47's failure class)", async () => {
    // A failing `chmod` shim ahead of the real one on PATH stands in for the exotic real-world
    // cases where chmod itself can fail (read-only remount, immutable attr, ACL/quota) — unlike
    // chown, which fails routinely for a non-root deploy-user run. Without the `|| warn` guard,
    // `set -e` would exit right here, before the closing `jq -n` ever runs, discarding the JSON
    // result for a .env rewrite that already happened.
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    writeFileSync(
      join(fx.bin, "chmod"),
      ["#!/usr/bin/env bash", "echo 'chmod: fake failure' >&2", "exit 1", ""].join("\n"),
      { mode: 0o755 },
    );
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["ANNOUNCE_CHANNEL_ID"], recreated: true });
    expect(run.stderr).toContain("bot-ops: warning: couldn't set .env permissions to 600");
    expect(envText(fx)).toBe("ANNOUNCE_CHANNEL_ID=22222\n");
    expect(dockerCalls(fx)).toEqual([
      expect.stringContaining("ps -a --filter"),
      expect.stringContaining("up -d --force-recreate"),
    ]);
  });
});

describe.skipIf(!runnable)("bot-ops.sh env-set refuses a blank REQUIRED key (issue #45)", () => {
  test("the issue's literal case: blanking ANNOUNCE_CHANNEL_ID exits non-zero, names the key, .env untouched", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=\n");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("env-set: 'ANNOUNCE_CHANNEL_ID' is required and cannot be blank");
    expect(envText(fx)).toBe("ANNOUNCE_CHANNEL_ID=11111\n");
    expect(existsSync(join(fx.cfg, "backups"))).toBe(false);
    expect(dockerCalls(fx)).toEqual([expect.stringContaining("ps -a --filter")]);
  });

  test("blanking a required key alongside a valid, unrelated change rejects the WHOLE submission", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\nWOW_REGION=us\n");
    const run = await botOps(fx, ["env-set"], "WOW_REGION=eu\nANNOUNCE_CHANNEL_ID=\n");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("'ANNOUNCE_CHANNEL_ID' is required and cannot be blank");
    expect(envText(fx)).toBe("ANNOUNCE_CHANNEL_ID=11111\nWOW_REGION=us\n"); // WOW_REGION change never applied either
    expect(dockerCalls(fx)).toEqual([expect.stringContaining("ps -a --filter")]);
  });

  test("a non-required key still clears to blank normally — REQUIRED doesn't block unrelated keys", async () => {
    const fx = setup("BOT_BRANCH=dev\nANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], "BOT_BRANCH=\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["BOT_BRANCH"] });
    expect(envText(fx)).toBe("BOT_BRANCH=\nANNOUNCE_CHANNEL_ID=11111\n");
  });

  test("submitting the already-stored value (still blank) is a no-op, not a fresh rejection", async () => {
    // Mirrors the existing "submitting the stored value spelled differently is a no-op" test:
    // a value that isn't CHANGING was never this script's to judge, even a required one that's
    // already broken from before this fix existed.
    const fx = setup("ANNOUNCE_CHANNEL_ID=\nWOW_REGION=us\n");
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=\nWOW_REGION=eu\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["WOW_REGION"] });
    expect(envText(fx)).toBe("ANNOUNCE_CHANNEL_ID=\nWOW_REGION=eu\n");
  });
});

// Issue #51 item 5: a self-update briefly runs the replacement alongside the original under
// "<container>-next" before it takes the canonical name over. restart/env-set recreating or
// restarting the ORIGINAL in that window races retireOriginal's own stop/remove/rename and can
// leave two bots on the shared token — both commands must refuse outright rather than risk it.
// The container's mere existence must NOT be the whole signal (see the next describe block) —
// whether the CANONICAL name is still a running container is what actually distinguishes "still
// unresolved" from "stuck on a cosmetic rename failure, already safe."
describe.skipIf(!runnable)("bot-ops.sh refuses restart/env-set while a swap is mid-flight (issue #51)", () => {
  test("restart refuses when a <container>-next container exists and the original is still running", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n", { nextRunning: true, originalState: "running" });
    const run = await botOps(fx, ["restart"]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("a self-update is in progress");
    expect(run.stderr).toContain("probe-container-next");
    // The guard fires before the real restart — never told compose to touch anything.
    expect(dockerCalls(fx).some((c) => c.includes("compose"))).toBe(false);
  });

  test("env-set refuses when a <container>-next container exists and the original is still running — .env untouched, no backup", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n", { nextRunning: true, originalState: "running" });
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("a self-update is in progress");
    expect(envText(fx)).toBe("ANNOUNCE_CHANNEL_ID=11111\n");
    expect(existsSync(join(fx.cfg, "backups"))).toBe(false);
    expect(dockerCalls(fx).some((c) => c.includes("compose"))).toBe(false);
  });

  test("restart and env-set both proceed normally when nothing is mid-swap", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n"); // nextRunning defaults to false
    const restart = await botOps(fx, ["restart"]);
    expect(restart.exitCode).toBe(0);
    const envSet = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(envSet.exitCode).toBe(0);
    expect(envSet.json).toMatchObject({ ok: true, changed: ["ANNOUNCE_CHANNEL_ID"] });
  });
});

// retireOriginal tolerates its own post-stop remove/rename failing and never retries — cosmetic,
// per its own comment, since the bot is up and serving regardless. That can leave a fully healthy
// replacement permanently running under "<container>-next" with no self-heal. A guard keyed on
// the container's mere existence would then refuse restart/env-set FOREVER — worse than the race
// it exists to prevent. Once retireOriginal gets past stopping the original — its own documented
// "point of no return" — the original is no longer RUNNING, which is what tells this state apart
// from a swap that's still genuinely in progress.
describe.skipIf(!runnable)("bot-ops.sh doesn't lock out restart/env-set forever on a stuck-but-healthy swap (issue #51)", () => {
  // "stopped" is round 1's actual bug: the original's own removeContainer failed, leaving a
  // stopped-but-not-removed corpse still present under the canonical name. It matters that this
  // is modeled as PRESENT-but-stopped rather than fully gone: it's the one state that would also
  // (wrongly) match a `docker ps -a` query, so it's what actually catches a future edit that
  // accidentally adds `-a` back onto the guard's running-check and reintroduces the lockout.
  test("restart proceeds when <container>-next exists but the original is a stopped, unremoved corpse", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n", { nextRunning: true, originalState: "stopped" });
    const run = await botOps(fx, ["restart"]);
    expect(run.exitCode).toBe(0);
    expect(dockerCalls(fx).some((c) => c.includes("compose") && c.includes("restart"))).toBe(true);
  });

  test("env-set proceeds when <container>-next exists but the original is a stopped, unremoved corpse", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n", { nextRunning: true, originalState: "stopped" });
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["ANNOUNCE_CHANNEL_ID"] });
    expect(envText(fx)).toBe("ANNOUNCE_CHANNEL_ID=22222\n");
  });

  // The other half of retireOriginal's tolerant path: the original's remove actually succeeded
  // (fully gone), only the rename failed. Same expected outcome as the stopped-corpse case.
  test("restart proceeds when <container>-next exists but the original has been fully removed", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n", { nextRunning: true, originalState: "gone" });
    const run = await botOps(fx, ["restart"]);
    expect(run.exitCode).toBe(0);
  });
});

describe.skipIf(!runnable)("bot-ops.sh logs bounds N before the arithmetic clamp (issue #53 item 4)", () => {
  test("a 2^64 N is refused, not silently wrapped past LOGS_MAX by bash's 64-bit arithmetic", async () => {
    const fx = setup("");
    const run = await botOps(fx, ["logs", "18446744073709551616"]); // 2^64: wraps to 0 in `(( ))`
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("logs: N must be a number");
    expect(dockerCalls(fx)).toHaveLength(0); // never reaches `docker logs` at all
  });

  test("a 6-digit N is refused too, even though it would never overflow", async () => {
    const fx = setup("");
    const run = await botOps(fx, ["logs", "123456"]);
    expect(run.exitCode).not.toBe(0);
    expect(dockerCalls(fx)).toHaveLength(0);
  });

  test("an in-bounds N over LOGS_MAX still clamps to 5000, unaffected by the tighter regex", async () => {
    const fx = setup("");
    const run = await botOps(fx, ["logs", "99999"]);
    expect(run.exitCode).toBe(0);
    expect(dockerCalls(fx)).toEqual(["docker logs probe-container --tail 5000"]);
  });

  test("the default (no N given) still works", async () => {
    const fx = setup("");
    const run = await botOps(fx, ["logs"]);
    expect(run.exitCode).toBe(0);
    expect(dockerCalls(fx)).toEqual(["docker logs probe-container --tail 200"]);
  });
});

describe.skipIf(!runnable)("bot-ops.sh env-set's temp file is atomic and self-cleaning (issue #54)", () => {
  test("the temp file is created in CONFIG_DIR, not $TMPDIR — so a cross-filesystem mv can't happen", async () => {
    // mktemp -p "$CONFIG_DIR" ignores TMPDIR entirely (an explicit -p wins). A bare `mktemp`
    // would instead fall back to this bogus TMPDIR and die before ever reaching ENV_FILE — this
    // is a real regression test for the EXDEV risk the issue describes (env-set usually runs
    // from the admin container, where the default temp dir is a different filesystem from
    // CONFIG_DIR's own bind mount): it fails against the pre-fix `tmp="$(mktemp)"` and passes
    // once the temp file is pinned to CONFIG_DIR.
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const bogusTmp = join(fx.root, "nonexistent-tmpdir");
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n", {
      TMPDIR: bogusTmp,
      TMP: bogusTmp,
      TEMP: bogusTmp,
    });
    expect(run.exitCode).toBe(0);
    expect(envText(fx)).toBe("ANNOUNCE_CHANNEL_ID=22222\n");
  });

  test("a failed rewrite leaves no leftover temp file in CONFIG_DIR (EXIT trap)", async () => {
    // Mirrors the existing fake-chmod-failure test's shim-injection style. mv is only ever
    // called at this one spot in the whole script, so faking it on PATH targets exactly this
    // failure without touching anything else env-set does.
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    writeFileSync(
      join(fx.bin, "mv"),
      ["#!/usr/bin/env bash", "echo 'mv: fake failure' >&2", "exit 1", ""].join("\n"),
      { mode: 0o755 },
    );
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).not.toBe(0);
    expect(envText(fx)).toBe("ANNOUNCE_CHANNEL_ID=11111\n"); // mv never landed — original untouched
    const leftovers = readdirSync(fx.cfg).filter((f) => f !== ".env" && f !== "backups");
    expect(leftovers).toHaveLength(0);
  });
});

// Issue #101: bot-ops.sh learns about plugins — the PLUGINS / PLUGIN_INDEX_URL static rows, the
// manifest-declared env keys of the installed plugins (merged into env-get / env-set from the
// container's cached index, never hand-mirrored), and status.plugins.

/** The real WARBANDEER_INGEST_PORT format (the 1-65535 shape #100 moved off the static whitelist). */
const PORT_RE = "^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$";

/** One PluginEnvKey (contract.ts) — `key`/`format`/`description` plus optional `required`/`secret`. */
function envKey(key: string, format: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { key, format, description: `${key} desc`, ...extra };
}
/** One PluginIndexEntry with just the fields load_plugin_keys reads (name + env). */
function pluginEntry(name: string, env: unknown[]): Record<string, unknown> {
  return {
    name,
    package: `@rackbops/plugin-${name}`,
    version: "1.0.0",
    description: `${name} plugin`,
    hostApiVersion: 1,
    commands: [],
    env,
    releases: [],
  };
}
/** The on-disk cached index is the CachedPluginIndex WRAPPER `{writtenAt, index}` — the manifest is
 *  at `.index.plugins`, which is what bot-ops.sh's `.index.plugins` jq path depends on. */
function wrapIndex(plugins: unknown[]): string {
  return JSON.stringify({
    writtenAt: "2026-09-05T00:00:00.000Z",
    index: { schemaVersion: 1, generatedAt: "2026-09-05T00:00:00.000Z", plugins },
  });
}

describe.skipIf(!runnable)("bot-ops.sh whitelists PLUGINS / PLUGIN_INDEX_URL (#101)", () => {
  test("PLUGINS accepts bare names and name@version, comma-separated; rejects bad shapes", async () => {
    const fx = setup("PLUGINS=warbandeer\n");
    for (const good of ["warbandeer,foo", "warbandeer@1.2.3", "a-b,c@0.0.0-rc.1"]) {
      const run = await botOps(fx, ["env-set"], `PLUGINS=${good}\n`);
      expect(run.exitCode).toBe(0);
      expect(run.json).toMatchObject({ changed: ["PLUGINS"] });
    }
    for (const bad of ["Warbandeer", "foo bar", "a,,b", "1foo", "foo@"]) {
      const run = await botOps(fx, ["env-set"], `PLUGINS=${bad}\n`);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("value for 'PLUGINS' is invalid");
    }
  });

  test("PLUGIN_INDEX_URL accepts http(s)/file/absolute path; rejects other shapes", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    for (const good of ["https://example.com/plugins.json", "http://x/y", "file:///opt/p.json", "/opt/plugins.json"]) {
      expect((await botOps(fx, ["env-set"], `PLUGIN_INDEX_URL=${good}\n`)).exitCode).toBe(0);
    }
    for (const bad of ["ftp://x/y", "example.com/p.json", "relative/path.json", "http:// space"]) {
      const run = await botOps(fx, ["env-set"], `PLUGIN_INDEX_URL=${bad}\n`);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("value for 'PLUGIN_INDEX_URL' is invalid");
    }
  });

  test("WARBANDEER_INGEST_PORT is no longer a static key — refused when no plugin declares it", async () => {
    // #100 removed the baked-in connector; with no plugins installed the key is unknown to the
    // whitelist. (It comes back via the manifest once warbandeer is installed — see below.)
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], "WARBANDEER_INGEST_PORT=8080\n");
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("'WARBANDEER_INGEST_PORT' is not an editable key");
    expect(await envGet(fx)).not.toHaveProperty("WARBANDEER_INGEST_PORT");
  });
});

describe.skipIf(!runnable)("bot-ops.sh env-get lists installed plugins' non-secret keys (#101)", () => {
  test("only the enabled plugin's non-secret keys appear, after the static ones, in manifest order", async () => {
    const index = wrapIndex([
      pluginEntry("a", [envKey("A_ONE", "^[a-z]+$"), envKey("A_SECRET", "^.+$", { secret: true }), envKey("A_TWO", "^[0-9]+$")]),
      pluginEntry("b", [envKey("B_ONE", "^.+$")]),
    ]);
    const fx = setup("PLUGINS=a\nANNOUNCE_CHANNEL_ID=11111\nA_ONE=xyz\n", { pluginIndex: index });
    const env = await envGet(fx);
    expect(env.A_ONE).toBe("xyz"); // listed, with its effective value from .env
    expect(env.A_TWO).toBe(""); // listed even when unset in .env
    expect(env).not.toHaveProperty("A_SECRET"); // a secret key is never listed
    expect(env).not.toHaveProperty("B_ONE"); // plugin b isn't in PLUGINS
    const keys = Object.keys(env);
    expect(keys).toContain("PLUGINS");
    expect(keys.slice(-2)).toEqual(["A_ONE", "A_TWO"]); // plugin keys after the static ones, manifest order
  });
});

describe.skipIf(!runnable)("bot-ops.sh env-set validates an installed plugin's key from the manifest (#101)", () => {
  const index = wrapIndex([
    pluginEntry("warbandeer", [envKey("WARBANDEER_INGEST_PORT", PORT_RE), envKey("WARBANDEER_SECRET", "^.+$", { secret: true })]),
  ]);

  test("a stored out-of-regex plugin value never blocks an unrelated change (diff-then-validate)", async () => {
    // WARBANDEER_INGEST_PORT=abc is invalid but UNCHANGED — a value that isn't changing was never
    // this script's to judge, exactly as for a static key (issue #44). Validating before diffing
    // would make this fail.
    const fx = setup("PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=11111\nWARBANDEER_INGEST_PORT=abc\n", { pluginIndex: index });
    const run = await botOps(fx, ["env-set"], "WARBANDEER_INGEST_PORT=abc\nANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["ANNOUNCE_CHANNEL_ID"], recreated: true });
    expect(envText(fx)).toBe("PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=22222\nWARBANDEER_INGEST_PORT=abc\n");
  });

  test("a CHANGED plugin value is validated against the manifest format and named when invalid", async () => {
    const fx = setup("PLUGINS=warbandeer\nWARBANDEER_INGEST_PORT=8080\n", { pluginIndex: index });
    const run = await botOps(fx, ["env-set"], "WARBANDEER_INGEST_PORT=99999\n"); // > 65535
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("env-set: value for 'WARBANDEER_INGEST_PORT' is invalid");
    expect(envText(fx)).toBe("PLUGINS=warbandeer\nWARBANDEER_INGEST_PORT=8080\n"); // untouched
    expect(existsSync(join(fx.cfg, "backups"))).toBe(false);
  });

  test("a valid plugin-key change backs up, rewrites, and recreates once — reading the index between the guard and the recreate", async () => {
    const fx = setup("PLUGINS=warbandeer\nWARBANDEER_INGEST_PORT=8080\n", { pluginIndex: index });
    const run = await botOps(fx, ["env-set"], "WARBANDEER_INGEST_PORT=9090\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["WARBANDEER_INGEST_PORT"], recreated: true });
    expect(envText(fx)).toBe("PLUGINS=warbandeer\nWARBANDEER_INGEST_PORT=9090\n");
    expect(readdirSync(join(fx.cfg, "backups"))).toHaveLength(1);
    expect(dockerCalls(fx)).toEqual([
      expect.stringContaining("ps -a --filter"),
      expect.stringContaining("exec probe-container cat /app/data/plugins/index.json"),
      expect.stringContaining("up -d --force-recreate"),
    ]);
  });

  test("a secret plugin key is refused as not editable, and never listed by env-get", async () => {
    const fx = setup("PLUGINS=warbandeer\n", { pluginIndex: index });
    const set = await botOps(fx, ["env-set"], "WARBANDEER_SECRET=hunter2\n");
    expect(set.exitCode).toBe(1);
    expect(set.stderr).toContain("'WARBANDEER_SECRET' is not an editable key");
    const env = await envGet(fx);
    expect(env).not.toHaveProperty("WARBANDEER_SECRET");
    expect(env).toHaveProperty("WARBANDEER_INGEST_PORT"); // the non-secret sibling IS listed
  });
});

describe.skipIf(!runnable)("bot-ops.sh env-get is graceful when the Plugin Index can't be read (#101)", () => {
  test("PLUGINS set but no cached index → static keys only, a note on stderr, exit 0", async () => {
    // No pluginIndex fixture, so the shim prints nothing for the exec cat — the file isn't there.
    const fx = setup("PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-get"]);
    expect(run.exitCode).toBe(0); // never an error (D3)
    expect(run.stderr).toContain("plugins: index unavailable");
    const env = run.json as Record<string, string>;
    expect(env).toHaveProperty("PLUGINS", "warbandeer");
    expect(env).not.toHaveProperty("WARBANDEER_INGEST_PORT"); // couldn't read the manifest
    expect(Object.keys(env)).toHaveLength(14); // the 14 static keys, nothing merged
  });

  test("no PLUGINS set → no docker read at all, no note", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-get"]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain("index unavailable");
    expect(dockerCalls(fx)).toHaveLength(0); // load_plugin_keys short-circuits before docker
  });
});

describe.skipIf(!runnable)("bot-ops.sh status includes the plugin state (#101)", () => {
  test("status.plugins carries the state file's .plugins array", async () => {
    const state = JSON.stringify({
      hostApiVersion: 1,
      writtenAt: "2026-09-05T00:00:00.000Z",
      plugins: [{ name: "warbandeer", enabled: true, installedVersion: "1.0.0", configured: true, missingEnv: [], active: true }],
    });
    const fx = setup("PLUGINS=warbandeer\n", { pluginState: state });
    const run = await botOps(fx, ["status"]);
    expect(run.exitCode).toBe(0);
    expect(run.json?.plugins).toEqual([
      { name: "warbandeer", enabled: true, installedVersion: "1.0.0", configured: true, missingEnv: [], active: true },
    ]);
  });

  test("status.plugins is [] when the plugin state file is absent", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n"); // no pluginState fixture
    const run = await botOps(fx, ["status"]);
    expect(run.exitCode).toBe(0);
    expect(run.json?.plugins).toEqual([]);
  });
});
