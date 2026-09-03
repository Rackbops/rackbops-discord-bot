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

function setup(envText: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "bot-ops-44-"));
  const cfg = join(root, "cfg");
  const bin = join(root, "bin");
  mkdirSync(cfg);
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    ["#!/usr/bin/env bash", `printf '%s\\n' "docker $*" >> "$(dirname "$0")/docker.log"`, "exit 0", ""].join("\n"),
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

async function botOps(fx: Fixture, args: string[], stdin?: string): Promise<Run> {
  // Windows spells the variable `Path`; setting a second `PATH` beside it would be ambiguous.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const proc = Bun.spawn([BASH!, bashPath(BOT_OPS_SH), ...args], {
    stdin: stdin !== undefined ? Buffer.from(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      [pathKey]: fx.bin + delimiter + (process.env[pathKey] ?? ""),
      BOT_OPS_PROJECT: "probe-project",
      BOT_OPS_CONTAINER: "probe-container",
      BOT_OPS_CONFIG_DIR: bashPath(fx.cfg),
      BOT_OPS_COMPOSE_FILE: bashPath(fx.compose),
    },
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
    expect(body.split("\n")).toHaveLength(12); // every whitelisted key echoed, like the old panel
    const run = await botOps(fx, ["env-set"], body);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ ok: true, changed: ["ANNOUNCE_CHANNEL_ID"], recreated: true });
    expect(envText(fx)).toBe('ADMIN_USER_IDS=123456, 234567\nWOW_REALM="stormrage"\nANNOUNCE_CHANNEL_ID=22222\n');
    expect(dockerCalls(fx)).toEqual([expect.stringContaining("up -d --force-recreate")]);
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
    expect(dockerCalls(fx)).toEqual([]);
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
    expect(dockerCalls(fx)).toEqual([]);
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
    expect(dockerCalls(fx)).toEqual([]);
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
    expect(dockerCalls(fx)).toHaveLength(1);
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
    expect(dockerCalls(fx)).toEqual([expect.stringContaining("-p probe-project up -d --force-recreate")]);
  });
});
