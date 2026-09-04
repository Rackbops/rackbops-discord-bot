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

async function composeConfig(dir: string): Promise<{ exitCode: number; stderr: string; json: ComposeConfig | null }> {
  const proc = Bun.spawn(["docker", "compose", "-f", "docker-compose.yml", "config", "--format", "json"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: cleanEnv(), // no BOT_OPS_*/BOT_ENV_FILE exported — mirrors Dockge's own invocation exactly
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
