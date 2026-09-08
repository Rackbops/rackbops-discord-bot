import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonWriter, DATA_DIR, readJsonOrFresh, resolveDataDir, writeJsonAtomic } from "./storage";

describe("resolveDataDir", () => {
  // The default is still one hop up from src/ — the mutation this guards is a wrong hop count.
  // Driven through the pure resolver with an explicit env, since the live DATA_DIR is the test
  // override (see dataIsolation.test.ts) and can no longer be compared against the checkout path.
  test("defaults to the repo's data/ directory when nothing overrides it", () => {
    expect(resolveDataDir({})).toBe(join(import.meta.dir, "..", "data"));
  });

  test("an absolute override wins", () => {
    const abs = process.platform === "win32" ? "C:\\tmp\\elsewhere" : "/tmp/elsewhere";
    expect(resolveDataDir({ BOT_DATA_DIR: abs })).toBe(abs);
  });

  // A relative path can resolve back into a checkout depending on cwd — the same reason
  // BOT_OPS_CONFIG_DIR is absolute-only. Refused loudly rather than quietly resolved.
  test("a relative override is refused, naming the offending value", () => {
    expect(() => resolveDataDir({ BOT_DATA_DIR: "./data" })).toThrow(/absolute path/);
    expect(() => resolveDataDir({ BOT_DATA_DIR: "./data" })).toThrow(/\.\/data/);
  });

  test("an empty override falls through rather than resolving to nothing", () => {
    expect(resolveDataDir({ BOT_DATA_DIR: "" })).toBe(join(import.meta.dir, "..", "data"));
  });

  // Without this, a preload that silently fails to run would drop straight back to the checkout
  // and re-corrupt the developer's state.json with the whole suite green.
  test("under bun test with no override it refuses instead of using the checkout", () => {
    expect(() => resolveDataDir({ NODE_ENV: "test" })).toThrow(/BOT_DATA_DIR must be set/);
  });

  test("the live DATA_DIR is the override, never the checkout", () => {
    expect(DATA_DIR).toBe(process.env.BOT_DATA_DIR!);
    expect(DATA_DIR).not.toBe(join(import.meta.dir, "..", "data"));
  });
});

// Mirrors state.test.ts's own coverage of the same two failure modes (a corrupt file, two
// overlapping writers), applied here since links.ts/characters.ts both delegate to this module.
describe("readJsonOrFresh / writeJsonAtomic / createJsonWriter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "warbandeer-storage-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("absent file resolves the fresh value, not an error", async () => {
    const result = await readJsonOrFresh(join(dir, "x.json"), () => ({ n: 0 }), "test");
    expect(result).toEqual({ n: 0 });
  });

  test("a well-formed file round-trips through writeJsonAtomic/readJsonOrFresh", async () => {
    const file = join(dir, "x.json");
    await writeJsonAtomic(file, { n: 7, list: [1, 2, 3] });
    const result = await readJsonOrFresh(file, () => ({ n: 0, list: [] as number[] }), "test");
    expect(result).toEqual({ n: 7, list: [1, 2, 3] });
  });

  test("an empty file loads fresh, logs a warning, and is moved aside — not a throw", async () => {
    const file = join(dir, "x.json");
    writeFileSync(file, "");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await readJsonOrFresh(file, () => ({ n: 0 }), "test");
      expect(result).toEqual({ n: 0 });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
    expect(existsSync(file)).toBe(false);
    const corruptFiles = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(corruptFiles.length).toBe(1);
  });

  test("a truncated/malformed-JSON file loads fresh, not a throw", async () => {
    const file = join(dir, "x.json");
    writeFileSync(file, '{"n": 1, "list": [1, 2');
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await readJsonOrFresh(file, () => ({ n: 0 }), "test");
      expect(result).toEqual({ n: 0 });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("writeJsonAtomic never leaves a .tmp file behind on success", async () => {
    const file = join(dir, "x.json");
    await writeJsonAtomic(file, { n: 1 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  test("100 concurrent saves through one writer leave a parseable, uncorrupted file", async () => {
    const file = join(dir, "x.json");
    const writer = createJsonWriter<{ n: number }>(file);
    await Promise.all(Array.from({ length: 100 }, (_, i) => writer.save({ n: i })));
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(typeof parsed.n).toBe("number");
  });
});
