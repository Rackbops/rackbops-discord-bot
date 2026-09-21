import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_DIR } from "../storage";
import { freshRouting, freshSecrets, type RoutingFile, type RoutingSecretsFile } from "./model";
import { mutateRouting, mutateSecrets, readRouting, readSecrets, routingPath, secretsPath } from "./store";

const GUILD = "111111111111111111";
const CHAN = "333333333333333331";
const HOOK_URL = "https://discord.com/api/webhooks/444444444444444444/SECRET-TOKEN";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "routing-store-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Adds a plugin placed in one server -- the smallest change that shows up in a read. */
function withPlugin(name: string): (current: RoutingFile) => RoutingFile {
  return (current) => ({ ...current, plugins: { ...current.plugins, [name]: { servers: { [GUILD]: { commands: "all" } } } } });
}

describe("paths", () => {
  test("the two files are routing.json and routing.secrets.json in the directory given", () => {
    // Spelled out as literals: these are data paths on a deployed volume, permanent once shipped.
    expect(routingPath("/data")).toBe("/data/routing.json");
    expect(secretsPath("/data")).toBe("/data/routing.secrets.json");
  });
});

describe("readRouting", () => {
  test("a missing file reads as fresh", async () => {
    expect(await readRouting(dir)).toEqual(freshRouting());
    // Reading never creates the file.
    expect(readdirSync(dir)).toEqual([]);
  });

  test("an unparseable file reads as fresh and is moved aside", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const damaged of ["", "{", '{"v":1,"plugins":{"music":', "not json at all"]) {
        writeFileSync(routingPath(dir), damaged);
        expect(await readRouting(dir)).toEqual(freshRouting());
        expect(existsSync(routingPath(dir))).toBe(false);
        // The damaged bytes are kept for inspection, not thrown away.
        const aside = readdirSync(dir).filter((f) => f.startsWith("routing.json.corrupt-"));
        expect(aside).toHaveLength(1);
        expect(readFileSync(join(dir, aside[0]!), "utf8")).toBe(damaged);
        rmSync(join(dir, aside[0]!));
      }
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("a wrong-shaped file reads as fresh", async () => {
    for (const shaped of [[], "text", 5, null, true, { v: 1, plugins: [] }, { v: 1, plugins: "x", webhooks: 7 }, {}]) {
      writeFileSync(routingPath(dir), JSON.stringify(shaped));
      expect(await readRouting(dir)).toEqual(freshRouting());
    }
  });

  test("a hand-written file without v keeps its entries and is written back as v 1", async () => {
    // The data-loss case: a hand-seeded file that forgot `v`, or one a newer bot wrote. Reading it as
    // fresh would let the very next mutate overwrite it, with no copy kept (only an UNPARSEABLE file
    // is moved aside).
    const placements = { music: { servers: { [GUILD]: { commands: [CHAN], postTo: CHAN } } } };
    for (const seeded of [{ plugins: placements }, { v: 2, plugins: placements, futureField: true }, { v: "1", plugins: placements }]) {
      writeFileSync(routingPath(dir), JSON.stringify(seeded));
      expect((await readRouting(dir)).plugins).toEqual(placements);
      await mutateRouting(dir, withPlugin("wow"));
      const written = JSON.parse(readFileSync(routingPath(dir), "utf8"));
      expect(written.v).toBe(1);
      expect(Object.keys(written.plugins).sort()).toEqual(["music", "wow"]);
      expect(written.plugins.music).toEqual(placements.music);
      expect(written.futureField).toBeUndefined();
    }
  });

  test("a partly-valid file is read down to what is valid", async () => {
    writeFileSync(
      routingPath(dir),
      JSON.stringify({
        v: 1,
        plugins: {
          music: { servers: { [GUILD]: { commands: [CHAN], postTo: CHAN } } },
          "Bad Name": { servers: {} },
        },
      }),
    );
    expect((await readRouting(dir)).plugins).toEqual({ music: { servers: { [GUILD]: { commands: [CHAN], postTo: CHAN } } } });
  });
});

describe("mutateRouting", () => {
  test("mutateRouting persists and the next read sees it", async () => {
    await mutateRouting(dir, withPlugin("music"));
    expect((await readRouting(dir)).plugins).toEqual({ music: { servers: { [GUILD]: { commands: "all" } } } });
    // It is on disk, as valid JSON, under the expected name -- not just held in memory.
    expect(JSON.parse(readFileSync(routingPath(dir), "utf8")).plugins.music.servers[GUILD].commands).toBe("all");
    await mutateRouting(dir, withPlugin("wow"));
    expect(Object.keys((await readRouting(dir)).plugins).sort()).toEqual(["music", "wow"]);
  });

  test("two overlapping mutateRouting calls both land", async () => {
    // Fired together, not awaited in turn: a read-then-write with nothing serializing it would let
    // several of these read the same empty file and each write only its own plugin. Twenty calls
    // make that all but certain to show, where two might get lucky.
    const names = Array.from({ length: 20 }, (_, i) => `plugin-${i}`);
    await Promise.all(names.map((name) => mutateRouting(dir, withPlugin(name))));
    expect(Object.keys((await readRouting(dir)).plugins).sort()).toEqual([...names].sort());
  });

  test("a mutate that throws fails its own call and leaves the file, and the queue, working", async () => {
    await mutateRouting(dir, withPlugin("music"));
    const before = readFileSync(routingPath(dir), "utf8");
    await expect(
      mutateRouting(dir, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(readFileSync(routingPath(dir), "utf8")).toBe(before);
    // The failure did not wedge the per-file queue.
    await mutateRouting(dir, withPlugin("wow"));
    expect(Object.keys((await readRouting(dir)).plugins).sort()).toEqual(["music", "wow"]);
  });

  test("mutate always receives a repaired value", async () => {
    const seen: RoutingFile[] = [];
    const capture = (current: RoutingFile): RoutingFile => {
      seen.push(structuredClone(current));
      return current;
    };
    // No file at all.
    await mutateRouting(dir, capture);
    // A wrong-shaped one, and one that is half good.
    writeFileSync(routingPath(dir), JSON.stringify([1, 2]));
    await mutateRouting(dir, capture);
    writeFileSync(
      routingPath(dir),
      JSON.stringify({
        v: 1,
        updatedBy: "someone",
        plugins: { music: { servers: { [GUILD]: { commands: [CHAN] }, "bad-id": { commands: "all" } } }, Nope: { servers: {} } },
        junk: true,
      }),
    );
    await mutateRouting(dir, capture);

    expect(seen[0]).toEqual(freshRouting());
    expect(seen[1]).toEqual(freshRouting());
    expect(seen[2]).toEqual({
      v: 1,
      updatedAt: "",
      updatedBy: "someone",
      plugins: { music: { servers: { [GUILD]: { commands: [CHAN] } } } },
      webhooks: {},
    });
    // And what was written back is the repaired file, not the damage.
    expect(JSON.parse(readFileSync(routingPath(dir), "utf8")).junk).toBeUndefined();
  });

  test("a url returned by mutate never reaches routing.json", async () => {
    // A caller that builds a value off the shape -- here a webhook carrying its URL -- cannot put it in
    // routing.json: that file is the one the panel reads, and the URL belongs in the secrets file only.
    await mutateRouting(dir, (current) => ({
      ...current,
      plugins: { ...current.plugins, music: { servers: { [GUILD]: { commands: "all", note: "x" } } }, "Bad Name": { servers: {} } },
      webhooks: {
        [CHAN]: { id: "444444444444444444", guildId: GUILD, addedAt: "t", addedBy: "u", url: HOOK_URL, token: "SECRET-TOKEN" },
      },
    } as unknown as RoutingFile));
    const text = readFileSync(routingPath(dir), "utf8");
    expect(text).not.toContain("SECRET-TOKEN");
    expect(text).not.toContain("discord.com/api/webhooks");
    expect(JSON.parse(text)).toEqual({
      v: 1,
      updatedAt: "",
      updatedBy: "",
      plugins: { music: { servers: { [GUILD]: { commands: "all" } } } },
      webhooks: { [CHAN]: { id: "444444444444444444", guildId: GUILD, addedAt: "t", addedBy: "u" } },
    });
  });

  test("the guard is on keys, not on text: a URL inside a free-text field is copied as given", async () => {
    // Pinned so nobody reads "a url never reaches routing.json" as more than it is. All five string
    // fields the shape allows -- `updatedAt`, `updatedBy`, and a webhook's `addedAt`, `addedBy` and
    // `broken` -- are text the store copies without reading.
    const url = "https://example.invalid/hook/1";
    await mutateRouting(dir, (current) => ({
      ...current,
      updatedAt: url,
      updatedBy: url,
      webhooks: { [CHAN]: { id: "444444444444444444", guildId: GUILD, addedAt: url, addedBy: url, broken: `HTTP 404 from ${url}` } },
    }));
    const written = JSON.parse(readFileSync(routingPath(dir), "utf8"));
    expect(written.updatedAt).toBe(url);
    expect(written.updatedBy).toBe(url);
    expect(written.webhooks[CHAN].addedAt).toBe(url);
    expect(written.webhooks[CHAN].addedBy).toBe(url);
    expect(written.webhooks[CHAN].broken).toContain(url);
  });

  test("it only ever writes under the directory it is given, never the bot's own data dir", async () => {
    await mutateRouting(dir, withPlugin("music"));
    await mutateSecrets(dir, (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }));
    expect(existsSync(join(DATA_DIR, "routing.json"))).toBe(false);
    expect(existsSync(join(DATA_DIR, "routing.secrets.json"))).toBe(false);
  });
});

describe("secrets", () => {
  test("a missing or wrong-shaped secrets file reads as fresh", async () => {
    expect(await readSecrets(dir)).toEqual(freshSecrets());
    for (const shaped of [[], "x", null, { v: 1 }, { v: 3, webhooks: {} }]) {
      writeFileSync(secretsPath(dir), JSON.stringify(shaped));
      expect(await readSecrets(dir)).toEqual(freshSecrets());
    }
  });

  test("mutateSecrets persists, and never touches routing.json", async () => {
    await mutateSecrets(dir, (s) => ({ ...s, webhooks: { ...s.webhooks, [CHAN]: HOOK_URL } }));
    expect((await readSecrets(dir)).webhooks).toEqual({ [CHAN]: HOOK_URL });
    // The webhook URL is in exactly one file.
    expect(readdirSync(dir).sort()).toEqual(["routing.secrets.json"]);
    await mutateRouting(dir, withPlugin("music"));
    expect(readFileSync(routingPath(dir), "utf8")).not.toContain("SECRET-TOKEN");
    expect(readFileSync(routingPath(dir), "utf8")).not.toContain("discord.com/api/webhooks");
  });

  test("two overlapping mutateSecrets calls both land", async () => {
    const channels = Array.from({ length: 20 }, (_, i) => String(500000 + i));
    await Promise.all(
      channels.map((c) => mutateSecrets(dir, (s) => ({ ...s, webhooks: { ...s.webhooks, [c]: `https://example.invalid/${c}` } }))),
    );
    expect(Object.keys((await readSecrets(dir)).webhooks).sort()).toEqual([...channels].sort());
  });

  test("a secrets file with no version, or another one, keeps its URLs across the next write", async () => {
    for (const seeded of [{ webhooks: { [CHAN]: HOOK_URL } }, { v: 2, webhooks: { [CHAN]: HOOK_URL }, extra: 1 }]) {
      writeFileSync(secretsPath(dir), JSON.stringify(seeded));
      expect((await readSecrets(dir)).webhooks).toEqual({ [CHAN]: HOOK_URL });
      await mutateSecrets(dir, (s) => ({ ...s, webhooks: { ...s.webhooks, "333333333333333332": "https://example.invalid/2" } }), async () => {});
      expect(JSON.parse(readFileSync(secretsPath(dir), "utf8"))).toEqual({
        v: 1,
        webhooks: { [CHAN]: HOOK_URL, "333333333333333332": "https://example.invalid/2" },
      });
    }
  });

  test("mutateSecrets repairs what mutate returns before it writes", async () => {
    await mutateSecrets(
      dir,
      () => ({ v: 1, webhooks: { [CHAN]: HOOK_URL, "not-a-channel": "x", "333333333333333332": 7, "333333333333333333": "" }, extra: 1 }) as unknown as RoutingSecretsFile,
      async () => {},
    );
    expect(JSON.parse(readFileSync(secretsPath(dir), "utf8"))).toEqual({ v: 1, webhooks: { [CHAN]: HOOK_URL } });
  });

  test("mutateSecrets hands mutate a repaired value", async () => {
    writeFileSync(secretsPath(dir), JSON.stringify({ v: 1, webhooks: { [CHAN]: HOOK_URL, "not-a-channel": "x", "444444444444444445": 7 }, junk: 1 }));
    let seen: unknown;
    await mutateSecrets(dir, (s) => {
      seen = structuredClone(s);
      return s;
    });
    expect(seen).toEqual({ v: 1, webhooks: { [CHAN]: HOOK_URL } });
  });

  // chmod is a no-op-ish on Windows (it can only toggle the read-only bit), so this can only be
  // observed on Linux -- which is CI. It is CI-ONLY: a green run on a Windows box says nothing.
  test.skipIf(process.platform === "win32")("the secrets file is owner-only after a write", async () => {
    await mutateSecrets(dir, (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }));
    expect(statSync(secretsPath(dir)).mode & 0o777).toBe(0o600);
    // Every later write replaces the file, so it has to be set again each time.
    await mutateSecrets(dir, (s) => ({ ...s, webhooks: { ...s.webhooks, "333333333333333332": "https://example.invalid/2" } }));
    expect(statSync(secretsPath(dir)).mode & 0o777).toBe(0o600);
  });

  test("a data directory that does not exist yet is created by the first secrets write", async () => {
    // A fresh install: `writeJsonAtomic` made the directory for every other data file, and this write
    // no longer goes through it.
    const nested = join(dir, "not", "there", "yet");
    await mutateSecrets(nested, (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }), async () => {});
    expect((await readSecrets(nested)).webhooks).toEqual({ [CHAN]: HOOK_URL });
  });

  test("the secrets temp file is written owner-only, and nothing else is left in the directory", async () => {
    // Runs on every platform: what it pins is the MODE ARGUMENT of the write that creates the temp
    // file, so the URLs are never in a wider-mode file. The CI-only tests below observe the real mode.
    const writes: { path: string; mode: number | undefined; flag: string | undefined }[] = [];
    const io = {
      writeFile: async (path: string, data: string, options: { mode: number; flag: string }) => {
        writes.push({ path, mode: options.mode, flag: options.flag });
        await writeFile(path, data, options);
      },
    };
    await mutateSecrets(dir, (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }), async () => {}, io);
    await mutateSecrets(dir, (s) => ({ ...s, webhooks: { ...s.webhooks, "333333333333333332": "https://example.invalid/2" } }), async () => {}, io);
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write.mode).toBe(0o600);
      // Created exclusively: a stale file or a symlink already at the temp name is refused, not written through.
      expect(write.flag).toBe("wx");
      // The write went to a temp file beside the target, not to the target itself.
      expect(write.path).not.toBe(secretsPath(dir));
      expect(write.path).toMatch(/routing\.secrets\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/);
    }
    // A random name per write -- a process id and a counter would repeat across containers on one
    // volume, and two writers would then share a temp file.
    expect(writes[0]!.path).not.toBe(writes[1]!.path);
    expect(readdirSync(dir)).toEqual(["routing.secrets.json"]);
  });

  test("a write that fails before its temp file exists reports the write's own error", async () => {
    // The clean-up must not turn the real failure into an ENOENT from unlinking a file that was never made.
    await expect(
      mutateSecrets(dir, (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }), async () => {}, {
        writeFile: async () => {
          throw new Error("EACCES: permission denied, open");
        },
      }),
    ).rejects.toThrow("EACCES");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a mutate that returns nothing fails its own call and writes nothing, for both files", async () => {
    // Repairing `undefined` gives a fresh file, and writing that would erase every placement silently.
    await mutateRouting(dir, withPlugin("music"));
    await mutateSecrets(dir, (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }), async () => {});
    const routingBefore = readFileSync(routingPath(dir), "utf8");
    const secretsBefore = readFileSync(secretsPath(dir), "utf8");
    for (const bad of [undefined, null, "a routing file", 7, ["v"], true, () => ({ v: 1 })]) {
      await expect(mutateRouting(dir, () => bad as unknown as RoutingFile)).rejects.toThrow(/mutateRouting: mutate must return the whole file/);
      await expect(mutateSecrets(dir, () => bad as unknown as RoutingSecretsFile, async () => {})).rejects.toThrow(
        /mutateSecrets: mutate must return the whole file/,
      );
    }
    expect(readFileSync(routingPath(dir), "utf8")).toBe(routingBefore);
    expect(readFileSync(secretsPath(dir), "utf8")).toBe(secretsBefore);
    // Neither refusal wedged its queue.
    await mutateRouting(dir, withPlugin("wow"));
    await mutateSecrets(dir, (s) => ({ ...s, webhooks: { ...s.webhooks, "333333333333333332": "https://example.invalid/2" } }), async () => {});
    expect(Object.keys((await readRouting(dir)).plugins).sort()).toEqual(["music", "wow"]);
    expect(Object.keys((await readSecrets(dir)).webhooks).sort()).toEqual([CHAN, "333333333333333332"]);
  });

  test("a failed rename leaves the previous secrets file intact and no temp file behind", async () => {
    await mutateSecrets(dir, (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }), async () => {});
    const before = readFileSync(secretsPath(dir), "utf8");
    await expect(
      mutateSecrets(
        dir,
        (s) => ({ ...s, webhooks: { ...s.webhooks, "333333333333333332": "https://example.invalid/2" } }),
        async () => {},
        {
          rename: async () => {
            throw new Error("EXDEV: cross-device link not permitted");
          },
        },
      ),
    ).rejects.toThrow("EXDEV");
    // The failed write neither damaged the file nor left the URLs lying beside it.
    expect(readFileSync(secretsPath(dir), "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["routing.secrets.json"]);
    // And it did not wedge the queue.
    await mutateSecrets(dir, (s) => ({ ...s, webhooks: { ...s.webhooks, "333333333333333332": "https://example.invalid/2" } }), async () => {});
    expect(Object.keys((await readSecrets(dir)).webhooks).sort()).toEqual([CHAN, "333333333333333332"]);
  });

  // The tests below (and `the secrets file is owner-only after a write`) read real file modes, which only mean something on Linux -- so they are
  // CI-ONLY: `skipIf(win32)`, and a green run on a Windows box says nothing about them.
  test.skipIf(process.platform === "win32")("the secrets temp file is owner-only when it is renamed into place (CI-only)", async () => {
    const old = process.umask(0o022); // the usual default, so a dropped mode would show as 0644
    try {
      const modes: number[] = [];
      await mutateSecrets(
        dir,
        (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }),
        async () => {},
        {
          rename: async (from, to) => {
            modes.push(statSync(from).mode & 0o777);
            await rename(from, to);
          },
        },
      );
      expect(modes).toEqual([0o600]);
      // The file that landed is owner-only without any chmod having run (it was passed a no-op).
      expect(statSync(secretsPath(dir)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });

  test.skipIf(process.platform === "win32")("a failed write leaves no copy of the secrets that anyone but the owner could read (CI-only)", async () => {
    const old = process.umask(0o022);
    try {
      await mutateSecrets(dir, (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }), async () => {});
      await expect(
        mutateSecrets(dir, (s) => ({ ...s, webhooks: { ...s.webhooks, "333333333333333332": "x" } }), async () => {}, {
          rename: async () => {
            throw new Error("EXDEV");
          },
        }),
      ).rejects.toThrow("EXDEV");
      for (const name of readdirSync(dir)) expect(statSync(join(dir, name)).mode & 0o077).toBe(0);
    } finally {
      process.umask(old);
    }
  });

  test.skipIf(process.platform === "win32")("a hand-seeded wide-mode secrets file keeps its mode until the first write replaces it at 0600 (CI-only)", async () => {
    // The limit `mutateSecrets` documents: "owner-only from creation" is about files IT writes. A
    // deployment that seeds the file by hand (#247) gets whatever mode it chose, until the bot's
    // first write renames a fresh 0600 file over it.
    const old = process.umask(0o022);
    try {
      writeFileSync(secretsPath(dir), JSON.stringify({ v: 1, webhooks: { [CHAN]: HOOK_URL } }));
      chmodSync(secretsPath(dir), 0o644);
      expect((await readSecrets(dir)).webhooks).toEqual({ [CHAN]: HOOK_URL });
      expect(statSync(secretsPath(dir)).mode & 0o777).toBe(0o644); // reading never tightens it
      await mutateSecrets(dir, (s) => ({ ...s, webhooks: { ...s.webhooks, "333333333333333332": "https://example.invalid/2" } }), async () => {});
      expect(statSync(secretsPath(dir)).mode & 0o777).toBe(0o600);
      expect(Object.keys((await readSecrets(dir)).webhooks).sort()).toEqual([CHAN, "333333333333333332"]);
    } finally {
      process.umask(old);
    }
  });

  test.skipIf(process.platform === "win32")("a hand-seeded wide-mode secrets file that will not parse is moved aside at that same mode (CI-only)", async () => {
    const old = process.umask(0o022);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(secretsPath(dir), '{"v":1,"webhooks":{"333333333333333331":');
      chmodSync(secretsPath(dir), 0o644);
      expect(await readSecrets(dir)).toEqual(freshSecrets());
      const aside = readdirSync(dir).filter((f) => f.startsWith("routing.secrets.json.corrupt-"));
      expect(aside).toHaveLength(1);
      expect(statSync(join(dir, aside[0]!)).mode & 0o777).toBe(0o644);
    } finally {
      error.mockRestore();
      process.umask(old);
    }
  });

  test.skipIf(process.platform === "win32")("a secrets file that will not parse is moved aside still owner-only (CI-only)", async () => {
    const old = process.umask(0o022);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await mutateSecrets(dir, (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }), async () => {});
      writeFileSync(secretsPath(dir), '{"v":1,"webhooks":{"333333333333333331":'); // truncated in place: same inode, same mode
      expect(await readSecrets(dir)).toEqual(freshSecrets());
      const aside = readdirSync(dir).filter((f) => f.startsWith("routing.secrets.json.corrupt-"));
      expect(aside).toHaveLength(1);
      expect(statSync(join(dir, aside[0]!)).mode & 0o777).toBe(0o600);
    } finally {
      error.mockRestore();
      process.umask(old);
    }
  });

  test("mutateSecrets asks for owner-only on the secrets file, after the write", async () => {
    // The same guarantee as the CI-only test above, observed through the injected chmod so it runs
    // on every platform: the right path, the right mode, and only once the file exists.
    const calls: { path: string; mode: number; existed: boolean }[] = [];
    await mutateSecrets(
      dir,
      (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }),
      async (path, mode) => {
        calls.push({ path, mode, existed: existsSync(path) });
      },
    );
    expect(calls).toEqual([{ path: secretsPath(dir), mode: 0o600, existed: true }]);
  });

  test("a chmod failure is logged, not thrown", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        mutateSecrets(
          dir,
          (s) => ({ ...s, webhooks: { [CHAN]: HOOK_URL } }),
          async () => {
            throw new Error("EPERM: operation not permitted");
          },
        ),
      ).resolves.toBeUndefined();
      // The write itself landed.
      expect((await readSecrets(dir)).webhooks).toEqual({ [CHAN]: HOOK_URL });
      // And the failure was said out loud, naming the file and the reason -- but not the secret.
      expect(error).toHaveBeenCalledTimes(1);
      const message = String(error.mock.calls[0]?.[0]);
      expect(message).toContain(secretsPath(dir));
      expect(message).toContain("EPERM");
      expect(message).not.toContain("SECRET-TOKEN");
    } finally {
      error.mockRestore();
    }
  });
});
