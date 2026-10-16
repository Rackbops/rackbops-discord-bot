import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonWriter, createKeyedJsonMutator, DATA_DIR, readJsonOrFresh, resolveDataDir, shortSha, SHORT_SHA_LEN, tmpPathFor, writeJsonAtomic } from "./storage";

describe("createKeyedJsonMutator idle (what the test-state guard reads)", () => {
  test("settles only once every update queued so far has, on every path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keyed-mutator-idle-"));
    try {
      const m = createKeyedJsonMutator<{ n: number }>();
      const done: string[] = [];
      const fresh = () => ({ n: 0 });
      void m.update(join(dir, "a.json"), fresh, (c) => ({ n: c.n + 1 }), "a").then(() => done.push("a"));
      void m.update(join(dir, "b.json"), fresh, (c) => ({ n: c.n + 1 }), "b").then(() => done.push("b"));
      void m.update(join(dir, "a.json"), fresh, (c) => ({ n: c.n + 1 }), "a").then(() => done.push("a2"));
      await m.idle();
      expect(done.sort()).toEqual(["a", "a2", "b"]);
      expect(JSON.parse(readFileSync(join(dir, "a.json"), "utf8"))).toEqual({ n: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with nothing queued it is already settled", async () => {
    await expect(createKeyedJsonMutator().idle()).resolves.toBeUndefined();
  });
});

describe("resolveDataDir", () => {
  // The default is still one hop up from src/ — the mutation this guards is a wrong hop count.
  // Driven through the pure resolver with an explicit env, since the live DATA_DIR is the test
  // override (see dataIsolation.test.ts) and can no longer be compared against the checkout path.
  //
  // The entry is passed explicitly (a non-test file): under `bun test` the default entry is the test file,
  // which `resolveDataDir` rightly refuses (#510), so the live process.argv[1] cannot stand in for it.
  test("defaults to the repo's data/ directory when nothing overrides it", () => {
    expect(resolveDataDir({}, "/app/src/index.ts")).toBe(join(import.meta.dir, "..", "data"));
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
    expect(resolveDataDir({ BOT_DATA_DIR: "" }, "/app/src/index.ts")).toBe(join(import.meta.dir, "..", "data"));
  });

  // Without this, a preload that silently fails to run would drop straight back to the checkout
  // and re-corrupt the developer's state.json with the whole suite green. Bun sets NODE_ENV=test only
  // when the shell exported none (#510), so the entry file is the second signal.
  test("under bun test with no override it refuses instead of using the checkout — by NODE_ENV, or by the entry file whatever NODE_ENV says", () => {
    expect(() => resolveDataDir({ NODE_ENV: "test" }, "/app/src/index.ts")).toThrow(/BOT_DATA_DIR must be set/);
    // Mutation: deleting the TEST_ENTRY half of the check, or narrowing the regex to /\.test\.ts$/, turns
    // one of these green-when-it-should-throw.
    for (const entry of ["/x/foo.test.ts", "C:\\x\\foo.test.tsx", "/x/foo.spec.js", "/x/foo_test.mts", "/x/foo_spec.cjs"]) {
      expect(() => resolveDataDir({ NODE_ENV: "production" }, entry)).toThrow(/BOT_DATA_DIR must be set/);
    }
    for (const entry of ["/x/foo.ts", "/x/test.ts", "/x/testing.ts", "/x/foo.test.md"]) {
      expect(resolveDataDir({ NODE_ENV: "production" }, entry)).toBe(join(import.meta.dir, "..", "data"));
    }
  });

  test("the live run is recognised through the default entry", () => {
    // Under `bun test` process.argv[1] is a test file -- this one, or the first file Bun discovered in a
    // whole-suite run -- so a shell exporting NODE_ENV=production gets no checkout either.
    expect(process.argv[1]).toMatch(/[._](test|spec)\.[cm]?[jt]sx?$/);
    expect(() => resolveDataDir({ NODE_ENV: "production" })).toThrow(/BOT_DATA_DIR must be set/);
  });

  test("an absolute override wins under bun test too", () => {
    const abs = process.platform === "win32" ? "C:\\tmp\\elsewhere" : "/tmp/elsewhere";
    expect(resolveDataDir({ BOT_DATA_DIR: abs, NODE_ENV: "test" }, "/x/foo.test.ts")).toBe(abs);
  });

  test("the live DATA_DIR is the override, never the checkout", () => {
    expect(DATA_DIR).toBe(process.env.BOT_DATA_DIR!);
    expect(DATA_DIR).not.toBe(join(import.meta.dir, "..", "data"));
  });
});

// #132: SHORT_SHA_LEN is the single source every short-sha site (shaTag, log/message text, and
// selectImagesToPrune's tag-shape regex) agrees on — pinning both the constant's value and that
// shortSha genuinely derives from it (not a separately hard-coded 7) is what closes the coupling
// redeploy.test.ts's own pin (below) proves end-to-end.
describe("shortSha / SHORT_SHA_LEN", () => {
  test("SHORT_SHA_LEN is 7", () => {
    expect(SHORT_SHA_LEN).toBe(7);
  });

  test("shortSha slices to exactly SHORT_SHA_LEN characters", () => {
    const sha = "abcdef1234567890";
    expect(shortSha(sha)).toBe(sha.slice(0, SHORT_SHA_LEN));
    expect(shortSha(sha)).toHaveLength(SHORT_SHA_LEN);
  });

  test("a sha shorter than SHORT_SHA_LEN passes through unchanged", () => {
    expect(shortSha("abc")).toBe("abc");
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

  // #154: writeJsonAtomic's temp name used to be fixed (`${path}.tmp`), safe only because every
  // IN-PROCESS caller goes through createJsonWriter/createKeyedJsonMutator above — neither of which
  // helps two DIFFERENT processes racing the same path, which the handoff overlap genuinely does
  // (the replacement's boot-time loadPluginIndex cache write vs. the original's still-running
  // pluginUpdates tick re-fetching the same manifest). `writeJsonAtomic` itself doesn't serialize —
  // this drives two direct, unserialized, "concurrent process" calls to prove the temp names no longer
  // collide: both writes land whole, and neither rename throws ENOENT reaching for a temp file the
  // other call already consumed.
  test("two concurrent, UNSERIALIZED writeJsonAtomic calls to the same path both land a whole file, never ENOENT", async () => {
    const file = join(dir, "concurrent.json");
    // Deliberately NOT through createJsonWriter — this is exactly the cross-process shape neither
    // in-process serializer can help with; writeJsonAtomic's own temp-name uniqueness is what must
    // carry this, not caller-side serialization.
    const results = await Promise.allSettled([
      writeJsonAtomic(file, { writer: "a" }),
      writeJsonAtomic(file, { writer: "b" }),
    ]);
    for (const r of results) expect(r.status).toBe("fulfilled"); // neither rename failed with ENOENT
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(["a", "b"]).toContain(parsed.writer); // last-rename-wins is fine; a torn/missing file is not
  });
});

// #253: a pid+counter name alone collides when two DIFFERENT processes (two containers in a
// handoff, same pid under the bot's init) agree on both — TMP_TOKEN, chosen once per process, is
// what actually separates them. Pure, so the no-collision guarantee is testable without two
// processes.
describe("tmpPathFor (#253)", () => {
  test("the same pid and counter with different tokens give different paths, and the token is in the name", () => {
    const a = tmpPathFor("/data/x.json", 100, "aaaa1111", 1);
    const b = tmpPathFor("/data/x.json", 100, "bbbb2222", 1);
    expect(a).not.toBe(b);
    expect(a).toContain("aaaa1111");
    expect(b).toContain("bbbb2222");
    expect(a).toBe("/data/x.json.100.aaaa1111.1.tmp");
  });
});

// writeJsonAtomic's own temp-path construction is source-pinned rather than driven through two real
// processes (which would need two real pids) — the no-collision guarantee itself is on tmpPathFor
// above, already proven pure; this just confirms writeJsonAtomic actually calls it, with the
// module's real TMP_TOKEN and the shared tmpCounter, not a hand-rolled template that dropped one.
describe("writeJsonAtomic uses tmpPathFor with the module token (#253, source pin)", () => {
  test("the temp-path line calls tmpPathFor(path, process.pid, TMP_TOKEN, ++tmpCounter)", () => {
    const src = readFileSync(new URL("./storage.ts", import.meta.url), "utf8");
    expect(src).toContain("tmpPathFor(path, process.pid, TMP_TOKEN, ++tmpCounter)");
  });
});
