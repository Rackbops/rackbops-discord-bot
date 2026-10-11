import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWriteFile, loadPluginIndex } from "./index";
import type { PluginIndex } from "./contract";

const VALID_INDEX: PluginIndex = {
  schemaVersion: 1,
  generatedAt: "2026-09-04T00:00:00.000Z",
  plugins: [
    {
      name: "warbandeer",
      package: "@rackbops/plugin-warbandeer",
      version: "1.0.0",
      description: "test",
      hostApiVersion: 1,
      commands: ["link", "unlink"],
      env: [],
      releases: [],
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("loadPluginIndex", () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plugins-index-test-"));
    cachePath = join(dir, "plugins", "index.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedCache(index: PluginIndex, writtenAt = "2026-09-01T00:00:00.000Z"): void {
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ writtenAt, index }));
  }

  test("a successful fetch returns fresh and atomically writes the cache", async () => {
    const fetch = async () => jsonResponse(VALID_INDEX);
    const now = () => new Date("2026-09-04T12:00:00.000Z");
    const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch, now });
    expect(result).toEqual({ index: VALID_INDEX, source: "fresh" });

    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cached).toEqual({ writtenAt: "2026-09-04T12:00:00.000Z", index: VALID_INDEX });
  });

  test("a rejected fetch (network error or timeout) falls back to the cache with a warning", async () => {
    seedCache(VALID_INDEX);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetch = async () => {
        throw new Error("fetch failed: ECONNREFUSED");
      };
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch });
      expect(result).toEqual({ index: VALID_INDEX, source: "cache" });
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes("using the cached copy from 2026-09-01")),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a non-200 response falls back to the cache, even with an otherwise-valid-looking body", async () => {
    seedCache(VALID_INDEX);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A valid-shaped body on the 503 isolates the res.ok check: without it, this fixture would
      // pass shape validation and be wrongly accepted as a fresh fetch.
      const fetch = async () => jsonResponse(VALID_INDEX, 503);
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch });
      expect(result.source).toBe("cache");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("invalid JSON in the response falls back to the cache", async () => {
    seedCache(VALID_INDEX);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetch = async () => new Response("not json", { status: 200 });
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch });
      expect(result.source).toBe("cache");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a well-formed but invalid-shape body falls back to the cache", async () => {
    seedCache(VALID_INDEX);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetch = async () => jsonResponse({ schemaVersion: 2, plugins: [] });
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch });
      expect(result.source).toBe("cache");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // #496: one bad entry still makes the whole index unusable (the cache is the fallback), but the log
  // now says "invalid", not "unreachable", and names the first failing check and the entry.
  describe("an invalid index is named as invalid, with the check and the entry that failed (#496)", () => {
    const warnsFor = async (body: unknown): Promise<{ source: string; warns: string[] }> => {
      seedCache(VALID_INDEX);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch: async () => jsonResponse(body) });
        return { source: result.source, warns: warnSpy.mock.calls.map((c) => String(c[0])) };
      } finally {
        warnSpy.mockRestore();
      }
    };
    const entryWith = (over: Record<string, unknown>) => ({ ...VALID_INDEX.plugins[0], ...over });

    test("a bad entry: its position, its name and the check", async () => {
      const { source, warns } = await warnsFor({ ...VALID_INDEX, plugins: [VALID_INDEX.plugins[0], entryWith({ name: "My_Plugin" })] });
      expect(source).toBe("cache");
      expect(warns).toEqual([
        '[plugins] index invalid (plugins[1] ("My_Plugin"): name is not a plugin name) — using the cached copy from 2026-09-01T00:00:00.000Z',
      ]);
    });

    test("a schemaVersion the bot does not know", async () => {
      const { warns } = await warnsFor({ ...VALID_INDEX, schemaVersion: 2 });
      expect(warns[0]).toStartWith("[plugins] index invalid (schemaVersion is 2, not 1) —");
    });

    test("an env element that is not a { key } object is refused here, not thrown on later", async () => {
      for (const env of [[null], ["KEY"], [{ name: "KEY" }], [{ key: 5 }]]) {
        const { source, warns } = await warnsFor({ ...VALID_INDEX, plugins: [entryWith({ env })] });
        expect(source).toBe("cache");
        expect(warns[0]).toContain('plugins[0] ("warbandeer"): env is not a list of { key } entries');
      }
    });

    test("a duplicate name, and an entry that is not an object", async () => {
      expect((await warnsFor({ ...VALID_INDEX, plugins: [VALID_INDEX.plugins[0], VALID_INDEX.plugins[0]] })).warns[0]).toContain(
        'plugins[1] ("warbandeer"): duplicate name',
      );
      expect((await warnsFor({ ...VALID_INDEX, plugins: [null] })).warns[0]).toContain("plugins[0]: not an object");
    });

    test("a value is shown as JSON, so a quoted number and an object read as what they are", async () => {
      expect((await warnsFor({ ...VALID_INDEX, schemaVersion: "1" })).warns[0]).toStartWith(
        '[plugins] index invalid (schemaVersion is "1", not 1) —',
      );
      expect((await warnsFor({ ...VALID_INDEX, schemaVersion: { v: 1 } })).warns[0]).toStartWith(
        '[plugins] index invalid (schemaVersion is {"v":1}, not 1) —',
      );
      expect((await warnsFor({ plugins: [] })).warns[0]).toStartWith("[plugins] index invalid (schemaVersion is undefined, not 1) —");
    });

    test("a body that is not JSON is named invalid, with the parse error", async () => {
      seedCache(VALID_INDEX);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch: async () => new Response("not json") });
        expect(result.source).toBe("cache");
        expect(String(warnSpy.mock.calls[0]?.[0])).toStartWith("[plugins] index invalid (not JSON: SyntaxError");
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("a body that stops arriving is named unreachable, not invalid", async () => {
      seedCache(VALID_INDEX);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"schemaVersion":'));
            controller.error(new Error("connection reset"));
          },
        });
        const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch: async () => new Response(body) });
        expect(result.source).toBe("cache");
        const warn = String(warnSpy.mock.calls[0]?.[0]);
        expect(warn).toStartWith("[plugins] index unreachable (body read failed: ");
        expect(warn).toContain("connection reset");
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("a long name is shown bounded", async () => {
      const { warns } = await warnsFor({ ...VALID_INDEX, plugins: [entryWith({ name: `X${"y".repeat(500)}` })] });
      expect(warns[0]!.length).toBeLessThan(250);
    });

    test("a fetch that got no answer still says unreachable", async () => {
      seedCache(VALID_INDEX);
      const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await loadPluginIndex("https://example/plugins.json", dir, { fetch: async () => jsonResponse({}, 503) });
        expect(String(warnSpy.mock.calls[0]?.[0])).toStartWith("[plugins] index unreachable (HTTP 503) — using the cached copy");
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test("no cache present falls back to an empty index, never throws", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetch = async () => {
        throw new Error("unreachable");
      };
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch });
      expect(result).toEqual({ index: { schemaVersion: 1, generatedAt: "", plugins: [] }, source: "none" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a corrupt cache file falls back to empty rather than throwing", async () => {
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(cachePath, "{not valid json");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetch = async () => {
        throw new Error("unreachable");
      };
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch });
      expect(result.source).toBe("none");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // #496: the shape check runs on the cached copy too, not only JSON parsing -- a parseable cache that is
  // not a usable index is refused, with the reason.
  test("a parseable cache that is not a usable index falls back to empty, naming why", async () => {
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ writtenAt: "2026-09-01T00:00:00.000Z", index: { ...VALID_INDEX, schemaVersion: 7 } }));
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch: async () => jsonResponse({}, 500) });
      expect(result.source).toBe("none");
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("cached copy is invalid: schemaVersion is 7, not 1");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a cache with no writtenAt is refused the same way", async () => {
    mkdirSync(join(dir, "plugins"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ index: VALID_INDEX }));
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch: async () => jsonResponse({}, 500) });
      expect(result.source).toBe("none");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // #496: the cache write goes through storage.ts's shared atomic write, whose temp name carries the
  // per-process token (#253), instead of a hand-kept copy that had missed it.
  test("the cache is written through storage.ts's writeFileAtomic, not a copy of it", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/import \{ writeFileAtomic \} from "\.\.\/storage";/);
    expect(source).toMatch(/await writeFileAtomic\(path, data\);/);
    expect(source).not.toMatch(/process\.pid/);
  });

  test("an entry with a non-number intents value is treated as invalid shape", async () => {
    seedCache(VALID_INDEX);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bad = { ...VALID_INDEX, plugins: [{ ...VALID_INDEX.plugins[0]!, intents: ["not-a-flag"] }] };
      const fetch = async () => jsonResponse(bad);
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch });
      // Falling back to the cache (not "fresh") is what keeps a malformed intents array from ever
      // reaching collectIntents()/createClient() — discord.js throws on a non-number flag.
      expect(result.source).toBe("cache");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("an entry with a numeric intents array is accepted", async () => {
    const fetch = async () => jsonResponse({ ...VALID_INDEX, plugins: [{ ...VALID_INDEX.plugins[0]!, intents: [1, 512] }] });
    const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch });
    expect(result.source).toBe("fresh");
    expect(result.index.plugins[0]!.intents).toEqual([1, 512]);
  });

  test("two entries sharing a name are treated as invalid shape, not silently collapsed", async () => {
    seedCache(VALID_INDEX);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dup = {
        ...VALID_INDEX,
        plugins: [VALID_INDEX.plugins[0]!, { ...VALID_INDEX.plugins[0]!, hostApiVersion: 2 }],
      };
      const fetch = async () => jsonResponse(dup);
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch });
      expect(result.source).toBe("cache");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a bare absolute path is fetched as a file:// URL, since fetch() can't resolve a schemeless string", async () => {
    let receivedUrl = "";
    const fetch = async (url: string) => {
      receivedUrl = url;
      return jsonResponse(VALID_INDEX);
    };
    const result = await loadPluginIndex("/data/plugins.json", dir, { fetch });
    expect(receivedUrl).toBe("file:///data/plugins.json");
    expect(result.source).toBe("fresh");
  });

  test("an http(s) URL is passed through unchanged", async () => {
    let receivedUrl = "";
    const fetch = async (url: string) => {
      receivedUrl = url;
      return jsonResponse(VALID_INDEX);
    };
    await loadPluginIndex("https://example/plugins.json", dir, { fetch });
    expect(receivedUrl).toBe("https://example/plugins.json");
  });

  test("a cache-write failure does not discard a good fresh fetch", async () => {
    const fetch = async () => jsonResponse(VALID_INDEX);
    const writeFile = async () => {
      throw new Error("EROFS: read-only file system");
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await loadPluginIndex("https://example/plugins.json", dir, { fetch, writeFile });
      expect(result).toEqual({ index: VALID_INDEX, source: "fresh" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  // #154: two DIRECT, back-to-back calls (mirrors storage.test.ts's own equivalent test for
  // writeJsonAtomic) — deterministic, unlike going through loadPluginIndex itself, where the
  // extra async work (fetch, parsing, validation) ahead of the write desynchronizes two top-level
  // calls enough that their writes rarely genuinely overlap. This is the real, actual mutation
  // guard for the per-process-unique temp name; the integration test below it proves the real
  // wiring reaches this function, not that the race is caught deterministically through it.
  test("two concurrent, unserialized defaultWriteFile calls to the same path both land a whole file, never ENOENT", async () => {
    const results = await Promise.allSettled([
      defaultWriteFile(cachePath, JSON.stringify({ writtenAt: "a", index: VALID_INDEX })),
      defaultWriteFile(cachePath, JSON.stringify({ writtenAt: "b", index: VALID_INDEX })),
    ]);
    for (const r of results) expect(r.status).toBe("fulfilled"); // neither rename failed with ENOENT
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(["a", "b"]).toContain(cached.writtenAt); // last-rename-wins is fine; a torn/missing file is not
  });

  // The concrete scenario that motivated the fix, end to end: the replacement's boot-time
  // loadPluginIndex call and the original's still-running pluginUpdates tick both re-caching this
  // exact file during a handoff. Uses the REAL default writeFile (only `fetch` is overridden), so
  // this is an integration proof that the real wiring reaches defaultWriteFile above — not itself
  // a reliable mutation guard for the race (see that test's own comment for why).
  test("two concurrent loadPluginIndex calls both writing the real cache file still return the right index", async () => {
    const fetch = async () => jsonResponse(VALID_INDEX);
    const results = await Promise.allSettled([
      loadPluginIndex("https://example/plugins.json", dir, { fetch }),
      loadPluginIndex("https://example/plugins.json", dir, { fetch }),
    ]);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
      if (r.status === "fulfilled") expect(r.value).toEqual({ index: VALID_INDEX, source: "fresh" });
    }
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(cached.index).toEqual(VALID_INDEX);
  });
});
