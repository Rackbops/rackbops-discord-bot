import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ContainerInspect, ImageSummary } from "./docker";
import type { HandoffMarker } from "./handoff";

// redeploy.ts pulls in the `config` singleton (env resolved at import time) -- the required vars
// are primed once by test/setup.ts's bunfig preload (#136).
const {
  baseName,
  buildCreateSpec,
  buildRemote,
  canonicalName,
  completeTakeOver,
  detectRollback,
  finishProbation,
  FIRST_TICK_CAP_MS,
  healOwnName,
  latestTag,
  redeploy,
  replacementName,
  resolveBootMode,
  retireOriginal,
  selectImagesToPrune,
  shaTag,
  stepAside,
  STEP_ASIDE_GRACE_MS,
  takeOver,
} = await import("./redeploy");
const { clearMarker, writeMarker, HANDOFF_FROM_ENV, HANDOFF_RESTART_POLICY_ENV, HANDOFF_RESTART_RETRIES_ENV } =
  await import("./handoff");
const { beginShutdown, handoffActive, restartPending, resetForTest } = await import("./restart");
const { SHORT_SHA_LEN } = await import("./storage");

const SELF_ID = "a".repeat(64);
const SELF_SHORT_ID = SELF_ID.slice(0, 12);
const SELF: ContainerInspect = {
  Id: SELF_ID,
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
  // Docker auto-adds a connected container's own short id here alongside any deliberately
  // configured alias — "bot" is the real, meant-to-be-shared compose service alias; the short id
  // is this SPECIFIC container's own identity and must not be carried onto a different one.
  NetworkSettings: { Networks: { wbd_default: { Aliases: ["bot", SELF_SHORT_ID] } } },
};

/** Polls `done` until it holds (at most `ms`), so a slow runner delays a test that waits on an un-awaited call
 *  instead of failing it. */
async function until(done: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await Bun.sleep(5);
}

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

  // #492/#547: `-next` is a reserved suffix. The base name is what the compose file pins.
  test("baseName strips the slash and any trailing -next suffixes, and only a suffix", () => {
    expect(baseName("/warbandeer-discord-next")).toBe("warbandeer-discord");
    expect(baseName("/warbandeer-discord-next-next")).toBe("warbandeer-discord");
    expect(baseName("/warbandeer-discord")).toBe("warbandeer-discord");
    expect(baseName("/nextgen-bot")).toBe("nextgen-bot");
    expect(baseName("/bot-next-gen")).toBe("bot-next-gen");
  });

  test("the replacement's name is derived from the base, so a drifted name folds back to <name>-next", () => {
    expect(replacementName("/warbandeer-discord-next")).toBe("warbandeer-discord-next");
    expect(replacementName("/warbandeer-discord-next-next")).toBe("warbandeer-discord-next");
  });
});

describe("buildRemote", () => {
  test("points the daemon at the whole repo on the target branch", () => {
    expect(buildRemote("Rackbops/rackbops-discord-bot", "main")).toBe(
      "https://github.com/Rackbops/rackbops-discord-bot.git#main",
    );
  });

  test("carries a branch with slashes through intact", () => {
    expect(buildRemote("Rackbops/rackbops-discord-bot", "feat/x")).toContain("#feat/x");
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

  // #132: shaTag's tag width and this function's tag-shape regex must never drift apart — a
  // hand-written same-width fixture (the tests above) would stay green even if they did, since
  // both sides would just happen to agree at test-writing time. Driving a REAL shaTag() output
  // through selectImagesToPrune closes that gap: if shaTag's width ever moves independently of
  // SHORT_SHA_LEN (or the regex is ever hand-written back to a literal {7}), this fails because
  // the produced tag's length no longer matches what the regex expects.
  test("a real shaTag() output is recognized as prunable — the shaTag/regex coupling", () => {
    const repo = "warbandeer-discord-debug-bot";
    const currentImage = `${repo}:latest`;
    const tag = shaTag(currentImage, "abcdef1234567890");
    expect(tag).toBe(`${repo}:${"abcdef1234567890".slice(0, SHORT_SHA_LEN)}`);
    const pruned = selectImagesToPrune([img([tag], 1), img([`${repo}:latest`], 2)], currentImage, 0);
    expect(pruned).toContain(tag);
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

  // #160: the standby must never be resurrected by Docker's own restart policy while it's still
  // unverified — a policy restore that only ran AFTER retireOriginal's stop, combined with #130's
  // 60s bound on that stop, would be a permanent zero-bots outage if the transport dropped in that
  // exact window (see redeploy.ts's takeOver docstring). The original's REAL policy still rides
  // along, just in the env now — see the next test — for takeOver to restore before it stops it.
  test("the standby is non-resurrecting, regardless of the original's own policy", () => {
    expect(spec.HostConfig.RestartPolicy).toEqual({ Name: "no" });
    const originalOnNoPolicy = buildCreateSpec(
      { ...SELF, HostConfig: { ...SELF.HostConfig, RestartPolicy: { Name: "always" } } },
      { image: "i", handoffFrom: "x", oldImageEnv: [] },
    );
    expect(originalOnNoPolicy.HostConfig.RestartPolicy).toEqual({ Name: "no" });
  });

  test("the original's policy name rides in the env for takeOver to restore, defaulting when absent", () => {
    expect(spec.Env).toContain(`${HANDOFF_RESTART_POLICY_ENV}=unless-stopped`);
    const bare = buildCreateSpec({ ...SELF, HostConfig: {} }, { image: "i", handoffFrom: "x", oldImageEnv: [] });
    expect(bare.Env).toContain(`${HANDOFF_RESTART_POLICY_ENV}=unless-stopped`);
    const always = buildCreateSpec(
      { ...SELF, HostConfig: { ...SELF.HostConfig, RestartPolicy: { Name: "always" } } },
      { image: "i", handoffFrom: "x", oldImageEnv: [] },
    );
    expect(always.Env).toContain(`${HANDOFF_RESTART_POLICY_ENV}=always`);
  });

  // Mirrors the existing "never stacks a second HANDOFF_FROM" test — a container that has already
  // been through one handoff (a standby that never finished, restarted, and is now redeploying
  // again) must not accumulate a second HANDOFF_RESTART_POLICY= line, which would make grep-style
  // extraction (takeOver's real effect) ambiguous about which one is current.
  test("never stacks a second HANDOFF_RESTART_POLICY when one is already set", () => {
    const chained = buildCreateSpec(
      { ...SELF, Config: { ...SELF.Config, Env: [...SELF.Config.Env, `${HANDOFF_RESTART_POLICY_ENV}=stale`] } },
      { image: "img:abc1234", handoffFrom: "newer", oldImageEnv: [] },
    );
    expect(chained.Env.filter((e) => e.startsWith(`${HANDOFF_RESTART_POLICY_ENV}=`))).toEqual([
      `${HANDOFF_RESTART_POLICY_ENV}=unless-stopped`,
    ]);
  });

  // #490 item 9: an `on-failure` original's retry cap rides along, so the restore does not turn "retry 5
  // times" into "retry forever" (Docker reads a missing cap as unlimited). Only for `on-failure` with a
  // positive cap -- never a `MaximumRetryCount: 0`, which Docker also reads as unlimited.
  test("carries an on-failure retry cap for takeOver to restore, and nothing for any other policy", () => {
    const withPolicy = (RestartPolicy: { Name: string; MaximumRetryCount?: number }) =>
      buildCreateSpec({ ...SELF, HostConfig: { ...SELF.HostConfig, RestartPolicy } }, { image: "i", handoffFrom: "x", oldImageEnv: [] });
    const retries = (s: { Env: string[] }) => s.Env.filter((e) => e.startsWith(`${HANDOFF_RESTART_RETRIES_ENV}=`));
    expect(retries(withPolicy({ Name: "on-failure", MaximumRetryCount: 5 }))).toEqual([`${HANDOFF_RESTART_RETRIES_ENV}=5`]);
    expect(withPolicy({ Name: "on-failure", MaximumRetryCount: 5 }).Env).toContain(`${HANDOFF_RESTART_POLICY_ENV}=on-failure`);
    // Mutation: pushing the cap for every policy puts a retries line on these.
    expect(retries(withPolicy({ Name: "unless-stopped", MaximumRetryCount: 5 }))).toEqual([]);
    expect(retries(withPolicy({ Name: "always" }))).toEqual([]);
    expect(retries(withPolicy({ Name: "on-failure", MaximumRetryCount: 0 }))).toEqual([]);
    expect(retries(withPolicy({ Name: "on-failure" }))).toEqual([]);
    expect(retries(spec)).toEqual([]);
  });

  test("never stacks a second HANDOFF_RESTART_RETRIES when one is already set", () => {
    const chained = buildCreateSpec(
      {
        ...SELF,
        Config: { ...SELF.Config, Env: [...SELF.Config.Env, `${HANDOFF_RESTART_RETRIES_ENV}=99`] },
        HostConfig: { ...SELF.HostConfig, RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 } },
      },
      { image: "img:abc1234", handoffFrom: "newer", oldImageEnv: [] },
    );
    expect(chained.Env.filter((e) => e.startsWith(`${HANDOFF_RESTART_RETRIES_ENV}=`))).toEqual([`${HANDOFF_RESTART_RETRIES_ENV}=3`]);
    // And a stale one is dropped when the original's policy no longer has a cap.
    const stale = buildCreateSpec(
      { ...SELF, Config: { ...SELF.Config, Env: [...SELF.Config.Env, `${HANDOFF_RESTART_RETRIES_ENV}=99`] } },
      { image: "img:abc1234", handoffFrom: "newer", oldImageEnv: [] },
    );
    expect(stale.Env.filter((e) => e.startsWith(`${HANDOFF_RESTART_RETRIES_ENV}=`))).toEqual([]);
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
  test("carries the network's deliberately-configured service alias over", () => {
    expect(spec.NetworkingConfig?.EndpointsConfig["wbd_default"]?.Aliases).toContain("bot");
  });

  // Docker auto-adds a connected container's own short id to the same Aliases array. Carrying
  // that over would tag the REPLACEMENT with the ORIGINAL's specific identity — meaningless (and
  // wrong) on a different container, unlike "bot", which is meant to be shared across whichever
  // container currently holds the service.
  test("drops the original's own auto-added short container id from the carried-over aliases", () => {
    expect(spec.NetworkingConfig?.EndpointsConfig["wbd_default"]?.Aliases).not.toContain(SELF_SHORT_ID);
  });

  test("no NetworkingConfig when the network has no aliases of its own", () => {
    const noAliases = buildCreateSpec(
      { ...SELF, NetworkSettings: { Networks: { wbd_default: {} } } },
      { image: "i", handoffFrom: "x", oldImageEnv: [] },
    );
    expect(noAliases.NetworkingConfig).toBeUndefined();
  });

  // If the only alias Docker ever recorded is the original's own short id (no deliberate alias
  // configured at all), filtering it out must not leave behind an empty-but-present
  // NetworkingConfig — that's functionally the same as having none.
  test("no NetworkingConfig when the only alias present is the original's own short id", () => {
    const onlyShortId = buildCreateSpec(
      { ...SELF, NetworkSettings: { Networks: { wbd_default: { Aliases: [SELF_SHORT_ID] } } } },
      { image: "i", handoffFrom: "x", oldImageEnv: [] },
    );
    expect(onlyShortId.NetworkingConfig).toBeUndefined();
  });

  test("no NetworkingConfig when the original has no network mode at all", () => {
    const bare = buildCreateSpec({ ...SELF, HostConfig: {} }, { image: "i", handoffFrom: "x", oldImageEnv: [] });
    expect(bare.NetworkingConfig).toBeUndefined();
  });
});

describe("takeOver", () => {
  const ID = "b".repeat(64);

  test("announces ready, restores the policy, retires the original, clears the marker — and never exits", async () => {
    const order: string[] = [];
    const exits: number[] = [];
    let retired: string | undefined;
    await takeOver(ID, {
      write: async (m) => void order.push(`write:${m.status}`),
      restorePolicy: async () => void order.push("restore"),
      retire: async (id) => void (order.push("retire"), (retired = id)),
      clear: async () => void order.push("clear"),
      exit: (code) => void exits.push(code),
    });
    // Order is load-bearing: `ready` must be written *before* the retire — that write is what
    // stops the original counting toward its deadline and removing a replacement that has in fact
    // verified — and the restart-policy restore lands before the retire too, since it acts on this
    // (still-live) container's own state, no different in kind from the write. #160: restore must
    // come before retire specifically — a restore that ran only after the original's stop would be a
    // permanent zero-bots outage if the transport dropped in that window (see takeOver's own
    // docstring). Assert the exact sequence, so a reorder — the guard for that whole hazard — can't
    // slip through green. #548: no `:latest` tag here any more -- it follows probation, in
    // completeTakeOver -- so a `retire` that throws can never leave `:latest` on a build the requester
    // was told was not deployed (#490 item 7).
    expect(order).toEqual(["write:ready", "restore", "retire", "clear"]);
    expect(retired).toBe(ID);
    expect(exits).toEqual([]);
  });

  // #548: asked again right before the ready write and the stop. An operator's `docker start <name>` that landed
  // after the boot-time check is a rollback; announcing `ready` and stopping the original would undo it.
  test("a rollback seen right before the takeover makes it step aside: no ready, no restore, no stop, no exit", async () => {
    const order: string[] = [];
    const exits: number[] = [];
    const aside = new Error("stepped aside");
    await expect(
      takeOver(ID, {
        write: async (m) => void order.push(`write:${m.status}`),
        restorePolicy: async () => void order.push("restore"),
        retire: async () => void order.push("retire"),
        clear: async () => void order.push("clear"),
        rolledBack: async () => (order.push("rolledBack"), true),
        stepAside: async () => (order.push("aside"), Promise.reject(aside)),
        exit: (code) => void exits.push(code),
      }),
    ).rejects.toBe(aside);
    // Mutation: dropping the look, or running it after the ready write, changes this list.
    expect(order).toEqual(["rolledBack", "aside"]);
    expect(exits).toEqual([]); // stepping aside is not a failed handoff
  });

  test("no rollback: the takeover goes ahead after one look", async () => {
    const order: string[] = [];
    await takeOver(ID, {
      write: async (m) => void order.push(`write:${m.status}`),
      restorePolicy: async () => void order.push("restore"),
      retire: async () => void order.push("retire"),
      clear: async () => void order.push("clear"),
      rolledBack: async () => (order.push("rolledBack"), false),
      stepAside: async () => Promise.reject(new Error("must not step aside")),
    });
    expect(order).toEqual(["rolledBack", "write:ready", "restore", "retire", "clear"]);
  });

  // #160: a restorePolicy failure is NOT best-effort — a swallowed failure would
  // leave the SURVIVING bot on RestartPolicy:"no" forever, silently, until a host reboot doesn't
  // bring it back and someone notices weeks later. So this must behave exactly like a retire
  // failure: failed marker, exit(1), and — critically — retire/clear never run at all, since the
  // original must stay alive to reclaim rather than being torn down by a replacement that isn't
  // actually safe to leave running unsupervised yet.
  test("a restorePolicy failure writes a failed marker and exits 1 — retire and clear never run", async () => {
    const writes: HandoffMarker[] = [];
    const exits: number[] = [];
    let retireCalled = false;
    let cleared = false;
    await takeOver(ID, {
      write: async (m) => void writes.push(m),
      restorePolicy: async () => {
        throw new Error("daemon: update rejected");
      },
      retire: async () => void (retireCalled = true),
      clear: async () => void (cleared = true),
      exit: (code) => void exits.push(code),
    });
    expect(exits).toEqual([1]);
    expect(retireCalled).toBe(false); // never reached — the original must stay alive to reclaim
    expect(cleared).toBe(false);
    const failed = writes.find((m) => m.status === "failed");
    expect(failed?.error).toContain("daemon: update rejected");
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
      restorePolicy: async () => {},
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
      restorePolicy: async () => {},
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
      restorePolicy: async () => {},
      retire: async () => {
        throw null;
      },
      exit: (code) => void exits.push(code),
    });
    expect(exits).toEqual([1]);
  });
});

// #160's actual guard against the permanent-outage hazard: the effects-injection tests above only
// prove the CALLING order of whichever functions were passed in — they say nothing about the real
// HTTP verbs the DEFAULT effects (restoreOriginalRestartPolicy, retireOriginal) issue against the
// daemon. This drives takeOver with real defaults for restorePolicy/retire (only write/clear are
// stubbed, to keep this hermetic and avoid touching the real marker file) through a stubbed
// globalThis.fetch, recording call order — the same harness shape as the retireOriginal describe below.
describe("takeOver — real daemon calls (the ordering guard for the whole hazard, #160)", () => {
  const realFetch = globalThis.fetch;
  const HOSTNAME = SELF_SHORT_ID; // 12 hex, a prefix of SELF.Id: inspectSelf (#512) accepts it without reading mountinfo
  const ORIGINAL_ID = "e".repeat(64);
  let calls: { path: string; method: string; body?: string }[] = [];

  const runningOriginal: ContainerInspect = {
    ...SELF,
    Id: ORIGINAL_ID,
    Name: "/warbandeer-discord",
    State: { Running: true, Status: "running", ExitCode: 0 },
  };
  // A FIRST-attempt standby: created with RestartPolicy "no" (#160), until takeOver restores the original's.
  const STANDBY: ContainerInspect = { ...SELF, HostConfig: { ...SELF.HostConfig, RestartPolicy: { Name: "no" } } };

  beforeEach(() => {
    process.env.HOSTNAME = HOSTNAME;
    process.env[HANDOFF_RESTART_POLICY_ENV] = "unless-stopped";
    delete process.env[HANDOFF_RESTART_RETRIES_ENV];
    calls = [];
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.HOSTNAME;
    delete process.env[HANDOFF_RESTART_POLICY_ENV];
    delete process.env[HANDOFF_RESTART_RETRIES_ENV];
  });

  function stubDaemon() {
    globalThis.fetch = (async (url: string, init?: RequestInit & { unix?: string }) => {
      const method = init?.method ?? "GET";
      const { pathname } = new URL(String(url));
      calls.push({ path: pathname, method, body: init?.body ? String(init.body) : undefined });
      if (pathname === `/containers/${HOSTNAME}/json`) return new Response(JSON.stringify(STANDBY), { status: 200 });
      if (pathname === `/containers/${SELF_ID}/update`) return new Response("", { status: 200 });
      if (pathname === `/containers/${ORIGINAL_ID}/json`) return new Response(JSON.stringify(runningOriginal), { status: 200 });
      if (pathname === `/containers/${ORIGINAL_ID}/stop`) return new Response("", { status: 204 });
      if (pathname === `/containers/${ORIGINAL_ID}` && method === "DELETE") return new Response("", { status: 204 });
      if (pathname.endsWith("/rename")) return new Response("", { status: 204 });
      // #548: recorded rather than thrown on, so a tag call during takeOver is VISIBLE to the pin below
      // (an unstubbed throw would be swallowed by a best-effort `.catch`).
      if (pathname.startsWith("/images/") && pathname.endsWith("/tag")) return new Response("", { status: 201 });
      throw new Error(`unstubbed daemon call: ${method} ${pathname}`);
    }) as unknown as typeof fetch;
  }

  // #548: takeOver ends at the STOP. The removal, the name and `:latest` are completeTakeOver's, after the
  // new build has run -- so a takeOver that also tagged, removed or renamed would leave nothing to start
  // again, which is the bug.
  test("takeOver stops the original and never tags, removes or renames", async () => {
    stubDaemon();
    await takeOver(ORIGINAL_ID, { write: async () => {}, clear: async () => {} });
    expect(calls.some((c) => c.method === "POST" && c.path === `/containers/${ORIGINAL_ID}/stop`)).toBe(true);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(calls.filter((c) => c.path.endsWith("/rename"))).toEqual([]);
    expect(calls.filter((c) => c.path.endsWith("/tag"))).toEqual([]);
  });

  // #548: the DEFAULT `rolledBack` (detectRollback, fed this container's env plus the original's id) against the
  // real HTTP verbs: a running original beside a container whose own policy is no longer `no` makes takeOver step
  // aside before it touches anything; a first-attempt standby (policy `no`) goes straight through.
  test("the default look at the original: a restored own policy beside a running original steps aside, a fresh standby does not", async () => {
    // Mutation: a default `rolledBack` that always says no lets this takeover go ahead and stop the original.
    globalThis.fetch = (async (url: string, init?: RequestInit & { unix?: string }) => {
      const method = init?.method ?? "GET";
      const { pathname } = new URL(String(url));
      calls.push({ path: pathname, method });
      if (pathname === `/containers/${HOSTNAME}/json`) {
        const restored = { ...SELF, HostConfig: { ...SELF.HostConfig, RestartPolicy: { Name: "unless-stopped" } } };
        return new Response(JSON.stringify(restored), { status: 200 });
      }
      if (pathname === `/containers/${ORIGINAL_ID}/json`) return new Response(JSON.stringify(runningOriginal), { status: 200 });
      if (pathname === `/containers/${SELF_ID}/stop`) return new Response("", { status: 204 });
      throw new Error(`unstubbed daemon call: ${method} ${pathname}`);
    }) as unknown as typeof fetch;
    const exits: number[] = [];
    const slept: number[] = [];
    // The DEFAULT stepAside too, with only its exit and grace wait injected (the grace never ends, so the call
    // never returns, like the real one). Mutation: a default that does nothing leaves no POST .../stop on this
    // container and lets the takeover go ahead; one that drops `stepAsideDeps` leaves the REAL 30 s grace and
    // `process.exit(1)` armed, which the recorded grace below catches as an assertion.
    void takeOver(ORIGINAL_ID, {
      write: async () => {},
      clear: async () => {},
      exit: (code) => void exits.push(code),
      stepAsideDeps: { exit: (code) => void exits.push(code), sleep: (ms) => (slept.push(ms), new Promise<void>(() => {})) },
    });
    await until(() => slept.length > 0);
    expect(slept).toEqual([STEP_ASIDE_GRACE_MS]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /containers/${ORIGINAL_ID}/json`,
      `GET /containers/${HOSTNAME}/json`,
      `GET /containers/${HOSTNAME}/json`, // stepAside's own inspect of this container
      `POST /containers/${SELF_ID}/stop`,
    ]);
    expect(exits).toEqual([]);

    calls = [];
    stubDaemon(); // the standby's own policy is "no": a first attempt
    await takeOver(ORIGINAL_ID, {
      write: async () => {},
      clear: async () => {},
      exit: (code) => void exits.push(code),
      stepAside: async () => Promise.reject(new Error("must not step aside")),
    });
    expect(exits).toEqual([]);
    expect(calls.some((c) => c.method === "POST" && c.path === `/containers/${ORIGINAL_ID}/stop`)).toBe(true);
  });

  // #490 item 9: the cap is restored with the policy, for `on-failure` only.
  test("restores on-failure with its retry cap, and any other policy by name alone", async () => {
    const restored = async (policy: string, retries?: string) => {
      calls = [];
      process.env[HANDOFF_RESTART_POLICY_ENV] = policy;
      if (retries === undefined) delete process.env[HANDOFF_RESTART_RETRIES_ENV];
      else process.env[HANDOFF_RESTART_RETRIES_ENV] = retries;
      stubDaemon();
      await takeOver(ORIGINAL_ID, { write: async () => {}, clear: async () => {} });
      const call = calls.find((c) => c.method === "POST" && c.path === `/containers/${SELF_ID}/update`);
      return JSON.parse(call!.body!);
    };
    expect(await restored("on-failure", "5")).toEqual({ RestartPolicy: { Name: "on-failure", MaximumRetryCount: 5 } });
    // Mutation: passing the cap for every policy puts a MaximumRetryCount on this one.
    expect(await restored("unless-stopped", "5")).toEqual({ RestartPolicy: { Name: "unless-stopped" } });
    // Mutation: dropping the cap restores bare `on-failure`, which Docker reads as unlimited.
    for (const junk of [undefined, "0", "abc", "", "-2", "1.5"]) {
      expect(await restored("on-failure", junk), String(junk)).toEqual({ RestartPolicy: { Name: "on-failure" } });
    }
  });

  // THE guard for the whole hazard the ⚠️ section describes: a reorder that moved the restore back
  // to after the stop would pass every effects-injection test above (which only checks the ORDER
  // OF WHATEVER'S PASSED IN) but would be exactly the permanent-outage bug — this is what actually
  // pins the real HTTP call order.
  test("POST .../update (restore policy) precedes POST .../stop (retire the original)", async () => {
    stubDaemon();
    await takeOver(ORIGINAL_ID, {
      write: async () => {},
      clear: async () => {},
      exit: () => {
        throw new Error("must not exit on the happy path");
      },
    });
    const updateIdx = calls.findIndex((c) => c.method === "POST" && c.path === `/containers/${SELF_ID}/update`);
    const stopIdx = calls.findIndex((c) => c.method === "POST" && c.path === `/containers/${ORIGINAL_ID}/stop`);
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(updateIdx);
  });

  // A distinct value from the "unless-stopped" fallback on purpose — using the same value as the
  // fallback here would let a hardcoded fallback masquerade as a genuine env pass-through.
  test("restores the env-carried policy name onto self, distinct from the fallback value", async () => {
    process.env[HANDOFF_RESTART_POLICY_ENV] = "always";
    stubDaemon();
    await takeOver(ORIGINAL_ID, { write: async () => {}, clear: async () => {} });
    const updateCall = calls.find((c) => c.method === "POST" && c.path === `/containers/${SELF_ID}/update`);
    expect(updateCall?.body).toBeDefined();
    expect(JSON.parse(updateCall!.body!)).toEqual({ RestartPolicy: { Name: "always" } });
  });

  test("falls back to unless-stopped when HANDOFF_RESTART_POLICY is absent from the env", async () => {
    delete process.env[HANDOFF_RESTART_POLICY_ENV];
    stubDaemon();
    await takeOver(ORIGINAL_ID, { write: async () => {}, clear: async () => {} });
    const updateCall = calls.find((c) => c.method === "POST" && c.path === `/containers/${SELF_ID}/update`);
    expect(JSON.parse(updateCall!.body!)).toEqual({ RestartPolicy: { Name: "unless-stopped" } });
  });

  // A restore that fails at the DAEMON level (not just an injected-effect throw) must still block
  // the stop — proves the real default restorePolicy effect propagates a real HTTP failure rather
  // than swallowing it the way completeTakeOver's best-effort steps are allowed to.
  test("a real daemon failure on the update call blocks the stop from ever being attempted", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit & { unix?: string }) => {
      const method = init?.method ?? "GET";
      const { pathname } = new URL(String(url));
      calls.push({ path: pathname, method });
      if (pathname === `/containers/${HOSTNAME}/json`) return new Response(JSON.stringify(STANDBY), { status: 200 });
      if (pathname === `/containers/${ORIGINAL_ID}/json`) return new Response(JSON.stringify(runningOriginal), { status: 200 });
      if (pathname === `/containers/${SELF_ID}/update`) return new Response("daemon blip", { status: 500 });
      throw new Error(`unstubbed daemon call: ${method} ${pathname}`);
    }) as unknown as typeof fetch;
    const writes: HandoffMarker[] = [];
    const exits: number[] = [];
    let cleared = false;
    await takeOver(ORIGINAL_ID, {
      write: async (m) => void writes.push(m),
      clear: async () => void (cleared = true),
      exit: (code) => void exits.push(code),
    });
    expect(exits).toEqual([1]);
    expect(cleared).toBe(false);
    expect(writes.find((m) => m.status === "failed")?.error).toContain("500");
    expect(calls.some((c) => c.path === `/containers/${ORIGINAL_ID}/stop`)).toBe(false);
  });
});

// A retire against the same original can run more than once with nothing left alive to reclaim if
// it fails: since #548 the stopped-but-not-removed corpse is the NORMAL state between a login and the
// end of probation (retireOriginal only STOPS; completeTakeOver removes and renames afterwards), so a
// build that crashes in probation restarts as a standby and retries takeOver -> retireOriginal against
// it, and separately HANDOFF_FROM never clears from a swapped-in container's own env, so a boot path
// that still honors it against an id since fully removed lands here too. The stop has to tell a genuine
// first attempt (original still running — a failure must propagate, since the original is alive to
// reclaim) from both of those (already stopped, or already gone entirely — a failure is just a daemon
// hiccup re-confirming what's already true, and must degrade instead of crashing the sole live bot).
// In every case nothing here removes or renames: that is completeTakeOver's, tested below.
describe("retireOriginal", () => {
  const realFetch = globalThis.fetch;
  const HOSTNAME = SELF_SHORT_ID; // 12 hex, a prefix of SELF.Id: inspectSelf (#512) accepts it without reading mountinfo
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

  // #548: what a retire leaves behind is the STOPPED original -- no removal, no rename. Every case below
  // ends in this check (a regression that put the removal back into the stop would turn them all red).
  const touchedNothingButTheStop = () => {
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(calls.filter((c) => c.path.endsWith("/rename"))).toEqual([]);
  };

  test("a first attempt against a running original propagates a genuine stop failure", async () => {
    stubDaemon({
      inspectOriginal: () => new Response(JSON.stringify(runningOriginal), { status: 200 }),
      stopOriginal: () => new Response("daemon blip", { status: 500 }),
    });
    await expect(retireOriginal(ORIGINAL_ID)).rejects.toThrow(/500/);
    touchedNothingButTheStop();
  });

  test("a live original is stopped, and the stopped original is left alone: no DELETE, no rename (#548)", async () => {
    stubDaemon({
      inspectOriginal: () => new Response(JSON.stringify(runningOriginal), { status: 200 }),
      stopOriginal: () => new Response("", { status: 204 }),
    });
    await retireOriginal(ORIGINAL_ID);
    expect(calls.filter((c) => c.method === "POST" && c.path === `/containers/${ORIGINAL_ID}/stop`)).toHaveLength(1);
    touchedNothingButTheStop();
  });

  test("a retry against an already-stopped corpse tolerates a genuine stop failure and nothing more", async () => {
    stubDaemon({
      inspectOriginal: () => new Response(JSON.stringify(stoppedCorpse), { status: 200 }),
      stopOriginal: () => new Response("daemon blip", { status: 500 }),
    });
    await retireOriginal(ORIGINAL_ID); // must not throw
    touchedNothingButTheStop();
  });

  // The expected 304 (already stopped) is tolerated by stopContainer itself either way — pinning
  // this keeps the new branch from changing the ordinary retry's behavior.
  test("a retry that gets the expected 304 behaves the same as before this fix", async () => {
    stubDaemon({
      inspectOriginal: () => new Response(JSON.stringify(stoppedCorpse), { status: 200 }),
      stopOriginal: () => new Response("", { status: 304 }),
    });
    await retireOriginal(ORIGINAL_ID);
    touchedNothingButTheStop();
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
    touchedNothingButTheStop();
  });

  test("an original that no longer exists at all still returns cleanly on the expected 404", async () => {
    stubDaemon({
      inspectOriginal: () => new Response("not found", { status: 404 }),
      stopOriginal: () => new Response("not found", { status: 404 }),
    });
    await retireOriginal(ORIGINAL_ID); // must not throw
    touchedNothingButTheStop();
  });

  // #160: with the replacement's own RestartPolicy now "no" until takeOver restores it, a stop
  // that THROWS on the live branch is no longer necessarily a failed stop — #130's 60s bound means
  // a stop the daemon actually performed but answered slowly now looks identical to one that never
  // ran. These two tests are the mutation guard for the re-inspect that tells them apart; the
  // first-inspect result must stay "running" (that's what makes this the LIVE branch to begin
  // with) while the RE-inspect after the stop throws differs per test.
  test("a stop that answers late (throws) re-inspects and proceeds once the original is confirmed down", async () => {
    let inspectCallCount = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit & { unix?: string }) => {
      const method = init?.method ?? "GET";
      const { pathname } = new URL(String(url));
      calls.push({ path: pathname, method });
      if (pathname === `/containers/${ORIGINAL_ID}/json`) {
        inspectCallCount++;
        const state =
          inspectCallCount === 1
            ? { Running: true, Status: "running", ExitCode: 0 }
            : { Running: false, Status: "exited", ExitCode: 0 };
        return new Response(JSON.stringify({ ...runningOriginal, State: state }), { status: 200 });
      }
      if (pathname === `/containers/${ORIGINAL_ID}/stop`) return new Response("stop timed out", { status: 500 });
      if (pathname === `/containers/${ORIGINAL_ID}` && method === "DELETE") return new Response("", { status: 204 });
      if (pathname === `/containers/${HOSTNAME}/json`) return new Response(JSON.stringify(SELF), { status: 200 });
      if (pathname.endsWith("/rename")) return new Response("", { status: 204 });
      throw new Error(`unstubbed daemon call: ${method} ${pathname}`);
    }) as unknown as typeof fetch;
    await retireOriginal(ORIGINAL_ID); // must NOT throw — the late-stop re-inspect confirms it's down
    expect(inspectCallCount).toBeGreaterThanOrEqual(2); // proves the re-inspect actually ran, not a fluke
    touchedNothingButTheStop(); // it proceeds as the ordinary path does: the removal follows probation
  });

  test("a stop that throws while the original is STILL confirmed running rethrows — a genuine failure, not a slow one", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit & { unix?: string }) => {
      const method = init?.method ?? "GET";
      const { pathname } = new URL(String(url));
      calls.push({ path: pathname, method });
      // Every inspect — the first AND the re-inspect after the stop throws — says still running.
      if (pathname === `/containers/${ORIGINAL_ID}/json`) return new Response(JSON.stringify(runningOriginal), { status: 200 });
      if (pathname === `/containers/${ORIGINAL_ID}/stop`) return new Response("daemon blip", { status: 500 });
      throw new Error(`unstubbed daemon call: ${method} ${pathname}`);
    }) as unknown as typeof fetch;
    await expect(retireOriginal(ORIGINAL_ID)).rejects.toThrow(/500/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false); // never reached the remove step
  });
});

// #548: the swap's last step, run by the replacement once `activate()` has returned and the first tick has
// settled. The effects are injected here; the real HTTP verbs are the next describe's.
describe("completeTakeOver", () => {
  const ORIGINAL = "f".repeat(64);
  const corpse: ContainerInspect = {
    ...SELF,
    Id: ORIGINAL,
    Name: "/warbandeer-discord",
    State: { Running: false, Status: "exited", ExitCode: 0 },
  };
  const asideSentinel = new Error("stepped aside");
  const logged = { warn: [] as string[], error: [] as string[] };
  const real = { warn: console.warn, error: console.error, log: console.log };

  beforeEach(() => {
    logged.warn = [];
    logged.error = [];
    console.warn = (...a: unknown[]) => void logged.warn.push(a.join(" "));
    console.error = (...a: unknown[]) => void logged.error.push(a.join(" "));
    console.log = () => {};
  });
  afterEach(() => {
    console.warn = real.warn;
    console.error = real.error;
    console.log = real.log;
  });

  function effects(order: string[], o: Record<string, unknown> = {}) {
    return {
      inspect: async () => (order.push("inspect"), corpse as ContainerInspect | undefined),
      tagLatest: async () => void order.push("tag"),
      remove: async (id: string, force?: boolean) => void order.push(`remove:${id}:${force === undefined ? "plain" : force}`),
      rename: async (name: string) => void order.push(`rename:${name}`),
      stepAside: async (): Promise<never> => {
        order.push("aside");
        throw asideSentinel;
      },
      ...o,
    };
  }

  test("reads the name, tags :latest, removes the stopped original, takes its name — in that order, and never throws", async () => {
    const order: string[] = [];
    await completeTakeOver(ORIGINAL, effects(order));
    // The name is read BEFORE the removal (nothing can be read off a removed container), the tag lands before
    // the removal, and the rename names the canonical container (no leading slash).
    expect(order).toEqual(["inspect", "tag", `remove:${ORIGINAL}:plain`, "rename:warbandeer-discord"]);
    expect(logged.warn).toEqual([]);
    expect(logged.error).toEqual([]);
  });

  // The removal is NOT forced: an original the operator started during the tag call is refused by Docker (409)
  // instead of being killed and deleted, and the refusal makes this build step aside too.
  test("a refused removal that finds the original running again steps aside and renames nothing", async () => {
    const order: string[] = [];
    let inspects = 0;
    const running = { ...corpse, State: { Running: true, Status: "running", ExitCode: 0 } };
    await expect(
      completeTakeOver(
        ORIGINAL,
        effects(order, {
          inspect: async () => (order.push("inspect"), ++inspects === 1 ? corpse : running),
          remove: async () => {
            order.push("remove");
            throw new Error("409 conflict: You cannot remove a running container");
          },
        }),
      ),
    ).rejects.toBe(asideSentinel);
    // Mutation: dropping the second look leaves two live bots, with the name rename failing on the conflict.
    expect(order).toEqual(["inspect", "tag", "remove", "inspect", "aside"]);
  });

  test("a refused removal whose second look also fails is tolerated: the rename is still attempted, nothing throws", async () => {
    const order: string[] = [];
    let inspects = 0;
    await completeTakeOver(
      ORIGINAL,
      effects(order, {
        inspect: async () => {
          order.push("inspect");
          if (++inspects === 1) return corpse;
          throw new Error("daemon blip");
        },
        remove: async () => {
          order.push("remove");
          throw new Error("rm refused");
        },
      }),
    );
    // Mutation: dropping the `.catch` on the second look rejects the ClientReady handler and ends the process.
    expect(order).toEqual(["inspect", "tag", "remove", "inspect", "rename:warbandeer-discord"]);
  });

  // A SIGTERM starts the shutdown drain, which lets the first tick finish, so probation "ends" while this
  // container is being stopped -- `docker stop <name>-next` is the rollback recipe. Completing then would remove the original the operator is about to start.
  test("a process that is shutting down leaves the stopped original alone: no tag, no removal, no rename", async () => {
    const order: string[] = [];
    await completeTakeOver(ORIGINAL, effects(order, { shuttingDown: () => true }));
    expect(order).toEqual(["inspect"]); // read, so a rollback is still noticed first; nothing is changed
    expect(logged.warn).toEqual([]);
  });

  test("a shutdown that starts during the tag call stops the completion before the removal", async () => {
    const order: string[] = [];
    let down = false;
    await completeTakeOver(
      ORIGINAL,
      effects(order, {
        shuttingDown: () => down,
        tagLatest: async () => {
          order.push("tag");
          down = true;
        },
      }),
    );
    // Mutation: dropping the second check removes the original although this process is going down.
    expect(order).toEqual(["inspect", "tag"]);
  });

  test("a tagLatest failure still removes and renames, and is only logged", async () => {
    const order: string[] = [];
    await completeTakeOver(
      ORIGINAL,
      effects(order, {
        tagLatest: async () => {
          order.push("tag");
          throw new Error("daemon: tag conflict");
        },
      }),
    );
    expect(order).toEqual(["inspect", "tag", `remove:${ORIGINAL}:plain`, "rename:warbandeer-discord"]);
    expect(logged.error).toHaveLength(1);
    expect(logged.error[0]).toContain("tag conflict");
  });

  test("a removal failure still attempts the rename, and a rename failure is only logged", async () => {
    const order: string[] = [];
    await completeTakeOver(
      ORIGINAL,
      effects(order, {
        remove: async () => {
          order.push("remove");
          throw new Error("rm refused");
        },
        rename: async () => {
          order.push("rename");
          throw new Error("name in use");
        },
      }),
    );
    // (the second inspect is the look after a refused removal, which finds the original still stopped)
    expect(order).toEqual(["inspect", "tag", "remove", "inspect", "rename"]);
    expect(logged.warn).toHaveLength(2);
    expect(logged.warn[0]).toContain("rm refused");
    expect(logged.warn[1]).toContain("name in use");
  });

  test("an inspect failure keeps everything: no tag, no removal, no rename", async () => {
    const order: string[] = [];
    await completeTakeOver(
      ORIGINAL,
      effects(order, {
        inspect: async () => {
          order.push("inspect");
          throw new Error("daemon blip");
        },
      }),
    );
    // Without the inspect there is no telling whether the operator rolled back, and no name to rename to:
    // a later standby boot finds the corpse and runs this again.
    expect(order).toEqual(["inspect"]);
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0]).toContain("daemon blip");
  });

  test("a running original is a rollback: step aside before tagging, remove nothing", async () => {
    const order: string[] = [];
    const running = { ...corpse, State: { Running: true, Status: "running", ExitCode: 0 } };
    await expect(
      completeTakeOver(ORIGINAL, effects(order, { inspect: async () => (order.push("inspect"), running) })),
    ).rejects.toBe(asideSentinel);
    // `:latest` must not move onto a build the operator just rolled back from.
    expect(order).toEqual(["inspect", "aside"]);
    expect(logged.error).toHaveLength(1);
    expect(logged.error[0]).toContain("rolled back");
  });

  test("an original that is already gone: tag it, nothing to rename, the removal is harmless", async () => {
    const order: string[] = [];
    await completeTakeOver(ORIGINAL, effects(order, { inspect: async () => (order.push("inspect"), undefined) }));
    expect(order).toEqual(["inspect", "tag", `remove:${ORIGINAL}:plain`]);
    expect(logged.warn).toEqual([]);
  });
});

// #548, #490 items 5 and 7: the same step against the REAL HTTP verbs, through a stubbed fetch that records
// each call's URL -- the earlier retire tests answered every DELETE and rename with 204 and recorded only the
// path and method, so dropping `force=1`, the try/catch, the rename or the right name all stayed green.
describe("completeTakeOver — real daemon calls", () => {
  const realFetch = globalThis.fetch;
  const HOSTNAME = SELF_SHORT_ID; // 12 hex, a prefix of SELF.Id: inspectSelf (#512) accepts it without reading mountinfo
  const ORIGINAL_ID = "9".repeat(64);
  let calls: { path: string; method: string; url: string }[] = [];
  const stopped: ContainerInspect = {
    ...SELF,
    Id: ORIGINAL_ID,
    Name: "/warbandeer-discord",
    State: { Running: false, Status: "exited", ExitCode: 0 },
  };
  // This container as a post-#39 replacement really is: running a SHA tag, never `:latest` itself (the shared
  // SELF fixture says `:latest`, which would let a no-op retag of the image onto itself pass).
  const SELF_SHA_IMAGE = "warbandeer-discord-debug-bot:abc1234";
  const selfOnShaTag: ContainerInspect = { ...SELF, Config: { ...SELF.Config, Image: SELF_SHA_IMAGE } };
  const real = { warn: console.warn, error: console.error, log: console.log };
  let warns: string[] = [];

  beforeEach(() => {
    process.env.HOSTNAME = HOSTNAME;
    calls = [];
    warns = [];
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    console.error = () => {};
    console.log = () => {};
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.HOSTNAME;
    console.warn = real.warn;
    console.error = real.error;
    console.log = real.log;
  });

  function stubDaemon(o: { original?: () => Response; remove?: () => Response; rename?: () => Response } = {}) {
    globalThis.fetch = (async (url: string, init?: RequestInit & { unix?: string }) => {
      const method = init?.method ?? "GET";
      const { pathname } = new URL(String(url));
      calls.push({ path: pathname, method, url: String(url) });
      if (pathname === `/containers/${HOSTNAME}/json`) return new Response(JSON.stringify(selfOnShaTag), { status: 200 });
      if (pathname === `/containers/${ORIGINAL_ID}/json`) return (o.original ?? (() => new Response(JSON.stringify(stopped), { status: 200 })))();
      if (pathname === `/containers/${ORIGINAL_ID}` && method === "DELETE") return (o.remove ?? (() => new Response("", { status: 204 })))();
      if (pathname === `/containers/${SELF_ID}/stop`) return new Response("", { status: 204 });
      if (pathname.endsWith("/rename")) return (o.rename ?? (() => new Response("", { status: 204 })))();
      if (pathname.startsWith("/images/") && pathname.endsWith("/tag")) return new Response("", { status: 201 });
      throw new Error(`unstubbed daemon call: ${method} ${pathname}`);
    }) as unknown as typeof fetch;
  }
  const idx = (pred: (c: { path: string; method: string }) => boolean) => calls.findIndex(pred);
  const isDelete = (c: { path: string; method: string }) => c.method === "DELETE" && c.path === `/containers/${ORIGINAL_ID}`;
  const isRename = (c: { path: string; method: string }) => c.path.endsWith("/rename");
  const isTag = (c: { path: string; method: string }) => c.path.startsWith("/images/") && c.path.endsWith("/tag");

  test("the tag lands before the original's DELETE, the DELETE is NOT forced, and the rename names the canonical container", async () => {
    stubDaemon();
    await completeTakeOver(ORIGINAL_ID);
    const tag = idx(isTag);
    const del = idx(isDelete);
    const ren = idx(isRename);
    expect(tag).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(tag); // Mutation: tagging after the removal turns this red.
    expect(ren).toBeGreaterThan(del);
    // Mutation: forcing the removal (a started-meanwhile original would be killed and deleted instead of
    // refused with a 409); renaming to the inspected name with its leading slash.
    expect(new URL(calls[del]!.url).searchParams.get("force")).toBeNull();
    expect(calls[ren]!.path).toBe(`/containers/${SELF_ID}/rename`); // this container takes the name
    expect(new URL(calls[ren]!.url).searchParams.get("name")).toBe("warbandeer-discord");
    // The tag moves :latest onto this build's own image: the SOURCE is this container's sha tag (the path) and
    // the target is `<repo>:latest` (the query). Mutation: tagging the image onto itself leaves :latest behind.
    expect(calls[tag]!.path).toBe(`/images/${encodeURIComponent(SELF_SHA_IMAGE)}/tag`);
    const tagged = new URL(calls[tag]!.url);
    expect(tagged.searchParams.get("repo")).toBe("warbandeer-discord-debug-bot");
    expect(tagged.searchParams.get("tag")).toBe("latest");
  });

  test("a DELETE 500 on the stopped original still renames, and only warns", async () => {
    stubDaemon({ remove: () => new Response("busy", { status: 500 }) });
    await completeTakeOver(ORIGINAL_ID); // must not throw
    expect(idx(isRename)).toBeGreaterThanOrEqual(0);
    expect(warns.some((w) => w.includes("could not remove the stopped original"))).toBe(true);
  });

  test("a rename 409 is tolerated: one warning, no throw", async () => {
    stubDaemon({ rename: () => new Response("name already in use", { status: 409 }) });
    await completeTakeOver(ORIGINAL_ID); // must not throw
    expect(warns.filter((w) => w.includes("could not take the name"))).toHaveLength(1);
  });

  test("an original already gone (404) means no rename and no throw; the tag still lands", async () => {
    stubDaemon({ original: () => new Response("not found", { status: 404 }) });
    await completeTakeOver(ORIGINAL_ID);
    expect(idx(isTag)).toBeGreaterThanOrEqual(0);
    expect(calls.filter(isRename)).toEqual([]);
  });

  // The DEFAULT stepAside, with only its exit and grace wait injected: the grace never ends here, so the call
  // never returns -- like the real one, which ends in the daemon's SIGTERM or an exit. Mutation: a default that
  // does nothing (or a stepAside whose stop is a no-op) leaves no POST .../stop on this container.
  test("an original that is running again is left alone: no tag, no DELETE, no rename, and this container stops itself", async () => {
    stubDaemon({ original: () => new Response(JSON.stringify({ ...stopped, State: { Running: true, Status: "running", ExitCode: 0 } }), { status: 200 }) });
    const exits: number[] = [];
    const slept: number[] = [];
    void completeTakeOver(ORIGINAL_ID, {
      stepAsideDeps: { exit: (c) => void exits.push(c), sleep: (ms) => (slept.push(ms), new Promise<void>(() => {})) },
    });
    await until(() => slept.length > 0);
    // Mutation: a default that drops `stepAsideDeps` leaves the real grace wait and `process.exit(1)` armed.
    expect(slept).toEqual([STEP_ASIDE_GRACE_MS]);
    expect(calls.filter((c) => c.method === "POST" && c.path === `/containers/${SELF_ID}/stop`)).toHaveLength(1);
    expect(calls.filter(isTag)).toEqual([]);
    expect(calls.filter(isDelete)).toEqual([]);
    expect(calls.filter(isRename)).toEqual([]);
    expect(exits).toEqual([]); // the daemon's SIGTERM, not an exit, ends it while the grace wait is pending
  });

  // The DEFAULT shutdown check (restart.ts's isShuttingDown): `docker stop <name>-next` is the rollback recipe, and
  // its SIGTERM starts a drain in which the first tick can settle, so probation looks over while this
  // container is on its way out.
  test("after a SIGTERM the default completion leaves the original alone: no tag, no DELETE, no rename", async () => {
    stubDaemon();
    beginShutdown("test SIGTERM");
    try {
      await finishProbation(ORIGINAL_ID, Promise.resolve(), { sleep: () => new Promise<void>(() => {}) });
    } finally {
      resetForTest();
    }
    expect(calls.filter(isTag)).toEqual([]);
    expect(calls.filter(isDelete)).toEqual([]);
    expect(calls.filter(isRename)).toEqual([]);
  });

  // The link finishProbation -> completeTakeOver, through the DEFAULT `complete`: mutation, a no-op default means
  // nothing ever completes the swap in production.
  test("finishProbation completes the swap with the real completeTakeOver by default", async () => {
    stubDaemon();
    await finishProbation(ORIGINAL_ID, Promise.resolve(), { sleep: () => new Promise<void>(() => {}) });
    expect(idx(isTag)).toBeGreaterThanOrEqual(0);
    expect(idx(isDelete)).toBeGreaterThan(idx(isTag));
    expect(idx(isRename)).toBeGreaterThan(idx(isDelete));
  });
});

// #548: probation's end. A first tick can contain a 15-minute build, so the wait is capped.
describe("finishProbation", () => {
  const real = { log: console.log };
  let said: string[] = [];
  beforeEach(() => {
    said = [];
    console.log = (...a: unknown[]) => void said.push(a.join(" "));
  });
  afterEach(() => {
    console.log = real.log;
  });

  test("waits for the first tick, then completes", async () => {
    let settle!: () => void;
    const firstTick = new Promise<void>((resolve) => (settle = resolve));
    const completed: string[] = [];
    const done = finishProbation("orig", firstTick, { capMs: 60_000, sleep: () => new Promise<void>(() => {}), complete: async (id) => void completed.push(id) });
    await Bun.sleep(10);
    // Mutation: dropping the await on the race (or racing nothing) completes while the tick is still pending.
    expect(completed).toEqual([]);
    settle();
    await done;
    expect(completed).toEqual(["orig"]);
    expect(said.some((l) => l.includes("first tick settled"))).toBe(true);
  });

  // The production call passes no options, so the default cap IS the 60 s the README, the ADR and the state table quote.
  test("the default cap is 60 seconds", async () => {
    let asked = -1;
    await finishProbation("orig", Promise.resolve(), {
      sleep: (ms) => ((asked = ms), new Promise<void>(() => {})),
      complete: async () => {},
    });
    expect(asked).toBe(FIRST_TICK_CAP_MS);
    expect(FIRST_TICK_CAP_MS).toBe(60_000);
  });

  test("a first tick that never settles is capped", async () => {
    const completed: string[] = [];
    const started = Date.now();
    await finishProbation("orig", new Promise<void>(() => {}), { capMs: 20, complete: async (id) => void completed.push(id) });
    expect(completed).toEqual(["orig"]);
    expect(Date.now() - started).toBeLessThan(500);
    expect(said.some((l) => l.includes("first tick capped"))).toBe(true);
  });

  test("a first tick that rejects still ends probation (it ran), and finishProbation does not throw", async () => {
    const completed: string[] = [];
    await finishProbation("orig", Promise.reject(new Error("tick blew up")), { capMs: 60_000, sleep: () => new Promise<void>(() => {}), complete: async (id) => void completed.push(id) });
    expect(completed).toEqual(["orig"]);
  });
});

// #548: at a standby boot, is the original RUNNING although this container has taken over before?
describe("detectRollback", () => {
  // A standby made by code that carries the original's policy (#160) has HANDOFF_RESTART_POLICY in its env.
  const ENV = { [HANDOFF_FROM_ENV]: "orig", [HANDOFF_RESTART_POLICY_ENV]: "unless-stopped" };
  const running = { ...SELF, State: { Running: true, Status: "running", ExitCode: 0 } };
  const stopped = { ...SELF, State: { Running: false, Status: "exited", ExitCode: 0 } };
  const selfWith = (Name?: string): ContainerInspect => ({ ...SELF, HostConfig: { ...SELF.HostConfig, RestartPolicy: Name === undefined ? undefined : { Name } } });
  const real = { warn: console.warn };
  let warns: string[] = [];
  beforeEach(() => {
    warns = [];
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  });
  afterEach(() => {
    console.warn = real.warn;
  });

  test("a running original and an own policy other than no is a rollback", async () => {
    for (const own of ["unless-stopped", "always", "on-failure"]) {
      expect(await detectRollback(ENV, { inspect: async () => running, inspectSelf: async () => selfWith(own) }), own).toBe(true);
    }
  });

  test("a first attempt (own policy no, or empty) is never a rollback, however the original looks", async () => {
    // Mutation: dropping the own-policy check makes a swap in flight step aside.
    expect(await detectRollback(ENV, { inspect: async () => running, inspectSelf: async () => selfWith("no") })).toBe(false);
    expect(await detectRollback(ENV, { inspect: async () => running, inspectSelf: async () => selfWith("") })).toBe(false);
    expect(await detectRollback(ENV, { inspect: async () => running, inspectSelf: async () => selfWith(undefined) })).toBe(false);
    // A stopped original never needs this container's own policy looked up.
    let selfCalls = 0;
    expect(await detectRollback(ENV, { inspect: async () => stopped, inspectSelf: async () => (selfCalls++, selfWith("always")) })).toBe(false);
    expect(selfCalls).toBe(0);
  });

  test("a stopped or gone original is not a rollback; a failing or hanging inspect is not either", async () => {
    expect(await detectRollback(ENV, { inspect: async () => undefined, inspectSelf: async () => selfWith("always") })).toBe(false);
    expect(
      await detectRollback(ENV, {
        inspect: async () => {
          throw new Error("daemon blip");
        },
        inspectSelf: async () => selfWith("always"),
      }),
    ).toBe(false);
    expect(warns).toHaveLength(1);
    expect(await detectRollback(ENV, { inspect: () => new Promise<never>(() => {}), inspectSelf: async () => selfWith("always") }, 20)).toBe(false);
  });

  // A standby created by an original from before #160 had the original's own policy from the start and carries no
  // HANDOFF_RESTART_POLICY, so "own policy is not no" says nothing about it: never a rollback, no daemon call.
  test("a standby without HANDOFF_RESTART_POLICY (made before #160) is never a rollback and never touches the daemon", async () => {
    let calls = 0;
    const count = async () => (calls++, running);
    expect(await detectRollback({ [HANDOFF_FROM_ENV]: "orig" }, { inspect: count, inspectSelf: async () => (calls++, selfWith("unless-stopped")) })).toBe(false);
    expect(calls).toBe(0);
  });

  // The DEFAULT inspects, through the real HTTP verbs: mutation, a default inspect that always says "gone" is never a rollback.
  test("with the default inspects: a running original and a restored own policy is a rollback; a fresh standby is not", async () => {
    const realFetch = globalThis.fetch;
    const realHostname = process.env.HOSTNAME;
    process.env.HOSTNAME = SELF_SHORT_ID; // 12 hex, a prefix of SELF.Id: inspectSelf (#512) accepts it without reading mountinfo
    const seen: string[] = [];
    const daemon = (ownPolicy: string) =>
      (globalThis.fetch = (async (url: string) => {
        const { pathname } = new URL(String(url));
        seen.push(pathname);
        if (pathname === "/containers/orig/json") return new Response(JSON.stringify(running), { status: 200 });
        if (pathname === `/containers/${SELF_SHORT_ID}/json`) return new Response(JSON.stringify(selfWith(ownPolicy)), { status: 200 });
        throw new Error(`unstubbed daemon call: ${pathname}`);
      }) as unknown as typeof fetch);
    try {
      daemon("unless-stopped");
      expect(await detectRollback(ENV)).toBe(true);
      expect(seen).toEqual(["/containers/orig/json", `/containers/${SELF_SHORT_ID}/json`]);
      daemon("no");
      expect(await detectRollback(ENV)).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
      if (realHostname === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = realHostname;
    }
  });

  test("no HANDOFF_FROM never touches the daemon", async () => {
    let calls = 0;
    const inspect = async () => (calls++, running);
    expect(await detectRollback({}, { inspect, inspectSelf: async () => selfWith("always") })).toBe(false);
    expect(await detectRollback({ [HANDOFF_FROM_ENV]: "" }, { inspect, inspectSelf: async () => selfWith("always") })).toBe(false);
    expect(calls).toBe(0);
  });
});

// #548: the replacement stops ITSELF through the daemon, so the stop is explicit (exempt from unless-stopped) and
// the container stays down; the SIGTERM it then receives drains through index.ts's shutdown handler.
describe("stepAside", () => {
  const real = { error: console.error };
  let errors: string[] = [];
  beforeEach(() => {
    errors = [];
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  });
  afterEach(() => {
    console.error = real.error;
  });

  test("stops its own id through the daemon, and exits 1 only if no signal arrives", async () => {
    const stopped: string[] = [];
    const exits: number[] = [];
    // The stop goes out and the grace wait is pending: no exit yet.
    void stepAside({ inspectSelf: async () => SELF, stop: async (id) => void stopped.push(id), exit: (c) => void exits.push(c), sleep: () => new Promise<void>(() => {}) });
    await until(() => stopped.length > 0);
    expect(stopped).toEqual([SELF_ID]);
    expect(exits).toEqual([]);
    // With the grace elapsed and no SIGTERM, it gives up and exits 1.
    void stepAside({ inspectSelf: async () => SELF, stop: async () => {}, exit: (c) => void exits.push(c), sleep: async () => {} });
    await until(() => exits.length > 0);
    expect(exits).toEqual([1]);
  });

  // The DEFAULT inspectSelf and stop, through the real HTTP verbs (mutation: a no-op default stop never stops the
  // replacement), and the grace the docs quote.
  test("by default it asks the daemon to stop this container, and waits out the 30 s grace before exiting", async () => {
    const realFetch = globalThis.fetch;
    const realHostname = process.env.HOSTNAME;
    process.env.HOSTNAME = SELF_SHORT_ID; // 12 hex, a prefix of SELF.Id: inspectSelf (#512) accepts it without reading mountinfo
    const seen: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const { pathname } = new URL(String(url));
      seen.push(`${init?.method ?? "GET"} ${pathname}`);
      if (pathname === `/containers/${SELF_SHORT_ID}/json`) return new Response(JSON.stringify(SELF), { status: 200 });
      if (pathname === `/containers/${SELF_ID}/stop`) return new Response("", { status: 204 });
      throw new Error(`unstubbed daemon call: ${pathname}`);
    }) as unknown as typeof fetch;
    const exits: number[] = [];
    let graceAsked = -1;
    try {
      void stepAside({ exit: (c) => void exits.push(c), sleep: (ms) => ((graceAsked = ms), new Promise<void>(() => {})) });
      await until(() => graceAsked >= 0);
      expect(seen).toEqual([`GET /containers/${SELF_SHORT_ID}/json`, `POST /containers/${SELF_ID}/stop`]);
      expect(graceAsked).toBe(STEP_ASIDE_GRACE_MS);
      expect(STEP_ASIDE_GRACE_MS).toBe(30_000);
      expect(exits).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      if (realHostname === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = realHostname;
    }
  });

  test("a stop that fails exits 1 at once, without waiting out the grace", async () => {
    const exits: number[] = [];
    let slept = false;
    void stepAside({
      inspectSelf: async () => SELF,
      stop: async () => {
        throw new Error("daemon down");
      },
      exit: (c) => void exits.push(c),
      sleep: async () => void (slept = true),
    });
    await until(() => exits.length > 0);
    expect(exits).toEqual([1]);
    expect(slept).toBe(false);
    expect(errors).toHaveLength(2); // the "stepping aside" line, then why it exits instead
  });
});

// #37: a daemon error anywhere from "replacement started" onward must still reach `endHandoff()`
// — otherwise the bot stays quiesced forever (scheduler stopped, every `/update` answers "busy").
// Drives `redeploy()` end-to-end through a stubbed `globalThis.fetch`, in the style of
// docker.test.ts/update.test.ts, rather than mocking the docker/handoff modules directly.
describe("redeploy — cleanup always runs", () => {
  const realFetch = globalThis.fetch;
  const HOSTNAME = SELF_SHORT_ID; // 12 hex, a prefix of SELF.Id: inspectSelf (#512) accepts it without reading mountinfo
  const REPLACEMENT_ID = "c".repeat(64);
  const LEFTOVER_ID = "d".repeat(64);
  let calls: { path: string; method: string; url: string; body?: string }[] = [];
  // `restartPending()` sampled at the moment of each daemon call the fix's timing hinges on.
  let pendingAt: Record<string, boolean> = {};
  // #492 item 15: set by any stop or removal of THIS container's own id. `redeploy()` never does either; the
  // `afterEach` below asserts it for every test here, so a self-removal the stub's `DELETE` catch-all would
  // absorb (or a self-stop only the "unstubbed" throw would catch) fails the test that made it.
  let touchedSelf = false;

  beforeEach(async () => {
    process.env.HOSTNAME = HOSTNAME;
    calls = [];
    pendingAt = {};
    touchedSelf = false;
    resetForTest();
    await clearMarker();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    delete process.env.HOSTNAME;
    resetForTest();
    await clearMarker();
    // LAST on purpose: a failing assertion placed first would skip the restores above and leak into the next test.
    expect(touchedSelf).toBe(false);
  });

  const jsonRes = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  /**
   * Wires every daemon call redeploy() makes through "replacement started" (self-inspect, build,
   * prune, leftover-cleanup, create, start) to a happy response, and lets each test steer only
   * the two calls the fix touches: the handoff poll, and the final removal of the replacement.
   */
  function stubDaemon(o: {
    pollReplacement: () => Response | Promise<Response>;
    removeReplacement: () => Response;
    /** Runs (awaited) when the replacement is started — before `awaitHandoff` ever polls, so a
     *  marker written here is guaranteed on disk for the very first poll to see. Used by the
     *  item-3 retirement-wait tests to reach a `ready` outcome deterministically, with no reliance
     *  on POLL_MS timing. */
    afterStart?: () => Promise<void>;
    /** The old image's own baked env, returned by the `GET /images/<id>/json` inspect — lets a
     *  test drive item 7's actual drop logic through the real redeploy() flow. Defaults to empty
     *  (carries everything, i.e. no drop), matching every test that isn't specifically about it. */
    oldImageEnv?: string[];
    /** Makes the `GET /images/<id>/json` inspect itself fail, to drive `redeploy()`'s
     *  `.catch(() => [])` degradation path (best-effort, same "never fail a good deploy over
     *  housekeeping" rule as pruneOldImages). */
    imageInspectFails?: boolean;
    /** Makes `POST /containers/{id}/start` fail after `create` already succeeded, to drive the
     *  cleanup-on-failure path so a failed start doesn't leak the replacement container. */
    startFails?: boolean;
    /** Makes `POST /build` come back with an error line in its stream (a 200 that failed —
     *  parseBuildOutput's whole reason for being), to drive redeploy()'s `!built.ok` branch. */
    buildFails?: boolean;
    /** Makes `POST /containers/create` abort the way docker.ts's timeout bound does — the daemon
     *  may still have created the container, but redeploy() never learns its id (#130). */
    createTimesOut?: boolean;
    /** Makes the hostname lookup `inspectSelf()` tries first answer 500, so `redeploy()` fails at its very
     *  first daemon call (the mountinfo fallback then fails too: absent off Linux, no container id on it). */
    selfInspectFails?: boolean;
    /** What `redeploy()` is running as (default `SELF`): a bot named `<name>-next` is refused (#547). */
    self?: ContainerInspect;
    /** The answer to the post-build inspect of the replacement's name (#492): default a 404, nothing holds it. */
    leftover?: () => Response;
    /** The answer to the un-forced removal of that leftover by id (default 204). */
    leftoverDelete?: () => Response;
  }) {
    globalThis.fetch = (async (url: string, init?: RequestInit & { unix?: string }) => {
      const method = init?.method ?? "GET";
      const { pathname } = new URL(String(url));
      calls.push({ path: pathname, method, url: String(url), body: init?.body ? String(init.body) : undefined });

      if (
        (method === "POST" && (pathname === `/containers/${SELF_ID}/stop` || pathname === `/containers/${HOSTNAME}/stop`)) ||
        (method === "DELETE" && (pathname === `/containers/${SELF_ID}` || pathname === `/containers/${HOSTNAME}`))
      ) {
        touchedSelf = true;
      }
      if (pathname === `/containers/${HOSTNAME}/json`) {
        return o.selfInspectFails ? new Response("boom", { status: 500 }) : jsonRes(o.self ?? SELF);
      }
      if (pathname === `/containers/${replacementName(SELF.Name)}/json`) {
        return o.leftover ? o.leftover() : new Response("", { status: 404 });
      }
      if (pathname === `/containers/${LEFTOVER_ID}` && method === "DELETE") {
        pendingAt.sweep = restartPending();
        return o.leftoverDelete ? o.leftoverDelete() : new Response("", { status: 204 });
      }
      if (pathname === "/build") {
        pendingAt.build = restartPending();
        if (o.buildFails) {
          return new Response('{"error":"boom","errorDetail":{"message":"boom"}}', { status: 200 });
        }
        return new Response('{"stream":"done"}', { status: 200 });
      }
      if (pathname === "/images/json") return jsonRes([]);
      if (pathname.startsWith("/images/") && pathname.endsWith("/json")) {
        if (o.imageInspectFails) return new Response("boom", { status: 500 });
        return jsonRes({ Config: { Env: o.oldImageEnv ?? [] } });
      }
      if (pathname === "/containers/create") {
        pendingAt.create = restartPending();
        // The daemon created it but never answered in time — the abort surfaces as a rejection
        // with no id, exactly as docker.ts's `bounded` produces it.
        if (o.createTimesOut) throw new Error("docker create warbandeer-discord-next timed out after 60000ms");
        return jsonRes({ Id: REPLACEMENT_ID });
      }
      if (pathname === `/containers/${REPLACEMENT_ID}/start`) {
        if (o.startFails) return new Response("boom", { status: 500 });
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

  // #130: beginHandoff moved past the build. The scheduler must stay live through the build (it
  // writes no state, and is the one long, now-timeout-bounded call) and only quiesce for the
  // create→verify window, where the replacement shares the state volume.
  test("the scheduler keeps running through the build and only quiesces for create→verify", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("", { status: 404 }),
    });
    await redeploy("a".repeat(40));
    expect(pendingAt.build).toBe(false); // build ran with the scheduler live
    expect(pendingAt.create).toBe(true); // quiesced by the time the replacement is created
    expect(handoffActive()).toBe(false); // and resumed on the failed outcome
  });

  // #130: a build that fails (or, in production, hangs until its timeout aborts it) must leave the
  // scheduler untouched — beginHandoff never ran, so there is nothing to resume and announcements
  // never stopped.
  test("a failed build leaves the scheduler un-quiesced — beginHandoff never ran", async () => {
    stubDaemon({
      pollReplacement: () => {
        throw new Error("must not poll — redeploy() returns on the failed build");
      },
      removeReplacement: () => new Response("", { status: 404 }),
      buildFails: true,
    });
    const result = await redeploy("b".repeat(40));
    expect(result.error).toContain("build failed");
    expect(pendingAt.build).toBe(false);
    expect(restartPending()).toBe(false);
    expect(handoffActive()).toBe(false);
    expect(pendingAt.create).toBeUndefined(); // never reached create
  });

  // #130: createContainer is timeout-bounded now, so it can abort while the daemon goes on to
  // create the container anyway. redeploy() never learns the id, so an id-only cleanup would skip
  // the orphan — and a lingering `<name>-next` (`created`; an exited one no longer blocks
  // the guard since #490) reads to bot-ops.sh as "a swap is still in
  // progress", refusing restart/env-set until some later redeploy's leftover sweep runs, which the
  // anti-loop suppression can defer indefinitely for the same sha. Cleanup must fall back to the
  // NAME. Before the fix this test saw only the pre-create sweep, never a cleanup removal.
  test("a create that times out removes the name it may have orphaned, by name and NOT forced", async () => {
    stubDaemon({
      pollReplacement: () => {
        throw new Error("must not poll — redeploy() returns on the failed create");
      },
      removeReplacement: () => new Response("", { status: 204 }),
      createTimesOut: true,
    });
    const result = await redeploy("8".repeat(40));
    expect(result.error).toContain("could not start the replacement");
    expect(result.error).toContain("timed out");
    // ONE DELETE against the NAME, the post-failure cleanup: with no leftover seen there is no pre-create sweep.
    const byName = calls.filter(
      (c) => c.method === "DELETE" && c.path === `/containers/${replacementName(SELF.Name)}`,
    );
    expect(byName.length).toBe(1);
    // NOT forced (#492): with no id the container was never started by us (createContainer is the call that
    // timed out), so the orphan is `created` and a plain DELETE removes it. A RUNNING container that holds
    // the name is someone else's, started during the build, and Docker's 409 refuses to remove it.
    for (const c of byName) expect(new URL(c.url).searchParams.get("force")).toBeNull();
    expect(handoffActive()).toBe(false);
  });

  // The other half of that rule, #130's: WITH an id the start may have taken effect, and a plain DELETE of a
  // running container is a 409 that would leave a second live bot, so the by-id cleanup is forced.
  test("a start that fails removes the created replacement by id, forcibly", async () => {
    stubDaemon({
      pollReplacement: () => {
        throw new Error("must not poll — redeploy() returns on the failed start");
      },
      removeReplacement: () => new Response("", { status: 204 }),
      startFails: true,
    });
    await redeploy("7".repeat(40));
    const cleanup = calls.filter((c) => c.method === "DELETE" && c.path === `/containers/${REPLACEMENT_ID}`);
    expect(cleanup).toHaveLength(1);
    expect(new URL(cleanup[0]!.url).searchParams.get("force")).toBe("1");
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/containers/${replacementName(SELF.Name)}`)).toBe(false);
  });

  // #547/#492: `-next` is reserved for the replacement. A bot that is itself `<name>-next` is refused on its
  // name alone, before anything is built, so it can never sweep or create under its own name.
  test("a bot named -next refuses before the build, on its name alone, and says docker restart heals it", async () => {
    stubDaemon({
      self: { ...SELF, Name: "/warbandeer-discord-next" },
      pollReplacement: () => {
        throw new Error("must not poll");
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    process.env[HANDOFF_FROM_ENV] = SELF_ID;
    try {
      const result = await redeploy("1".repeat(40));
      expect(result.replacement).toBe("none");
      expect(result.outcome).toBeUndefined();
      expect(result.error).toContain("docker restart warbandeer-discord-next");
      expect(result.error).toContain("run /update again");
      expect(result.error).toContain("still named warbandeer-discord-next");
    } finally {
      delete process.env[HANDOFF_FROM_ENV];
    }
    // The self-inspect and nothing else: no build, no inspect of any name, no removal.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /containers/${HOSTNAME}/json`]);
    expect(restartPending()).toBe(false);
    expect(handoffActive()).toBe(false);
  });

  test("a compose-created bot named -next is told to rename it, not to restart", async () => {
    stubDaemon({
      self: { ...SELF, Name: "/warbandeer-discord-next" },
      pollReplacement: () => {
        throw new Error("must not poll");
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    delete process.env[HANDOFF_FROM_ENV];
    const result = await redeploy("1".repeat(40));
    expect(result.replacement).toBe("none");
    expect(result.error).toContain("container_name");
    expect(result.error).not.toContain("docker restart");
    expect(calls.some((c) => c.path === "/build")).toBe(false);
  });

  // #492: whatever holds the replacement's name is inspected after the build, outside the quiesce.
  test("a running holder of <name>-next after the build is refused before anything is quiesced or created", async () => {
    stubDaemon({
      leftover: () =>
        jsonRes({ ...SELF, Id: "f".repeat(64), Name: "/warbandeer-discord-next", State: { Running: true, Status: "running", ExitCode: 0 } }),
      pollReplacement: () => {
        throw new Error("must not poll");
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("2".repeat(40));
    expect(result.replacement).toBe("none");
    expect(result.error).toContain("a running container already holds warbandeer-discord-next");
    expect(calls.some((c) => c.path === "/build")).toBe(true); // after the build: a holder that appeared in it is seen
    expect(calls.some((c) => c.path === "/containers/create")).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(pendingAt.create).toBeUndefined();
    expect(restartPending()).toBe(false);
    expect(handoffActive()).toBe(false);
  });

  test("a stopped leftover is removed by id, un-forced, after the quiesce begins and before the create", async () => {
    stubDaemon({
      leftover: () =>
        jsonRes({ ...SELF, Id: LEFTOVER_ID, Name: "/warbandeer-discord-next", State: { Running: false, Status: "exited", ExitCode: 1 } }),
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("", { status: 404 }),
    });
    await redeploy("3".repeat(40));
    const at = (pred: (c: (typeof calls)[number]) => boolean) => calls.findIndex(pred);
    const build = at((c) => c.path === "/build");
    const inspect = at((c) => c.method === "GET" && c.path === "/containers/warbandeer-discord-next/json");
    const sweep = at((c) => c.method === "DELETE" && c.path === `/containers/${LEFTOVER_ID}`);
    const create = at((c) => c.path === "/containers/create");
    expect(build).toBeGreaterThan(-1);
    expect(inspect).toBeGreaterThan(build);
    expect(sweep).toBeGreaterThan(inspect);
    expect(create).toBeGreaterThan(sweep);
    expect(new URL(calls[sweep]!.url).searchParams.get("force")).toBeNull();
    expect(pendingAt.sweep).toBe(true); // inside the quiesce, like the create
    // never by name
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/containers/${replacementName(SELF.Name)}`)).toBe(false);
  });

  test("no leftover means no removal before the create", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("", { status: 404 }),
    });
    await redeploy("4".repeat(40));
    const create = calls.findIndex((c) => c.path === "/containers/create");
    expect(create).toBeGreaterThan(-1);
    expect(calls.slice(0, create).some((c) => c.method === "DELETE")).toBe(false);
  });

  test("a leftover inspect that errors ends the redeploy before the quiesce, with the reason", async () => {
    stubDaemon({
      leftover: () => new Response("boom", { status: 500 }),
      pollReplacement: () => {
        throw new Error("must not poll");
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("5".repeat(40));
    expect(result.error).toContain("could not check for a leftover warbandeer-discord-next");
    expect(result.replacement).toBe("none");
    expect(calls.some((c) => c.path === "/containers/create")).toBe(false);
    expect(restartPending()).toBe(false);
  });

  // The window between the inspect and the sweep: a stopped leftover that someone starts in it is a 409 on the
  // un-forced removal, reported as a failure to start, and never force-removed, by id or by name.
  test("a leftover started between the inspect and the sweep is a reported failure, not a kill", async () => {
    stubDaemon({
      leftover: () =>
        jsonRes({ ...SELF, Id: LEFTOVER_ID, Name: "/warbandeer-discord-next", State: { Running: false, Status: "exited", ExitCode: 1 } }),
      leftoverDelete: () => new Response("conflict: cannot remove a running container", { status: 409 }),
      pollReplacement: () => {
        throw new Error("must not poll");
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("6".repeat(40));
    expect(result.error).toContain("could not start the replacement");
    expect(result.error).toContain("409");
    expect(calls.some((c) => c.path === "/containers/create")).toBe(false);
    for (const c of calls.filter((c) => c.method === "DELETE")) expect(new URL(c.url).searchParams.get("force")).toBeNull();
    expect(handoffActive()).toBe(false);
  });

  // The crux of #37's fix was that a rejection from `tryInspectContainer` mid-poll (a dropped socket,
  // one 500) must not skip `endHandoff()`. Since #433 it is stronger: a failed inspect is not a verdict
  // at all. The poll goes on with the replacement's state unknown, and the next answer decides.
  // The verdict here is the second poll's `exited`; the third answer is the pre-removal inspect. Its
  // StartedAt sits after the pre-poll sample (so a guard left comparing against that sample, or epoch 0,
  // would read it as a later life and skip the removal, #431) but before the deciding poll's own
  // observation (so the guard rightly sees the same life and removes).
  test("a single failed inspect mid-poll is tolerated — the next poll decides, the 500 is not the verdict, and the verdict's own time is what the guard uses", async () => {
    let pollCount = 0;
    let t1 = 0;
    stubDaemon({
      pollReplacement: () => {
        pollCount++;
        if (pollCount === 1) {
          t1 = Date.now();
          return new Response("boom", { status: 500 });
        }
        if (pollCount === 2) return jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } });
        return jsonRes({
          ...SELF,
          State: { Running: true, Status: "running", ExitCode: 0, StartedAt: new Date(t1 + 5).toISOString() },
        });
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("a".repeat(40), { pollMs: 30 });
    expect(result.outcome).toBe("failed");
    expect(result.error).toBeUndefined(); // the 500 did not become the verdict
    expect(pollCount).toBe(3); // the failed poll, the deciding poll, the pre-removal inspect
    expect(wasRemovalAttempted()).toBe(true);
    expect(result.replacement).toBe("removed");
    expect(handoffActive()).toBe(false);
  });

  // The cost of that, pinned: a daemon that answers every poll with an error holds the original for the
  // whole handoff deadline, and the deadline still ends it — with the last error named, not a false
  // "failed" — instead of the first 500 aborting a swap that may be healthy.
  test("every poll failing until the handoff deadline is a timeout that names the last error; the handoff ends and the replacement is removed", async () => {
    stubDaemon({
      pollReplacement: () => new Response("boom", { status: 500 }),
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const startedAt = Date.now();
    const result = await redeploy("a".repeat(40), { handoffDeadlineMs: 50, pollMs: 10 });
    expect(result.outcome).toBe("timeout");
    expect(result.error).toContain("500");
    expect(wasRemovalAttempted()).toBe(true); // the guard's own inspect also fails and "proceeds as usual"
    expect(handoffActive()).toBe(false);
    // Both seams reach the poll: a 50 ms deadline polled every 10 ms ends in well under the real 2 s poll
    // interval, which a poll that ignored `pollMs` would need to see even one deadline check.
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  test("an error the daemon recovered from is not blamed for a timeout", async () => {
    let pollCount = 0;
    stubDaemon({
      pollReplacement: () => {
        pollCount++;
        if (pollCount === 1) return new Response("boom", { status: 500 });
        return jsonRes(SELF); // running, never signalling
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    // 300 ms, not tighter: the first (failing) poll must finish well inside the deadline, or it would itself be
    // the timeout and carry its error on a loaded CI box.
    const result = await redeploy("a".repeat(40), { handoffDeadlineMs: 300, pollMs: 10 });
    expect(result.outcome).toBe("timeout");
    expect(result.error).toBeUndefined();
  });

  // #433: the marker is read before the inspect in every poll, and a `ready` it holds decides that very
  // poll. Counting the GETs is the assertion: with the marker ignored on a failed inspect the poll would
  // wait out the whole deadline (and the late re-read would rescue the outcome after ~13 more polls),
  // so a count past 2 means this poll did not decide.
  test("a ready marker decides in the same poll as a failed inspect — one poll, not a wait for the deadline", async () => {
    stubDaemon({
      pollReplacement: () => new Response("boom", { status: 500 }),
      removeReplacement: () => new Response("", { status: 204 }),
      afterStart: () => writeMarker({ status: "ready", sha: "3333333", at: Date.now() }),
    });
    const result = await redeploy("a".repeat(40), { handoffDeadlineMs: 200, deadlineMs: 60, pollMs: 15 });
    expect(result.outcome).toBe("stalled"); // ready honoured, then the retirement wait elapsed — not "failed"
    expect(result.error).toBeUndefined(); // the poll's 500 belongs to no verdict: it is only named on a timeout
    const inspects = calls.filter((c) => c.method === "GET" && c.path === `/containers/${REPLACEMENT_ID}/json`);
    expect(inspects.length).toBe(2); // the one deciding poll, then the pre-removal inspect
    expect(wasRemovalAttempted()).toBe(true);
    expect(handoffActive()).toBe(false);
  });

  // The replacement's own reason outranks the poll's last daemon error: a `failed` marker decided this poll
  // although its inspect failed too, and what the requester reads is the replacement's reason.
  test("a failed marker's own reason is reported, not the poll's last daemon error", async () => {
    stubDaemon({
      pollReplacement: () => new Response("boom", { status: 500 }),
      removeReplacement: () => new Response("", { status: 204 }),
      afterStart: () => writeMarker({ status: "failed", sha: "3434343", error: "gateway login refused", at: Date.now() }),
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await redeploy("a".repeat(40));
      expect(result.outcome).toBe("failed");
      expect(result.error).toBe("gateway login refused");
      expect(wasRemovalAttempted()).toBe(true);
      // The poll decided this `failed` itself, so the late re-read has nothing to report: no "signalled
      // failed" warning, which would read as a race that did not happen.
      expect(warn.mock.calls.some((c) => String(c[0]).includes("signalled failed"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  // Row 15 of the handoff state table: the marker is read at the top of a poll and the verdict is computed
  // after the inspect returns, so a `ready` written in between used to lose to `timeout`. Here the deadline
  // is already past (0 ms) and the replacement writes `ready` while that very poll's inspect is in flight:
  // the poll decides `timeout`; the re-read in redeploy() must turn it into the ready path. That poll's own
  // inspect fails too, so the poll holds a "last daemon error" that belonged to a timeout that did not happen.
  test("a ready written during the deciding poll beats the deadline, and the poll's last error is not blamed for it", async () => {
    let pollCount = 0;
    stubDaemon({
      pollReplacement: async () => {
        pollCount++;
        if (pollCount === 1) {
          await writeMarker({ status: "ready", sha: "4444444", at: Date.now() });
          return new Response("boom", { status: 500 });
        }
        return jsonRes(SELF);
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("a".repeat(40), { handoffDeadlineMs: 0, deadlineMs: 60, pollMs: 15 });
    expect(result.outcome).toBe("stalled"); // never "timeout": what the replacement said outranks the poll
    expect(result.error).toBeUndefined();
  });

  // A verdict the poll already decided as `ready` is acted on as it stands: the marker is read by the poll and
  // once at the end, and not a third time by the late re-read (which exists for every OTHER verdict).
  test("a poll that decides ready does not re-read the marker", async () => {
    let reads = 0;
    stubDaemon({
      pollReplacement: () => jsonRes(SELF),
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("a".repeat(40), {
      deadlineMs: 60,
      pollMs: 15,
      readMarker: async () => {
        reads++;
        return { status: "ready", sha: "5656565", at: Date.now() };
      },
    });
    expect(result.outcome).toBe("stalled"); // the retirement wait reads the module's marker: the file is empty
    expect(reads).toBe(2);
  });

  // The same window for a `failed` the replacement wrote: its own word beats "never reported in", and its own
  // reason beats the poll's last daemon error (this poll's inspect fails too). It is reported as `failed`
  // straight away, NOT through the ready path, whose first marker check would wait out a whole `pollMs`.
  test("a failed written during a poll that decides timeout is reported as failed, with the replacement's own reason", async () => {
    let pollCount = 0;
    stubDaemon({
      pollReplacement: async () => {
        pollCount++;
        if (pollCount === 1) {
          await writeMarker({ status: "failed", sha: "4646464", error: "gateway login refused", at: Date.now() });
          return new Response("boom", { status: 500 });
        }
        return jsonRes(SELF);
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const startedAt = Date.now();
    const result = await redeploy("a".repeat(40), { handoffDeadlineMs: 0, deadlineMs: 60, pollMs: 1000 });
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("gateway login refused");
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(wasRemovalAttempted()).toBe(true);
  });

  // The re-read applies to every verdict but `ready`, not only to a timeout: here the deciding poll sees the
  // replacement EXITED (a `failed` verdict) while its `ready` is being written, and `ready` still wins.
  test("a ready written during a poll that decides failed beats that verdict too", async () => {
    let pollCount = 0;
    stubDaemon({
      pollReplacement: async () => {
        pollCount++;
        if (pollCount === 1) {
          await writeMarker({ status: "ready", sha: "4545454", at: Date.now() });
          return jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 0 } });
        }
        return jsonRes(SELF);
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("a".repeat(40), { deadlineMs: 60, pollMs: 15 });
    expect(result.outcome).toBe("stalled"); // the ready path ran (its retirement wait elapsed), not "failed"
  });

  // The re-read goes through the `readMarker` seam like the poll's reads do (the retirement wait keeps the
  // module's, so the file stays empty): read 1 is the poll's, read 2 the late re-read, read 3 the final one.
  test("the late re-read and the final marker read both go through the marker seam", async () => {
    let reads = 0;
    stubDaemon({
      pollReplacement: () => jsonRes(SELF),
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("a".repeat(40), {
      handoffDeadlineMs: 0,
      deadlineMs: 60,
      pollMs: 15,
      readMarker: async () => {
        reads++;
        return reads === 2 ? { status: "ready", sha: "5555555", at: Date.now() } : undefined;
      },
    });
    expect(result.outcome).toBe("stalled");
    expect(reads).toBe(3);
  });

  // The handoff deadline runs on the injected clock too: each reading advances it 20 s, so a 60 s deadline is
  // reached on the second poll. On the real clock it would wait out the 60 s itself and the test would time out.
  // The injected clock starts at epoch 0, so any reading taken from the real clock instead (the start of the
  // wait, or the elapsed time) would be 1.7e12 ms away from the others and the deadline would never be reached.
  test("the handoff deadline is measured on the injected clock", async () => {
    let t = 0;
    stubDaemon({
      pollReplacement: () => jsonRes(SELF), // running, never signalling
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("a".repeat(40), {
      now: () => (t += 20_000),
      handoffDeadlineMs: 60_000,
      pollMs: 1,
    });
    expect(result.outcome).toBe("timeout");
    expect(result.error).toBeUndefined();
    // Two polls and the pre-removal inspect: the first poll (40 s elapsed) waits, the second (80 s) is the
    // deadline. An elapsed time read off the real clock instead would be past 60 s at once and stop at poll 1.
    const inspects = calls.filter((c) => c.method === "GET" && c.path === `/containers/${REPLACEMENT_ID}/json`);
    expect(inspects.length).toBe(3);
  });

  // The clock seam: every verdict time comes from `now`. The injected clock is an hour ahead and the
  // replacement's StartedAt is 30 minutes ahead of real time: judged against the injected clock it is the
  // same life (removed); judged against the real clock it would read as a later one (left alone).
  describe("the verdict time comes from the injected clock", () => {
    const T = Date.now();
    const FUTURE = T + 3_600_000;
    const runningSince = (ms: number) =>
      jsonRes({
        ...SELF,
        State: { Running: true, Status: "running", ExitCode: 0, StartedAt: new Date(ms).toISOString() },
      });

    test("a verdict decided by a poll", async () => {
      let pollCount = 0;
      stubDaemon({
        pollReplacement: () => {
          pollCount++;
          if (pollCount === 1) return jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } });
          return runningSince(T + 1_800_000);
        },
        removeReplacement: () => new Response("", { status: 204 }),
      });
      const result = await redeploy("a".repeat(40), { now: () => FUTURE });
      expect(result.outcome).toBe("failed");
      expect(result.replacement).toBe("removed");
    });

    test("a ready demoted after the retirement wait", async () => {
      stubDaemon({
        pollReplacement: () => runningSince(T + 1_800_000),
        removeReplacement: () => new Response("", { status: 204 }),
        afterStart: () => writeMarker({ status: "ready", sha: "1010101", at: Date.now() }),
      });
      const result = await redeploy("a".repeat(40), { now: () => FUTURE, deadlineMs: 60, pollMs: 15 });
      expect(result.outcome).toBe("stalled");
      expect(result.replacement).toBe("removed");
    });

    test("the backstop catch", async () => {
      stubDaemon({
        pollReplacement: () => runningSince(T + 1_800_000),
        removeReplacement: () => new Response("", { status: 204 }),
      });
      let reads = 0;
      const result = await redeploy("a".repeat(40), {
        now: () => FUTURE,
        readMarker: async () => {
          if (++reads === 1) throw new Error("marker read blew up"); // only the poll's read; the final one answers
          return undefined;
        },
      });
      expect(result.outcome).toBe("failed");
      expect(result.replacement).toBe("removed");
    });
  });

  // The #37 safety net still ends the handoff, and since #431 it judges the replacement against the
  // moment it fired. Nothing the daemon stubs do reaches it any more, so the `readMarker` seam throws on
  // the third poll's read. Polls 1-2 see a running replacement with no StartedAt (waiting); the pre-removal
  // inspect finds one whose StartedAt is after poll 1 but long before the catch fired.
  test("the #37 backstop still ends the handoff and judges the replacement against the moment it fired, not the pre-poll time", async () => {
    let inspectCount = 0;
    let t1 = 0;
    let reads = 0;
    stubDaemon({
      pollReplacement: () => {
        inspectCount++;
        if (inspectCount === 1) t1 = Date.now();
        if (inspectCount <= 2) return jsonRes(SELF); // running, no StartedAt: still waiting
        return jsonRes({
          ...SELF,
          State: { Running: true, Status: "running", ExitCode: 0, StartedAt: new Date(t1 + 5).toISOString() },
        });
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("a".repeat(40), {
      pollMs: 30,
      readMarker: async () => {
        reads++;
        if (reads === 3) throw new Error("marker read blew up");
        // The final read finds a failed marker with a reason of its own: the backstop's own reason still
        // leads the result (`pollError ?? marker?.error`).
        if (reads === 4) return { status: "failed", error: "the replacement's own reason", at: Date.now() };
        return undefined;
      },
    });
    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("marker read blew up");
    expect(wasRemovalAttempted()).toBe(true); // the catch's observedAt is after t1 + 5; the pre-poll time is not
    expect(handoffActive()).toBe(false);
    expect(reads).toBe(4); // three poll reads (the third threw), then the final marker read through the seam
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

  // createContainer can succeed and startContainer still fail (a bind-mount error, a network
  // alias conflict, a daemon hiccup) — without cleanup here the created-but-never-started
  // container leaks until the NEXT redeploy attempt's own leftover-removal line. Found during
  // review of #51 item 5: bot-ops.sh's new guard reads that lingering (`created`) container as "a swap is
  // still in progress" and refuses restart/env-set for however long until that next attempt,
  // which the update scheduler's anti-loop suppression can push out indefinitely for the same sha.
  test("a startContainer failure cleans up the just-created replacement instead of leaking it", async () => {
    stubDaemon({
      pollReplacement: () => {
        throw new Error("must not poll — redeploy() should have returned before this");
      },
      removeReplacement: () => new Response("", { status: 204 }),
      startFails: true,
    });
    const result = await redeploy("7".repeat(40));
    expect(result.outcome).toBeUndefined();
    expect(result.error).toContain("could not start the replacement");
    expect(calls.some((c) => c.method === "DELETE" && c.path === `/containers/${REPLACEMENT_ID}`)).toBe(true);
    expect(handoffActive()).toBe(false);
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

  // A failed image inspect must degrade to "carry everything over" (today's pre-item-7 behavior),
  // not crash the whole redeploy — the same "never fail a good deploy over housekeeping" rule as
  // pruneOldImages.
  test("a failed old-image inspect doesn't abort the redeploy — degrades to carrying every env var over", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("", { status: 404 }),
      imageInspectFails: true,
    });
    const result = await redeploy("6".repeat(40));
    expect(result.outcome).toBe("failed"); // the ordinary poll outcome — the image-inspect failure must not surface as this
    const create = calls.find((c) => c.path === "/containers/create");
    const body = JSON.parse(create!.body!) as { Env: string[] };
    expect(body.Env).toContain("PATH=/usr/bin"); // nothing dropped — the fallback carried it over
  });

  // The wiring test above only confirms the GET happened — not that its result actually reaches
  // the create call. A fetch that silently discarded the inspected env (e.g. always resolving to
  // []) would still pass it; this drives the real POST /containers/create body and would catch
  // exactly that.
  test("the old image's env fetched via inspectImage actually reaches the create request body", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("", { status: 404 }),
      oldImageEnv: ["PATH=/usr/bin"], // matches SELF.Config.Env's own PATH entry verbatim
    });
    await redeploy("4".repeat(40));
    const create = calls.find((c) => c.path === "/containers/create");
    expect(create?.body).toBeDefined();
    const body = JSON.parse(create!.body!) as { Env: string[] };
    expect(body.Env).not.toContain("PATH=/usr/bin");
    expect(body.Env).toContain("DISCORD_TOKEN=secret"); // an operator-set var, untouched
  });

  // Same class of gap for item 6: confirms the network aliases computed in buildCreateSpec
  // actually land in the real create request body, not just that the isolated unit tests exercise
  // the function in the abstract.
  test("the network's service alias actually reaches the create request body", async () => {
    stubDaemon({
      pollReplacement: () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } }),
      removeReplacement: () => new Response("", { status: 404 }),
    });
    await redeploy("5".repeat(40));
    const create = calls.find((c) => c.path === "/containers/create");
    const body = JSON.parse(create!.body!) as {
      NetworkingConfig?: { EndpointsConfig: Record<string, { Aliases?: string[] }> };
    };
    const aliases = body.NetworkingConfig?.EndpointsConfig["wbd_default"]?.Aliases;
    expect(aliases).toContain("bot");
    expect(aliases).not.toContain(SELF_SHORT_ID);
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
    const startedAt = Date.now();
    const result = await redeploy("3".repeat(40), { deadlineMs: 60, pollMs: 15 });
    expect(result.outcome).toBe("stalled");
    expect(handoffActive()).toBe(false);
    // #161's keeper: a stalled replacement is still genuinely reclaimed (removed), not just
    // reported as stalled — a guard keyed on outcome === "ready" alone would wrongly skip removal
    // once the outcome demotes to "stalled" here.
    expect(wasRemovalAttempted()).toBe(true);
    // `pollMs` reaches the retirement wait too (RedeployOptions): a wait that ignored it would sleep the real
    // 2 s poll interval before its single check.
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  // #160 change 5, defence in depth (Docker itself can no longer produce this once the standby's
  // own RestartPolicy is "no" — this covers a manual `docker start`, or a pre-#160 standby mid-
  // rollout). The FIRST poll decides "failed" (exited); the SECOND — the pre-removal re-inspect —
  // finds it back up with a StartedAt strictly after that decision: a different life of the same
  // container than the one just judged.
  test("a replacement that restarted after we decided its outcome is left alone, not removed", async () => {
    let pollCount = 0;
    stubDaemon({
      pollReplacement: () => {
        pollCount++;
        if (pollCount === 1) {
          return jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } });
        }
        // +5ms guarantees this strictly postdates observedAt regardless of clock resolution —
        // observedAt was sampled synchronously before the first poll's marker read and inspect,
        // microseconds before this closure runs on the SECOND (pre-removal) call. Written the way
        // Docker writes it, with a nanosecond fraction (nine digits): if `Date.parse` read that as
        // NaN the guard would never skip, and this test would go red (#434).
        const nanos = `${new Date(Date.now() + 5).toISOString().slice(0, -1)}000000Z`;
        return jsonRes({
          ...SELF,
          State: { Running: true, Status: "running", ExitCode: 0, StartedAt: nanos },
        });
      },
      removeReplacement: () => {
        throw new Error("must not attempt removal — the replacement restarted since the decision");
      },
    });
    const result = await redeploy("9".repeat(40));
    expect(result.outcome).toBe("failed");
    expect(wasRemovalAttempted()).toBe(false);
    expect(result.replacement).toBe("left"); // and the requester is told so (#451)
  });

  // A Running replacement whose StartedAt is WELL BEFORE the decision (the ordinary "stalled" case —
  // the replacement never restarted, it's the SAME life we just judged) must still be removed, not
  // false-positive skipped. The tie and the not-running cases have their own tests below (#434).
  test("a replacement whose StartedAt is well before the decision is still removed, not a false-positive skip", async () => {
    const stableStartedAt = new Date(Date.now() - 60_000).toISOString(); // well before observedAt
    stubDaemon({
      pollReplacement: () =>
        jsonRes({ ...SELF, State: { Running: true, Status: "running", ExitCode: 0, StartedAt: stableStartedAt } }),
      removeReplacement: () => new Response("", { status: 204 }),
      afterStart: () => writeMarker({ status: "ready", sha: "0000000", at: Date.now() }),
    });
    const result = await redeploy("0".repeat(40), { deadlineMs: 60, pollMs: 15 });
    expect(result.outcome).toBe("stalled");
    expect(wasRemovalAttempted()).toBe(true);
  });

  // Found in review: observedAt used to be captured ONLY at the moment "ready" was first observed
  // (inside awaitHandoff) and never refreshed when that outcome is later demoted to stalled/failed
  // — up to RETIREMENT_DEADLINE_MS (3 real minutes) afterward. A replacement whose restorePolicy
  // update genuinely landed at the daemon but whose response was lost (the same transport-drop
  // class retireOriginal's own re-inspect already treats as realistic) restarts under its
  // now-correctly-restored policy SOMETIME during that wait — strictly after the stale "ready"
  // timestamp, but before the decision the guard is actually supposed to be judged against. Against
  // the stale baseline that reads as "restarted later than our decision," wrongly skipping a
  // removal the old, unconditional code always made. Fixed by re-sampling observedAt right where
  // the outcome is actually decided (after the retirement wait concludes), not where "ready" first
  // arrived. This StartedAt sits deliberately in that exact gap — between the two timestamps — so a
  // regression back to the stale baseline fails this test while the boundary test above (a
  // StartedAt from well BEFORE "ready" was ever seen) would not have caught it.
  test("a StartedAt between 'ready' and the LATE stalled decision is still removed — the baseline must be the decision, not the stale 'ready' moment", async () => {
    let pollCount = 0;
    let readyObservedAt = 0;
    stubDaemon({
      pollReplacement: () => {
        pollCount++;
        if (pollCount === 1) {
          readyObservedAt = Date.now();
          return jsonRes(SELF); // the "ready" observation itself — no StartedAt needed here
        }
        // The pre-removal re-inspect, well after the retirement wait has concluded: restarted
        // strictly after "ready" was first seen, but the wait's own elapsed deadline (not this
        // restart) is what actually decided "stalled" — this StartedAt predates that decision.
        return jsonRes({
          ...SELF,
          State: { Running: true, Status: "running", ExitCode: 0, StartedAt: new Date(readyObservedAt + 30).toISOString() },
        });
      },
      removeReplacement: () => new Response("", { status: 204 }),
      afterStart: () => writeMarker({ status: "ready", sha: "8080808", at: Date.now() }),
    });
    const result = await redeploy("8".repeat(40), { deadlineMs: 60, pollMs: 15 });
    expect(result.outcome).toBe("stalled");
    expect(wasRemovalAttempted()).toBe(true);
  });

  // The baseline is the START of the deciding observation, not the moment the verdict was reached: a restart
  // while that poll's inspect was in flight happened after we began looking, so the verdict ("exited") was
  // about an earlier life and the new one is left alone. A baseline taken when the poll returned would put
  // this StartedAt (20 ms into a 40 ms inspect) before it and remove a bot that is up.
  test("a restart while the deciding poll's inspect was in flight is a later life, left alone", async () => {
    let pollCount = 0;
    let t0 = 0;
    stubDaemon({
      pollReplacement: async () => {
        pollCount++;
        if (pollCount === 1) {
          t0 = Date.now();
          await Bun.sleep(40);
          return jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } });
        }
        return jsonRes({
          ...SELF,
          State: { Running: true, Status: "running", ExitCode: 0, StartedAt: new Date(t0 + 20).toISOString() },
        });
      },
      removeReplacement: () => {
        throw new Error("must not attempt removal — the replacement restarted while we were looking");
      },
    });
    const result = await redeploy("a".repeat(40));
    expect(result.outcome).toBe("failed");
    expect(wasRemovalAttempted()).toBe(false);
    expect(result.replacement).toBe("left");
  });

  // #434, the tie: `>` is a strictly-later test. A StartedAt equal to the verdict's own time is the SAME
  // life, not a later one, and is removed; `>=` would leave a replacement alone that it should remove. The
  // clock is fixed (`now`) so the two timestamps are equal by construction; the retirement wait still
  // runs on real time, so the test ends because `ready` is on disk and that wait elapses (stalled).
  test("a StartedAt equal to the verdict time is the same life, removed — a tie is not a later generation", async () => {
    const T = Date.now();
    stubDaemon({
      pollReplacement: () =>
        jsonRes({ ...SELF, State: { Running: true, Status: "running", ExitCode: 0, StartedAt: new Date(T).toISOString() } }),
      removeReplacement: () => new Response("", { status: 204 }),
      afterStart: () => writeMarker({ status: "ready", sha: "6666666", at: Date.now() }),
    });
    const result = await redeploy("6".repeat(40), { now: () => T, deadlineMs: 60, pollMs: 15 });
    expect(result.outcome).toBe("stalled");
    expect(wasRemovalAttempted()).toBe(true);
  });

  // #434, the Running conjunct: a later StartedAt on a container that is NOT running is a corpse of an
  // earlier life, not a bot "genuinely up and serving" — it is removed. Before this test deleting
  // `State.Running === true` from the guard left every test green.
  test("a later StartedAt on a container that is not running is removed, not left alone", async () => {
    let pollCount = 0;
    stubDaemon({
      pollReplacement: () => {
        pollCount++;
        if (pollCount === 1) return jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } });
        return jsonRes({
          ...SELF,
          State: {
            Running: false,
            Status: "exited",
            ExitCode: 1,
            StartedAt: new Date(Date.now() + 5_000).toISOString(),
          },
        });
      },
      removeReplacement: () => new Response("", { status: 204 }),
    });
    const result = await redeploy("7".repeat(40));
    expect(result.outcome).toBe("failed");
    expect(wasRemovalAttempted()).toBe(true);
    expect(result.replacement).toBe("removed");
  });

  // #451: the result says what became of the `<name>-next` container, so the requester is never told "I
  // removed it" about something that was never there, was left alone, or could not be removed.
  describe("what became of the replacement", () => {
    const exited = () => jsonRes({ ...SELF, State: { Running: false, Status: "exited", ExitCode: 1 } });
    const mustNotPoll = () => {
      throw new Error("must not poll — redeploy() returns before the handoff");
    };

    // The fallback inspect also fails here (see `selfInspectFails`), so assert the result, not the reason.
    test("nothing was created when the own-container inspect fails", async () => {
      stubDaemon({
        pollReplacement: mustNotPoll,
        removeReplacement: () => new Response("", { status: 204 }),
        selfInspectFails: true,
      });
      const result = await redeploy("a".repeat(40));
      expect(result.error).toContain("could not inspect own container");
      expect(result.replacement).toBe("none");
    });

    test("nothing was created when the build fails", async () => {
      stubDaemon({
        pollReplacement: mustNotPoll,
        removeReplacement: () => new Response("", { status: 204 }),
        buildFails: true,
      });
      const result = await redeploy("b".repeat(40));
      expect(result.error).toContain("build failed");
      expect(result.replacement).toBe("none");
    });

    test("a start failure whose cleanup removes the container reports it removed", async () => {
      stubDaemon({
        pollReplacement: mustNotPoll,
        removeReplacement: () => new Response("", { status: 204 }),
        startFails: true,
      });
      const result = await redeploy("c".repeat(40));
      expect(result.error).toContain("could not start the replacement");
      expect(result.replacement).toBe("removed");
    });

    test("a start failure whose cleanup finds nothing by that id reports none, not removed", async () => {
      stubDaemon({
        pollReplacement: mustNotPoll,
        removeReplacement: () => new Response("", { status: 404 }),
        startFails: true,
      });
      const result = await redeploy("d".repeat(40));
      expect(result.replacement).toBe("none");
    });

    test("a start failure whose cleanup is refused reports remove-failed with the daemon's answer", async () => {
      stubDaemon({
        pollReplacement: mustNotPoll,
        removeReplacement: () => new Response("daemon blip", { status: 500 }),
        startFails: true,
      });
      const result = await redeploy("e".repeat(40));
      expect(result.error).toContain("could not start the replacement");
      expect(result.replacement).toBe("remove-failed");
      expect(result.replacementError).toContain("500");
      expect(handoffActive()).toBe(false);
    });

    test("a failed swap whose removal the daemon refuses (409) reports remove-failed", async () => {
      stubDaemon({ pollReplacement: exited, removeReplacement: () => new Response("removal in progress", { status: 409 }) });
      const result = await redeploy("f".repeat(40));
      expect(result.outcome).toBe("failed");
      expect(result.replacement).toBe("remove-failed");
      expect(result.replacementError).toContain("409");
    });

    test("a failed swap whose replacement is removed reports removed; one already gone reports none", async () => {
      stubDaemon({ pollReplacement: exited, removeReplacement: () => new Response("", { status: 204 }) });
      expect((await redeploy("1".repeat(40))).replacement).toBe("removed");
      stubDaemon({ pollReplacement: exited, removeReplacement: () => new Response("", { status: 404 }) });
      expect((await redeploy("2".repeat(40))).replacement).toBe("none");
    });
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

  // The other new failure mode this fix could introduce: the daemon call happens before
  // `client.login()` is even attempted. `docker.ts` bounds every call at 60s since #130, but this
  // one keeps its own tighter bound — a hung (not merely erroring) socket must not eat 60s of boot
  // before a login is even attempted; it has to fall through to the same "can't confirm" handling
  // as any other inspect failure, bounded well under the real default so this test stays fast.
  test("a daemon call that never resolves times out and stays standby, not hung forever", async () => {
    const inspect = () => new Promise<ContainerInspect | undefined>(() => {}); // never settles
    expect(await resolveBootMode({ [HANDOFF_FROM_ENV]: SELF.Id }, inspect, 20)).toBe("standby");
  });
});

// #547: a swapped-in container whose rename never landed boots `normal` (its original is gone), and nothing on
// that path renames it. `index.ts` calls `healOwnName` right after `resolveBootMode` when the env says standby
// and the daemon said normal; every daemon call here is an injected seam.
describe("healOwnName", () => {
  const NEXT: ContainerInspect = { ...SELF, Name: "/warbandeer-discord-next" };
  const HOLDER_ID = "e".repeat(64);
  const holder = (over: Partial<ContainerInspect> = {}): ContainerInspect => ({
    ...SELF,
    Id: HOLDER_ID,
    Name: "/warbandeer-discord",
    State: { Running: false, Status: "exited", ExitCode: 0 },
    ...over,
  });

  /** Records every seam call, in order, and what was logged. */
  function harness(o: { self?: ContainerInspect; holder?: ContainerInspect | undefined; failAt?: "inspectSelf" | "inspect" | "remove" | "rename" } = {}) {
    const events: string[] = [];
    const logs: { level: "log" | "warn" | "error"; text: string }[] = [];
    const fail = (at: string) => {
      if (o.failAt === at) throw new Error(`${at} failed`);
    };
    const deps = {
      inspectSelf: async () => {
        events.push("inspectSelf");
        fail("inspectSelf");
        return o.self ?? NEXT;
      },
      inspect: async (name: string) => {
        events.push(`inspect:${name}`);
        fail("inspect");
        return "holder" in o ? o.holder : undefined;
      },
      remove: async (id: string) => {
        events.push(`remove:${id}`);
        fail("remove");
      },
      rename: async (id: string, name: string) => {
        events.push(`rename:${id}:${name}`);
        fail("rename");
      },
      log: {
        log: (text: string) => void logs.push({ level: "log", text }),
        warn: (text: string) => void logs.push({ level: "warn", text }),
        error: (text: string) => void logs.push({ level: "error", text }),
      },
    };
    return { deps, events, logs };
  }

  test("a canonical name is left alone, with one inspect and no rename", async () => {
    const h = harness({ self: SELF });
    expect(await healOwnName(h.deps)).toBe("canonical");
    expect(h.events).toEqual(["inspectSelf"]);
  });

  test("a free base name is taken", async () => {
    const h = harness();
    expect(await healOwnName(h.deps)).toBe("renamed");
    expect(h.events).toEqual(["inspectSelf", "inspect:warbandeer-discord", `rename:${SELF_ID}:warbandeer-discord`]);
    expect(h.logs).toEqual([{ level: "log", text: expect.stringContaining("took the name warbandeer-discord") }]);
  });

  test("a stopped holder of the same compose service is removed, then the name is taken", async () => {
    const h = harness({ holder: holder() });
    expect(await healOwnName(h.deps)).toBe("renamed");
    expect(h.events).toEqual([
      "inspectSelf",
      "inspect:warbandeer-discord",
      `remove:${HOLDER_ID}`,
      `rename:${SELF_ID}:warbandeer-discord`,
    ]);
  });

  test("a RUNNING holder is left alone and logged as two bots on one token", async () => {
    const h = harness({ holder: holder({ State: { Running: true, Status: "running", ExitCode: 0 } }) });
    expect(await healOwnName(h.deps)).toBe("occupied");
    expect(h.events).toEqual(["inspectSelf", "inspect:warbandeer-discord"]);
    const errors = h.logs.filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.text).toContain("two bots");
    expect(errors[0]!.text).toContain("warbandeer-discord-next");
  });

  test("a stopped holder of another service, or with no compose labels, is left alone", async () => {
    const otherService = holder({
      Config: { ...SELF.Config, Labels: { ...SELF.Config.Labels, "com.docker.compose.service": "admin" } },
    });
    const otherProject = holder({
      Config: { ...SELF.Config, Labels: { ...SELF.Config.Labels, "com.docker.compose.project": "elsewhere" } },
    });
    const unlabelled = holder({ Config: { ...SELF.Config, Labels: {} } });
    for (const other of [otherService, otherProject, unlabelled]) {
      const h = harness({ holder: other });
      expect(await healOwnName(h.deps)).toBe("occupied");
      expect(h.events).toEqual(["inspectSelf", "inspect:warbandeer-discord"]); // no remove, no rename
      expect(h.logs.filter((l) => l.level === "warn")).toHaveLength(1);
    }
  });

  test("this bot without compose labels never matches a holder (no service to be the same as)", async () => {
    const h = harness({ self: { ...NEXT, Config: { ...SELF.Config, Labels: {} } }, holder: holder({ Config: { ...SELF.Config, Labels: {} } }) });
    expect(await healOwnName(h.deps)).toBe("occupied");
    expect(h.events).toEqual(["inspectSelf", "inspect:warbandeer-discord"]);
  });

  test("a drifted -next-next name folds back to the base in one hop", async () => {
    const h = harness({ self: { ...SELF, Name: "/warbandeer-discord-next-next" } });
    expect(await healOwnName(h.deps)).toBe("renamed");
    expect(h.events).toEqual(["inspectSelf", "inspect:warbandeer-discord", `rename:${SELF_ID}:warbandeer-discord`]);
  });

  test("a daemon error at any step is logged and the boot continues: unknown", async () => {
    for (const failAt of ["inspectSelf", "inspect", "remove", "rename"] as const) {
      const h = harness({ holder: holder(), failAt });
      expect(await healOwnName(h.deps), failAt).toBe("unknown");
      const warns = h.logs.filter((l) => l.level === "warn");
      expect(warns, failAt).toHaveLength(1);
      expect(warns[0]!.text).toContain(`${failAt} failed`);
    }
  });

  test("a hung daemon is bounded: unknown, in well under the daemon's own 60 s", async () => {
    const h = harness();
    const started = Date.now();
    const outcome = await healOwnName({ ...h.deps, inspect: () => new Promise(() => {}) }, 20);
    expect(outcome).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(500);
    expect(h.logs.filter((l) => l.level === "warn")[0]!.text).toContain("timed out");
  });

  test("a canonical name takes no inspect of the base even when the holder seam would answer", async () => {
    const h = harness({ self: SELF, holder: holder() });
    await healOwnName(h.deps);
    expect(h.events.filter((e) => e.startsWith("inspect:"))).toEqual([]);
  });
});
