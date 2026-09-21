// Real-bash tests for ops/bot-ops.sh's env-get / env-set: the script is spawned as-is against a
// throwaway config dir, with a fake `docker` shim first on PATH (it logs its argv and exits 0, so
// `up -d --force-recreate` never reaches a daemon) and `jq` from the host. Discovered by the root
// `bun test` the same way ops/admin/server.test.ts is. Needs bash + jq on PATH; on a box without
// them the whole file skips LOUDLY rather than passing vacuously. On Windows, Git's own bash is
// used — a WSL bash.exe earlier on PATH would run the script against a different filesystem.
import { afterEach, describe, expect, test as bunTest } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repairRouting } from "../src/routing/model";

// Every test here spawns real bash + jq, ~0.3-0.5 s a call on Windows; a test that loops over a
// table of cases (the #240 request-validation ones do) can pass Bun's 5 s default on a loaded box, so
// each test gets a minute instead. Same test bodies, same names; only the ceiling moves.
const test = (name: string, fn: () => void | Promise<void>) => bunTest(name, fn, 60_000);

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
    /** cmd_status's single `docker ps -a --filter ... --format '{{.State}}\t{{.Status}}\t{{.Image}}'`
     *  call (#59/#143) — matched on the literal `{{.State}}` template text, distinct from the
     *  `{{.Names}}`-format `ps` calls `nextRunning`/`originalState` simulate. Absent → the shim
     *  prints nothing, same as a `status` call against a container that doesn't exist. */
    containerMeta?: { state: string; status: string; image: string };
    /** Fixture JSON the fake `docker exec … cat` returns for the bot's cached Plugin Index
     *  (`/app/data/plugins/index.json` — the CachedPluginIndex wrapper `{writtenAt, index}`) and
     *  Plugin State (`/app/data/plugins/state.json`). Absent → the shim prints nothing for that
     *  path, i.e. the file isn't there in the container (index unavailable / no state). */
    pluginIndex?: string;
    pluginState?: string;
    /** Fixture text the fake `docker exec … cat` returns for the bot's routing record and its
     *  discovery file (`/app/data/routing.json`, `/app/data/discovery.json` — #240), verbatim, so a
     *  test can serve corrupt or hand-edited content. Absent → the file isn't in the container. The
     *  shim matches by substring, and `/app/data/routing.json` is not a substring of the bot's
     *  webhook store's path, so the two can never be confused (asserted in a test, not assumed). */
    routing?: string;
    discovery?: string;
    /** What the fake `docker compose … up -d --force-recreate` prints (the script merges stderr into
     *  stdout) and exits with — for the tests that check a recreate message can't carry a secret. */
    composeUp?: { output: string; exitCode?: number };
    /** Inject a failure into the plugin-request write (see the exec handler in setup()). */
    requestWrite?: "mv-fails" | "exec-fails";
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
  const routingFile = join(root, "routing.json");
  const discoveryFile = join(root, "discovery.json");
  const composeOutFile = join(root, "compose-up-output.txt");
  if (opts.routing !== undefined) writeFileSync(routingFile, opts.routing);
  if (opts.discovery !== undefined) writeFileSync(discoveryFile, opts.discovery);
  if (opts.composeUp !== undefined) writeFileSync(composeOutFile, opts.composeUp.output);
  const execHandler = [
    // An absent routing / discovery file exits 1, as a real `docker exec … cat <missing>` does (unlike the
    // older index / state handlers below, which stay silent with status 0) — routing-get must survive it.
    opts.routing !== undefined
      ? `if [[ "$1" == "exec" ]] && [[ "$*" == *"/app/data/routing.json"* ]]; then cat ${JSON.stringify(bashPath(routingFile))}; fi`
      : `if [[ "$1" == "exec" ]] && [[ "$*" == *"/app/data/routing.json"* ]]; then exit 1; fi`,
    opts.discovery !== undefined
      ? `if [[ "$1" == "exec" ]] && [[ "$*" == *"/app/data/discovery.json"* ]]; then cat ${JSON.stringify(bashPath(discoveryFile))}; fi`
      : `if [[ "$1" == "exec" ]] && [[ "$*" == *"/app/data/discovery.json"* ]]; then exit 1; fi`,
    opts.composeUp !== undefined
      ? `if [[ "$1" == "compose" ]] && [[ "$*" == *"up -d --force-recreate"* ]]; then cat ${JSON.stringify(bashPath(composeOutFile))}; exit ${opts.composeUp.exitCode ?? 0}; fi`
      : "",
    opts.pluginIndex !== undefined
      ? `if [[ "$1" == "exec" ]] && [[ "$*" == *"/app/data/plugins/index.json"* ]]; then cat ${JSON.stringify(bashPath(pluginIndexFile))}; fi`
      : "",
    opts.pluginState !== undefined
      ? `if [[ "$1" == "exec" ]] && [[ "$*" == *"/app/data/plugins/state.json"* ]]; then cat ${JSON.stringify(bashPath(pluginStateFile))}; fi`
      : "",
    // #105 plugin-request write. The fake records the piped payload (request-stdin.json) so a test can
    // assert the round-trip, AND runs the `sh -c` the script sent for real, with `/app/data` pointed at
    // <bin>/data, so the temp-then-rename write and its cleanup are exercised, not just string-matched.
    // opts.requestWrite injects a failure: "mv-fails" makes the rename fail after the body is written,
    // "exec-fails" makes the whole `docker exec` fail (container not running).
    opts.requestWrite === "exec-fails"
      ? `if [[ "$1" == "exec" ]] && [[ "$*" == *"/app/data/plugins/requests"* ]]; then cat > /dev/null; echo "Error response from daemon: container is not running" >&2; exit 1; fi`
      : [
          `if [[ "$1" == "exec" ]] && [[ "$*" == *"/app/data/plugins/requests"* ]]; then`,
          `  cmd="\${@: -1}"; data="$(dirname "$0")/data"; cmd="\${cmd//\\/app\\/data/$data}"`,
          opts.requestWrite === "mv-fails" ? `  cmd="\${cmd// mv / false }"` : "",
          `  tee "$(dirname "$0")/request-stdin.json" | sh -c "$cmd"; exit "\${PIPESTATUS[1]}"`,
          `fi`,
        ]
          .filter(Boolean)
          .join("\n"),
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
      // cmd_status's one-shot metadata read — matched on the `{{.State}}` template text, which is
      // unique to that call (the swap-guard's `ps` queries above use `{{.Names}}`). Not meant to be
      // combined with nextRunning in the same fixture (no test needs both).
      opts.containerMeta
        ? [
            `if [[ "$1" == "ps" ]] && [[ "$*" == *'{{.State}}'* ]]; then`,
            `  printf '%s\\t%s\\t%s\\n' ${JSON.stringify(opts.containerMeta.state)} ${JSON.stringify(opts.containerMeta.status)} ${JSON.stringify(opts.containerMeta.image)}`,
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
interface SchemaEntry {
  pattern: string;
  required: boolean;
  source: string;
}
const envSchema = async (fx: Fixture): Promise<Record<string, SchemaEntry>> => {
  const run = await botOps(fx, ["env-schema"]);
  expect(run.exitCode).toBe(0);
  return run.json as unknown as Record<string, SchemaEntry>;
};
const dockerCalls = (fx: Fixture): string[] => {
  const log = join(fx.bin, "docker.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
};
/** dockerCalls with the read-only `exec … cat /app/data/plugins/index.json` reads load_plugin_keys
 *  makes dropped — for the .env-mechanics tests, whose fixtures now carry PLUGINS=wow (so the whitelist
 *  is built from the plugin index) but which assert on the recreate/guard ops, not that read. Tests that
 *  DO assert on the index read (or a plugin-request write) use `dockerCalls` directly. */
const recreateCalls = (fx: Fixture): string[] =>
  dockerCalls(fx).filter((c) => !(c.includes("exec") && c.includes("/app/data/plugins/index.json")));
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

// Its own describe rather than nested in the #41 block above: that one is about the vars being
// REQUIRED, this is about the shape of the value once given, and #60 work reporting under a "(issue
// #41)" heading is misleading in test output.
describe.skipIf(!runnable)("bot-ops.sh requires BOT_OPS_CONFIG_DIR/BOT_OPS_COMPOSE_FILE to be absolute (issue #60 item 4)", () => {
  // #60 item 4: a relative path resolves against whatever cwd the script was invoked from. For a
  // maintainer running this out of a clone that is the checkout, and `env-set` would then rewrite
  // the checkout's own .env and drop backups/.env.bak.* — a live token — beside it. Deployed
  // invocations are always absolute, so this rejects only the hand-run mistake. `src/storage.ts`
  // has cited BOT_OPS_CONFIG_DIR as the absolute-only precedent for BOT_DATA_DIR since #139; until
  // this guard existed that was a claim about a rule nothing enforced.
  for (const [name, value] of [
    ["BOT_OPS_CONFIG_DIR", "."],
    ["BOT_OPS_CONFIG_DIR", "./config"],
    ["BOT_OPS_COMPOSE_FILE", "docker-compose.yml"],
  ] as const) {
    test(`a relative ${name} (${value}) dies before touching docker`, async () => {
      const fx = setup("");
      const run = await botOps(fx, ["status"], undefined, { [name]: value });
      expect(run.exitCode).not.toBe(0);
      // Matched as the one whole quoted phrase, not `${name}` and `${value}` separately: for
      // value "." a bare toContain(value) passes against any stderr with a full stop in it —
      // vacuously true of the message itself. This pins that the offending value is echoed back,
      // quoted, so the operator can see the empty-looking path they actually passed.
      expect(run.stderr).toContain(`${name} must be an absolute path, got "${value}"`);
      expect(dockerCalls(fx)).toHaveLength(0);
    });
  }

  test("an absolute config dir and compose file still run normally", async () => {
    const fx = setup("");
    const run = await botOps(fx, ["status"]);
    // Not just "no rejection message": the guard runs before docker is touched, so proving it
    // didn't fire means proving the run got all the way *past* it to a normal successful status.
    // Asserting only the absent string would still pass if the script died for some other reason.
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain("must be an absolute path");
    expect(dockerCalls(fx).length).toBeGreaterThan(0);
  });
});

// The three keys #107 moved off bot-ops.sh's static whitelist into @rackbops/plugin-wow. The
// .env-mechanics tests below use them as their permissive-key palette (region / realm-slug / IANA-zone
// shapes) — which post-#107 means seeding a cached Plugin Index so load_plugin_keys merges them back
// when PLUGINS=wow, exactly as they become editable in production. `wowSetup` prepends PLUGINS=wow +
// seeds the index; `wowEnv` is the matching expected-.env prefix.
const WOW_INDEX = JSON.stringify({
  writtenAt: "2026-09-05T00:00:00.000Z",
  index: {
    schemaVersion: 1,
    generatedAt: "2026-09-05T00:00:00.000Z",
    plugins: [
      {
        name: "wow",
        package: "@rackbops/plugin-wow",
        version: "1.0.0",
        description: "wow plugin",
        hostApiVersion: 1,
        commands: [],
        env: [
          { key: "WOW_REGION", format: "^(us|eu)$", description: "region" },
          { key: "WOW_REALM", format: "^[a-z0-9àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ-]{1,40}$", description: "realm" },
          { key: "DMF_TIMEZONE", format: "^[A-Za-z0-9+_-]+(/[A-Za-z0-9+_-]+){0,2}$", description: "tz" },
        ],
        releases: [],
      },
    ],
  },
});
const wowSetup = (envText: string): Fixture => setup(`PLUGINS=wow\n${envText}`, { pluginIndex: WOW_INDEX });
const wowEnv = (text: string): string => `PLUGINS=wow\n${text}`;

describe.skipIf(!runnable)("bot-ops.sh env-get reads .env the way compose's env_file loader does (issue #44)", () => {
  test("the LAST occurrence of a duplicated key wins, not the first", async () => {
    const fx = wowSetup("WOW_REGION=us\nWOW_REGION=eu\n");
    expect((await envGet(fx)).WOW_REGION).toBe("eu");
  });

  test("one layer of matching quotes is stripped; a mismatched or lone quote is left alone", async () => {
    // Compose refuses to load a file with an unterminated quote at all ("unterminated quoted
    // value", verified with `docker compose config`), so there is no effective value to mirror
    // there: the raw text is the honest reading, and saving that key from the panel rewrites it
    // unquoted — which repairs the file.
    const fx = wowSetup(`WOW_REALM="stormrage"\nDMF_TIMEZONE='UTC'\nCOMMAND_PREFIX="abc\nBOT_BRANCH="\nWATCHED_REPOS='"'\n`);
    const env = await envGet(fx);
    expect(env.WOW_REALM).toBe("stormrage");
    expect(env.DMF_TIMEZONE).toBe("UTC");
    expect(env.COMMAND_PREFIX).toBe('"abc');
    expect(env.BOT_BRANCH).toBe('"');
    expect(env.WATCHED_REPOS).toBe('"'); // the outer single-quote pair goes, the inner char stays
  });

  test("a CRLF-saved file yields values without the trailing CR", async () => {
    const fx = wowSetup('ANNOUNCE_CHANNEL_ID=11111\r\nWOW_REGION=us\r\nWOW_REALM="hyjal"\r\n');
    const env = await envGet(fx);
    expect(env.ANNOUNCE_CHANNEL_ID).toBe("11111");
    expect(env.WOW_REGION).toBe("us");
    expect(env.WOW_REALM).toBe("hyjal");
  });

  test("an `export KEY=` line defines the key", async () => {
    const fx = wowSetup("export WOW_REGION=eu\n");
    expect((await envGet(fx)).WOW_REGION).toBe("eu");
  });

  test("an indented line defines the key too, as it does for compose", async () => {
    const fx = wowSetup("  WOW_REGION=eu\n\texport BOT_BRANCH=dev\n");
    const env = await envGet(fx);
    expect(env.WOW_REGION).toBe("eu");
    expect(env.BOT_BRANCH).toBe("dev");
  });

  test("whitespace around an unquoted value is trimmed; inside quotes it is kept", async () => {
    const fx = wowSetup('WOW_REGION=  eu \t\nCOMMAND_PREFIX="  r_  "\n');
    const env = await envGet(fx);
    expect(env.WOW_REGION).toBe("eu");
    expect(env.COMMAND_PREFIX).toBe("  r_  ");
  });

  test("a longer key and a commented-out line don't define the key; an absent key is empty", async () => {
    const fx = wowSetup("WOW_REGIONX=eu\n# WOW_REGION=eu\n\n");
    const env = await envGet(fx);
    expect(env.WOW_REGION).toBe("");
    expect(env.ANNOUNCE_CHANNEL_ID).toBe("");
    expect(Object.keys(env)).not.toContain("WOW_REGIONX"); // not whitelisted, so never reported
  });
});

// #133: ALLOWED and its display order are both derived from ALLOWED_SPEC now, so there is nothing
// left to drift — this pins the observable result of that (every whitelisted key present, in
// ALLOWED_SPEC's own declared order) against real bot-ops.sh output, the way the issue's own test
// table calls for. A hand-listed expected order, not scraped from the script's source: if
// ALLOWED_SPEC's order ever changes on purpose, this list gets a matching one-line update, same as
// any other pinned expectation.
describe.skipIf(!runnable)("bot-ops.sh env-get emits every whitelisted key, in ALLOWED_SPEC's order (#133)", () => {
  const EXPECTED_ORDER = [
    "DISCORD_SERVER_ID",
    "ANNOUNCE_CHANNEL_ID",
    "RELEASE_ANNOUNCE_CHANNEL_ID",
    "REPORT_ROLE_ID",
    "ADMIN_USER_IDS",
    "WATCHED_REPOS",
    "AUTO_UPDATE",
    "BOT_BRANCH",
    "COMMAND_PREFIX",
    "PLUGINS",
    "PLUGIN_INDEX_URL",
  ];

  test("every ALLOWED_SPEC key is present and in the declared order, with no plugins installed", async () => {
    const fx = setup("");
    const env = await envGet(fx);
    expect(Object.keys(env)).toEqual(EXPECTED_ORDER);
  });
});

describe.skipIf(!runnable)("bot-ops.sh env-set diffs against the effective value BEFORE validating (issue #44)", () => {
  test("a stored value the whitelist rejects no longer blocks saving an unrelated key", async () => {
    // ADMIN_USER_IDS with a space: config.ts trims it, the regex here doesn't. WOW_REALM quoted:
    // compose strips the quotes, the old env_value didn't. Both used to fail EVERY panel save.
    const stored = 'ADMIN_USER_IDS=123456, 234567\nWOW_REALM="stormrage"\nANNOUNCE_CHANNEL_ID=11111\n';
    const fx = wowSetup(stored);
    const body = await fullBody(fx, { ANNOUNCE_CHANNEL_ID: "22222" });
    // 11 static whitelisted keys (#101 dropped WARBANDEER_INGEST_PORT; #107 moved the 3 WoW keys to the
    // wow plugin) + the 3 wow plugin keys merged via PLUGINS=wow = 14 echoed, like the old panel.
    expect(body.split("\n")).toHaveLength(14);
    const run = await botOps(fx, ["env-set"], body);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["ANNOUNCE_CHANNEL_ID"], recreated: true });
    expect(envText(fx)).toBe(wowEnv('ADMIN_USER_IDS=123456, 234567\nWOW_REALM="stormrage"\nANNOUNCE_CHANNEL_ID=22222\n'));
    // The #51-item-5 guard's `docker ps` check runs first, then the real recreate.
    expect(recreateCalls(fx)).toEqual([
      expect.stringContaining("ps -a --filter"),
      expect.stringContaining("up -d --force-recreate"),
    ]);
  });

  test("the issue's literal case — a 3-segment DMF_TIMEZONE stored — keeps working (regex widened by #69)", async () => {
    const fx = wowSetup("DMF_TIMEZONE=America/Indiana/Indianapolis\nANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], await fullBody(fx, { ANNOUNCE_CHANNEL_ID: "22222" }));
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["ANNOUNCE_CHANNEL_ID"] });
    expect(envText(fx)).toBe(wowEnv("DMF_TIMEZONE=America/Indiana/Indianapolis\nANNOUNCE_CHANNEL_ID=22222\n"));
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
    const fx = wowSetup("WOW_REGION=US\n");
    const a = await botOps(fx, ["env-set"], "WOW_REGION=US\nAUTO_UPDATE=maybe\nBOT_BRANCH=bad branch\n");
    expect(a.exitCode).toBe(1);
    expect(a.stderr).toContain("value for 'AUTO_UPDATE' is invalid");
    const b = await botOps(fx, ["env-set"], "WOW_REGION=US\nBOT_BRANCH=bad branch\nAUTO_UPDATE=maybe\n");
    expect(b.exitCode).toBe(1);
    expect(b.stderr).toContain("value for 'BOT_BRANCH' is invalid");
    expect(envText(fx)).toBe(wowEnv("WOW_REGION=US\n"));
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

  test("empty stdin (nothing submitted) is a no-op, not an 'unbound variable' crash (issue #135 item 13)", async () => {
    // Guards the SUBMITTED/DIFF associative arrays staying genuinely empty end to end — the
    // hand-kept n_submitted/n_diff counters this used to lean on are gone (item 13); this proves
    // `${#SUBMITTED[@]}`/`${#DIFF[@]}` on a never-populated associative array behaves under
    // `set -u`, not just that the JSON shape is right. Mutation: reintroducing either counter
    // wrong (e.g. never zero-checked) would either crash under set -u or mis-skip this early
    // return.
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], "");
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ ok: true, changed: [], recreated: false, note: "no changes" });
    expect(dockerCalls(fx)).toEqual([expect.stringContaining("ps -a --filter")]);
  });

  test("submitting the stored value spelled differently (quotes, CR, export, duplicate) is a no-op", async () => {
    const stored = 'WOW_REALM="stormrage"\r\nexport WOW_REGION=eu\nBOT_BRANCH=main\nBOT_BRANCH=dev\n';
    const fx = wowSetup(stored);
    const run = await botOps(fx, ["env-set"], "WOW_REALM=stormrage\nWOW_REGION=eu\nBOT_BRANCH=dev\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ ok: true, changed: [], recreated: false, note: "no changes" });
    expect(envText(fx)).toBe(wowEnv(stored)); // byte-identical: no rewrite, quotes and CR left alone
    expect(recreateCalls(fx)).toEqual([expect.stringContaining("ps -a --filter")]);
  });

  test("a duplicated key is diffed against its LAST (effective) value, and every copy is rewritten", async () => {
    const fx = wowSetup("WOW_REGION=us\nWOW_REGION=eu\n");
    const run = await botOps(fx, ["env-set"], "WOW_REGION=us\n"); // equals the first copy, not the effective one
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["WOW_REGION"] });
    expect(envText(fx)).toBe(wowEnv("WOW_REGION=us\nWOW_REGION=us\n"));
    expect((await envGet(fx)).WOW_REGION).toBe("us");
  });

  test("changing an exported or indented key rewrites that line in place — no duplicate appended", async () => {
    const fx = wowSetup("export WOW_REGION=eu\n  BOT_BRANCH=dev\nANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], "WOW_REGION=us\nBOT_BRANCH=main\n");
    expect(run.exitCode).toBe(0);
    expect(envText(fx)).toBe(wowEnv("WOW_REGION=us\nBOT_BRANCH=main\nANNOUNCE_CHANNEL_ID=11111\n"));
    expect(recreateCalls(fx)).toHaveLength(2); // the #51-item-5 guard's `ps` check, then the recreate
  });

  test("a .env whose LAST line has no trailing newline is still read by load_env_values", async () => {
    // The whitelisted key is deliberately the unterminated last line: load_env_values (env-get,
    // and env-set's diff) is a SEPARATE read loop from the rewrite loop below, and a fixture that
    // only puts the no-newline line in an unwhitelisted key would never exercise this one — env-get
    // only reports whitelisted keys, so a dropped unwhitelisted line is invisible either way.
    const fx = wowSetup("DISCORD_TOKEN=secret\nWOW_REGION=us"); // no final \n — writeFileSync writes it raw
    expect(readFileSync(fx.envFile, "utf8").endsWith("\n")).toBe(false);
    expect((await envGet(fx)).WOW_REGION).toBe("us");
    // And the diff sees it too: submitting the same value is a no-op, not a "was empty" false change.
    const run = await botOps(fx, ["env-set"], "WOW_REGION=us\n");
    expect(run.json).toEqual({ ok: true, changed: [], recreated: false, note: "no changes" });
  });

  test("a real change preserves an untouched, no-trailing-newline LAST line through the rewrite", async () => {
    // Here the no-newline last line is the one the rewrite loop (a separate read loop again) must
    // carry through untouched while a DIFFERENT key is the one being changed.
    const fx = wowSetup("ANNOUNCE_CHANNEL_ID=11111\nWOW_REGION=us"); // no final \n
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).toBe(0);
    expect(envText(fx)).toBe(wowEnv("ANNOUNCE_CHANNEL_ID=22222\nWOW_REGION=us\n")); // survives, gains its \n
  });

  test("a real change to a CRLF file leaves the untouched lines' CR in place", async () => {
    const fx = wowSetup("WOW_REGION=us\r\nexport DMF_TIMEZONE=UTC\r\nANNOUNCE_CHANNEL_ID=11111\r\n");
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).toBe(0);
    expect(envText(fx)).toBe(wowEnv("WOW_REGION=us\r\nexport DMF_TIMEZONE=UTC\r\nANNOUNCE_CHANNEL_ID=22222\n"));
  });

  test("saving a key whose stored value has an unterminated quote rewrites it clean (repairs the file)", async () => {
    const fx = wowSetup('WOW_REALM="abc\n');
    expect((await envGet(fx)).WOW_REALM).toBe('"abc');
    const run = await botOps(fx, ["env-set"], "WOW_REALM=abc\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["WOW_REALM"] });
    expect(envText(fx)).toBe(wowEnv("WOW_REALM=abc\n"));
  });

  test("a real change backs up, rewrites only the changed lines, appends a new key, recreates once", async () => {
    const stored = "# comment kept\nDISCORD_TOKEN=secret\nANNOUNCE_CHANNEL_ID=11111\n";
    const fx = wowSetup(stored);
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\nWOW_REGION=eu\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, recreated: true });
    expect([...(run.json!.changed as string[])].sort()).toEqual(["ANNOUNCE_CHANNEL_ID", "WOW_REGION"]);
    expect(envText(fx)).toBe(wowEnv("# comment kept\nDISCORD_TOKEN=secret\nANNOUNCE_CHANNEL_ID=22222\nWOW_REGION=eu\n"));
    const backups = readdirSync(join(fx.cfg, "backups"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(fx.cfg, "backups", backups[0]!), "utf8")).toBe(wowEnv(stored));
    expect(recreateCalls(fx)).toEqual([
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
    const fx = wowSetup("ANNOUNCE_CHANNEL_ID=11111\nWOW_REGION=us\n");
    const run = await botOps(fx, ["env-set"], "WOW_REGION=eu\nANNOUNCE_CHANNEL_ID=\n");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("'ANNOUNCE_CHANNEL_ID' is required and cannot be blank");
    expect(envText(fx)).toBe(wowEnv("ANNOUNCE_CHANNEL_ID=11111\nWOW_REGION=us\n")); // WOW_REGION change never applied either
    expect(recreateCalls(fx)).toEqual([expect.stringContaining("ps -a --filter")]);
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
    const fx = wowSetup("ANNOUNCE_CHANNEL_ID=\nWOW_REGION=us\n");
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=\nWOW_REGION=eu\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: ["WOW_REGION"] });
    expect(envText(fx)).toBe(wowEnv("ANNOUNCE_CHANNEL_ID=\nWOW_REGION=eu\n"));
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

  // #240 changed the FIRST half of this test on purpose: a plugin's secret key used to be refused
  // here ("not an editable key"); since ADR-0006 decision 8 it is settable, write-only — see the
  // "accepts a plugin's secret key, write-only (#240)" describe below, which owns that behaviour.
  // What has NOT changed, and stays pinned here, is that env-get never lists it.
  test("a secret plugin key is never listed by env-get, and its non-secret sibling is", async () => {
    const fx = setup("PLUGINS=warbandeer\n", { pluginIndex: index });
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
    expect(Object.keys(env)).toHaveLength(11); // the 11 static keys, nothing merged
  });

  test("no PLUGINS set → no docker read at all, no note", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-get"]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain("index unavailable");
    expect(dockerCalls(fx)).toHaveLength(0); // load_plugin_keys short-circuits before docker
  });
});

describe.skipIf(!runnable)("bot-ops.sh env-schema emits env-get's validation, not its values (#205)", () => {
  test("env-schema lists exactly env-get's keys, in the same order", async () => {
    const index = wrapIndex([pluginEntry("a", [envKey("A_ONE", "^[a-z]+$")])]);
    const fx = setup("PLUGINS=a\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    const [schema, env] = await Promise.all([envSchema(fx), envGet(fx)]);
    expect(Object.keys(schema)).toEqual(Object.keys(env));
  });

  test("a core key carries its ALLOWED_SPEC pattern, its REQUIRED flag and source core", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const schema = await envSchema(fx);
    expect(schema.ANNOUNCE_CHANNEL_ID).toEqual({ pattern: "^[0-9]{5,25}$", required: true, source: "core" });
    expect(schema.BOT_BRANCH!.required).toBe(false);
  });

  test("every emitted core pattern is the verbatim ALLOWED_SPEC string", async () => {
    // Scrape the 'KEY|regex' rows straight from the script source rather than hand-copying them
    // here, so this test can't silently drift from ALLOWED_SPEC the way a hand-mirrored copy could.
    const src = readFileSync(BOT_OPS_SH, "utf8");
    const block = src.match(/ALLOWED_SPEC=\(([\s\S]*?)\n\)/);
    expect(block).not.toBeNull();
    const expected: Record<string, string> = {};
    for (const line of block![1]!.split("\n")) {
      const m = line.match(/^\s*'([A-Z0-9_]+)\|(.*)'\s*$/);
      if (m) expected[m[1]!] = m[2]!;
    }
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const schema = await envSchema(fx);
    for (const [key, pattern] of Object.entries(expected)) {
      expect(schema[key]?.pattern).toBe(pattern);
    }
    // The load-bearing case: an ERE with alternation AND a POSIX class survives jq's quoting/escaping
    // round-trip untouched, rather than the collapsed/escaped-differently string a naive interpolation
    // (or the plan's original `_nwise`-based grouping) could produce.
    expect(schema.PLUGIN_INDEX_URL!.pattern).toBe(expected.PLUGIN_INDEX_URL!);
    expect(schema.PLUGIN_INDEX_URL!.pattern).toContain("[:space:]");
  });

  test("a plugin key reports its manifest format and required with source plugin; a colliding static key stays core", async () => {
    const index = wrapIndex([
      pluginEntry("x", [
        envKey("X_PORT", PORT_RE, { required: true }),
        envKey("ANNOUNCE_CHANNEL_ID", "^.+$"), // collides with a static key -- static must win, exactly as env-get
      ]),
    ]);
    const fx = setup("PLUGINS=x\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    const schema = await envSchema(fx);
    expect(schema.X_PORT).toEqual({ pattern: PORT_RE, required: true, source: "plugin" });
    expect(schema.ANNOUNCE_CHANNEL_ID).toEqual({ pattern: "^[0-9]{5,25}$", required: true, source: "core" });
  });

  test("index unavailable: static keys only and the stderr note", async () => {
    // No pluginIndex fixture, so the shim prints nothing for the exec cat — the file isn't there.
    const fx = setup("PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-schema"]);
    expect(run.exitCode).toBe(0); // never an error (D3), same posture as env-get
    expect(run.stderr).toContain("plugins: index unavailable");
    const schema = run.json as unknown as Record<string, SchemaEntry>;
    expect(Object.keys(schema)).toHaveLength(11); // the 11 static keys, nothing merged
  });

  test("env-schema is a recognised subcommand and appears in usage", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["bogus-subcommand"]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("env-schema");
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

describe.skipIf(!runnable)("bot-ops.sh status reads running/status/image from one docker ps call (#59/#143)", () => {
  test("one `ps -a --filter` call covers running/status/image — no `docker inspect` at all", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n", {
      containerMeta: { state: "running", status: "Up 3 hours", image: "ghcr.io/rackbops/bot:abc123" },
    });
    const run = await botOps(fx, ["status"]);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ running: true, status: "Up 3 hours", image: "ghcr.io/rackbops/bot:abc123" });
    const psCalls = dockerCalls(fx).filter((c) => c.startsWith("docker ps"));
    expect(psCalls).toHaveLength(1); // was 1 `ps` + 2 `inspect` before #143
    expect(dockerCalls(fx).some((c) => c.startsWith("docker inspect"))).toBe(false);
  });

  test("a stopped container: running is false, the human status string still comes through", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n", {
      containerMeta: { state: "exited", status: "Exited (0) 2 hours ago", image: "ghcr.io/rackbops/bot:old" },
    });
    const run = await botOps(fx, ["status"]);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ running: false, status: "Exited (0) 2 hours ago", image: "ghcr.io/rackbops/bot:old" });
  });

  test("container absent: running false, status/image empty, no crash", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n"); // no containerMeta fixture — shim answers nothing
    const run = await botOps(fx, ["status"]);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ running: false, status: "", image: "" });
  });
});

describe.skipIf(!runnable)("bot-ops.sh degrades gracefully on a valid-JSON-but-wrong-shape index (#101, D3)", () => {
  // The bot's own isValidPluginIndex only checks `Array.isArray(env)`, so a manifest it accepts and
  // caches can still be wrong-shaped here — and `jq -e .` only proves valid JSON. Without the shape
  // guards in load_plugin_keys these crashed env-get AND env-set (exit 5), breaking the whole panel
  // even for a static-key save. A plugin issue must never crash ops (D3).
  test("a plugin whose env has a NON-OBJECT element: env-get exit 0, no jq error, that entry skipped, siblings still list", async () => {
    const index = wrapIndex([pluginEntry("warbandeer", ["OOPS", 123, envKey("WARBANDEER_INGEST_PORT", "^[0-9]+$")])]);
    const fx = setup("PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    const run = await botOps(fx, ["env-get"]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain("jq: error");
    expect(run.json).toHaveProperty("WARBANDEER_INGEST_PORT"); // the well-formed sibling still lists
  });

  test("a non-object env element doesn't break a static-key env-set (was exit 5 before the shape guard)", async () => {
    const index = wrapIndex([pluginEntry("warbandeer", ["OOPS"])]);
    const fx = setup("PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["ANNOUNCE_CHANNEL_ID"], recreated: true });
  });

  test("a non-object `.index` → index unavailable note, static keys only, exit 0 — not a crash", async () => {
    // wrapIndex always makes `.index` an object, so hand-build the wrong shape.
    const fx = setup("PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: JSON.stringify({ writtenAt: "x", index: "broken" }) });
    const run = await botOps(fx, ["env-get"]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("plugins: index unavailable");
    expect(run.stderr).not.toContain("jq: error");
    expect(Object.keys(run.json as object)).toHaveLength(11); // the static keys only
  });

  test("a required plugin key cannot be blanked — same rule as a required static key", async () => {
    const index = wrapIndex([pluginEntry("warbandeer", [envKey("WARBANDEER_INGEST_PORT", "^[0-9]+$", { required: true })])]);
    const fx = setup("PLUGINS=warbandeer\nWARBANDEER_INGEST_PORT=8080\n", { pluginIndex: index });
    const run = await botOps(fx, ["env-set"], "WARBANDEER_INGEST_PORT=\n");
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("env-set: 'WARBANDEER_INGEST_PORT' is required and cannot be blank");
    expect(envText(fx)).toBe("PLUGINS=warbandeer\nWARBANDEER_INGEST_PORT=8080\n");
  });

  test("a NON-OBJECT plugin ENTRY beside a well-formed one: the bad entry is skipped, the good plugin's keys still list — NOT degraded", async () => {
    // Pins the plugin-entry `type == "object"` guard (the whole plugins array, not just one env
    // array). Without it the bare `123` entry makes jq error on `.name`, the extraction is caught
    // as "index unavailable", and EVERY plugin's keys vanish — a silent regression a green suite
    // would otherwise miss.
    const index = JSON.stringify({
      writtenAt: "x",
      index: { schemaVersion: 1, generatedAt: "x", plugins: [123, pluginEntry("warbandeer", [envKey("WARBANDEER_INGEST_PORT", "^[0-9]+$")])] },
    });
    const fx = setup("PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    const run = await botOps(fx, ["env-get"]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).not.toContain("index unavailable"); // the good plugin survives — not degraded
    expect(run.json).toHaveProperty("WARBANDEER_INGEST_PORT");
  });

  test("env elements with a non-string key or non-string format are skipped; the well-formed sibling lists", async () => {
    const index = wrapIndex([
      pluginEntry("warbandeer", [
        { key: 5, format: "^x$", description: "numeric key" },
        { key: "BAD_FMT", format: 42, description: "numeric format" },
        envKey("WARBANDEER_INGEST_PORT", "^[0-9]+$"),
      ]),
    ]);
    const fx = setup("PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    const env = await envGet(fx);
    expect(env).not.toHaveProperty("5"); // non-string key not listed
    expect(env).not.toHaveProperty("BAD_FMT"); // non-string format not listed
    expect(env).toHaveProperty("WARBANDEER_INGEST_PORT");
  });
});

describe.skipIf(!runnable)("plugin-request (#105)", () => {
  const ENV = "PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=11111\n";
  const req = (o: object) => JSON.stringify(o);

  test("a valid request queues a file: exec -i -u bun to the requests path, {queued} output", async () => {
    const fx = setup(ENV, {});
    const run = await botOps(fx, ["plugin-request"], req({ action: "update-now", plugin: "warbandeer", version: "1.1.0", requestedBy: "email:me@x.com" }));
    expect(run.exitCode).toBe(0);
    // The filename carries the epoch-ms + action + a nonce (so same-ms same-action can't collide).
    expect(run.json?.queued).toMatch(/^\d{10,}-update-now-\d+\.json$/);
    const exec = dockerCalls(fx).find((c) => c.startsWith("docker exec"));
    expect(exec).toBeDefined();
    expect(exec).toContain("-u bun"); // load-bearing: the bot (bun) must own requests/ to consume it
    expect(exec).toContain("exec -i"); // stdin piped
    expect(exec).toContain("probe-container");
    expect(exec).toContain("/app/data/plugins/requests/");
    // The untrusted payload round-trips to the container's stdin, verbatim.
    expect(readFileSync(join(fx.bin, "request-stdin.json"), "utf8")).toContain('"action":"update-now"');
  });

  test("cancel needs no version; schedule accepts an ISO-with-offset `at`", async () => {
    const fx = setup(ENV, {});
    expect((await botOps(fx, ["plugin-request"], req({ action: "cancel", plugin: "warbandeer", requestedBy: "t" }))).exitCode).toBe(0);
    expect((await botOps(fx, ["plugin-request"], req({ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "2026-09-06T18:30-07:00", requestedBy: "t" }))).exitCode).toBe(0);
  });

  test("rejects a bad action / plugin / version / at before touching docker", async () => {
    const fx = setup(ENV, {});
    const cases: [object, string][] = [
      [{ action: "rm-rf", plugin: "warbandeer", version: "1.1.0", requestedBy: "t" }, "bad action"],
      [{ action: "skip", plugin: "Warbandeer", version: "1.1.0", requestedBy: "t" }, "bad plugin"],
      [{ action: "update-now", plugin: "warbandeer", version: "1.0.0/../x", requestedBy: "t" }, "bad version"],
      [{ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "tomorrow", requestedBy: "t" }, "bad at"],
    ];
    for (const [payload, msg] of cases) {
      const run = await botOps(fx, ["plugin-request"], req(payload));
      expect(run.exitCode, msg).not.toBe(0);
      expect(run.stderr, msg).toContain(`plugin-request: ${msg}`);
    }
    // None of the invalid requests reached a docker exec-write.
    expect(dockerCalls(fx).some((c) => c.includes("/app/data/plugins/requests/"))).toBe(false);
  });

  test("non-JSON stdin is rejected", async () => {
    const fx = setup(ENV, {});
    const run = await botOps(fx, ["plugin-request"], "{ not json");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("not valid JSON");
  });

  test("remind days is 1-999 (aligned with the bot): 0 is rejected, 7 accepted", async () => {
    const fx = setup(ENV, {});
    const zero = await botOps(fx, ["plugin-request"], req({ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 0, requestedBy: "t" }));
    expect(zero.exitCode).not.toBe(0);
    expect(zero.stderr).toContain("bad days");
    expect((await botOps(fx, ["plugin-request"], req({ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 7, requestedBy: "t" }))).exitCode).toBe(0);
  });
});

// #60 item 2 / #168: name which .env this command is acting on, on stderr — env-get/status's
// stdout is JSON the panel parses (#101's lesson), so the new line must never land on stdout.
describe.skipIf(!runnable)("bot-ops.sh restart/env-set log which env file they act on (issue #60 item 2 / #168)", () => {
  test("restart prints the env file path on stderr, and stdout is unchanged", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["restart"]);
    expect(run.exitCode).toBe(0);
    // Mutation: printing to stdout instead of stderr, or dropping the line, both turn this red.
    expect(run.stderr).toContain(`bot-ops: env file ${bashPath(fx.envFile)}`);
    expect(run.stdout).not.toContain("bot-ops: env file");
    expect(run.stdout).toBe("restarted probe-container\n");
  });

  test("env-set (a real change) prints the env file path on stderr, before the recreate", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=22222\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["ANNOUNCE_CHANNEL_ID"] });
    expect(run.stderr).toContain(`bot-ops: env file ${bashPath(fx.envFile)}`);
    // env-set's stdout is the JSON result the panel parses — the new line must never land there,
    // or a stray non-JSON line would be echoed back and rejected (the #101 lesson this issue cites).
    expect(() => JSON.parse(run.stdout)).not.toThrow();
  });

  test("env-set with NO real change (the early-return path) never logs the env file line", async () => {
    // The line sits right before the recreate call, deliberately AFTER the "no changes" early
    // return — a save that changes nothing must not claim to have acted on the file.
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["env-set"], "ANNOUNCE_CHANNEL_ID=11111\n"); // same value, no-op
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ ok: true, changed: [], recreated: false, note: "no changes" });
    // Mutation: moving the echo above the no-change early return would turn this red.
    expect(run.stderr).not.toContain("bot-ops: env file");
  });
});

// #173: the panel's runBotOps reads a subcommand's STDOUT as JSON — a stray line anywhere else
// on stdout (or the JSON landing on stderr instead) would break the same way env-get/status's own
// stdout-is-JSON contract breaks (#101's lesson, reused here for a fourth subcommand).
describe.skipIf(!runnable)("bot-ops.sh version (issue #173)", () => {
  test("prints {\"schema\": N, \"composeSchema\": null} on stdout, nothing on stderr", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["version"]);
    expect(run.exitCode).toBe(0);
    // Mutation: printing to stderr instead of stdout, or a malformed shape, both turn this red.
    // composeSchema is null here because the fixture's default compose.yml (a bare
    // "services:\n  bot:\n    image: x\n") has no x-rackbops-schema: line — #178.
    expect(run.json).toEqual({ schema: 3, composeSchema: null });
    expect(run.stderr).toBe("");
  });

  test("BOT_OPS_SCHEMA matches the acceptance bullet's literal value (schema 3, #240)", () => {
    // A source-level pin distinct from the subprocess test above: this is the number the drift
    // test on the ops/admin side (ops/admin/server.test.ts) asserts REQUIRED_BOT_OPS_SCHEMA against.
    const src = readFileSync(BOT_OPS_SH, "utf8");
    expect(src).toMatch(/readonly BOT_OPS_SCHEMA=3\b/);
  });

  test("reports schema 3 (#240: routing-get, the four routing/webhook request actions, write-only plugin secrets)", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["version"]);
    expect(run.exitCode).toBe(0);
    expect((run.json as { schema: number }).schema).toBe(3);
  });

  // #173 round 3: `version` needs no instance config at all — a real review-caught bug had it
  // dispatched AFTER main()'s BOT_OPS_PROJECT/CONTAINER/CONFIG_DIR/COMPOSE_FILE/.env preconditions,
  // so a genuinely CURRENT script pointed at a bad instance config failed `version` the same way an
  // OLD script would, and the panel reported "OUT OF DATE — re-run install.sh" for a problem that
  // had nothing to do with script drift. `version` is dispatched before ALL of that now.
  test("succeeds with NO BOT_OPS_* env set at all (not even PROJECT/CONTAINER)", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    // Mutation: moving the version dispatch back below main()'s preconditions turns this red —
    // the run would instead die naming BOT_OPS_PROJECT/CONTAINER/CONFIG_DIR/COMPOSE_FILE not set.
    const run = await botOps(fx, ["version"], undefined, {
      BOT_OPS_PROJECT: undefined,
      BOT_OPS_CONTAINER: undefined,
      BOT_OPS_CONFIG_DIR: undefined,
      BOT_OPS_COMPOSE_FILE: undefined,
    });
    expect(run.exitCode).toBe(0);
    // No BOT_OPS_COMPOSE_FILE at all -> composeSchema is null, not an error (#178).
    expect(run.json).toEqual({ schema: 3, composeSchema: null });
  });

  test("succeeds even with a nonexistent BOT_OPS_CONFIG_DIR/COMPOSE_FILE (the review-caught case)", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const run = await botOps(fx, ["version"], undefined, {
      BOT_OPS_CONFIG_DIR: "/opt/does-not-exist",
      BOT_OPS_COMPOSE_FILE: "/opt/does-not-exist/compose.yml",
    });
    // Mutation: dispatching version after the .env/compose-file existence checks in main() turns
    // this red — those paths genuinely don't exist, so main() would die before reaching cmd_version.
    expect(run.exitCode).toBe(0);
    // A set-but-nonexistent BOT_OPS_COMPOSE_FILE -> composeSchema null, never an error (#178).
    expect(run.json).toEqual({ schema: 3, composeSchema: null });
  });
});

// #178: composeSchema is read from $BOT_OPS_COMPOSE_FILE's own x-rackbops-schema: line — a second,
// independent drift signal alongside BOT_OPS_SCHEMA, for the compose file install.sh also fetches
// once and never refreshes.
describe.skipIf(!runnable)("bot-ops.sh version reports composeSchema (issue #178)", () => {
  test("reads the real, stamped repo docker-compose.yml correctly", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    const realCompose = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));
    const run = await botOps(fx, ["version"], undefined, { BOT_OPS_COMPOSE_FILE: realCompose });
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ schema: 3, composeSchema: 1 });
  });

  test("a pre-#178 compose file (no x-rackbops-schema: line) -> composeSchema null", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    // The fixture's own default compose.yml is already pre-#178-shaped (no schema line) — reuse it
    // explicitly here for a name that documents the scenario, rather than relying on the default.
    writeFileSync(fx.compose, "services:\n  bot:\n    image: x\n");
    const run = await botOps(fx, ["version"], undefined, { BOT_OPS_COMPOSE_FILE: fx.compose });
    expect(run.exitCode).toBe(0);
    // Mutation: dropping the null path (treating a missing key as schema 0, or crashing) turns this red.
    expect(run.json).toEqual({ schema: 3, composeSchema: null });
  });

  test("a malformed x-rackbops-schema value (non-numeric) -> composeSchema null, never a crash", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    writeFileSync(fx.compose, "x-rackbops-schema: not-a-number\nservices:\n  bot:\n    image: x\n");
    const run = await botOps(fx, ["version"], undefined, { BOT_OPS_COMPOSE_FILE: fx.compose });
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ schema: 3, composeSchema: null });
  });

  test("a real numeric x-rackbops-schema value is reported exactly, including when it differs from 1", async () => {
    const fx = setup("ANNOUNCE_CHANNEL_ID=11111\n");
    writeFileSync(fx.compose, "x-rackbops-schema: 2\nservices:\n  bot:\n    image: x\n");
    const run = await botOps(fx, ["version"], undefined, { BOT_OPS_COMPOSE_FILE: fx.compose });
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ schema: 3, composeSchema: 2 });
  });
});

// ---- #240: write-only plugin secrets, routing-get, the four routing / webhook request actions ------
// Epic #236, ADR-0006. The property everything below rests on: a plugin secret's VALUE (and a webhook
// URL) never leaves the script — not in env-get, env-schema, env-set's result, a die message, stderr,
// or docker's argv (docker.log). `everythingObservable` gathers every place a value could surface.

/** A recognisable plugin secret: it matches MUSIC_API_KEY's format below and cannot occur in any
 *  fixture or output by chance, so "the value appears nowhere" is a meaningful literal search. */
const SECRET = "sk_live_Zx91QpL7mNv3TrWq";
const OLD_SECRET = "sk_old_Qw83RtYu12LmNbVc";
const WEBHOOK_TOKEN = "Zk3nQ8xV1mB7cR4tY9uL2pS6wA0dF5gHjKq";
const WEBHOOK_URL = `https://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;

const SECRET_INDEX = wrapIndex([
  pluginEntry("music", [
    envKey("MUSIC_PORT", PORT_RE),
    envKey("MUSIC_API_KEY", "^[A-Za-z0-9_-]{8,64}$", { secret: true }),
    envKey("MUSIC_MUST_KEY", "^[a-z]{4,}$", { secret: true, required: true }),
  ]),
]);
const MUSIC_ENV = "PLUGINS=music\nANNOUNCE_CHANNEL_ID=11111\nMUSIC_MUST_KEY=abcd\n";

/** Every place a value could surface after a run: both output streams, docker's logged argv, the
 *  config dir's file names and the backups listing. (A backup's CONTENT legitimately holds the
 *  previous .env, values included — it is 0600 and asserted separately.) */
function everythingObservable(fx: Fixture, run: Run): string {
  return [
    run.stdout,
    run.stderr,
    dockerCalls(fx).join("\n"),
    readdirSync(fx.cfg).join("\n"),
    existsSync(join(fx.cfg, "backups")) ? readdirSync(join(fx.cfg, "backups")).join("\n") : "",
  ].join("\n--\n");
}

describe.skipIf(!runnable)("bot-ops.sh env-set accepts a plugin's secret key, write-only (#240)", () => {
  test("a secret key is written to .env and named in changed", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    const run = await botOps(fx, ["env-set"], `MUSIC_API_KEY=${SECRET}\n`);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["MUSIC_API_KEY"], recreated: true });
    expect(envText(fx)).toBe(`${MUSIC_ENV}MUSIC_API_KEY=${SECRET}\n`);
    expect(readdirSync(join(fx.cfg, "backups"))).toHaveLength(1);
    expect(dockerCalls(fx).some((c) => c.includes("up -d --force-recreate"))).toBe(true);
  });

  test("env-get emits neither its name nor its value, before or after", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    const before = await botOps(fx, ["env-get"]);
    expect(before.exitCode).toBe(0);
    expect(before.stdout).not.toContain("MUSIC_API_KEY");
    expect(before.stdout).not.toContain("MUSIC_MUST_KEY"); // a stored secret is not listed either
    await botOps(fx, ["env-set"], `MUSIC_API_KEY=${SECRET}\n`);
    const after = await botOps(fx, ["env-get"]);
    expect(after.stdout).not.toContain("MUSIC_API_KEY");
    expect(after.stdout).not.toContain(SECRET);
    expect(after.stderr).not.toContain(SECRET);
    expect(after.json).toHaveProperty("MUSIC_PORT"); // the plugin's non-secret sibling IS listed
    expect(Object.keys(after.json!)).toEqual(Object.keys(before.json!));
  });

  test("its format is enforced", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    const run = await botOps(fx, ["env-set"], "MUSIC_API_KEY=short\n"); // < 8 chars
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("env-set: value for 'MUSIC_API_KEY' is invalid");
    expect(envText(fx)).toBe(MUSIC_ENV); // untouched
    expect(existsSync(join(fx.cfg, "backups"))).toBe(false);
  });

  test("a required secret cannot be blanked, an optional one can be cleared", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    const blank = await botOps(fx, ["env-set"], "MUSIC_MUST_KEY=\n");
    expect(blank.exitCode).toBe(1);
    expect(blank.stderr).toContain("env-set: 'MUSIC_MUST_KEY' is required and cannot be blank");
    expect(envText(fx)).toBe(MUSIC_ENV);
    expect((await botOps(fx, ["env-set"], `MUSIC_API_KEY=${SECRET}\n`)).exitCode).toBe(0);
    const clear = await botOps(fx, ["env-set"], "MUSIC_API_KEY=\n");
    expect(clear.exitCode).toBe(0);
    expect(clear.json).toMatchObject({ changed: ["MUSIC_API_KEY"] });
    expect(envText(fx)).toContain("MUSIC_API_KEY=\n");
  });

  test("a core secret is still refused", async () => {
    const fx = setup(`${MUSIC_ENV}DISCORD_TOKEN=keepme\n`, { pluginIndex: SECRET_INDEX });
    for (const key of ["DISCORD_TOKEN", "GITHUB_TOKEN", "ADMIN_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN", "CLOUDFLARE_ACCESS_AUD"]) {
      const run = await botOps(fx, ["env-set"], `${key}=${SECRET}\n`);
      expect(run.exitCode, key).toBe(1);
      expect(run.stderr, key).toContain(`'${key}' is not an editable key`);
      expect(everythingObservable(fx, run), key).not.toContain(SECRET);
    }
    expect(envText(fx)).toBe(`${MUSIC_ENV}DISCORD_TOKEN=keepme\n`);
    expect(existsSync(join(fx.cfg, "backups"))).toBe(false);
  });

  test("the wow plugin's Blizzard client is not core: settable, write-only, listed nowhere but env-schema", async () => {
    // Shaped like the real wow entry in the published Plugin Index: both keys `secret: true`, format
    // ^\S+$. BLIZZARD_CLIENT_* belong to that plugin, so the panel must be able to set them.
    const index = wrapIndex([
      pluginEntry("wow", [
        envKey("WOW_REGION", "^(us|eu)$"),
        envKey("BLIZZARD_CLIENT_ID", "^\\S+$", { secret: true }),
        envKey("BLIZZARD_CLIENT_SECRET", "^\\S+$", { secret: true }),
      ]),
    ]);
    const base = "PLUGINS=wow\nANNOUNCE_CHANNEL_ID=11111\n";
    const fx = setup(base, { pluginIndex: index });
    const run = await botOps(fx, ["env-set"], `BLIZZARD_CLIENT_SECRET=${SECRET}\n`);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["BLIZZARD_CLIENT_SECRET"], recreated: true });
    expect(envText(fx)).toBe(`${base}BLIZZARD_CLIENT_SECRET=${SECRET}\n`);
    expect(everythingObservable(fx, run)).not.toContain(SECRET);

    const get = await botOps(fx, ["env-get"]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout).not.toContain("BLIZZARD");
    expect(get.stdout).not.toContain(SECRET);

    const schema = await botOps(fx, ["env-schema"]);
    expect(schema.json).toMatchObject({
      WOW_REGION: { source: "plugin", required: false },
      BLIZZARD_CLIENT_ID: { source: "plugin", secret: true, isSet: false },
      BLIZZARD_CLIENT_SECRET: { source: "plugin", secret: true, isSet: true },
    });
    expect(schema.stdout).not.toContain(SECRET);

    // The manifest, not the key's name, is the authority: with wow not enabled the same key is refused.
    const off = setup("ANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    const refused = await botOps(off, ["env-set"], `BLIZZARD_CLIENT_SECRET=${SECRET}\n`);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("'BLIZZARD_CLIENT_SECRET' is not an editable key");
  });

  test("a manifest field holding a line break cannot re-frame the rows and unmask another plugin's secret", async () => {
    // load_plugin_keys reads five raw lines per key, so a `format` / `required` with embedded newlines
    // used to shift every later row: the hostile plugin (listed FIRST) forged a plain row for
    // A_SECRET and env-get listed its stored value. Each payload is framed for one row width.
    const forged4 = "F1\nF2\nF3\nA_SECRET\n.*\nfalse\nfalse";
    const forged5 = "^x$\nfalse\nfalse\ntrue\nA_SECRET\n.*\nfalse\nfalse\ntrue\nJUNK";
    const variants: [string, Record<string, unknown>][] = [
      ["format, 4-line framing", { format: forged4 }],
      ["format, 5-line framing", { format: forged5 }],
      ["required", { required: "false\nfalse\ntrue\nA_SECRET\n.*\nfalse\nfalse\ntrue" }],
      ["carriage return in the key", { key: "X1\rA_SECRET" }],
    ];
    for (const [why, override] of variants) {
      const evil = { ...envKey("X1", "^x$"), ...override };
      const index = wrapIndex([
        pluginEntry("evil", [evil]),
        pluginEntry("goodplug", [envKey("A_SECRET", "^[A-Za-z0-9_]{8,}$", { secret: true })]),
      ]);
      const fx = setup("PLUGINS=evil,goodplug\nANNOUNCE_CHANNEL_ID=11111\nA_SECRET=STOREDVALUE_zzz9\n", { pluginIndex: index });
      const get = await botOps(fx, ["env-get"]);
      expect(get.exitCode, why).toBe(0);
      expect(get.stdout, why).not.toContain("A_SECRET");
      expect(get.stdout, why).not.toContain("STOREDVALUE_zzz9");
      const schema = await botOps(fx, ["env-schema"]);
      expect(schema.json, why).toMatchObject({ A_SECRET: { secret: true, isSet: true } });
      expect(schema.stdout, why).not.toContain("STOREDVALUE_zzz9");
      expect(Object.keys(schema.json ?? {}), why).not.toContain("X1"); // the hostile entry is dropped whole
    }
  });

  test("a `secret` that is not exactly false or absent counts as secret (fail closed)", async () => {
    const asSecret: unknown[] = ["yes", 1, "TRUE", "true ", "false", [], {}, "true"];
    for (const secret of asSecret) {
      const index = wrapIndex([pluginEntry("p", [envKey("K_SECRET", "^.+$", { secret })])]);
      const fx = setup("PLUGINS=p\nANNOUNCE_CHANNEL_ID=11111\nK_SECRET=VALUE_OF_K_SECRET\n", { pluginIndex: index });
      const why = JSON.stringify(secret);
      const get = await botOps(fx, ["env-get"]);
      expect(get.stdout, why).not.toContain("K_SECRET");
      expect(get.stdout, why).not.toContain("VALUE_OF_K_SECRET");
      const schema = await botOps(fx, ["env-schema"]);
      expect(schema.json, why).toMatchObject({ K_SECRET: { secret: true, isSet: true } });
    }
    for (const plain of [false, null, undefined]) {
      const extra = plain === undefined ? {} : { secret: plain };
      const index = wrapIndex([pluginEntry("p", [envKey("K_PLAIN", "^.+$", extra)])]);
      const fx = setup("PLUGINS=p\nANNOUNCE_CHANNEL_ID=11111\nK_PLAIN=plainvalue\n", { pluginIndex: index });
      const get = await botOps(fx, ["env-get"]);
      expect(get.json, String(plain)).toMatchObject({ K_PLAIN: "plainvalue" });
    }
  });

  test("a key any plugin in the index declares secret is never listed as plain, but stays uneditable unless that plugin is enabled", async () => {
    const index = wrapIndex([
      pluginEntry("spotify", [envKey("SHARED_KEY", "^[A-Za-z0-9_]{8,}$", { secret: true })]),
      pluginEntry("music", [envKey("SHARED_KEY", "^.+$"), envKey("MUSIC_PORT", PORT_RE)]),
    ]);
    const stored = "PLUGINS=music\nANNOUNCE_CHANNEL_ID=11111\nSHARED_KEY=LEFTOVER_VALUE_1\nMUSIC_PORT=8080\n";
    const off = setup(stored, { pluginIndex: index });
    const get = await botOps(off, ["env-get"]);
    expect(get.json).toMatchObject({ MUSIC_PORT: "8080" });
    expect(get.stdout).not.toContain("SHARED_KEY");
    expect(get.stdout).not.toContain("LEFTOVER_VALUE_1");
    expect(Object.keys((await botOps(off, ["env-schema"])).json ?? {})).not.toContain("SHARED_KEY");
    const refused = await botOps(off, ["env-set"], "SHARED_KEY=another_value_9\n");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("'SHARED_KEY' is not an editable key");

    const on = setup(stored.replace("PLUGINS=music", "PLUGINS=music,spotify"), { pluginIndex: index });
    expect((await botOps(on, ["env-schema"])).json).toMatchObject({ SHARED_KEY: { secret: true, isSet: true } });
    expect((await botOps(on, ["env-get"])).stdout).not.toContain("SHARED_KEY");
    expect((await botOps(on, ["env-set"], "SHARED_KEY=another_value_9\n")).exitCode).toBe(0);
  });

  test("a refusal never echoes a line of a multi-line value as if it were a key name", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    // A PEM-like value read line by line: its later lines look like `KEY=`. None may be echoed.
    const body = "MUSIC_API_KEY=-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj=\nAAAAB3NzaC1yc2E=\n-----END KEY-----\n";
    const run = await botOps(fx, ["env-set"], body);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("'(not shown)' is not an editable key");
    expect(everythingObservable(fx, run)).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSj");
    expect(everythingObservable(fx, run)).not.toContain("AAAAB3NzaC1yc2E");
    expect(envText(fx)).toBe(MUSIC_ENV);
    // A mistyped variable name is still named (upper-case, at most 40 characters)...
    const typo = await botOps(fx, ["env-set"], "MUSIC_API_KAY=x\n");
    expect(typo.stderr).toContain("'MUSIC_API_KAY' is not an editable key");
    // ...and one over that length is not.
    const long = `A${"B".repeat(40)}`;
    const over = await botOps(fx, ["env-set"], `${long}=x\n`);
    expect(over.stderr).toContain("'(not shown)' is not an editable key");
    expect(over.stderr).not.toContain(long);
  });

  test("a manifest that declares a core credential cannot make it editable, listable or schema-visible", async () => {
    // Secret or plain, by mistake or through a bad index entry: a key the deployment owns stays out.
    const index = wrapIndex([
      pluginEntry("evil", [
        envKey("DISCORD_TOKEN", "^.+$", { secret: true }),
        envKey("ADMIN_TOKEN", "^.+$", { secret: true }),
        envKey("GITHUB_TOKEN", "^.+$"), // declared PLAIN: must not be listed with its value either
        envKey("BOT_OPS_CONFIG_DIR", "^.+$"),
        envKey("EVIL_PORT", PORT_RE),
      ]),
    ]);
    const fx = setup("PLUGINS=evil\nDISCORD_TOKEN=tok-1\nADMIN_TOKEN=tok-2\nGITHUB_TOKEN=tok-3\nBOT_OPS_CONFIG_DIR=/x\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    const get = await botOps(fx, ["env-get"]);
    for (const leak of ["DISCORD_TOKEN", "ADMIN_TOKEN", "GITHUB_TOKEN", "BOT_OPS_CONFIG_DIR", "tok-1", "tok-2", "tok-3"]) {
      expect(get.stdout, leak).not.toContain(leak);
    }
    expect(get.json).toHaveProperty("EVIL_PORT"); // the legitimate key is still listed
    const schema = await botOps(fx, ["env-schema"]);
    for (const leak of ["DISCORD_TOKEN", "ADMIN_TOKEN", "GITHUB_TOKEN", "BOT_OPS_CONFIG_DIR"]) {
      expect(schema.stdout, leak).not.toContain(leak);
    }
    for (const key of ["DISCORD_TOKEN", "ADMIN_TOKEN", "GITHUB_TOKEN", "BOT_OPS_CONFIG_DIR"]) {
      const run = await botOps(fx, ["env-set"], `${key}=new-value\n`);
      expect(run.exitCode, key).toBe(1);
      expect(run.stderr, key).toContain(`'${key}' is not an editable key`);
    }
  });

  test("a secret key of a plugin that is not enabled is refused", async () => {
    const other = "PLUGINS=warbandeer\nANNOUNCE_CHANNEL_ID=11111\n"; // music is in the index but not in PLUGINS
    const fx = setup(other, { pluginIndex: SECRET_INDEX });
    const run = await botOps(fx, ["env-set"], `MUSIC_API_KEY=${SECRET}\n`);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("'MUSIC_API_KEY' is not an editable key");
    expect(envText(fx)).toBe(other);
    // ... nor when the index cannot be read at all
    const noIndex = setup(MUSIC_ENV);
    const run2 = await botOps(noIndex, ["env-set"], `MUSIC_API_KEY=${SECRET}\n`);
    expect(run2.exitCode).toBe(1);
    expect(run2.stderr).toContain("'MUSIC_API_KEY' is not an editable key");
    expect(everythingObservable(noIndex, run2)).not.toContain(SECRET);
  });

  test("the value appears nowhere in stdout, stderr, docker.log or the backups listing", async () => {
    const fx = setup(`${MUSIC_ENV}MUSIC_API_KEY=${OLD_SECRET}\n`, { pluginIndex: SECRET_INDEX });
    const run = await botOps(fx, ["env-set"], `MUSIC_API_KEY=${SECRET}\nANNOUNCE_CHANNEL_ID=22222\n`);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ changed: expect.arrayContaining(["MUSIC_API_KEY", "ANNOUNCE_CHANNEL_ID"]) });
    const seen = everythingObservable(fx, run);
    expect(seen).not.toContain(SECRET); // the new value
    expect(seen).not.toContain(OLD_SECRET); // nor the one it replaced
    // The backup file legitimately holds the PREVIOUS .env — values included — so it must be owner-only.
    const [backupName] = readdirSync(join(fx.cfg, "backups"));
    const backup = join(fx.cfg, "backups", backupName!);
    expect(readFileSync(backup, "utf8")).toContain(`MUSIC_API_KEY=${OLD_SECRET}`);
    if (process.platform !== "win32") expect(statSync(backup).mode & 0o777).toBe(0o600);
  });

  test("a rejected value is never echoed either: the messages name the key only", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    const bad = "bad value with spaces and the secret sk_live_Leak123456"; // fails the format
    const run = await botOps(fx, ["env-set"], `MUSIC_API_KEY=${bad}\n`);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("value for 'MUSIC_API_KEY' is invalid");
    expect(everythingObservable(fx, run)).not.toContain("sk_live_Leak123456");
    const malformed = await botOps(fx, ["env-set"], `MUSIC_API_KEY ${SECRET}\n`); // no `=`
    expect(malformed.exitCode).toBe(1);
    expect(everythingObservable(fx, malformed)).not.toContain(SECRET);
  });

  test("a submitted secret is always written, so a guess cannot be checked against the stored value", async () => {
    // "No change" would be a read oracle: submit a guess, and an empty `changed` means it IS the value.
    const fx = setup(`${MUSIC_ENV}MUSIC_API_KEY=${SECRET}\n`, { pluginIndex: SECRET_INDEX });
    const same = await botOps(fx, ["env-set"], `MUSIC_API_KEY=${SECRET}\n`);
    const guess = await botOps(fx, ["env-set"], "MUSIC_API_KEY=some_other_guess_1\n");
    for (const run of [same, guess]) {
      expect(run.exitCode).toBe(0);
      expect(run.json).toMatchObject({ ok: true, changed: ["MUSIC_API_KEY"], recreated: true });
      expect(run.json).not.toHaveProperty("note");
    }
    // indistinguishable to a caller: same keys, same shape
    expect(Object.keys(same.json!).sort()).toEqual(Object.keys(guess.json!).sort());
  });

  test("a blank for a secret that is already unset changes nothing (that much isSet already says)", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    const run = await botOps(fx, ["env-set"], "MUSIC_API_KEY=\n");
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ ok: true, changed: [], recreated: false, note: "no changes" });
    expect(envText(fx)).toBe(MUSIC_ENV);
  });

  test("a line break inside a value is refused for every key, naming the key only", async () => {
    // A CR could start a new line in .env (`KEY=a\rDISCORD_TOKEN=evil`); a permissive plugin format
    // would let it through, so the script refuses it before the format is even consulted.
    const index = wrapIndex([pluginEntry("lax", [envKey("LAX_KEY", "^.+$", { secret: true }), envKey("LAX_PLAIN", "^.+$")])]);
    const fx = setup("PLUGINS=lax\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    for (const key of ["LAX_KEY", "LAX_PLAIN"]) {
      const run = await botOps(fx, ["env-set"], `${key}=abc\rDISCORD_TOKEN=evil\n`);
      expect(run.exitCode, key).toBe(1);
      expect(run.stderr, key).toContain(`env-set: value for '${key}' is invalid`);
      expect(run.stderr, key).not.toContain("evil");
    }
    expect(envText(fx)).toBe("PLUGINS=lax\nANNOUNCE_CHANNEL_ID=11111\n");
  });

  test("a recreate message that echoes a value is redacted before it reaches the result's log", async () => {
    // Nothing this script prints carries a value — but `docker compose up` is not ours, and a .env
    // line it refuses to parse can be quoted back in its error. Both the new and the old value go.
    const fx = setup(`${MUSIC_ENV}MUSIC_API_KEY=${OLD_SECRET}\n`, {
      pluginIndex: SECRET_INDEX,
      composeUp: { output: `error while loading .env: line 3: bad value MUSIC_API_KEY=${SECRET} (was ${OLD_SECRET})`, exitCode: 1 },
    });
    const run = await botOps(fx, ["env-set"], `MUSIC_API_KEY=${SECRET}\n`);
    expect(run.exitCode).toBe(1); // the recreate failed, and env-set says so
    expect(run.json).toMatchObject({ ok: false, changed: ["MUSIC_API_KEY"] });
    expect(String((run.json as { log: string }).log)).toContain("[redacted]");
    const seen = everythingObservable(fx, run);
    expect(seen).not.toContain(SECRET);
    expect(seen).not.toContain(OLD_SECRET);
  });

  test("redaction treats a secret as a literal, whatever glob characters it holds", async () => {
    const glob = "pre*fix[ab]?tail";
    const index = wrapIndex([pluginEntry("g", [envKey("GLOB_KEY", "^.+$", { secret: true })])]);
    const fx = setup("PLUGINS=g\nANNOUNCE_CHANNEL_ID=11111\n", {
      pluginIndex: index,
      composeUp: { output: `bad line GLOB_KEY=${glob}; unrelated preXfixaZtail stays`, exitCode: 1 },
    });
    const run = await botOps(fx, ["env-set"], `GLOB_KEY=${glob}\n`);
    const log = String((run.json as { log: string }).log);
    expect(log).not.toContain(glob);
    expect(log).toContain("[redacted]");
    // an unquoted pattern would glob-match this text and redact it too
    expect(log).toContain("unrelated preXfixaZtail stays");
  });

  test("a manifest entry with an empty key is skipped, secret or plain, and never crashes the reads", async () => {
    const index = wrapIndex([pluginEntry("p", [envKey("", "^.+$", { secret: true }), envKey("", "^.+$"), envKey("P_PORT", PORT_RE)])]);
    const fx = setup("PLUGINS=p\nANNOUNCE_CHANNEL_ID=11111\nP_PORT=8080\n", { pluginIndex: index });
    const get = await botOps(fx, ["env-get"]);
    expect(get.exitCode).toBe(0);
    expect(get.json).toMatchObject({ P_PORT: "8080" });
    const schema = await botOps(fx, ["env-schema"]);
    expect(schema.exitCode).toBe(0);
    expect(Object.keys(schema.json ?? {})).not.toContain("");
  });

  test("a key one plugin declares secret and another declares plain is secret: never listed, schema says so", async () => {
    for (const order of [["plain", "secret"], ["secret", "plain"]] as const) {
      const decl = { plain: pluginEntry("aaa", [envKey("SHARED_KEY", "^.+$")]), secret: pluginEntry("bbb", [envKey("SHARED_KEY", "^.+$", { secret: true })]) };
      const fx = setup(`PLUGINS=aaa,bbb\nANNOUNCE_CHANNEL_ID=11111\nSHARED_KEY=${SECRET}\n`, { pluginIndex: wrapIndex(order.map((o) => decl[o])) });
      const get = await botOps(fx, ["env-get"]);
      expect(get.stdout, order.join()).not.toContain("SHARED_KEY");
      expect(get.stdout, order.join()).not.toContain(SECRET);
      const schema = (await botOps(fx, ["env-schema"])).json as unknown as Record<string, Record<string, unknown>>;
      expect(schema.SHARED_KEY, order.join()).toMatchObject({ secret: true, isSet: true });
    }
  });

  test("a secret key that collides with a static key is ignored: the static key stays, and stays core", async () => {
    const index = wrapIndex([pluginEntry("sneaky", [envKey("COMMAND_PREFIX", "^.+$", { secret: true })])]);
    const fx = setup("PLUGINS=sneaky\nCOMMAND_PREFIX=rb\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    expect((await envGet(fx)).COMMAND_PREFIX).toBe("rb");
    const schema = await envSchema(fx);
    expect(schema.COMMAND_PREFIX).toEqual({ pattern: "^[a-z0-9_-]{1,20}$", required: false, source: "core" });
  });

  test("a secret declared twice: the first declaration's format wins", async () => {
    const index = wrapIndex([
      pluginEntry("one", [envKey("TWICE_KEY", "^[0-9]+$", { secret: true })]),
      pluginEntry("two", [envKey("TWICE_KEY", "^[a-z]+$", { secret: true })]),
    ]);
    const fx = setup("PLUGINS=one,two\nANNOUNCE_CHANNEL_ID=11111\n", { pluginIndex: index });
    expect((await botOps(fx, ["env-set"], "TWICE_KEY=abc\n")).exitCode).toBe(1);
    expect((await botOps(fx, ["env-set"], "TWICE_KEY=123\n")).exitCode).toBe(0);
  });
});

describe.skipIf(!runnable)("bot-ops.sh env-schema lists secret keys without their values (#240)", () => {
  type Row = Record<string, unknown>;
  const schemaOf = async (fx: Fixture) => (await botOps(fx, ["env-schema"])).json as unknown as Record<string, Row>;

  test("a secret key carries secret:true and isSet:false when unset", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    const schema = await schemaOf(fx);
    expect(schema.MUSIC_API_KEY).toEqual({ pattern: "^[A-Za-z0-9_-]{8,64}$", required: false, source: "plugin", secret: true, isSet: false });
    // MUSIC_MUST_KEY=abcd is in MUSIC_ENV, so it is set — and its required flag comes through
    expect(schema.MUSIC_MUST_KEY).toEqual({ pattern: "^[a-z]{4,}$", required: true, source: "plugin", secret: true, isSet: true });
  });

  test("isSet turns true once it is set, and false again once it is cleared", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    expect((await schemaOf(fx)).MUSIC_API_KEY).toMatchObject({ isSet: false });
    await botOps(fx, ["env-set"], `MUSIC_API_KEY=${SECRET}\n`);
    expect((await schemaOf(fx)).MUSIC_API_KEY).toMatchObject({ secret: true, isSet: true });
    await botOps(fx, ["env-set"], "MUSIC_API_KEY=\n");
    expect((await schemaOf(fx)).MUSIC_API_KEY).toMatchObject({ isSet: false });
    // a quoted-empty value is not "set" either (it reads back as the empty string)
    const quoted = setup(`${MUSIC_ENV}MUSIC_API_KEY=""\n`, { pluginIndex: SECRET_INDEX });
    expect((await schemaOf(quoted)).MUSIC_API_KEY).toMatchObject({ isSet: false });
    const quotedSet = setup(`${MUSIC_ENV}MUSIC_API_KEY="${SECRET}"\n`, { pluginIndex: SECRET_INDEX });
    expect((await schemaOf(quotedSet)).MUSIC_API_KEY).toMatchObject({ isSet: true });
  });

  test("a non-secret entry is exactly {pattern, required, source}", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    const schema = await schemaOf(fx);
    expect(schema.ANNOUNCE_CHANNEL_ID).toEqual({ pattern: "^[0-9]{5,25}$", required: true, source: "core" });
    expect(schema.MUSIC_PORT).toEqual({ pattern: PORT_RE, required: false, source: "plugin" });
    for (const [key, row] of Object.entries(schema)) {
      if (row.secret === true) continue;
      expect(Object.keys(row).sort(), key).toEqual(["pattern", "required", "source"]);
    }
  });

  test("secret rows come after every other row, and env-get never lists them", async () => {
    const fx = setup(MUSIC_ENV, { pluginIndex: SECRET_INDEX });
    const [schema, env] = await Promise.all([schemaOf(fx), envGet(fx)]);
    const keys = Object.keys(schema);
    expect(keys.slice(-2)).toEqual(["MUSIC_API_KEY", "MUSIC_MUST_KEY"]); // manifest order, last
    expect(keys.slice(0, -2)).toEqual(Object.keys(env)); // everything before them is exactly env-get's listing
  });

  test("the value appears nowhere in the output", async () => {
    const fx = setup(`${MUSIC_ENV}MUSIC_API_KEY=${SECRET}\n`, { pluginIndex: SECRET_INDEX });
    const run = await botOps(fx, ["env-schema"]);
    expect(run.exitCode).toBe(0);
    expect(everythingObservable(fx, run)).not.toContain(SECRET);
    expect(run.stdout).not.toContain("abcd"); // nor the required secret's stored value
  });
});

describe.skipIf(!runnable)("bot-ops.sh routing-get (#240)", () => {
  const GUILD = "123456789012345678";
  const CHANNEL = "223456789012345678";
  const ROUTING = {
    v: 1,
    updatedAt: "2026-09-21T00:00:00.000Z",
    updatedBy: "email:me@x.com",
    plugins: { music: { servers: { [GUILD]: { commands: "all", postTo: CHANNEL } } } },
    webhooks: { [CHANNEL]: { id: "323456789012345678", guildId: GUILD, addedAt: "2026-09-21T00:00:00.000Z", addedBy: "email:me@x.com" } },
  };
  const DISCOVERY = {
    v: 1,
    generatedAt: "2026-09-21T00:00:00.000Z",
    bot: { id: "423456789012345678", username: "rackbops" },
    inviteUrl: "https://discord.com/oauth2/authorize?client_id=423456789012345678&scope=bot%20applications.commands",
    homeGuildId: GUILD,
    guilds: [{ id: GUILD, name: "Home", channels: [{ id: CHANNEL, name: "general", canSend: true }], commands: { registered: 4, at: "2026-09-21T00:00:00.000Z" } }],
    plugins: { music: { posts: true, commands: ["play"] } },
  };
  const ENV = "ANNOUNCE_CHANNEL_ID=11111\n";
  const get = async (fx: Fixture) => botOps(fx, ["routing-get"]);

  test("returns both files", async () => {
    const fx = setup(ENV, { routing: JSON.stringify(ROUTING), discovery: JSON.stringify(DISCOVERY) });
    const run = await get(fx);
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ routing: ROUTING, discovery: DISCOVERY });
    expect(run.stderr).toBe("");
  });

  test("a missing file is null, not an error", async () => {
    const neither = await get(setup(ENV));
    expect(neither.exitCode).toBe(0);
    expect(neither.json).toEqual({ routing: null, discovery: null });
    const onlyRouting = await get(setup(ENV, { routing: JSON.stringify(ROUTING) }));
    expect(onlyRouting.json).toEqual({ routing: ROUTING, discovery: null });
    const onlyDiscovery = await get(setup(ENV, { discovery: JSON.stringify(DISCOVERY) }));
    expect(onlyDiscovery.json).toEqual({ routing: null, discovery: DISCOVERY });
  });

  test("a corrupt file is null, not an error", async () => {
    for (const bad of ['{ "v": 1, "plugins": ', "", "not json at all", "[]", "42", '"a string"', "null", '{"a":1}{"b":2}']) {
      const fx = setup(ENV, { routing: bad, discovery: JSON.stringify(DISCOVERY) });
      const run = await get(fx);
      expect(run.exitCode, bad).toBe(0);
      expect(run.json, bad).toEqual({ routing: null, discovery: DISCOVERY });
    }
    // and both corrupt at once: still valid JSON on stdout
    const both = await get(setup(ENV, { routing: "{", discovery: "}" }));
    expect(both.exitCode).toBe(0);
    expect(both.json).toEqual({ routing: null, discovery: null });
  });

  test("never reads the secrets file", async () => {
    const fx = setup(ENV, { routing: JSON.stringify(ROUTING), discovery: JSON.stringify(DISCOVERY) });
    await get(fx);
    const calls = dockerCalls(fx);
    expect(calls.some((c) => c.includes("routing.secrets"))).toBe(false);
    // exactly two reads, of exactly the two files
    expect(calls).toEqual([
      expect.stringContaining("exec probe-container cat /app/data/routing.json"),
      expect.stringContaining("exec probe-container cat /app/data/discovery.json"),
    ]);
    // the fixture shim matches by substring: prove the secrets path could never satisfy the routing match
    expect("/app/data/routing.secrets.json".includes("/app/data/routing.json")).toBe(false);
  });

  test("the script never names the secrets file", () => {
    expect(readFileSync(BOT_OPS_SH, "utf8")).not.toContain("routing.secrets");
  });

  test("a webhook URL a hand-edit left in either file never appears in the output", async () => {
    const dirtyRouting = {
      ...ROUTING,
      note: `see ${WEBHOOK_URL} for the hook`,
      // url / token / secret / password members are dropped whatever their case
      webhooks: {
        [CHANNEL]: {
          ...ROUTING.webhooks[CHANNEL],
          url: WEBHOOK_URL,
          token: WEBHOOK_TOKEN,
          Token: "TokenCased_9f8e7d6c",
          URL: "UrlCased_1a2b3c4d",
          secret: "member-secret-5e6f",
          Password: "member-password-7a8b",
        },
      },
      [WEBHOOK_URL]: 1, // even as a key
    };
    const dirtyDiscovery = { ...DISCOVERY, hook: "https://discordapp.com/api/v10/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWx", tail: "webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz" };
    const run = await get(setup(ENV, { routing: JSON.stringify(dirtyRouting), discovery: JSON.stringify(dirtyDiscovery) }));
    expect(run.exitCode).toBe(0);
    for (const leak of [WEBHOOK_TOKEN, "AbCdEfGhIjKlMnOpQrStUvWx", "https://discord.com/api/webhooks", "https://discordapp.com/api", "TokenCased_9f8e7d6c", "UrlCased_1a2b3c4d", "member-secret-5e6f", "member-password-7a8b"]) {
      expect(run.stdout, leak).not.toContain(leak);
    }
    const out = run.json as { routing: Record<string, unknown>; discovery: Record<string, unknown> };
    expect(out.routing.plugins).toEqual(ROUTING.plugins); // everything else survives untouched
    expect(out.routing.webhooks).toEqual(ROUTING.webhooks); // the hand-edited url / token members are dropped, the metadata stays
    expect(out.discovery.inviteUrl).toBe(DISCOVERY.inviteUrl); // an invite URL is not a webhook URL
    expect(JSON.stringify(out.routing.note)).toContain("[redacted]");
  });

  test("a large discovery file (past Linux's 128 KB single-argument limit) comes through whole", async () => {
    // Windows' command line is capped near 32 KB and Linux's single argument at 128 KB, so the file has
    // to be bigger than both for a regression to `--argjson` to fail on either CI or a dev box.
    const channels = Array.from({ length: 1800 }, (_, i) => ({ id: String(500000000000000000n + BigInt(i)), name: `channel-${i}-with-a-reasonably-long-name`, canSend: i % 2 === 0 }));
    const big = { ...DISCOVERY, guilds: [{ ...DISCOVERY.guilds[0]!, channels }] };
    expect(JSON.stringify(big).length).toBeGreaterThan(140_000);
    const run = await get(setup(ENV, { discovery: JSON.stringify(big) }));
    expect(run.exitCode).toBe(0);
    expect(run.json).toEqual({ routing: null, discovery: big });
  });

  test("routing-get is a recognised subcommand and appears in usage", async () => {
    const run = await botOps(setup(ENV), ["bogus-subcommand"]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("routing-get");
  });
});

describe.skipIf(!runnable)("plugin-request routing actions (#240)", () => {
  const ENV = "PLUGINS=music\nANNOUNCE_CHANNEL_ID=11111\n";
  const req = (o: object) => JSON.stringify(o);
  const GUILD = "123456789012345678";
  const CHANNEL = "223456789012345678";
  const wrote = (fx: Fixture) => dockerCalls(fx).some((c) => c.includes("/app/data/plugins/requests/"));
  const stdinOf = (fx: Fixture) => readFileSync(join(fx.bin, "request-stdin.json"), "utf8");

  /** What the bot's own reader (src/routing/model.ts) would keep of a `servers` value for a plugin. */
  const keptByBot = (servers: unknown): unknown => repairRouting({ plugins: { music: { servers } } }).plugins.music?.servers;

  const GOOD_SERVERS: Record<string, unknown>[] = [
    { [GUILD]: { commands: "all" } },
    { [GUILD]: { commands: "all", postTo: CHANNEL } },
    { [GUILD]: { commands: [CHANNEL, "323456789012345678"], postTo: CHANNEL }, "923456789012345678": { commands: "all" } },
    {}, // an empty object is valid: the plugin is placed nowhere
  ];

  test("routing-set round-trips to the mailbox", async () => {
    const fx = setup(ENV);
    const servers = GOOD_SERVERS[1]!;
    const run = await botOps(fx, ["plugin-request"], req({ action: "routing-set", plugin: "music", servers, requestedBy: "email:me@x.com" }));
    expect(run.exitCode).toBe(0);
    expect(run.json?.queued).toMatch(/^\d{10,}-routing-set-\d+\.json$/);
    const exec = dockerCalls(fx).find((c) => c.startsWith("docker exec -i -u bun"));
    expect(exec).toContain("/app/data/plugins/requests/");
    expect(JSON.parse(stdinOf(fx))).toEqual({ action: "routing-set", plugin: "music", servers, requestedBy: "email:me@x.com" });
  });

  test("every routing-set shape the script accepts is one the bot's own repair (src/routing/model.ts) keeps intact", async () => {
    for (const servers of GOOD_SERVERS) {
      const fx = setup(ENV);
      const run = await botOps(fx, ["plugin-request"], req({ action: "routing-set", plugin: "music", servers, requestedBy: "t" }));
      expect(run.exitCode, JSON.stringify(servers)).toBe(0);
      expect(keptByBot(servers), JSON.stringify(servers)).toEqual(servers);
    }
  });

  const BAD_SERVERS: [string, unknown][] = [
    ["servers missing", undefined],
    ["servers null", null],
    ["servers an array", []],
    ["servers a string", "all"],
    ["a non-snowflake server id", { abc: { commands: "all" } }],
    ["a too-short server id", { "1234": { commands: "all" } }],
    ["a prototype-ish server id", JSON.parse('{"__proto__": {"commands": "all"}}')],
    ["a server entry that is not an object", { [GUILD]: "all" }],
    ["an empty channel list", { [GUILD]: { commands: [] } }],
    ["a non-snowflake channel in the list", { [GUILD]: { commands: [CHANNEL, "12"] } }],
    ["a non-string channel in the list", { [GUILD]: { commands: [123456789012345678] } }],
    ["commands neither all nor a list", { [GUILD]: { commands: "some" } }],
    ["commands missing", { [GUILD]: { postTo: CHANNEL } }],
    ["a non-snowflake postTo", { [GUILD]: { commands: "all", postTo: "general" } }],
    ["a numeric postTo", { [GUILD]: { commands: "all", postTo: 223456789012345678 } }],
    ["a null postTo", { [GUILD]: { commands: "all", postTo: null } }],
  ];
  test("routing-set rejects each malformed shape, naming the field, before touching docker", async () => {
    const fx = setup(ENV);
    for (const [why, servers] of BAD_SERVERS) {
      const run = await botOps(fx, ["plugin-request"], req({ action: "routing-set", plugin: "music", servers, requestedBy: "t" }));
      expect(run.exitCode, why).not.toBe(0);
      expect(run.stderr, why).toContain("plugin-request: bad servers");
      // whatever the script rejects, the bot's own repair would not have kept verbatim
      if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
        expect(keptByBot(servers), why).not.toEqual(servers);
      }
    }
    const badPlugin = await botOps(fx, ["plugin-request"], req({ action: "routing-set", plugin: "Music", servers: {}, requestedBy: "t" }));
    expect(badPlugin.exitCode).not.toBe(0);
    expect(badPlugin.stderr).toContain("plugin-request: bad plugin");
    expect(wrote(fx)).toBe(false);
  });

  test("webhook-add round-trips on stdin", async () => {
    const fx = setup(ENV);
    const run = await botOps(fx, ["plugin-request"], req({ action: "webhook-add", url: WEBHOOK_URL, requestedBy: "email:me@x.com" }));
    expect(run.exitCode).toBe(0);
    expect(run.json?.queued).toMatch(/^\d{10,}-webhook-add-\d+\.json$/);
    expect(JSON.parse(stdinOf(fx))).toEqual({ action: "webhook-add", url: WEBHOOK_URL, requestedBy: "email:me@x.com" });
    expect(run.stdout).not.toContain(WEBHOOK_TOKEN); // the result names the file, never the URL
  });

  test("a webhook url never appears in argv (docker.log), stdout or stderr", async () => {
    const fx = setup(ENV);
    const run = await botOps(fx, ["plugin-request"], req({ action: "webhook-add", url: WEBHOOK_URL, requestedBy: "t" }));
    expect(run.exitCode).toBe(0);
    const seen = everythingObservable(fx, run);
    expect(seen).not.toContain(WEBHOOK_TOKEN);
    expect(seen).not.toContain("webhooks/");
  });

  // A request file is never visible half-written, and is owner-only (#241's gate found the race: `cat >
  // <final>` creates the file before filling it, and the bot's drain rejects a `.json` it cannot parse).
  // The fake docker runs the `sh -c` for real against <bin>/data (see setup()), so these check what the
  // write LEAVES in the directory as well as the command string.
  const REQUESTS: { action: string; [k: string]: unknown }[] = [
    { action: "update-now", plugin: "music", version: "1.1.0", requestedBy: "t" },
    { action: "schedule", plugin: "music", version: "1.1.0", at: "2026-09-06T18:30-07:00", requestedBy: "t" },
    { action: "remind", plugin: "music", version: "1.1.0", days: 3, requestedBy: "t" },
    { action: "skip", plugin: "music", version: "1.1.0", requestedBy: "t" },
    { action: "cancel", plugin: "music", requestedBy: "t" },
    { action: "routing-set", plugin: "music", servers: {}, requestedBy: "t" },
    { action: "webhook-add", url: WEBHOOK_URL, requestedBy: "t" },
    { action: "webhook-remove", channelId: CHANNEL, requestedBy: "t" },
    { action: "discovery-refresh", requestedBy: "t" },
  ];
  const writeCall = (fx: Fixture): string => dockerCalls(fx).find((c) => c.includes("/app/data/plugins/requests/")) ?? "";
  const mailbox = (fx: Fixture): string => join(fx.bin, "data", "plugins", "requests");

  test("the request is written to a .tmp name and renamed into place", async () => {
    for (const payload of REQUESTS) {
      const fx = setup(ENV);
      const run = await botOps(fx, ["plugin-request"], req(payload));
      expect(run.exitCode, payload.action).toBe(0);
      const queued = String(run.json?.queued);
      // `cat > <dir>/<file>.tmp && mv <dir>/<file>.tmp <dir>/<file>`, in that order, the same <file>
      const m = writeCall(fx).match(/cat > (\/app\/data\/plugins\/requests\/\S+\.json)\.tmp && mv \1\.tmp \1 \|\|/);
      expect(m, `${payload.action}: ${writeCall(fx)}`).not.toBeNull();
      expect(m![1], payload.action).toBe(`/app/data/plugins/requests/${queued}`);
      // and for real: the directory holds exactly the final file, with the whole body, and no temp file
      expect(readdirSync(mailbox(fx)), payload.action).toEqual([queued]);
      expect(readFileSync(join(mailbox(fx), queued), "utf8"), payload.action).toBe(stdinOf(fx));
    }
  });

  test("the temp name does not end in .json, so the bot's drain never lists it", async () => {
    // The assumption this rests on: the drain lists only names ending .json.
    const consumer = readFileSync(new URL("../src/plugins/requests.ts", import.meta.url), "utf8");
    expect(consumer).toMatch(/endsWith\("\.json"\)/);
    const fx = setup(ENV);
    expect((await botOps(fx, ["plugin-request"], req(REQUESTS[3]!))).exitCode).toBe(0);
    const tmp = writeCall(fx).match(/cat > (\S+)/)?.[1] ?? "";
    expect(tmp).toMatch(/\.json\.tmp$/);
    expect(tmp.endsWith(".json")).toBe(false);
  });

  test("the write is owner-only: umask 077 comes after mkdir -p and before the write", async () => {
    for (const payload of REQUESTS) {
      const fx = setup(ENV);
      expect((await botOps(fx, ["plugin-request"], req(payload))).exitCode, payload.action).toBe(0);
      const call = writeCall(fx);
      const [mkdir, umask, write] = [call.indexOf("mkdir -p"), call.indexOf("umask 077"), call.indexOf("cat >")];
      expect(mkdir, payload.action).toBeGreaterThan(-1);
      expect(umask, payload.action).toBeGreaterThan(mkdir); // a not-yet-existing requests/ keeps the ordinary mode
      expect(write, payload.action).toBeGreaterThan(umask);
    }
  });

  test("a failed write removes the temp file and exits non-zero, never reporting queued", async () => {
    // The rename fails after the body is on disk: the temp file must not be left behind.
    const fx = setup(ENV, { requestWrite: "mv-fails" });
    const run = await botOps(fx, ["plugin-request"], req({ action: "webhook-add", url: WEBHOOK_URL, requestedBy: "t" }));
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).not.toContain("queued");
    expect(run.stderr).toContain("plugin-request: could not write the request");
    expect(everythingObservable(fx, run)).not.toContain(WEBHOOK_TOKEN);
    expect(JSON.parse(stdinOf(fx)).url).toBe(WEBHOOK_URL); // the body did reach the shell...
    expect(existsSync(mailbox(fx)) ? readdirSync(mailbox(fx)) : []).toEqual([]); // ...and nothing is left behind
    // The whole `docker exec` failing (container not running) is the same story.
    const dead = setup(ENV, { requestWrite: "exec-fails" });
    const run2 = await botOps(dead, ["plugin-request"], req(REQUESTS[3]!));
    expect(run2.exitCode).not.toBe(0);
    expect(run2.stdout).not.toContain("queued");
    expect(run2.stderr).toContain("plugin-request: could not write the request");
  });

  test("a bad webhook url is rejected without echoing it", async () => {
    const fx = setup(ENV);
    const bad: [string, unknown][] = [
      ["http, not https", `http://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`],
      ["another host", `https://example.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`],
      ["a look-alike host", `https://discord.com.evil.example/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`],
      ["a look-alike subdomain", `https://evil.discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`],
      ["a token that is too short", "https://discord.com/api/webhooks/123456789012345678/short"],
      ["no webhook id", `https://discord.com/api/webhooks/${WEBHOOK_TOKEN}`],
      ["a non-numeric id", `https://discord.com/api/webhooks/abc/${WEBHOOK_TOKEN}`],
      ["a query string", `${WEBHOOK_URL}?wait=true`],
      ["a trailing path", `${WEBHOOK_URL}/extra`],
      ["a leading space", ` ${WEBHOOK_URL}`],
      ["a trailing newline", `${WEBHOOK_URL}\n`],
      ["userinfo", `https://user:pw@discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`],
      ["not a string", 12345],
      ["an object", { u: WEBHOOK_URL }],
      ["missing", undefined],
    ];
    for (const [why, url] of bad) {
      const run = await botOps(fx, ["plugin-request"], req({ action: "webhook-add", url, requestedBy: "t" }));
      expect(run.exitCode, why).not.toBe(0);
      expect(run.stderr, why).toContain("plugin-request: bad webhook url");
      expect(run.stderr, why).not.toContain(WEBHOOK_TOKEN);
      expect(run.stderr, why).not.toContain("https://");
      expect(run.stdout, why).not.toContain(WEBHOOK_TOKEN);
    }
    expect(wrote(fx)).toBe(false);
  });

  test("a webhook url on the canary / ptb / discordapp hosts, with or without an API version, is accepted", async () => {
    for (const host of ["discord.com", "canary.discord.com", "ptb.discord.com", "discordapp.com"]) {
      for (const api of ["api", "api/v10"]) {
        const fx = setup(ENV);
        const url = `https://${host}/${api}/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;
        const run = await botOps(fx, ["plugin-request"], req({ action: "webhook-add", url, requestedBy: "t" }));
        expect(run.exitCode, url).toBe(0);
      }
    }
  });

  test("webhook-remove: accepted with a channel id, rejected naming the field otherwise", async () => {
    const fx = setup(ENV);
    const ok = await botOps(fx, ["plugin-request"], req({ action: "webhook-remove", channelId: CHANNEL, requestedBy: "t" }));
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(stdinOf(fx))).toEqual({ action: "webhook-remove", channelId: CHANNEL, requestedBy: "t" });
    const bad: unknown[] = ["abc", "1234", "12345678901234567890123456", 12345, CHANNEL + "x", "", undefined, null, { id: CHANNEL }];
    for (const channelId of bad) {
      const run = await botOps(fx, ["plugin-request"], req({ action: "webhook-remove", channelId, requestedBy: "t" }));
      expect(run.exitCode, String(channelId)).not.toBe(0);
      expect(run.stderr, String(channelId)).toContain("plugin-request: bad channelId");
    }
  });

  test("discovery-refresh round-trips", async () => {
    const fx = setup(ENV);
    const run = await botOps(fx, ["plugin-request"], req({ action: "discovery-refresh", requestedBy: "email:me@x.com" }));
    expect(run.exitCode).toBe(0);
    expect(run.json?.queued).toMatch(/^\d{10,}-discovery-refresh-\d+\.json$/);
    expect(JSON.parse(stdinOf(fx))).toEqual({ action: "discovery-refresh", requestedBy: "email:me@x.com" });
  });

  test("the five update actions still validate exactly as before", async () => {
    const fx = setup(ENV);
    // the same two rejections the #105 suite asserts, and one acceptance per family of checks
    const cases: [object, string][] = [
      [{ action: "rm-rf", plugin: "warbandeer", version: "1.1.0", requestedBy: "t" }, "plugin-request: bad action 'rm-rf'"],
      [{ action: "skip", plugin: "Warbandeer", version: "1.1.0", requestedBy: "t" }, "plugin-request: bad plugin 'Warbandeer'"],
      [{ action: "update-now", plugin: "warbandeer", version: "1.0.0/../x", requestedBy: "t" }, "plugin-request: bad version '1.0.0/../x'"],
      [{ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "tomorrow", requestedBy: "t" }, "plugin-request: bad at 'tomorrow'"],
      [{ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 0, requestedBy: "t" }, "plugin-request: bad days '0'"],
    ];
    for (const [payload, msg] of cases) {
      const run = await botOps(fx, ["plugin-request"], req(payload));
      expect(run.exitCode, msg).not.toBe(0);
      expect(run.stderr, msg).toContain(msg);
    }
    // the version check covers every update action except cancel, not just the first one above
    for (const action of ["update-now", "schedule", "remind", "skip"]) {
      const run = await botOps(fx, ["plugin-request"], req({ action, plugin: "warbandeer", version: "1.2", at: "2026-09-06T18:30-07:00", days: 3, requestedBy: "t" }));
      expect(run.exitCode, action).not.toBe(0);
      expect(run.stderr, action).toContain("plugin-request: bad version '1.2'");
    }
    expect(wrote(fx)).toBe(false);
    for (const payload of [
      { action: "cancel", plugin: "warbandeer", requestedBy: "t" },
      { action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "2026-09-06T18:30-07:00", requestedBy: "t" },
      { action: "remind", plugin: "warbandeer", version: "1.1.0", days: 7, requestedBy: "t" },
    ]) {
      expect((await botOps(fx, ["plugin-request"], req(payload))).exitCode, payload.action).toBe(0);
    }
    // the new actions do not leak into the old arms: a routing-only field is not required by an update action
    expect((await botOps(fx, ["plugin-request"], req({ action: "update-now", plugin: "warbandeer", version: "1.1.0" }))).exitCode).toBe(0);
  });

  test("a rejected request never echoes a value longer than a plugin name would be, whatever field it sits in", async () => {
    const fx = setup(ENV);
    const cases: [object, string][] = [
      [{ action: WEBHOOK_URL, plugin: "music", requestedBy: "t" }, "bad action '(not shown)'"],
      [{ action: "skip", plugin: WEBHOOK_URL, version: "1.1.0", requestedBy: "t" }, "bad plugin '(not shown)'"],
      [{ action: "update-now", plugin: "music", version: WEBHOOK_URL, requestedBy: "t" }, "bad version '(not shown)'"],
      [{ action: "schedule", plugin: "music", version: "1.1.0", at: WEBHOOK_URL, requestedBy: "t" }, "bad at '(not shown)'"],
      [{ action: "remind", plugin: "music", version: "1.1.0", days: WEBHOOK_URL, requestedBy: "t" }, "bad days '(not shown)'"],
      [{ action: "routing-set", plugin: WEBHOOK_URL, servers: {}, requestedBy: "t" }, "bad plugin"],
    ];
    for (const [payload, msg] of cases) {
      const run = await botOps(fx, ["plugin-request"], req(payload));
      expect(run.exitCode, msg).not.toBe(0);
      expect(run.stderr, msg).toContain(msg);
      expect(run.stderr, msg).not.toContain(WEBHOOK_TOKEN);
    }
    expect(wrote(fx)).toBe(false);
    // the limit is exactly 40 printable characters: 40 are echoed, 41 are not
    const at40 = await botOps(fx, ["plugin-request"], req({ action: "skip", plugin: "P".repeat(40), version: "1.1.0" }));
    expect(at40.stderr).toContain(`bad plugin '${"P".repeat(40)}'`);
    const at41 = await botOps(fx, ["plugin-request"], req({ action: "skip", plugin: "P".repeat(41), version: "1.1.0" }));
    expect(at41.stderr).toContain("bad plugin '(not shown)'");
    expect(wrote(fx)).toBe(false);
  });

  test("a routing-set plugin name with a trailing newline or another control character is rejected, not queued with it", async () => {
    const fx = setup(ENV);
    for (const plugin of ["music\n", "music\r", "music\t", "mu sic"]) {
      const run = await botOps(fx, ["plugin-request"], req({ action: "routing-set", plugin, servers: {}, requestedBy: "t" }));
      expect(run.exitCode, JSON.stringify(plugin)).not.toBe(0);
      expect(run.stderr, JSON.stringify(plugin)).toContain("plugin-request: bad plugin");
    }
    expect(wrote(fx)).toBe(false);
  });

  test("a webhook token needs at least 20 characters (Discord's are far longer)", async () => {
    const fx = setup(ENV);
    const url = (token: string) => `https://discord.com/api/webhooks/123456789012345678/${token}`;
    const short = await botOps(fx, ["plugin-request"], req({ action: "webhook-add", url: url("a".repeat(19)), requestedBy: "t" }));
    expect(short.exitCode).not.toBe(0);
    expect(short.stderr).toContain("plugin-request: bad webhook url");
    expect(wrote(fx)).toBe(false);
    const ok = await botOps(fx, ["plugin-request"], req({ action: "webhook-add", url: url("a".repeat(20)), requestedBy: "t" }));
    expect(ok.exitCode).toBe(0);
  });

  test("an unknown action, including a near-miss of a new one, is rejected", async () => {
    const fx = setup(ENV);
    for (const action of ["webhook-list", "routing-get", "Routing-Set", "webhook_add", ""]) {
      const run = await botOps(fx, ["plugin-request"], req({ action, plugin: "music", requestedBy: "t" }));
      expect(run.exitCode, action).not.toBe(0);
      expect(run.stderr, action).toContain("plugin-request: bad action");
    }
    expect(wrote(fx)).toBe(false);
  });
});

// The deployment owns a set of keys (core credentials, access control, every variable compose
// interpolates) that no Plugin Index manifest may make editable. The set is hand-maintained in the
// script (RESERVED_KEYS), so it is pinned against the two places a new core secret would show up.
describe("RESERVED_KEYS covers the deployment's own keys (#240)", () => {
  const script = readFileSync(BOT_OPS_SH, "utf8");
  const block = script.match(/declare -A RESERVED_KEYS=\(([\s\S]*?)\n\)/)?.[1] ?? "";
  const reserved = new Set([...block.matchAll(/\[([A-Z][A-Z0-9_]*)\]=1/g)].map((m) => m[1]!));

  test("the block is found and non-empty (can't pass vacuously)", () => {
    expect(reserved.size).toBeGreaterThanOrEqual(15);    expect(reserved.has("DISCORD_TOKEN") && reserved.has("GITHUB_TOKEN") && reserved.has("ADMIN_TOKEN")).toBe(true);
  });

  // Credentials a first-party plugin owns are NOT reserved, on purpose (ADR-0006 decision 8): the panel
  // sets them write-only. Add a key here only when a plugin's Plugin Index entry declares it and nothing
  // in the bot core (src/) reads it. Each entry is checked below against .env.example's "Used by the
  // <plugin> plugin" block, so this list cannot be used to un-reserve a core key by accident.
  const PLUGIN_OWNED: Record<string, string> = { BLIZZARD_CLIENT_ID: "wow", BLIZZARD_CLIENT_SECRET: "wow" };
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  /** .env.example's blank-line-separated blocks: the plugin a "# Used by the <name> plugin" header names
   *  (or null) and the keys the block sets. */
  const blocks = example.split(/\r?\n[ \t]*\r?\n/).map((b) => ({
    plugin: b.match(/^# Used by the ([a-z][a-z0-9-]*) plugin/m)?.[1] ?? null,
    keys: [...b.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
  }));

  test("every credential-shaped key in .env.example is reserved, bar the plugin-owned exemptions", () => {
    const keys = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    const credentialShaped = keys.filter((k) => /TOKEN|SECRET|CLIENT_ID|PASSWORD|_KEY$|ALLOWED_EMAILS|ACCESS_/.test(k));
    expect(credentialShaped.length).toBeGreaterThanOrEqual(6);
    expect(credentialShaped.filter((k) => !reserved.has(k) && !(k in PLUGIN_OWNED))).toEqual([]);
  });

  test("each plugin-owned exemption is unreserved and really sits under its plugin's block in .env.example", () => {
    expect(Object.keys(PLUGIN_OWNED)).toEqual(["BLIZZARD_CLIENT_ID", "BLIZZARD_CLIENT_SECRET"]);
    for (const [key, plugin] of Object.entries(PLUGIN_OWNED)) {
      expect(reserved.has(key), `${key} is plugin-owned, so it must not be reserved`).toBe(false);
      const block = blocks.find((b) => b.keys.includes(key));
      expect(block?.plugin, `${key} must sit under a "# Used by the <plugin> plugin" block`).toBe(plugin);
    }
    // ...and a core key is in no such block, so listing it as an exemption would fail the check above.
    expect(blocks.find((b) => b.keys.includes("DISCORD_TOKEN"))?.plugin ?? null).toBeNull();
  });

  test("every variable docker-compose.yml interpolates is reserved", () => {
    const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
    const vars = [...new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!))];
    expect(vars.length).toBeGreaterThanOrEqual(10);
    expect(vars.filter((v) => !reserved.has(v))).toEqual([]);
  });

  test("no reserved key is also an ALLOWED_SPEC key (the two sets are disjoint by construction)", () => {
    const allowedBlock = script.match(/ALLOWED_SPEC=\(([\s\S]*?)\n\)/)?.[1] ?? "";
    const allowed = [...allowedBlock.matchAll(/^\s*'([A-Z0-9_]+)\|/gm)].map((m) => m[1]!);
    expect(allowed.length).toBeGreaterThan(5);
    expect(allowed.filter((k) => reserved.has(k))).toEqual([]);
  });
});
