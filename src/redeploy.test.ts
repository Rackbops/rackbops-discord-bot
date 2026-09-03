import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ContainerInspect, ImageSummary } from "./docker";
import type { HandoffMarker } from "./handoff";

// redeploy.ts pulls in the `config` singleton (env resolved at import time) — see config.test.ts.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
const {
  buildCreateSpec,
  buildRemote,
  canonicalName,
  latestTag,
  redeploy,
  replacementName,
  resolveBootMode,
  retireOriginal,
  selectImagesToPrune,
  shaTag,
  takeOver,
} = await import("./redeploy");
const { clearMarker, writeMarker, HANDOFF_FROM_ENV } = await import("./handoff");
const { handoffActive, resetForTest } = await import("./restart");

const SELF: ContainerInspect = {
  Id: "a".repeat(64),
  Name: "/warbandeer-discord",
  Image: "sha256:deadbeef",
  State: { Running: true, Status: "running", ExitCode: 0 },
  Config: {
    Image: "warbandeer-discord-debug-bot:latest",
    Env: ["PATH=/usr/bin", "DISCORD_TOKEN=secret", "GIT_SHA=oldoldold", "AUTO_UPDATE=true"],
    Labels: {
      "com.docker.compose.project": "warbandeer-discord-debug",
      "com.docker.compose.service": "bot",
      "com.docker.compose.container-number": "1",
    },
    User: "0:0",
  },
  HostConfig: { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "wbd_default", Init: true },
  Mounts: [
    { Type: "volume", Name: "wbd_state", Source: "/var/lib/docker/volumes/wbd_state/_data", Destination: "/app/data", RW: true },
    { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true },
  ],
  NetworkSettings: { Networks: { wbd_default: { Aliases: ["bot", "warbandeer-discord-debug-bot-1"] } } },
};

describe("naming", () => {
  test("canonicalName strips docker's leading slash", () => {
    expect(canonicalName("/warbandeer-discord")).toBe("warbandeer-discord");
    expect(canonicalName("warbandeer-discord")).toBe("warbandeer-discord");
  });

  // The replacement can't be created under the pinned container_name while the original holds
  // it, so it comes up beside it and takes the name during the retire.
  test("the replacement gets a name that can't collide with the original", () => {
    expect(replacementName("/warbandeer-discord")).toBe("warbandeer-discord-next");
    expect(replacementName("/warbandeer-discord")).not.toBe(canonicalName("/warbandeer-discord"));
  });
});

describe("buildRemote", () => {
  test("points the daemon at the whole repo on the target branch", () => {
    expect(buildRemote("roshne/rackbops-discord-bot", "main")).toBe(
      "https://github.com/roshne/rackbops-discord-bot.git#main",
    );
  });

  test("carries a branch with slashes through intact", () => {
    expect(buildRemote("roshne/rackbops-discord-bot", "feat/x")).toContain("#feat/x");
  });
});

describe("shaTag", () => {
  test("the per-sha tag, off the same repo", () => {
    expect(shaTag("warbandeer-discord-debug-bot:latest", "abcdef1234")).toBe(
      "warbandeer-discord-debug-bot:abcdef1",
    );
  });

  test("an untagged current image still yields a tag", () => {
    expect(shaTag("mybot", "abcdef1234")).toBe("mybot:abcdef1");
  });
});

describe("latestTag", () => {
  test("the floating tag, off the same repo", () => {
    expect(latestTag("warbandeer-discord-debug-bot:abc1234")).toBe("warbandeer-discord-debug-bot:latest");
  });

  test("an untagged current image still yields a tag", () => {
    expect(latestTag("mybot")).toBe("mybot:latest");
  });
});

describe("selectImagesToPrune", () => {
  const img = (tags: string[], created: number): ImageSummary => ({ Id: tags[0]!, RepoTags: tags, Created: created });
  const repo = "warbandeer-discord-debug-bot";

  test("keeps the newest N sha tags and drops the rest, oldest first", () => {
    const pruned = selectImagesToPrune(
      [
        img([`${repo}:1111111`], 100),
        img([`${repo}:2222222`], 300),
        img([`${repo}:3333333`], 200),
        img([`${repo}:4444444`], 400),
      ],
      `${repo}:latest`,
      2,
    );
    expect(pruned).toEqual([`${repo}:3333333`, `${repo}:1111111`]);
  });

  test("nothing to prune while at or under the limit", () => {
    expect(selectImagesToPrune([img([`${repo}:1111111`], 1)], `${repo}:latest`, 3)).toEqual([]);
  });

  // A tag someone parked by hand is a deliberate rollback target; only sha-shaped tags of this
  // image's own repo are ever candidates.
  test("never prunes :latest, a hand-named tag, or another repo's images", () => {
    const pruned = selectImagesToPrune(
      [
        img([`${repo}:latest`], 1),
        img([`${repo}:known-good`], 2),
        img(["other-bot:1111111"], 3),
        img([`${repo}:1111111`], 4),
      ],
      `${repo}:latest`,
      0,
    );
    expect(pruned).toEqual([`${repo}:1111111`]);
  });

  test("an untagged image doesn't blow up the scan", () => {
    expect(selectImagesToPrune([{ Id: "x", RepoTags: null, Created: 1 }], `${repo}:latest`, 0)).toEqual([]);
  });

  // A registry-qualified name's dots must match literally — as a regex they'd match any
  // character, and another repo's sha tags could get swept into the prune.
  test("a dotted registry name never matches another repo loosely", () => {
    const pruned = selectImagesToPrune(
      [
        img(["registryXexample.com/bot:1111111"], 1),
        img(["registry.example.com/bot:2222222"], 2),
      ],
      "registry.example.com/bot:latest",
      0,
    );
    expect(pruned).toEqual(["registry.example.com/bot:2222222"]);
  });
});

describe("buildCreateSpec", () => {
  const spec = buildCreateSpec(SELF, { image: "img:abc1234", handoffFrom: SELF.Id, oldImageEnv: [] });

  // The crux of "zero config": everything the replacement needs is discovered from the
  // original's own inspect, so there is nothing for an operator to set up first.
  test("replicates the compose labels so compose still owns the container", () => {
    expect(spec.Labels["com.docker.compose.project"]).toBe("warbandeer-discord-debug");
    expect(spec.Labels["com.docker.compose.service"]).toBe("bot");
  });

  test("carries the env over and marks the replacement as a standby", () => {
    expect(spec.Env).toContain("DISCORD_TOKEN=secret");
    expect(spec.Env).toContain("AUTO_UPDATE=true");
    expect(spec.Env).toContain(`HANDOFF_FROM=${SELF.Id}`);
  });

  // Config.Env merges the image's baked ENV with the container's own, so copying it verbatim
  // would pin the OLD sha onto the new container and override the new image's — a bot that
  // updated correctly would then report its own update as a no-op.
  test("drops GIT_SHA so the new image's baked-in sha wins", () => {
    expect(spec.Env.some((e) => e.startsWith("GIT_SHA="))).toBe(false);
  });

  test("never stacks a second HANDOFF_FROM when one is already set", () => {
    const chained = buildCreateSpec(
      { ...SELF, Config: { ...SELF.Config, Env: [...SELF.Config.Env, "HANDOFF_FROM=older"] } },
      { image: "img:abc1234", handoffFrom: "newer", oldImageEnv: [] },
    );
    expect(chained.Env.filter((e) => e.startsWith("HANDOFF_FROM="))).toEqual(["HANDOFF_FROM=newer"]);
  });

  // #51 item 7: Config.Env is the image's baked ENV merged with the container's own, so copying
  // it verbatim pins EVERY image default (not just GIT_SHA) at the old image's value forever.
  // Dropping only entries that match an old-image entry VERBATIM is what lets the new image
  // supply its own defaults while a genuine operator override (env_file-sourced, same key,
  // different value) still survives the swap.
  test("drops an entry that matches the old image's own baked env verbatim", () => {
    const withBaked = buildCreateSpec(
      { ...SELF, Config: { ...SELF.Config, Env: [...SELF.Config.Env, "BUN_INSTALL_BIN=/usr/local/bin"] } },
      { image: "img:abc1234", handoffFrom: SELF.Id, oldImageEnv: ["PATH=/usr/bin", "BUN_INSTALL_BIN=/usr/local/bin"] },
    );
    expect(withBaked.Env.some((e) => e.startsWith("PATH="))).toBe(false);
    expect(withBaked.Env.some((e) => e.startsWith("BUN_INSTALL_BIN="))).toBe(false);
  });

  test("keeps an operator override even when it shares a key with an image default", () => {
    // AUTO_UPDATE=true is the container's own value; the (hypothetical) image bakes a DIFFERENT
    // default. A key-only match would wrongly drop this and silently revert the operator's choice.
    const overridden = buildCreateSpec(SELF, {
      image: "img:abc1234",
      handoffFrom: SELF.Id,
      oldImageEnv: ["AUTO_UPDATE=false"],
    });
    expect(overridden.Env).toContain("AUTO_UPDATE=true");
  });

  test("an empty oldImageEnv carries every container-set var over, same as before this fix", () => {
    expect(spec.Env).toContain("PATH=/usr/bin");
  });

  test("re-binds the state volume, so the replacement reads the report left for it", () => {
    expect(spec.HostConfig.Binds).toContain("wbd_state:/app/data:rw");
  });

  test("re-binds the daemon socket, so the replacement can retire the original", () => {
    expect(spec.HostConfig.Binds).toContain("/var/run/docker.sock:/var/run/docker.sock:rw");
  });

  // Without this the replacement falls back to the image's `USER bun` and can't open the socket.
  test("carries the user over", () => {
    expect(spec.User).toBe("0:0");
  });

  test("keeps the restart policy, so the replacement survives a host reboot", () => {
    expect(spec.HostConfig.RestartPolicy).toEqual({ Name: "unless-stopped" });
  });

  test("defaults the restart policy when the original somehow has none", () => {
    const bare = buildCreateSpec({ ...SELF, HostConfig: {} }, { image: "i", handoffFrom: "x", oldImageEnv: [] });
    expect(bare.HostConfig.RestartPolicy).toEqual({ Name: "unless-stopped" });
  });

  // Found on the debug box: the swapped-in bot ran with bun as PID 1 because compose's
  // `init: true` is container config, not image config, and wasn't carried over.
  test("keeps init, so the replacement still runs under docker-init", () => {
    expect(spec.HostConfig.Init).toBe(true);
    const bare = buildCreateSpec({ ...SELF, HostConfig: {} }, { image: "i", handoffFrom: "x", oldImageEnv: [] });
    expect(bare.HostConfig.Init).toBeUndefined();
  });

  test("stays on the original's network", () => {
    expect(spec.HostConfig.NetworkMode).toBe("wbd_default");
  });

  test("runs the freshly built image, not the one we're on", () => {
    expect(spec.Image).toBe("img:abc1234");
  });

  test("a read-only mount stays read-only", () => {
    const ro = buildCreateSpec(
      { ...SELF, Mounts: [{ Type: "bind", Source: "/etc/x", Destination: "/etc/x", RW: false }] },
      { image: "i", handoffFrom: "x", oldImageEnv: [] },
    );
    expect(ro.HostConfig.Binds).toEqual(["/etc/x:/etc/x:ro"]);
  });

  // #51 item 6: without this the replacement resolves by container name only, so
  // `http://bot:<port>` (README's documented tunnel mapping) stops resolving after the first
  // self-update — inert today (no HTTP server yet), latent for the desktop-app API work.
  test("carries the network's service aliases over", () => {
    expect(spec.NetworkingConfig?.EndpointsConfig["wbd_default"]?.Aliases).toEqual([
      "bot",
      "warbandeer-discord-debug-bot-1",
    ]);
  });

  test("no NetworkingConfig when the network has no aliases of its own", () => {
    const noAliases = buildCreateSpec(
      { ...SELF, NetworkSettings: { Networks: { wbd_default: {} } } },
      { image: "i", handoffFrom: "x", oldImageEnv: [] },
    );
    expect(noAliases.NetworkingConfig).toBeUndefined();
  });

  test("no NetworkingConfig when the original has no network mode at all", () => {
    const bare = buildCreateSpec({ ...SELF, HostConfig: {} }, { image: "i", handoffFrom: "x", oldImageEnv: [] });
    expect(bare.NetworkingConfig).toBeUndefined();
  });
});

describe("takeOver", () => {
  const ID = "b".repeat(64);

  test("announces ready, tags :latest, retires the original, clears the marker — and never exits", async () => {
    const order: string[] = [];
    const exits: number[] = [];
    let retired: string | undefined;
    await takeOver(ID, {
      write: async (m) => void order.push(`write:${m.status}`),
      tagLatest: async () => void order.push("tag"),
      retire: async (id) => void (order.push("retire"), (retired = id)),
      clear: async () => void order.push("clear"),
      exit: (code) => void exits.push(code),
    });
    // Order is load-bearing: `ready` must be written *before* the retire — that write is what
    // stops the original counting toward its deadline and removing a replacement that has in fact
    // verified — and the :latest tag lands before the retire too, since it tags this (still-live)
    // container's own image, no different in kind from the write. Assert the exact sequence, so a
    // reorder can't slip through green.
    expect(order).toEqual(["write:ready", "tag", "retire", "clear"]);
    expect(retired).toBe(ID);
    expect(exits).toEqual([]);
  });

  // Issue #39's other half: tagging :latest is best-effort — a tag-API hiccup must not turn a
  // genuinely successful handoff into a reported failure. The retire and clear still have to run.
  test("a tagLatest failure doesn't abort the takeover — retire and clear still run, no failed marker", async () => {
    const writes: HandoffMarker[] = [];
    const exits: number[] = [];
    let retired: string | undefined;
    let cleared = false;
    await takeOver(ID, {
      write: async (m) => void writes.push(m),
      tagLatest: async () => {
        throw new Error("daemon: tag conflict");
      },
      retire: async (id) => void (retired = id),
      clear: async () => void (cleared = true),
      exit: (code) => void exits.push(code),
    });
    expect(retired).toBe(ID);
    expect(cleared).toBe(true);
    expect(exits).toEqual([]);
    expect(writes.some((m) => m.status === "failed")).toBe(false);
  });

  // The crux of the fix: a retire that throws must not become an unhandled rejection. The
  // original was never stopped (`stopContainer` only throws when the stop failed), so it is
  // alive to reclaim — we tell it why with a `failed` marker and exit, rather than crashing or
  // falling through to activate() and running a second live bot on the shared token.
  test("a retire failure writes a failed marker and exits 1 instead of crashing", async () => {
    const writes: HandoffMarker[] = [];
    const exits: number[] = [];
    let cleared = false;
    await takeOver(ID, {
      write: async (m) => void writes.push(m),
      tagLatest: async () => {},
      retire: async () => {
        throw new Error("daemon unreachable");
      },
      clear: async () => void (cleared = true),
      exit: (code) => void exits.push(code),
    });
    expect(exits).toEqual([1]);
    expect(cleared).toBe(false); // short-circuited past the happy-path clear
    const failed = writes.find((m) => m.status === "failed");
    expect(failed?.error).toContain("daemon unreachable");
  });

  // Belt and suspenders: if the marker mechanism itself is what's broken, the give-up write
  // fails too — the exit must still happen so the original reclaims on its own deadline.
  test("still exits when even the failed-marker write throws", async () => {
    const exits: number[] = [];
    await takeOver(ID, {
      write: async () => {
        throw new Error("disk full");
      },
      tagLatest: async () => {},
      retire: async () => void 0,
      exit: (code) => void exits.push(code),
    });
    expect(exits).toEqual([1]);
  });

  // The catch builds the give-up marker's message out of `err`; a bare `throw null` must not
  // defeat the guard by throwing a TypeError before `exit`. No production site throws a non-Error,
  // but "crash-proof" has to mean crash-proof — so this pins the `instanceof` narrowing.
  test("a non-Error throw still exits cleanly instead of re-rejecting", async () => {
    const exits: number[] = [];
    await takeOver(ID, {
      write: async () => void 0,
      tagLatest: async () => {},
      retire: async () => {
        throw null;
      },
      exit: (code) => void exits.push(code),
    });
    expect(exits).toEqual([1]);
  });
});

// A retire against the same original can run more than once with nothing left alive to reclaim if
// it fails: a prior removeContainer failure below leaves a stopped-but-not-removed corpse a later
// standby boot retries takeOver -> retireOriginal against, and separately HANDOFF_FROM never
// clears from a swapped-in container's own env, so a boot path that still honors it against an id
// since fully removed lands here too. The stop has to tell a genuine first attempt (original still
// running — a failure must propagate, since the original is alive to reclaim) from both of those
// (already stopped, or already gone entirely — a failure is just a daemon hiccup re-confirming
// what's already true, and must degrade like every other post-stop step instead of crashing the
// sole live bot).
describe("retireOriginal", () => {
  const realFetch = globalThis.fetch;
  const HOSTNAME = "self-container-id";
  const ORIGINAL_ID = "d".repeat(64);
  let calls: { path: string; method: string }[] = [];

  const runningOriginal: ContainerInspect = {
    ...SELF,
    Id: ORIGINAL_ID,
    Name: "/warbandeer-discord",
    State: { Running: true, Status: "running", ExitCode: 0 },
  };
  const stoppedCorpse: ContainerInspect = {
    ...SELF,
    Id: ORIGINAL_ID,
    Name: "/warbandeer-discord",
    State: { Running: false, Status: "exited", ExitCode: 0 },
  };

  beforeEach(() => {
    process.env.HOSTNAME = HOSTNAME;
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.HOSTNAME;
  });

  function stubDaemon(o: { inspectOriginal: () => Response; stopOriginal: () => Response }) {
    globalThis.fetch = (async (url: string, init?: RequestInit & { unix?: string }) => {
      const method = init?.method ?? "GET";
      const { pathname } = new URL(String(url));
      calls.push({ path: pathname, method });

      if (pathname === `/containers/${ORIGINAL_ID}/json`) return o.inspectOriginal();
      if (pathname === `/containers/${ORIGINAL_ID}/stop`) return o.stopOriginal();
      if (pathname === `/containers/${ORIGINAL_ID}` && method === "DELETE") return new Response("", { status: 204 });
      if (pathname === `/containers/${HOSTNAME}/json`) return new Response(JSON.stringify(SELF), { status: 200 });
      if (pathname.endsWith("/rename")) return new Response("", { status: 204 });
      throw new Error(`unstubbed daemon call: ${method} ${pathname}`);
    }) as unknown as typeof fetch;
  }

  test("a first attempt against a running original propagates a genuine stop failure", async () => {
    stubDaemon({
      inspectOriginal: () => new Response(JSON.stringify(runningOriginal), { status: 200 }),
      stopOriginal: () => new Response("daemon blip", { status: 500 }),
    });
    await expect(retireOriginal(ORIGINAL_ID)).rejects.toThrow(/500/);
  });

  test("a retry against an already-stopped corpse tolerates a genuine stop failure and still removes it", async () => {
    stubDaemon({
      inspectOriginal: () => new Response(JSON.stringify(stoppedCorpse), { status: 200 }),
      stopOriginal: () => new Response("daemon blip", { status: 500 }),
    });
    await retireOriginal(ORIGINAL_ID); // must not throw
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/containers/${ORIGINAL_ID}`)).toBe(true);
  });

  // The expected 304 (already stopped) is tolerated by stopContainer itself either way — pinning
  // this keeps the new branch from changing the ordinary retry's behavior.
  test("a retry that gets the expected 304 behaves the same as before this fix", async () => {
    stubDaemon({
      inspectOriginal: () => new Response(JSON.stringify(stoppedCorpse), { status: 200 }),
      stopOriginal: () => new Response("", { status: 304 }),
    });
    await retireOriginal(ORIGINAL_ID);
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/containers/${ORIGINAL_ID}`)).toBe(true);
  });

  // An original that's already fully gone (removed, not just stopped) is a third "nothing left to
  // reclaim" case — reached routinely, since HANDOFF_FROM never clears from a swapped-in
  // container's own env, so any boot path that still honors it against a since-fully-removed id
  // lands here too. stopContainer's own 404 tolerance covers the expected repeat-404, but this
  // pins the case a naive "not-running" check would miss: a genuine daemon error on that same
  // call must be tolerated exactly like the stopped-corpse retry above, not left to propagate.
  test("an original that no longer exists at all tolerates a genuine stop failure too", async () => {
    stubDaemon({
      inspectOriginal: () => new Response("not found", { status: 404 }),
      stopOriginal: () => new Response("daemon blip", { status: 500 }),
    });
    await retireOriginal(ORIGINAL_ID); // must not throw
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/containers/${ORIGINAL_ID}`)).toBe(true);
  });

  test("an original that no longer exists at all still returns cleanly on the expected 404", async () => {
    stubDaemon({
      inspectOriginal: () => new Response("not found", { status: 404 }),
      stopOriginal: () => new Response("not found", { status: 404 }),
    });
    await retireOriginal(ORIGINAL_ID); // must not throw
  });
});

// #37: a daemon error anywhere from "replacement started" onward must still reach `endHandoff()`
// — otherwise the bot stays quiesced forever (scheduler stopped, every `/update` answers "busy").
// Drives `redeploy()` end-to-end through a stubbed `globalThis.fetch`, in the style of
// docker.test.ts/update.test.ts, rather than mocking the docker/handoff modules directly.
describe("redeploy — cleanup always runs", () => {
  const realFetch = globalThis.fetch;
  const HOSTNAME = "self-container-id";
  const REPLACEMENT_ID = "c".repeat(64);
  let calls: { path: string; method: string; url: string }[] = [];

  beforeEach(async () => {
    process.env.HOSTNAME = HOSTNAME;
    calls = [];
    resetForTest();
    await clearMarker();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    delete process.env.HOSTNAME;
    resetForTest();
    await clearMarker();
  });

  const jsonRes = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  /**
   * Wires every daemon call redeploy() makes through "replacement started" (self-inspect, build,
   * prune, leftover-cleanup, create, start) to a happy response, and lets each test steer only
   * the two calls the fix touches: the handoff poll, and the final removal of the replacement.
   */
  function stubDaemon(o: {
    pollReplacement: () => Response;
    removeReplacement: () => Response;
    /** Runs (awaited) when the replacement is started — before `awaitHandoff` ever polls, so a
     *  marker written here is guaranteed on disk for the very first poll to see. Used by the
     *  item-3 retirement-wait tests to reach a `ready` outcome deterministically, with no reliance
     *  on POLL_MS timing. */
    afterStart?: () => Promise<void>;
  }) {
    globalThis.fetch = (async (url: string, init?: RequestInit & { unix?: string }) => {
      const method = init?.method ?? "GET";
      const { pathname } = new URL(String(url));
      calls.push({ path: pathname, method, url: String(url) });

      if (pathname === `/containers/${HOSTNAME}/json`) return jsonRes(SELF);
      if (pathname === "/build") return new Response('{"stream":"done"}', { status: 200 });
      if (pathname === "/images/json") return jsonRes([]);
      if (pathname.startsWith("/images/") && pathname.endsWith("/json")) return jsonRes({ Config: { Env: [] } });
      if (pathname === "/containers/create") return jsonRes({ Id: REPLACEMENT_ID });
      if (pathname === `/containers/${REPLACEMENT_ID}/start`) {
        await o.afterStart?.();
        return new Response("", { status: 204 });
      }
      if (pathname === `/containers/${REPLACEMENT_ID}/json`) return o.pollReplacement();
      if (pathname === `/containers/${REPLACEMENT_ID}` && method === "DELETE") return o.removeReplacement();
      if (method === "DELETE") return new Response("", { status: 404 }); // the leftover-name cleanup
      throw new Error(`unstubbed daemon call: ${method} ${pathname}`);
    }) as unknown as typeof fetch;
  }

  const wasRemovalAttempted = () =>
    calls.some((c) => c.method === "DELETE" && c.path === `/containers/${REPLACEMENT_ID}`);

  // The crux of the fix: a rejection from `tryInspectContainer` mid-poll (a dropped socket, one
  // 500) used to propagate straight out of `redeploy()`, skipping `endHandoff()` entirely.
  test("a daemon error during the handoff poll still ends the handoff", async () => {
    stubDaemon({
      pollReplacement: () => new Response("boom", { status: 500 }),
      removeReplacement: () => new Response("", { status: 404 }),
    });
    const result = await redeploy("a".repeat(40));
    expect(handoffActive()).toBe(false);
    expect(wasRemovalAttempted()).toBe(true);
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("500");
  });

  // Same gap, the other unguarded call: a 409 removing the replacement at the very end must not
  // skip `endHandoff()` either.
  test("a removeContainer conflict during cleanup still ends the handoff", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("removal in progress", { status: 409 }),
    });
    const result = await redeploy("b".repeat(40));
    expect(handoffActive()).toBe(false);
    expect(wasRemovalAttempted()).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  // Issue #39, acceptance bullet 1: a build tagged only its sha (never :latest at build time —
  // the crux of the fix), so a failed/timed-out handoff structurally cannot have touched :latest
  // at all. redeploy() itself never calls the tag endpoint on any outcome — only takeOver, in a
  // replacement that has actually verified, ever does (see the takeOver describe block above).
  test("a failed handoff never touches :latest — redeploy() never applies a tag on any outcome", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("", { status: 404 }),
    });
    const result = await redeploy("d".repeat(40));
    expect(result.outcome).toBe("failed");
    expect(calls.some((c) => c.path.includes("/tag"))).toBe(false);
  });

  // Issue #39, the other half of the fix: the build request itself must carry only the sha tag —
  // this is what closes the window, since a build tagged :latest directly would arm every later
  // recreate (env-set, a Dockge restart, a plain `compose up -d`) the instant it merely compiled.
  test("the build request tags only the sha, never :latest", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("", { status: 404 }),
    });
    await redeploy("e".repeat(40));
    const build = calls.find((c) => c.path === "/build");
    expect(build).toBeDefined();
    const params = new URL(build!.url).searchParams;
    expect(params.getAll("t")).toEqual(["warbandeer-discord-debug-bot:eeeeeee"]);
  });

  // #51 item 2: the daemon fetches at build *start*, seconds after `latestSha` was resolved and
  // compared — a push landing in that window must not silently ship newer code stamped with the
  // older, already-compared sha. Building from the exact sha (not config.botBranch's live tip)
  // closes it: GitHub serves a fetch by full sha, so the daemon checks out exactly that commit.
  test("builds from the exact compared sha, not the branch's current tip", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("", { status: 404 }),
    });
    const sha = "f".repeat(40);
    await redeploy(sha);
    const build = calls.find((c) => c.path === "/build");
    expect(build).toBeDefined();
    const remote = new URL(build!.url).searchParams.get("remote");
    expect(remote).toContain(`#${sha}`);
    expect(remote).not.toContain("#main");
  });

  // #51 item 7: the old image's own baked env has to be read so buildCreateSpec can tell an
  // image default apart from a genuine operator override — wiring pinned so it can't go silently
  // dead (the drop-logic itself is unit-tested directly on buildCreateSpec, below).
  test("inspects the old image's own env before creating the replacement", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("", { status: 404 }),
    });
    await redeploy("1".repeat(40));
    expect(calls.some((c) => c.method === "GET" && c.path.startsWith("/images/") && c.path.endsWith("/json"))).toBe(
      true,
    );
  });

  // #51 item 3: a blind Bun.sleep(RETIREMENT_DEADLINE_MS) here used to sit on a `failed` marker
  // for up to 3 minutes before ever reading it. Polling instead catches it within one `pollMs` —
  // pinned with a deadline generously larger than when the marker actually flips, so a slow CI
  // disk can't turn this into a flake.
  test("a marker that flips to failed during the retirement wait reclaims quickly, with the reason", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes(SELF),
      removeReplacement: () => new Response("", { status: 404 }),
      afterStart: () => writeMarker({ status: "ready", sha: "2222222", at: Date.now() }),
    });
    const resultPromise = redeploy("2".repeat(40), { deadlineMs: 300, pollMs: 20 });
    void Bun.sleep(60).then(() =>
      writeMarker({ status: "failed", sha: "2222222", error: "retire boom", at: Date.now() }),
    );
    const result = await resultPromise;
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("retire boom");
    expect(handoffActive()).toBe(false);
  });

  // The other half: the deadline genuinely elapsing (nothing ever flips the marker) is still a
  // `stalled` outcome, not `failed` — distinct because it points at the daemon socket, not the
  // build itself (see handoff.ts's handoffFailureMessage).
  test("a marker that stays ready for the whole deadline is stalled, not failed", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes(SELF),
      removeReplacement: () => new Response("", { status: 404 }),
      afterStart: () => writeMarker({ status: "ready", sha: "3333333", at: Date.now() }),
    });
    const result = await redeploy("3".repeat(40), { deadlineMs: 60, pollMs: 15 });
    expect(result.outcome).toBe("stalled");
    expect(handoffActive()).toBe(false);
  });
});

// Issue #46: HANDOFF_FROM is baked into the replacement's env at creation time and never
// cleared, so `bootMode(env)` alone re-reads "standby" on every later in-place restart of the
// very container that already completed the handoff. `resolveBootMode` is the fix — it confirms
// the instruction against the daemon before honoring it.
describe("resolveBootMode", () => {
  const countingInspect = (result: ContainerInspect | undefined | (() => never)) => {
    let calls = 0;
    const inspect = async (_id: string) => {
      calls++;
      if (typeof result === "function") return result();
      return result;
    };
    return { inspect, callCount: () => calls };
  };

  test("no HANDOFF_FROM at all is a normal boot, and never touches the daemon", async () => {
    const { inspect, callCount } = countingInspect(SELF);
    expect(await resolveBootMode({}, inspect)).toBe("normal");
    expect(callCount()).toBe(0);
  });

  // Mirrors bootMode's own empty-string case: an unset compose var interpolates to "", and that
  // must not arm standby or reach for the daemon either.
  test("an empty HANDOFF_FROM is a normal boot, and never touches the daemon", async () => {
    const { inspect, callCount } = countingInspect(SELF);
    expect(await resolveBootMode({ [HANDOFF_FROM_ENV]: "" }, inspect)).toBe("normal");
    expect(callCount()).toBe(0);
  });

  test("a HANDOFF_FROM whose original is still running is a genuine handoff — standby", async () => {
    const { inspect } = countingInspect({ ...SELF, State: { Running: true, Status: "running", ExitCode: 0 } });
    expect(await resolveBootMode({ [HANDOFF_FROM_ENV]: SELF.Id }, inspect)).toBe("standby");
  });

  // The issue's own acceptance bullet: an id that 404s (long gone, fully removed) is a normal
  // boot, not standby.
  test("a HANDOFF_FROM whose original no longer exists is a normal boot", async () => {
    const { inspect } = countingInspect(undefined);
    expect(await resolveBootMode({ [HANDOFF_FROM_ENV]: SELF.Id }, inspect)).toBe("normal");
  });

  // Deliberately existence, not the original's live running state: a container that merely
  // hasn't been (re)started yet post-reboot still exists (200, State.Running: false), and a
  // check keyed on "running" would misread that window as "gone," letting a genuinely mid-flight
  // replacement go live without ever retiring the original — two live bots on the shared token.
  // A stopped-but-still-present original (e.g. a failed removal in `retireOriginal`) must stay
  // standby, the same as a running one.
  test("a HANDOFF_FROM whose original exists but isn't running yet stays standby, not normal", async () => {
    const { inspect } = countingInspect({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 0 } });
    expect(await resolveBootMode({ [HANDOFF_FROM_ENV]: SELF.Id }, inspect)).toBe("standby");
  });

  // A daemon blip can't confirm the original is gone, and a genuine handoff boot needs a live
  // daemon connection for the rest of the protocol regardless — so an unconfirmed error must
  // stay standby rather than risk two live bots on the shared token.
  test("a daemon error while checking is not proof the original is gone — stays standby", async () => {
    const { inspect } = countingInspect(() => {
      throw new Error("boom");
    });
    expect(await resolveBootMode({ [HANDOFF_FROM_ENV]: SELF.Id }, inspect)).toBe("standby");
  });

  // The other new failure mode this fix could introduce: the daemon call now happens before
  // `client.login()` is even attempted, and `docker.ts` carries no timeout of its own. A hung
  // (not merely erroring) socket must not block boot forever — it has to fall through to the
  // same "can't confirm" handling as any other inspect failure, bounded well under the real
  // default so this test stays fast.
  test("a daemon call that never resolves times out and stays standby, not hung forever", async () => {
    const inspect = () => new Promise<ContainerInspect | undefined>(() => {}); // never settles
    expect(await resolveBootMode({ [HANDOFF_FROM_ENV]: SELF.Id }, inspect, 20)).toBe("standby");
  });
});
