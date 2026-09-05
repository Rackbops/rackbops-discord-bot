// Boot-time Plugin Index fetch, with a cache — no plugin code loads here. Deliberately dependency-
// free of src/warbandeer/ and src/config.ts (src/plugins/* stays that way; see CONTEXT.md) — the
// atomic-write pattern below is a small copy of src/storage.ts's rather than an import. #99 moved
// storage up to src/storage.ts, so this could now import from ../storage; left duplicated on purpose
// to keep this module dependency-light and the #99 diff small.
import { mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginIndex } from "./contract";

export type PluginIndexSource = "fresh" | "cache" | "none";

export interface LoadPluginIndexResult {
  index: PluginIndex;
  source: PluginIndexSource;
}

export interface LoadPluginIndexDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Stamped into the cache file as `writtenAt` when a fetch succeeds. */
  now?: () => Date;
  timeoutMs?: number;
  /** Returns the file's text, or undefined if it doesn't exist. */
  readFile?: (path: string) => Promise<string | undefined>;
  writeFile?: (path: string, data: string) => Promise<void>;
}

// `writtenAt` is when THIS bot cached the file — distinct from the manifest's own `generatedAt`,
// which is the plugins repo's CI clock. The "using the cached copy from <writtenAt>" warning below
// needs the former.
interface CachedPluginIndex {
  writtenAt: string;
  index: PluginIndex;
}

const EMPTY_INDEX: PluginIndex = { schemaVersion: 1, generatedAt: "", plugins: [] };

async function defaultReadFile(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return file.text();
}

async function defaultWriteFile(path: string, data: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await Bun.write(tmp, data);
  renameSync(tmp, path);
}

function isValidPluginIndex(value: unknown): value is PluginIndex {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1 || !Array.isArray(v.plugins)) return false;
  // Duplicate names collapse silently in registry.ts's Map-keyed lookup (last one wins), so
  // rejecting them here — same bucket as every other malformed-manifest case — is cheaper than
  // guarding it at every later consumer.
  const seenNames = new Set<string>();
  return v.plugins.every((p) => {
    if (typeof p !== "object" || p === null) return false;
    const e = p as Record<string, unknown>;
    const shapeOk =
      typeof e.name === "string" &&
      /^[a-z][a-z0-9-]*$/.test(e.name) &&
      typeof e.package === "string" &&
      typeof e.version === "string" &&
      typeof e.description === "string" &&
      typeof e.hostApiVersion === "number" &&
      Array.isArray(e.commands) &&
      Array.isArray(e.env) &&
      Array.isArray(e.releases) &&
      // discord.js's IntentsBitField throws on a non-number flag (BitFieldInvalid) — validated
      // here so a malformed entry is skipped as "bad manifest," never reaches createClient()
      // uncaught. A bad entry that slipped past this would also get cached, crash-looping every
      // restart until the cache is cleared — this check is what keeps that unreachable.
      (e.intents === undefined || (Array.isArray(e.intents) && e.intents.every((i) => typeof i === "number")));
    if (!shapeOk) return false;
    if (seenNames.has(e.name as string)) return false;
    seenNames.add(e.name as string);
    return true;
  });
}

/**
 * Fetches the Plugin Index with a timeout, validates its shape, and atomically caches it. Any
 * failure (unreachable, timeout, bad JSON, bad shape) falls back to the cached copy with a
 * warning, or an empty index with a warning if there's no usable cache. Never throws — a manifest
 * outage degrades to "no new plugins," never a boot failure.
 */
export async function loadPluginIndex(
  url: string,
  dataDir: string,
  deps: LoadPluginIndexDeps = {},
): Promise<LoadPluginIndexResult> {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 5000;
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const cachePath = join(dataDir, "plugins", "index.json");

  const useCache = async (reason: string): Promise<LoadPluginIndexResult> => {
    let raw: string | undefined;
    try {
      raw = await readFile(cachePath);
    } catch (err) {
      console.warn(`[plugins] index unreachable (${reason}) — cache read failed (${err}), no plugins will load`);
      return { index: EMPTY_INDEX, source: "none" };
    }
    if (raw === undefined) {
      console.warn(`[plugins] index unreachable (${reason}) — no cached copy, no plugins will load`);
      return { index: EMPTY_INDEX, source: "none" };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CachedPluginIndex>;
      if (typeof parsed.writtenAt !== "string" || !isValidPluginIndex(parsed.index)) {
        throw new Error("cached copy has an invalid shape");
      }
      console.warn(`[plugins] index unreachable (${reason}) — using the cached copy from ${parsed.writtenAt}`);
      return { index: parsed.index, source: "cache" };
    } catch (err) {
      console.warn(`[plugins] index unreachable (${reason}) — cached copy is unreadable (${err}), no plugins will load`);
      return { index: EMPTY_INDEX, source: "none" };
    }
  };

  // config.ts accepts a bare absolute path (POSIX — this bot only ever runs in the Linux
  // container) as shorthand, but fetch() can't resolve a schemeless string as a URL at all.
  const fetchUrl = url.startsWith("/") ? `file://${url}` : url;

  let res: Response;
  try {
    res = await fetchFn(fetchUrl, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return useCache(String(err));
  }
  if (!res.ok) return useCache(`HTTP ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return useCache(`invalid JSON response (${err})`);
  }
  if (!isValidPluginIndex(body)) return useCache("invalid manifest shape");

  const cacheFile: CachedPluginIndex = { writtenAt: now().toISOString(), index: body };
  try {
    await writeFile(cachePath, JSON.stringify(cacheFile, null, 2));
  } catch (err) {
    // The fetch itself succeeded — a cache-write failure (e.g. a read-only volume) must not
    // discard a good, freshly-fetched index.
    console.warn(`[plugins] fetched the index but failed to cache it (${err})`);
  }
  return { index: body, source: "fresh" };
}
