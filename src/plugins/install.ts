// Installs the plugins #98 selected: resolve package@version on the npm registry, download the
// tarball, verify its dist.integrity, and extract dist/plugin.js into data/plugins/<name>/<version>/.
// Pure over injected I/O (fetch/extract/now/log) so it unit-tests with a fake fetch + fixture
// tarball and never hits the network or the real data dir. No plugin CODE runs here — that is
// loadPlugins/activatePlugins in host.ts, inside the bot's activate() after takeOver().
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOST_API_VERSION, type PluginIndexEntry } from "./contract";
import type { SelectedPlugin } from "./registry";
import { compareSemver } from "./updates";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** #281: a blank (or whitespace-only) `PLUGIN_REGISTRY_URL` is unset — compose's `env_file:` sets a bare
 *  `KEY=` line to the empty string, and `.env.example` ships PLUGIN_REGISTRY_URL blank, so `??` alone
 *  (falling back only on undefined/null) let a shipped-as-documented instance resolve every plugin metadata
 *  URL against a relative path instead of the registry. This is broader than `src/config.ts`'s `optional()`
 *  (#436): that treats only the empty string as unset, so a whitespace-only `PLUGIN_INDEX_URL` that
 *  reaches the process is kept as given and fails that variable's scheme check at boot, while a
 *  whitespace-only value here falls back to npm. (Compose's `env_file:` and Bun's own `.env` reader
 *  already trim an unquoted one to empty, so in practice that takes a quoted value or a launch outside
 *  compose.) Exported so install.test.ts drives it directly rather than only through the module-level constant
 *  below. */
export function resolveRegistryBase(env: Record<string, string | undefined>): string {
  return (env.PLUGIN_REGISTRY_URL?.trim() || DEFAULT_REGISTRY).replace(/\/$/, "");
}

// Development-only override so the end-to-end fixture-plugin flow can point at a local registry
// stub (see .env.example). Production leaves it unset and resolves against npm. Exported (constant
// export only, nothing else changes) so install.test.ts can pin that THIS constant, not just
// resolveRegistryBase in isolation, is actually resolved through it in a fresh process.
export const REGISTRY_BASE = resolveRegistryBase(process.env);
const FETCH_TIMEOUT_MS = 30_000;
/** #497: the largest tarball the installer downloads. A published bundle is one `dist/plugin.js` plus a
 *  `package.json`, well under a megabyte; the cap is only so a misbehaving registry or mirror cannot
 *  exhaust the bot's memory at boot, inside the step documented as never crashing it. */
export const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
/** #497: the largest registry metadata document the installer reads — one version's manifest, a few
 *  kilobytes — bounded for the same reason as the tarball. */
export const MAX_METADATA_BYTES = 1024 * 1024;
/** #497: the most `tarExtract` waits on `tar` before killing it — a stalled extract otherwise held
 *  `activate()`, and with it command registration, for good. */
export const TAR_TIMEOUT_MS = 60_000;
/** #496: what a version must look like before it is joined into a path, put in a registry URL or
 *  `rmSync`ed — the same shape `src/config.ts` already requires of a `PLUGINS=name@version` pin. The
 *  index and `state.json` only promise a string (`version: "latest"`, or a `..` from a corrupt file). */
export const PLUGIN_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

interface InstallLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface InstallDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Extracts `package/dist/plugin.js` and `package/package.json` from `tarPath` into `destDir`
   * (flattening the leading `package/`). Injected so tests use a plain writer, production uses tar. */
  extract: (tarPath: string, destDir: string) => Promise<void>;
  now: () => number;
  log: InstallLog;
}

export interface InstalledPlugin {
  entry: PluginIndexEntry;
  version: string;
  bundlePath: string;
}

export interface InstallResult {
  installed: InstalledPlugin[];
  /** name -> reason, for the plugins that couldn't be installed (download/integrity/extract). */
  skips: Record<string, string>;
  /** #104: name -> {the target that failed, why}, when a `/plugins update` target-version install
   *  failed but the recorded previous version was used instead. The plugin IS installed (on its
   *  previous version); this drives the boot report-back's "could not update … still on …" message. */
  fallbacks: Record<string, { attempted: string; reason: string }>;
}

/** The pins a plugin resolves its install version against — the last-good `installedVersion` and,
 *  after a `/plugins update`, the transient `targetVersion` the next boot should try first (#104). */
interface PluginPins {
  installedVersion?: string;
  targetVersion?: string;
}

/** The production `extract`: `tar` flattening the npm tarball's `package/` prefix. `tar` is present
 * in `oven/bun:1-slim` (verified — see the issue's Acceptance). Bounded by `timeoutMs` (#497), through
 * `runBounded`. */
export async function tarExtract(tarPath: string, destDir: string, timeoutMs = TAR_TIMEOUT_MS): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  await runBounded(
    ["tar", "-xzf", tarPath, "-C", destDir, "--strip-components=1", "package/dist/plugin.js", "package/package.json"],
    timeoutMs,
    "tar",
  );
}

/** Runs `argv` and resolves once it exits 0; rejects naming `label` on any other exit, with its stderr,
 *  or once `timeoutMs` passes (#497). On a timeout the process is sent SIGKILL, its stderr read is
 *  cancelled, and neither its exit nor its stderr closing is waited on: the process dies, but a child it
 *  forked need not -- `tar -z` blocked opening a FIFO leaves a forked child blocked in `open()` holding
 *  the stderr pipe, so waiting for that pipe to close would hold the install for good, the very thing
 *  the bound is for. Exported so install.test.ts can drive the bound with a command that never finishes. */
export async function runBounded(argv: string[], timeoutMs: number, label: string): Promise<void> {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const stderrReader = proc.stderr.getReader();
  const readStderr = async (): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await stderrReader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
  });
  const finished = Promise.all([readStderr(), proc.exited]);
  let outcome: "timed-out" | [string, number];
  try {
    outcome = await Promise.race([finished, timedOut]);
  } catch (err) {
    proc.kill("SIGKILL"); // reading its stderr failed: never leave it writing into a dir the caller removes
    proc.unref();
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (outcome === "timed-out") {
    proc.kill("SIGKILL");
    finished.catch(() => {}); // nothing awaits it any more
    void stderrReader.cancel().catch(() => {}); // not awaited either: the bound waits on nothing the child holds
    proc.unref(); // never keep the bot alive for a process it gave up on
    throw new Error(`${label} did not finish within ${timeoutMs}ms`);
  }
  const [stderr, exitCode] = outcome;
  if (exitCode !== 0) throw new Error(`${label} exited ${exitCode}: ${stderr.trim()}`);
}

/** `res`'s body, or `"too-large"` once it passes `max` bytes (#497): a declared `Content-Length` over
 *  `max` is refused without reading, and any other body is read with a running count and abandoned the
 *  moment it passes `max` — the same shape `routeHttpRequest`'s body cap uses (`src/plugins/host.ts`).
 *  Exported so install.test.ts can drive the boundary with a small `max`. */
export async function readCapped(res: Response, max: number): Promise<Uint8Array | "too-large"> {
  const declared = res.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > max) {
    await res.body?.cancel().catch(() => {});
    return "too-large";
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return "too-large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return bytes;
}

interface RegistryVersion {
  dist?: { tarball?: unknown; integrity?: unknown };
}

async function fetchJson(fetchImpl: InstallDeps["fetch"], url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  const bytes = await readCapped(res, MAX_METADATA_BYTES);
  if (bytes === "too-large") throw new Error(`${url} is larger than ${MAX_METADATA_BYTES} bytes`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** The newest already-installed version of `name` on disk (a version dir with a built bundle), or
 * undefined. Used only when neither an operator pin nor a `state.json` record is available — so a
 * lost/corrupt state.json reuses what's cached rather than silently upgrading to the index's newer
 * version (the "no silent upgrades" rule; a real version move is #104's explicit action). Only a dir
 * named like a version counts (a crashed extract's `.staging-*` leftover never does), ordered by
 * `compareSemver` (#497): `1.10.0` above `1.9.0`, and a release above its own prerelease. */
function newestCachedVersion(dataDir: string, name: string): string | undefined {
  const pluginDir = join(dataDir, "plugins", name);
  let versions: string[];
  try {
    versions = readdirSync(pluginDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && PLUGIN_VERSION_RE.test(e.name) && existsSync(join(pluginDir, e.name, "dist", "plugin.js")))
      .map((e) => e.name);
  } catch {
    return undefined;
  }
  return versions.sort((a, b) => compareSemver(b, a))[0];
}

/** #498: removes what a killed install leaves behind — a `.staging-*` dir under any `plugins/<name>/`,
 *  and a tarball in `plugins/tmp/` — before this boot installs anything. Nothing else in the process
 *  installs, and it runs after `takeOver()`, so no other install can be in flight. Never throws: a
 *  directory that cannot be listed, or a leftover that cannot be removed, is logged and left, and the
 *  rest of the sweep goes on. A plugin named `tmp` shares `plugins/tmp/` with the tarballs; both kinds of
 *  leftover are matched there, and its version dirs match neither. */
function sweepInstallLeftovers(dataDir: string, log: InstallLog): void {
  const pluginsDir = join(dataDir, "plugins");
  const problem = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  let dirs: Dirent[];
  try {
    dirs = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (err) {
    // No plugins/ dir yet is a fresh install: nothing to sweep, nothing to say.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`[plugins] could not list ${pluginsDir} to sweep install leftovers: ${problem(err)}`);
    return;
  }
  let removed = 0;
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(pluginsDir, dir.name);
    let entries: Dirent[];
    try {
      entries = readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      log.warn(`[plugins] could not list ${dirPath} to sweep install leftovers: ${problem(err)}`);
      continue;
    }
    for (const e of entries) {
      const staging = e.isDirectory() && e.name.startsWith(".staging-");
      const tarball = dir.name === "tmp" && e.isFile() && e.name.endsWith(".tgz");
      if (!staging && !tarball) continue;
      try {
        rmSync(join(dirPath, e.name), { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        log.warn(`[plugins] could not remove the install leftover ${join(dirPath, e.name)}: ${problem(err)}`);
      }
    }
  }
  if (removed > 0) log.info(`[plugins] removed ${removed} leftover(s) of an interrupted install`);
}

/** SRI compare: `dist.integrity` is `sha512-<base64>`; hash the tarball bytes and compare base64. */
function integrityMatches(bytes: Uint8Array, integrity: string): boolean {
  const [algo, expected] = integrity.split("-", 2);
  if (algo !== "sha512" || !expected) return false;
  const actual = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
  return actual === expected;
}

interface BotPluginManifest {
  hostApiVersion?: unknown;
  commands?: unknown;
  env?: unknown;
}

/** #223: reconciles the extracted bundle's own `package.json` `botPlugin` block — what it was
 *  actually built against — with what the host is about to hand it. Called on BOTH the cache-reuse
 *  fast path and a fresh extract (before the extract is committed by rename), since a pinned bundle
 *  is served by the fast path forever and never re-extracted.
 *
 *  Total: never throws. A missing, unreadable, unparseable `package.json`, or one with no `botPlugin`
 *  block, warns and returns ok — an already-installed plugin (or a test fixture) with no manifest
 *  must never be bricked by this check. `commands`/`env` key-set divergence from `entry` only warns
 *  (the host still acts on the index entry for both — see the per-version env-key-scoping gotcha in
 *  `ops/README.md`/`CONTEXT.md`, not restated here). The one refusal is a declared `hostApiVersion`
 *  that differs from the HOST's own `HOST_API_VERSION` — deliberately not `entry.hostApiVersion`,
 *  which describes only the index's CURRENT version: #222's `keepOlder` path legitimately installs an
 *  older version built against a different host API than that current entry declares. */
export function reconcileManifest(
  entry: PluginIndexEntry,
  version: string,
  packageJsonPath: string,
  log: InstallLog,
): { ok: true } | { ok: false; reason: string } {
  const warnSkip = (why: string): { ok: true } => {
    log.warn(`[plugins] ${entry.name}@${version}: ${why}, skipping reconciliation`);
    return { ok: true };
  };

  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, "utf8");
  } catch {
    return warnSkip("no readable package.json in the extracted bundle");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return warnSkip("package.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) return warnSkip("package.json is not an object");

  const botPlugin = (parsed as Record<string, unknown>).botPlugin;
  if (typeof botPlugin !== "object" || botPlugin === null) return warnSkip("package.json has no botPlugin block");
  const manifest = botPlugin as BotPluginManifest;

  if (typeof manifest.hostApiVersion === "number" && manifest.hostApiVersion !== HOST_API_VERSION) {
    return {
      ok: false,
      reason: `${entry.package}@${version} was built against host API v${manifest.hostApiVersion}, this bot is v${HOST_API_VERSION}`,
    };
  }

  if (Array.isArray(manifest.commands)) {
    const declared = new Set(manifest.commands.filter((c): c is string => typeof c === "string"));
    const indexed = new Set(entry.commands);
    const diverges = declared.size !== indexed.size || [...declared].some((c) => !indexed.has(c));
    if (diverges) {
      log.warn(
        `[plugins] ${entry.name}@${version}: package.json's commands (${[...declared].join(", ") || "none"}) ` +
          `diverge from the index entry's (${entry.commands.join(", ") || "none"})`,
      );
    }
  }

  if (Array.isArray(manifest.env)) {
    const declaredKeys = new Set(
      manifest.env
        .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
        .map((e) => e.key)
        .filter((k): k is string => typeof k === "string"),
    );
    // Read defensively, like `manifest.env` above: the index check (src/plugins/index.ts) refuses a
    // non-object env element, but this function is documented total, so it must not rely on that (#496).
    const indexedKeys = new Set(
      (entry.env as unknown[])
        .map((e) => (typeof e === "object" && e !== null ? (e as { key?: unknown }).key : undefined))
        .filter((k): k is string => typeof k === "string"),
    );
    const diverges = declaredKeys.size !== indexedKeys.size || [...declaredKeys].some((k) => !indexedKeys.has(k));
    if (diverges) {
      log.warn(
        `[plugins] ${entry.name}@${version}: package.json's env keys (${[...declaredKeys].join(", ") || "none"}) ` +
          `diverge from the index entry's (${[...indexedKeys].join(", ") || "none"})`,
      );
    }
  }

  return { ok: true };
}

/** Install ONE specific version: reuse a cached `<name>/<version>/dist/plugin.js` with no fetch (after
 *  reconciling its package.json against the host — see `reconcileManifest`), else download the
 *  tarball, verify its `dist.integrity`, extract into a sibling staging dir, reconcile the staged
 *  package.json, and rename the staging dir into place. So anything at `<version>/dist/plugin.js` came
 *  from a completed, integrity-verified, contract-reconciled extract — never a partial one left behind
 *  by a `tar` that died mid-write (#224). Never throws — returns a reason. */
async function tryInstallVersion(
  entry: PluginIndexEntry,
  name: string,
  version: string,
  dataDir: string,
  deps: InstallDeps,
): Promise<{ ok: true; plugin: InstalledPlugin } | { ok: false; reason: string }> {
  // #496: before the version touches a path, a URL or an rmSync below.
  if (!PLUGIN_VERSION_RE.test(version)) {
    return { ok: false, reason: `${JSON.stringify(version).slice(0, 40)} is not a version (expected major.minor.patch)` };
  }
  const pluginDir = join(dataDir, "plugins", name);
  const versionDir = join(pluginDir, version);
  // `tar --strip-components=1` drops only the tarball's leading `package/`, so `package/dist/plugin.js`
  // extracts to `<versionDir>/dist/plugin.js` (not `<versionDir>/plugin.js`).
  const bundlePath = join(versionDir, "dist", "plugin.js");
  if (existsSync(bundlePath)) {
    const reconciled = reconcileManifest(entry, version, join(versionDir, "package.json"), deps.log);
    if (!reconciled.ok) return reconciled;
    return { ok: true, plugin: { entry, version, bundlePath } };
  }
  try {
    const meta = (await fetchJson(
      deps.fetch,
      `${REGISTRY_BASE}/${encodeURIComponent(entry.package)}/${encodeURIComponent(version)}`,
    )) as RegistryVersion;
    const tarball = meta.dist?.tarball;
    const integrity = meta.dist?.integrity;
    if (typeof tarball !== "string" || typeof integrity !== "string") {
      return { ok: false, reason: `registry entry for ${entry.package}@${version} has no dist.tarball/integrity` };
    }
    const tarRes = await deps.fetch(tarball, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!tarRes.ok) return { ok: false, reason: `${tarball}: ${tarRes.status} ${tarRes.statusText}` };
    const bytes = await readCapped(tarRes, MAX_TARBALL_BYTES);
    if (bytes === "too-large") return { ok: false, reason: `${tarball} is larger than ${MAX_TARBALL_BYTES} bytes` };
    if (!integrityMatches(bytes, integrity)) {
      return { ok: false, reason: `integrity mismatch for ${entry.package}@${version}` };
    }
    const tmpDir = join(dataDir, "plugins", "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const tarPath = join(tmpDir, `${name}-${version}-${deps.now()}.tgz`);
    // Sits under `plugins/<name>/` (not `tmp/`) so the rename below stays within one filesystem.
    const stagingDir = join(pluginDir, `.staging-${version}-${deps.now()}`);
    try {
      await Bun.write(tarPath, bytes);
      await deps.extract(tarPath, stagingDir);
      const stagingBundlePath = join(stagingDir, "dist", "plugin.js");
      if (!existsSync(stagingBundlePath)) {
        return { ok: false, reason: `extract produced no plugin.js for ${entry.package}@${version}` };
      }
      // Reconcile the staged copy BEFORE the rename — a bundle refused on hostApiVersion must never
      // land in the cache at all (a later boot's fast path would otherwise reuse it unreconciled).
      const reconciled = reconcileManifest(entry, version, join(stagingDir, "package.json"), deps.log);
      if (!reconciled.ok) return reconciled;
      rmSync(versionDir, { recursive: true, force: true }); // clear any earlier partial extract
      renameSync(stagingDir, versionDir);
    } finally {
      rmSync(tarPath, { force: true });
      rmSync(stagingDir, { recursive: true, force: true }); // no-op after a successful rename
    }
    deps.log.info(`[plugins] ${name}@${version} downloaded, integrity ok`);
    return { ok: true, plugin: { entry, version, bundlePath } };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Installs each selected, non-skipped plugin. Version resolution: an operator pin
 * (`PLUGINS=name@version`) wins, then #104's transient `targetVersion` (an explicit `/plugins update`),
 * then the last-good `installedVersion` from the previous `state.json`, then the newest cached version,
 * then the index's current version — the bot NEVER moves an installed plugin to a newer version on its
 * own. A cached `data/plugins/<name>/<version>/dist/plugin.js` is reused with no fetch.
 *
 * #223: every install (cached or freshly extracted) is reconciled against the bundle's own
 * `package.json` `botPlugin` block — see `reconcileManifest`. A `hostApiVersion` that differs from
 * this host's `HOST_API_VERSION` refuses the bundle (recorded in `skips`/`fallbacks` like any other
 * install failure); a `commands`/`env` divergence only warns.
 *
 * #104 failure fallback: when a `/plugins update` **target** install fails, fall back to the recorded
 * last-good `installedVersion` (deterministically — NOT `newestCachedVersion`, which could out-rank a
 * hand-lowered pin), so the bot comes back running on the previous version; the failure is recorded in
 * `fallbacks`. Any per-plugin failure with no usable fallback is recorded in `skips`.
 */
export async function installPlugins(
  selected: readonly SelectedPlugin[],
  dataDir: string,
  pins: Record<string, PluginPins>,
  deps: InstallDeps,
): Promise<InstallResult> {
  const installed: InstalledPlugin[] = [];
  const skips: Record<string, string> = {};
  const fallbacks: Record<string, { attempted: string; reason: string }> = {};

  sweepInstallLeftovers(dataDir, deps.log);
  for (const sp of selected) {
    if (sp.skipped || !sp.entry) continue;
    const entry = sp.entry;
    const pin = pins[sp.name];
    const primary =
      sp.pinnedVersion ?? pin?.targetVersion ?? pin?.installedVersion ?? newestCachedVersion(dataDir, sp.name) ?? entry.version;

    const attempt = await tryInstallVersion(entry, sp.name, primary, dataDir, deps);
    if (attempt.ok) {
      installed.push(attempt.plugin);
      continue;
    }

    // A failed TARGET-version update (an explicit /plugins update, not an operator @pin) falls back to
    // the recorded last-good version — deterministic, never a cached version that could out-rank the
    // pin. The previous bundle is normally still cached (existsSync reuse in tryInstallVersion).
    const lastGood = pin?.installedVersion;
    const wasTarget = !sp.pinnedVersion && pin?.targetVersion !== undefined && primary === pin.targetVersion;
    if (wasTarget && lastGood && lastGood !== primary) {
      const fb = await tryInstallVersion(entry, sp.name, lastGood, dataDir, deps);
      if (fb.ok) {
        installed.push(fb.plugin);
        fallbacks[sp.name] = { attempted: primary, reason: attempt.reason };
        deps.log.warn(`[plugins] ${sp.name}: install of ${primary} failed (${attempt.reason}); staying on ${lastGood}`);
        continue;
      }
    }

    skips[sp.name] = attempt.reason;
    deps.log.error(`[plugins] ${sp.name}: install failed — ${attempt.reason}`);
  }

  return { installed, skips, fallbacks };
}
