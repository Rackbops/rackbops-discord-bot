// Installs the plugins #98 selected: resolve package@version on the npm registry, download the
// tarball, verify its dist.integrity, and extract dist/plugin.js into data/plugins/<name>/<version>/.
// Pure over injected I/O (fetch/extract/now/log) so it unit-tests with a fake fetch + fixture
// tarball and never hits the network or the real data dir. No plugin CODE runs here — that is
// loadPlugins/activatePlugins in host.ts, inside the bot's activate() after takeOver().
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOST_API_VERSION, type PluginIndexEntry } from "./contract";
import type { SelectedPlugin } from "./registry";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** #281: a blank (or whitespace-only) `PLUGIN_REGISTRY_URL` is unset, the same rule `src/config.ts`'s
 *  `optional()` already applies to `PLUGIN_INDEX_URL` — compose's `env_file:` sets a bare `KEY=` line to
 *  the empty string, and `.env.example` ships PLUGIN_REGISTRY_URL blank, so `??` alone (falling back only
 *  on undefined/null) let a shipped-as-documented instance resolve every plugin metadata URL against a
 *  relative path instead of the registry. Exported so install.test.ts drives it directly rather than only
 *  through the module-level constant below. */
export function resolveRegistryBase(env: Record<string, string | undefined>): string {
  return (env.PLUGIN_REGISTRY_URL?.trim() || DEFAULT_REGISTRY).replace(/\/$/, "");
}

// Development-only override so the end-to-end fixture-plugin flow can point at a local registry
// stub (see .env.example). Production leaves it unset and resolves against npm.
const REGISTRY_BASE = resolveRegistryBase(process.env);
const FETCH_TIMEOUT_MS = 30_000;

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
 * in `oven/bun:1-slim` (verified — see the issue's Acceptance). */
export async function tarExtract(tarPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const proc = Bun.spawn(
    ["tar", "-xzf", tarPath, "-C", destDir, "--strip-components=1", "package/dist/plugin.js", "package/package.json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`tar exited ${exitCode}: ${stderr.trim()}`);
}

interface RegistryVersion {
  dist?: { tarball?: unknown; integrity?: unknown };
}

async function fetchJson(fetchImpl: InstallDeps["fetch"], url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

/** Descending compare of dotted numeric versions — enough to pick the newest cached version dir. */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest already-installed version of `name` on disk (a version dir with a built bundle), or
 * undefined. Used only when neither an operator pin nor a `state.json` record is available — so a
 * lost/corrupt state.json reuses what's cached rather than silently upgrading to the index's newer
 * version (the "no silent upgrades" rule; a real version move is #104's explicit action). */
function newestCachedVersion(dataDir: string, name: string): string | undefined {
  const pluginDir = join(dataDir, "plugins", name);
  let versions: string[];
  try {
    versions = readdirSync(pluginDir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          e.name !== "tmp" &&
          !e.name.startsWith(".") && // a crashed extract's `.staging-*` leftover is never a version
          existsSync(join(pluginDir, e.name, "dist", "plugin.js")),
      )
      .map((e) => e.name);
  } catch {
    return undefined;
  }
  return versions.sort(compareVersionsDesc)[0];
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
    const indexedKeys = new Set(entry.env.map((e) => e.key));
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
      `${REGISTRY_BASE}/${encodeURIComponent(entry.package)}/${version}`,
    )) as RegistryVersion;
    const tarball = meta.dist?.tarball;
    const integrity = meta.dist?.integrity;
    if (typeof tarball !== "string" || typeof integrity !== "string") {
      return { ok: false, reason: `registry entry for ${entry.package}@${version} has no dist.tarball/integrity` };
    }
    const tarRes = await deps.fetch(tarball, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!tarRes.ok) return { ok: false, reason: `${tarball}: ${tarRes.status} ${tarRes.statusText}` };
    const bytes = new Uint8Array(await tarRes.arrayBuffer());
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
