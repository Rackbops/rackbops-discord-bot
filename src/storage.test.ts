import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonWriter, DATA_DIR, readJsonOrFresh, writeJsonAtomic } from "./storage";

describe("DATA_DIR", () => {
  test("resolves to the repo's data/ directory (one hop up from src/)", () => {
    // storage.test.ts sits in src/ alongside storage.ts, so import.meta.dir is the same src/;
    // the mutation this guards is a wrong hop count (e.g. an extra "..").
    expect(DATA_DIR).toBe(join(import.meta.dir, "..", "data"));
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
