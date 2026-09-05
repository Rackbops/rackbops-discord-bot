// Installs the plugins #98 selected: resolve package@version on the npm registry, download the
// tarball, verify its dist.integrity, and extract dist/plugin.js into data/plugins/<name>/<version>/.
// Pure over injected I/O (fetch/extract/now/log) so it unit-tests with a fake fetch + fixture
// tarball and never hits the network or the real data dir. No plugin CODE runs here — that is
// loadPlugins/activatePlugins in host.ts, inside the bot's activate() after takeOver().
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PluginIndexEntry } from "./contract";
import type { SelectedPlugin } from "./registry";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
// Development-only override so the end-to-end fixture-plugin flow can point at a local registry
// stub (see .env.example). Production leaves it unset and resolves against npm.
const REGISTRY_BASE = (process.env.PLUGIN_REGISTRY_URL ?? DEFAULT_REGISTRY).replace(/\/$/, "");
const FETCH_TIMEOUT_MS = 30_000;

export interface InstallLog {
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
export interface PluginPins {
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
      .filter((e) => e.isDirectory() && e.name !== "tmp" && existsSync(join(pluginDir, e.name, "dist", "plugin.js")))
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

/** Install ONE specific version: reuse a cached `<name>/<version>/dist/plugin.js` with no fetch, else
 *  download the tarball, verify its `dist.integrity`, and extract. Never throws — returns a reason. */
async function tryInstallVersion(
  entry: PluginIndexEntry,
  name: string,
  version: string,
  dataDir: string,
  deps: InstallDeps,
): Promise<{ ok: true; plugin: InstalledPlugin } | { ok: false; reason: string }> {
  const versionDir = join(dataDir, "plugins", name, version);
  // `tar --strip-components=1` drops only the tarball's leading `package/`, so `package/dist/plugin.js`
  // extracts to `<versionDir>/dist/plugin.js` (not `<versionDir>/plugin.js`).
  const bundlePath = join(versionDir, "dist", "plugin.js");
  if (existsSync(bundlePath)) return { ok: true, plugin: { entry, version, bundlePath } };
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
    try {
      await Bun.write(tarPath, bytes);
      await deps.extract(tarPath, versionDir);
    } finally {
      rmSync(tarPath, { force: true });
    }
    if (!existsSync(bundlePath)) return { ok: false, reason: `extract produced no plugin.js for ${entry.package}@${version}` };
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
