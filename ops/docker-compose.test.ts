// Proves issue #41's acceptance bullet for real: `docker compose ... config` on a bootstrapped
// instance's stack directory resolves container_name/env_file to that instance, not the
// monorepo-era fallback — invoked exactly the way Dockge does it (cwd = stack dir, no `-p`, no
// shell-exported vars; see ops/install.sh and CONTEXT.md's "two interpolation sources" note).
// Needs a real `docker` with the `compose` plugin on PATH; skips LOUDLY (not vacuously) on a box
// without one, same convention as ops/bot-ops.test.ts. This dev box has `docker` but not the
// `compose` plugin — GitHub Actions' ubuntu-latest runners ship both, so CI is where this runs
// for real.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const COMPOSE_SRC = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));

// A deliberately narrow view of `config --format json`'s output — only `container_name` is typed;
// everything else on a service is left as `unknown` and read via a whole-object JSON.stringify
// (see the env_file assertion below) rather than a specific key, since Compose's own normalization
// of `env_file:` isn't stable/documented enough to assert an exact shape against.
interface ComposeConfig {
  services: Record<string, { container_name?: string } & Record<string, unknown>>;
}

// The exact keys ops/install.sh writes into a stack directory's own .env (its compose-project
// interpolation source, distinct from env_file: — see install.sh's STACKENV heredoc). Stripped
// from the child's environment before every invocation below so an ambient value in the host or
// CI shell can never leak in and silently validate the wrong thing.
const STACK_VARS = [
  "BOT_ENV_FILE",
  "BOT_OPS_CONTAINER",
  "BOT_OPS_PROJECT",
  "BOT_OPS_CONFIG_DIR",
  "BOT_OPS_COMPOSE_FILE",
  "BOT_BUILD_CONTEXT",
  "GIT_SHA",
];
function cleanEnv(): Record<string, string> {
  const env = { ...process.env };
  for (const key of STACK_VARS) delete env[key];
  return env as Record<string, string>;
}

function composeRunnable(): boolean {
  if (!Bun.which("docker")) return false;
  return Bun.spawnSync(["docker", "compose", "version"], { env: cleanEnv() }).exitCode === 0;
}
const runnable = composeRunnable();
if (!runnable) {
  console.warn("[docker-compose.test] SKIPPING: needs `docker` with the `compose` plugin on PATH");
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway stack dir holding a COPY of the real docker-compose.yml (never the repo-root file
 *  in place — Compose's project directory, and therefore where it auto-loads `.env` from, is the
 *  directory of the `-f` file, so pointing at the repo root would always hit the fallback and
 *  prove nothing) plus, optionally, a project `.env` for `${VAR}` interpolation. */
function makeStack(env: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "compose-41-"));
  copyFileSync(COMPOSE_SRC, join(dir, "docker-compose.yml"));
  if (env !== null) writeFileSync(join(dir, ".env"), env);
  dirs.push(dir);
  return dir;
}

async function composeConfig(
  dir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string; json: ComposeConfig | null }> {
  const proc = Bun.spawn(["docker", "compose", "-f", "docker-compose.yml", "config", "--format", "json"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    // No BOT_OPS_*/BOT_ENV_FILE exported by default — mirrors Dockge's own invocation exactly.
    // extraEnv layers on top for tests that need to simulate a specific shell export (e.g. the
    // CLOUDFLARE_TUNNEL_TOKEN a real operator would export by hand — see issue #54's tests below).
    env: { ...cleanEnv(), ...extraEnv },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let json: ComposeConfig | null = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* an error path — asserted on stderr/exit code instead */
  }
  return { exitCode, stderr, json };
}

// Scope note: these tests only exercise the `bot` service — the one Dockge's plain Start/Restart/
// Stop always touches, profile or no profile. They deliberately do NOT create an `ops/admin/`
// directory in the fixture, so `admin`'s own `build.context` (`${ADMIN_BUILD_CONTEXT:-./ops/admin}`)
// points at a path that doesn't exist here — matching a REAL bootstrapped stack directory exactly:
// ops/install.sh only ever writes docker-compose.yml + .env into $STACK_DIR, never a copy of
// ops/admin/. Confirmed in CI (this repo's ubuntu-latest runner, real `docker compose`): `config`
// with no `--profile admin` renders cleanly regardless — an inactive profile's build context is not
// filesystem-validated, only its `${VAR}` interpolation is (consistent with `admin`'s own
// `BOT_OPS_CONFIG_DIR`/`BOT_OPS_COMPOSE_FILE` needing the `:-` — not `:?` — default documented in
// CONTEXT.md, which is about interpolation validation, not build-context resolution).
describe.skipIf(!runnable)("docker-compose.yml interpolation resolves per-instance, not monorepo-era (issue #41)", () => {
  test("a bootstrapped instance's stack .env overrides every monorepo-era fallback", async () => {
    const dir = makeStack(null);
    // env_file:'s short form defaults to required: true — the target must actually exist on disk
    // or `config` itself refuses to resolve it, same as a real deploy's BOT_ENV_FILE. A marker
    // line (rather than an empty file) lets the assertion below prove the RIGHT file was loaded —
    // Compose's `config` folds a resolved env_file's contents into the service's own environment
    // rather than echoing the source path back out (confirmed empirically: asserting on a path
    // substring under an `env_file` key failed in CI with "Received value must be ... a string" —
    // that key is undefined in the rendered JSON once Compose has already resolved it).
    const botEnvFile = join(dir, "bot-secrets.env");
    writeFileSync(botEnvFile, "PROBE_ENV_MARKER=rackbops-instance-secrets\n");
    const stackEnv = [
      `BOT_ENV_FILE=${botEnvFile}`,
      "BOT_OPS_CONTAINER=probe-instance",
      "BOT_OPS_PROJECT=probe-instance",
      `BOT_OPS_CONFIG_DIR=${dir}`,
      `BOT_OPS_COMPOSE_FILE=${join(dir, "docker-compose.yml")}`,
      "BOT_BUILD_CONTEXT=https://example.invalid/repo.git#main",
      "GIT_SHA=deadbeef",
      "",
    ].join("\n");
    writeFileSync(join(dir, ".env"), stackEnv);

    const { exitCode, json } = await composeConfig(dir);
    expect(exitCode).toBe(0);
    expect(json!.services.bot!.container_name).toBe("probe-instance");
    expect(json!.services.bot!.container_name).not.toBe("warbandeer-discord");
    // Whole-object stringify rather than a specific key — robust to wherever Compose's resolved
    // JSON actually places a loaded env_file's contents (see the comment above).
    expect(JSON.stringify(json!.services.bot)).toContain("rackbops-instance-secrets");
    // #60 item 2 / #168: BOT_ENV_FILE itself must ALSO reach the bot's runtime `environment` (a
    // separate mechanism from env_file: above, which only loads that file's CONTENTS) — this is
    // what src/bootLog.ts reads to log which file it was actually started against. Whole-object
    // stringify (not a specific key/format) for the same Compose-rendering-shape-not-guaranteed
    // reason as the assertion above — `config --format json` may render `environment:` as either
    // an object or an array depending on version, so check both the key name and the resolved
    // value appear, rather than assume a `KEY=value` shape. Mutation: removing docker-compose.yml's
    // `environment: BOT_ENV_FILE: ...` entry turns this red.
    const botServiceJson = JSON.stringify(json!.services.bot);
    expect(botServiceJson).toContain("BOT_ENV_FILE");
    expect(botServiceJson).toContain(botEnvFile);
  });

  test("a bare stack dir with a plain local .env (no BOT_OPS_* keys) keeps the local-dev default", async () => {
    // Mirrors real local dev: a checkout's own `.env` (from .env.example, holding DISCORD_TOKEN
    // etc.) sits beside docker-compose.yml — present, but defining none of the BOT_OPS_*/
    // BOT_ENV_FILE keys. CONTEXT.md documents this as the reason docker-compose.yml's own `:-`
    // fallbacks are left in place on purpose; this proves that claim instead of just reciting it.
    const dir = makeStack("DISCORD_TOKEN=unused-in-this-test\n");
    const { exitCode, json } = await composeConfig(dir);
    expect(exitCode).toBe(0);
    expect(json!.services.bot!.container_name).toBe("warbandeer-discord");
  });
});

// #178: the top-level x-rackbops-schema: key must NEVER break `docker compose config` — Compose
// ignores any top-level `x-` extension key by spec, but that's exactly the assumption worth
// proving for real rather than just citing, since a typo (a bad indent putting the key INSIDE
// `services:`, a duplicate top-level key) could silently turn this into a real validation error.
describe.skipIf(!runnable)("the x-rackbops-schema: stamp doesn't break docker compose config (issue #178)", () => {
  test("config still resolves cleanly with the schema key present", async () => {
    const dir = makeStack("DISCORD_TOKEN=unused-in-this-test\n");
    const { exitCode, stderr, json } = await composeConfig(dir);
    // The load-bearing assertion: config succeeds — an unknown top-level key that Compose rejected
    // (a typo nesting it under services:, a duplicate key) would turn this red with a real error.
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("x-rackbops-schema");
    expect(json!.services.bot).toBeTruthy();
  });
});

// #135 item 10: `admin`'s own BOT_OPS_PROJECT/BOT_OPS_CONTAINER `environment:` entries (distinct
// from the `bot`/`admin`/`tunnel` `container_name:` defaults above, which CONTEXT.md documents as
// a deliberate local-dev convenience and the test above pins) used to default to
// `warbandeer-discord*` — a value bot-ops.sh's own "not set" guard (ops/bot-ops.sh:106-115) reads
// as DATA, not just a Docker object label, so that bogus default silently defeated the guard and
// re-opened issue #41 one layer up. Proves the fix rather than just trusting the diff.
describe.skipIf(!runnable)("admin's BOT_OPS_PROJECT/BOT_OPS_CONTAINER resolve empty, not the monorepo-era default, when unset (issue #135 item 10)", () => {
  test("a bare stack dir with no BOT_OPS_* keys leaves admin's forwarded env empty", async () => {
    const dir = makeStack("DISCORD_TOKEN=unused-in-this-test\n");
    const { exitCode, json } = await composeConfig(dir, { COMPOSE_PROFILES: "admin" });
    expect(exitCode).toBe(0);
    expect(json!.services.admin).toBeTruthy();
    // Mutation: reverting either default back to `:-warbandeer-discord*` turns this red.
    expect(JSON.stringify(json!.services.admin)).not.toContain("warbandeer-discord");
  });
});

// install.sh's printed "bring it up" step (#169) is shortened to a bare `docker compose -f
// $STACK_DIR/docker-compose.yml -p $PROJECT up -d --build`, with none of GIT_SHA/BOT_ENV_FILE/
// BOT_BUILD_CONTEXT/BOT_OPS_CONTAINER exported as shell prefixes any more — they're all already in
// the generated $STACK_DIR/.env (install.sh:200-208), so dropping them relies entirely on Compose
// resolving its project directory (and therefore which .env it auto-loads) from the directory of
// the file passed via -f, regardless of the invoking shell's own cwd. The test above only proves
// that auto-load when cwd already IS the stack dir (Dockge's own invocation shape, matching this
// file's own top comment); install.sh's real invocation is different — an ABSOLUTE -f path, run
// from wherever the operator's shell happens to be, never a `cd` into the stack dir first. Proven
// for real here rather than trusted from Compose's docs, since a wrong assumption would silently
// break every future bring-up install.sh prints.
describe.skipIf(!runnable)("an absolute -f path resolves its OWN directory's .env regardless of cwd (#169)", () => {
  test("docker compose -f <absolute path> config still picks up that directory's .env from an unrelated cwd", async () => {
    const dir = makeStack(null);
    const botEnvFile = join(dir, "bot-secrets.env");
    writeFileSync(botEnvFile, "PROBE_ENV_MARKER=absolute-path-cwd-probe\n");
    const stackEnv = [
      `BOT_ENV_FILE=${botEnvFile}`,
      "BOT_OPS_CONTAINER=probe-abs-cwd-instance",
      "BOT_OPS_PROJECT=probe-abs-cwd-instance",
      `BOT_OPS_CONFIG_DIR=${dir}`,
      `BOT_OPS_COMPOSE_FILE=${join(dir, "docker-compose.yml")}`,
      "BOT_BUILD_CONTEXT=https://example.invalid/repo.git#main",
      "GIT_SHA=deadbeef",
      "",
    ].join("\n");
    writeFileSync(join(dir, ".env"), stackEnv);

    // The one thing that differs from every other test in this file: cwd is deliberately NOT dir
    // (an unrelated tmp dir), and -f carries dir's own ABSOLUTE path, not a bare relative filename.
    const proc = Bun.spawn(
      ["docker", "compose", "-f", join(dir, "docker-compose.yml"), "-p", "probe-abs-cwd", "config", "--format", "json"],
      { cwd: tmpdir(), stdout: "pipe", stderr: "pipe", env: cleanEnv() },
    );
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(exitCode).toBe(0);
    const json: ComposeConfig = JSON.parse(stdout);
    expect(json.services.bot!.container_name).toBe("probe-abs-cwd-instance");
    expect(json.services.bot!.container_name).not.toBe("warbandeer-discord");
    expect(JSON.stringify(json.services.bot)).toContain("absolute-path-cwd-probe");
  });
});

// cloudflared's TUNNEL_TOKEN is Compose *interpolation* (${CLOUDFLARE_TUNNEL_TOKEN} in the
// environment: block), resolved only from a shell-exported var or the stack directory's own
// .env — never from BOT_ENV_FILE/$CONFIG_DIR/.env, which is a completely separate env_file:
// runtime-injection mechanism (see the .env-precedence bullet in CONTEXT.md). install.sh's
// generated stack .env deliberately carries no secrets, so the only realistic path is a shell
// export — the same mechanism admin's own secrets already use, and what install.sh's printed
// tunnel-profile instructions do by hand.
describe.skipIf(!runnable)("cloudflared's TUNNEL_TOKEN resolves via Compose interpolation, not env_file (issue #54)", () => {
  // makeStack("") — not null — for the same reason the #41 test above uses a real file: the
  // `bot` service's `env_file: ${BOT_ENV_FILE:-.env}` short form defaults to `required: true`
  // (see that test's own comment), so `docker compose config` refuses to resolve ANY service in
  // the file, cloudflared included, unless *some* .env exists on disk relative to the stack dir —
  // empty is fine, since these tests don't want BOT_OPS_*/secrets in it anyway.
  //
  // COMPOSE_PROFILES=tunnel (equivalent to --profile tunnel) on every call here: a profile-gated
  // service is fully INTERPOLATED regardless of active profile (CONTEXT.md's own documented
  // finding, which the #41 tests above rely on for `admin`), but `config`'s rendered *output*
  // still omits a service whose profile isn't active — confirmed the hard way, in CI, once this
  // test actually ran against a real `docker compose` for the first time. Without it,
  // `json.services.cloudflared` is `undefined`, not merely token-less.
  test("a shell-exported CLOUDFLARE_TUNNEL_TOKEN reaches cloudflared's TUNNEL_TOKEN", async () => {
    const dir = makeStack("");
    const { exitCode, json } = await composeConfig(dir, {
      CLOUDFLARE_TUNNEL_TOKEN: "probe-tunnel-token",
      COMPOSE_PROFILES: "tunnel",
    });
    expect(exitCode).toBe(0);
    expect(JSON.stringify(json!.services.cloudflared)).toContain("probe-tunnel-token");
  });

  test("with no token anywhere, the :- default resolves it to empty with no undefined-variable warning", async () => {
    // Compose already tolerates a bare ${VAR} with no default (empty value, exit 0) — only `:?`
    // actually fails, so exitCode alone can't distinguish this from the pre-fix bare
    // ${CLOUDFLARE_TUNNEL_TOKEN}. The `:-` default's real, checkable effect is suppressing
    // Compose's own "variable is not set" warning on stderr for every var-less `docker compose`
    // invocation against this file (Dockge's Start/Stop/Restart included) — assert on that
    // directly rather than just the exit code.
    const dir = makeStack("");
    const { exitCode, stderr, json } = await composeConfig(dir, { COMPOSE_PROFILES: "tunnel" });
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("CLOUDFLARE_TUNNEL_TOKEN");
    expect(JSON.stringify(json!.services.cloudflared)).not.toContain("probe-tunnel-token");
  });
});
