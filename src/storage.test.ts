import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stallBunWrite } from "../test/stallBunWrite";
import { failJsonRead, tempNameRegExp } from "../test/storageProbes";
import {
  classifyReadError,
  createJsonWriter,
  createKeyedJsonMutator,
  DATA_DIR,
  moveCorruptAside,
  readJsonOrFresh,
  resetKeptCorruptForTest,
  resolveDataDir,
  shortSha,
  SHORT_SHA_LEN,
  storageStateForTest,
  TMP_TOKEN,
  tmpPathFor,
  writeJsonAtomic,
} from "./storage";

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

// #511: the per-path queue map used to keep one settled entry per path for the life of the process.
// The prune runs two microtasks after an update's own promise settles (`next` -> `tail` -> the
// `.then` that deletes), so a test that awaits an update lets those two ticks pass before it looks.
describe("createKeyedJsonMutator pruning (#511)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keyed-mutator-prune-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const fresh = () => ({ n: 0 });
  const bump = (c: { n: number }) => ({ n: c.n + 1 });
  const settleTicks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  test("forgets a path once its queue settles, and holds it while an update is in flight", async () => {
    const m = createKeyedJsonMutator<{ n: number }>();
    const a = join(dir, "a.json");
    expect(m.pendingPaths()).toBe(0);
    await m.update(a, fresh, bump, "a");
    await settleTicks();
    expect(m.pendingPaths()).toBe(0);
    const stall = stallBunWrite();
    try {
      void m.update(a, fresh, bump, "a").catch(() => {});
      await stall.reached;
      expect(m.pendingPaths()).toBe(1);
    } finally {
      stall.restore();
    }
    // The stuck update never settles; it is this test's own mutator, so nothing else waits on it.
  });

  test("a path with a second update still queued is not forgotten when the first settles", async () => {
    const m = createKeyedJsonMutator<{ n: number }>();
    const a = join(dir, "a.json");
    const p1 = m.update(a, fresh, bump, "a");
    const p2 = m.update(a, fresh, bump, "a");
    await p1;
    await settleTicks();
    expect(m.pendingPaths()).toBe(1); // p2's queue is the current one; p1's prune must not delete it
    await p2;
    await settleTicks();
    expect(m.pendingPaths()).toBe(0);
    expect(JSON.parse(readFileSync(a, "utf8"))).toEqual({ n: 2 });
  });

  test("an update that rejects still clears its path", async () => {
    const m = createKeyedJsonMutator<{ n: number }>();
    const a = join(dir, "a.json");
    await expect(
      m.update(a, fresh, () => {
        throw new Error("mutate blew up");
      }, "a"),
    ).rejects.toThrow("mutate blew up");
    await settleTicks();
    expect(m.pendingPaths()).toBe(0);
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
    // The `$` anchor: a test-looking directory in the path must not make a production entry a test run.
    for (const entry of ["/x/foo.ts", "/x/test.ts", "/x/testing.ts", "/x/foo.test.md", "/srv/proj.spec.js/src/index.ts", "/x/foo.test.ts.d/index.ts"]) {
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
    // The kept-corrupt record is per process; the test-state guard fails a test that leaves it behind.
    resetKeptCorruptForTest();
  });

  test("absent file resolves the fresh value, not an error, and logs nothing", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await readJsonOrFresh(join(dir, "x.json"), () => ({ n: 0 }), "test");
      expect(result).toEqual({ n: 0 });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
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

  test("a truncated/malformed-JSON file loads fresh and is moved aside, not a throw", async () => {
    const file = join(dir, "x.json");
    writeFileSync(file, '{"n": 1, "list": [1, 2');
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await readJsonOrFresh(file, () => ({ n: 0 }), "test");
      expect(result).toEqual({ n: 0 });
    } finally {
      errorSpy.mockRestore();
    }
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length).toBe(1);
  });

  // #477: a plain read (onCorrupt "keep") never renames; the serialized write path (the default) does.
  describe("onCorrupt: keep and redactReason", () => {
    const BARE = "SECRETTOKEN123";
    /** Reads with console.error recorded, and gives back the lines. */
    async function readKeeping(file: string, options: Parameters<typeof readJsonOrFresh>[3]): Promise<string[]> {
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(await readJsonOrFresh(file, () => ({ n: 0 }), "test", options)).toEqual({ n: 0 });
        return errorSpy.mock.calls.map((call) => String(call[0]));
      } finally {
        errorSpy.mockRestore();
      }
    }

    test("T1: a file that will not parse is left byte-identical and said once per path", async () => {
      const file = join(dir, "x.json");
      writeFileSync(file, "{ not json");
      const first = await readKeeping(file, { onCorrupt: "keep" });
      expect(first).toHaveLength(1);
      expect(first[0]).toContain("will not parse");
      expect(first[0]).toContain(file);
      expect(readFileSync(file, "utf8")).toBe("{ not json");
      expect(readdirSync(dir)).toEqual(["x.json"]);
      expect(await readKeeping(file, { onCorrupt: "keep" })).toEqual([]);
      resetKeptCorruptForTest();
      expect(await readKeeping(file, { onCorrupt: "keep" })).toHaveLength(1);
    });

    test("T1b: a good parse, an absent file and a move-aside each make a later corruption be said again", async () => {
      const file = join(dir, "x.json");
      writeFileSync(file, "{ not json");
      expect(await readKeeping(file, { onCorrupt: "keep" })).toHaveLength(1);
      expect(storageStateForTest().kept).toBe(1);
      // a good parse
      writeFileSync(file, '{"n": 1}');
      await readJsonOrFresh(file, () => ({ n: 0 }), "test", { onCorrupt: "keep" });
      expect(storageStateForTest().kept).toBe(0);
      writeFileSync(file, "{ not json");
      expect(await readKeeping(file, { onCorrupt: "keep" })).toHaveLength(1);
      // an absent file
      rmSync(file);
      await readJsonOrFresh(file, () => ({ n: 0 }), "test", { onCorrupt: "keep" });
      expect(storageStateForTest().kept).toBe(0);
      writeFileSync(file, "{ not json");
      expect(await readKeeping(file, { onCorrupt: "keep" })).toHaveLength(1);
      // the write path moving it aside
      expect(await readKeeping(file, {})).not.toEqual([]);
      expect(storageStateForTest().kept).toBe(0);
      writeFileSync(file, "{ not json");
      expect(await readKeeping(file, { onCorrupt: "keep" })).toHaveLength(1);
    });

    test("T2: redactReason keeps the parser's message, which can quote the file, out of the kept-file line", async () => {
      const file = join(dir, "x.json");
      writeFileSync(file, `{ "a": ${BARE} }`);
      const lines = await readKeeping(file, { onCorrupt: "keep", redactReason: true });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("SyntaxError");
      expect(lines[0]).not.toContain(BARE);
      expect(lines[0]).not.toContain("JSON Parse error");
      // without it the message is there (the routing file's position helps)
      resetKeptCorruptForTest();
      expect((await readKeeping(file, { onCorrupt: "keep" }))[0]).toContain(BARE);
    });

    test("T3: redactReason on the default (move-aside) path redacts moveCorruptAside's line too", async () => {
      const file = join(dir, "x.json");
      writeFileSync(file, `{ "a": ${BARE} }`);
      const lines = await readKeeping(file, { redactReason: true });
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0]).toContain("SyntaxError");
      for (const line of lines) expect(line).not.toContain(BARE);
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toHaveLength(1);
    });
  });

  // #509 item 2: only a file that parsed badly is "corrupt". A read that fails for another reason may
  // be an intact file behind an environment fault; returning fresh would let the next write overwrite
  // it, and moving it aside would hide the fault. Bun.file is stubbed to throw what EIO throws, since
  // a real EIO cannot be provoked here.
  test("a read that fails for a reason other than corruption is rethrown, and nothing is moved aside", async () => {
    const file = join(dir, "x.json");
    writeFileSync(file, '{"n": 7}');
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const failing = failJsonRead(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
    try {
      await expect(readJsonOrFresh(file, () => ({ n: 0 }), "test")).rejects.toThrow(/EIO/);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = String(errorSpy.mock.calls[0]![0]);
      expect(message).toContain("could not be read");
      expect(message).not.toContain("starting fresh");
    } finally {
      failing.restore();
      errorSpy.mockRestore();
    }
    expect(readFileSync(file, "utf8")).toBe('{"n": 7}'); // still there, untouched
    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-"))).toEqual([]);
  });

  test("a file that vanished between exists() and json() reads fresh, with no log and nothing moved aside", async () => {
    const file = join(dir, "x.json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const failing = failJsonRead(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }));
    try {
      expect(await readJsonOrFresh(file, () => ({ n: 0 }), "test")).toEqual({ n: 0 });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      failing.restore();
      errorSpy.mockRestore();
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("writeJsonAtomic leaves no *.tmp entry in the directory on success", async () => {
    const file = join(dir, "x.json");
    await writeJsonAtomic(file, { n: 1 });
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  // #509 item 3: a rename that fails (a directory sits where the file should go: EPERM on Windows,
  // EISDIR on POSIX — only that it throws is asserted) must take its temp file with it, because the
  // counter means a retry never reuses the name and the orphan would stay for good.
  test("a write that cannot complete leaves no temp file behind", async () => {
    const file = join(dir, "x.json");
    mkdirSync(file);
    await expect(writeJsonAtomic(file, { n: 1 })).rejects.toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  // The other half of #509 item 3: a Bun.write that fails AFTER creating its temp file (a full disk
  // leaves the partial file behind), which the rename-only case above never reaches.
  test("a Bun.write that fails after creating its temp file leaves nothing behind", async () => {
    const file = join(dir, "x.json");
    const spy = spyOn(Bun, "write").mockImplementation((async (path: unknown) => {
      writeFileSync(String(path), '{"half');
      throw new Error("ENOSPC: no space left on device");
    }) as never);
    try {
      await expect(writeJsonAtomic(file, { n: 1 })).rejects.toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  // The cleanup is best-effort: when it fails too (EBUSY/EPERM on Windows), the error worth throwing is
  // the write's. A directory sits where the next write's temp file goes: Bun.write fails EISDIR and the
  // cleanup's rmSync fails as well (ERR_FS_EISDIR -- removing a directory needs `recursive`). The next
  // temp name is read off a stalled write first, since the counter is private to the module.
  test("the cleanup's own failure does not mask the error that caused it", async () => {
    const file = join(dir, "x.json");
    const stall = stallBunWrite();
    let next: number;
    try {
      void writeJsonAtomic(file, { n: 0 }).catch(() => {});
      await stall.reached;
      next = Number(String(stall.calls[0]![0]).match(/\.(\d+)\.tmp$/)![1]) + 1;
    } finally {
      stall.restore();
    }
    mkdirSync(`${file}.${process.pid}.${TMP_TOKEN}.${next}.tmp`);
    const thrown = await writeJsonAtomic(file, { n: 1 }).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    // Bun.write's own message, not rmSync's ("Path is a directory: rm returned EISDIR ...").
    expect(thrown?.message).toMatch(/illegal operation on a directory/);
    expect(thrown?.message).not.toMatch(/rm returned/);
  });

  // classifyReadError calls a read that fails with EISDIR an error, which is only unreachable because
  // Bun's exists() is false for a directory (probed on Windows); this keeps a Bun or platform that
  // answers differently from turning a directory at the path into a boot-time crash loop unseen.
  test("a directory where the file should be reads as absent", async () => {
    const file = join(dir, "x.json");
    mkdirSync(file);
    expect(await readJsonOrFresh(file, () => ({ n: 0 }), "test")).toEqual({ n: 0 });
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

// The no-collision guarantee itself is on tmpPathFor above, proven pure. These two pin the rest of the
// chain (#509 item 5): that the write really goes to a name carrying the module's own TMP_TOKEN (the
// old pin grepped the source text for the call, so `const TMP_TOKEN = "x"` kept it green), and that
// the token is per process, not a constant.
describe("writeJsonAtomic's temp name carries the per-process TMP_TOKEN (#253)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "warbandeer-storage-token-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("TMP_TOKEN is eight hex chars, and the name the write is given is <path>.<pid>.<TMP_TOKEN>.<n>.tmp", async () => {
    expect(TMP_TOKEN).toMatch(/^[0-9a-f]{8}$/);
    const file = join(dir, "x.json");
    const stall = stallBunWrite();
    try {
      void writeJsonAtomic(file, { n: 1 }).catch(() => {});
      await stall.reached;
      expect(String(stall.calls[0]![0])).toMatch(tempNameRegExp(file));
    } finally {
      stall.restore();
    }
  });

  test("TMP_TOKEN differs between two processes", () => {
    const repoRoot = join(import.meta.dir, "..");
    const tokens = [0, 1].map(() => {
      const child = Bun.spawnSync([process.execPath, "-e", 'import("./src/storage").then((m) => console.log(m.TMP_TOKEN))'], {
        cwd: repoRoot,
        env: process.env, // carries BOT_DATA_DIR, so the child's own DATA_DIR resolves
        timeout: 20_000,
      });
      expect(child.exitCode).toBe(0);
      return child.stdout.toString().trim();
    });
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{8}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens).not.toContain(TMP_TOKEN);
  });
});

describe("classifyReadError", () => {
  test("a SyntaxError is corrupt, ENOENT is absent, anything else is an error", () => {
    expect(classifyReadError(new SyntaxError("Unexpected end of JSON input"))).toBe("corrupt");
    expect(classifyReadError(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe("absent");
    expect(classifyReadError({ code: "ENOENT" })).toBe("absent");
    expect(classifyReadError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe("error");
    expect(classifyReadError(Object.assign(new Error("is a directory"), { code: "EISDIR" }))).toBe("error");
    expect(classifyReadError(new Error("no code at all"))).toBe("error");
    expect(classifyReadError("a string")).toBe("error");
    expect(classifyReadError(null)).toBe("error");
  });
});

describe("moveCorruptAside", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "warbandeer-storage-aside-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("logs the reason and the new name, and moves the file aside", () => {
    const file = join(dir, "x.json");
    writeFileSync(file, "not json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      moveCorruptAside(file, "test", "because I said so");
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(String(errorSpy.mock.calls[0]![0])).toContain("because I said so");
      expect(String(errorSpy.mock.calls[1]![0])).toContain(".corrupt-");
    } finally {
      errorSpy.mockRestore();
    }
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length).toBe(1);
  });

  test("a failed rename is logged, not thrown", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => moveCorruptAside(join(dir, "never-existed.json"), "test", "x")).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(String(errorSpy.mock.calls[1]![0])).toContain("couldn't move");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
