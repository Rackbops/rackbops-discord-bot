import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginIndex } from "./index";
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
});
