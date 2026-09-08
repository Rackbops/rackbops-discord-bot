import { afterEach, describe, expect, test } from "bun:test";
import { parseBuildOutput, parseContainerId } from "./docker";
import { settleWithin } from "../test/settleWithin";

// The socket-facing calls are exercised through a stubbed `globalThis.fetch`, in the style of
// update.test.ts — the parsing they depend on is pure and tested directly.
const {
  buildImage,
  createContainer,
  daemonReachable,
  inspectContainer,
  inspectImage,
  inspectSelf,
  listImages,
  removeContainer,
  removeImage,
  renameContainer,
  startContainer,
  stopContainer,
  tagImage,
  tryInspectContainer,
} = await import("./docker");

describe("parseContainerId", () => {
  const ID = "f".repeat(64);

  test("reads the id out of a docker mountinfo line", () => {
    expect(
      parseContainerId(
        `1234 1023 0:59 /containers/${ID}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw`,
      ),
    ).toBe(ID);
  });

  test("handles the /docker/containers/ layout too", () => {
    expect(parseContainerId(`654 321 0:59 /var/lib/docker/containers/${ID}/resolv.conf /etc/resolv.conf rw`)).toBe(
      ID,
    );
  });

  test("undefined when nothing in the file names a container", () => {
    expect(parseContainerId("22 1 0:21 / /proc rw,nosuid - proc proc rw")).toBeUndefined();
  });

  // Short ids appear all over docker output; only the full 64-hex one identifies a container.
  test("ignores a short id", () => {
    expect(parseContainerId("1 1 0:1 /containers/abc123/hostname /etc/hostname rw")).toBeUndefined();
  });
});

describe("parseBuildOutput", () => {
  test("a clean build is ok", () => {
    expect(
      parseBuildOutput('{"stream":"Step 1/9"}\n{"stream":"Successfully built abc"}\n'),
    ).toEqual({ ok: true });
  });

  // The whole reason this exists: /build answers 200 even when the build failed, with the
  // failure buried in the stream. Trusting the status code alone would ship every broken build.
  test("an error line fails the build despite a 200", () => {
    const { ok, error } = parseBuildOutput(
      '{"stream":"Step 1/9"}\n{"error":"pull access denied","errorDetail":{"message":"pull access denied"}}\n',
    );
    expect(ok).toBe(false);
    expect(error).toBe("pull access denied");
  });

  test("prefers errorDetail.message, which carries the fuller text", () => {
    expect(
      parseBuildOutput('{"error":"failed","errorDetail":{"message":"no such ref: main"}}').error,
    ).toBe("no such ref: main");
  });

  test("non-JSON noise in the stream is skipped, not treated as a verdict", () => {
    expect(parseBuildOutput('not json\n{"stream":"ok"}\n\n')).toEqual({ ok: true });
  });

  test("empty output is ok — nothing reported a problem", () => {
    expect(parseBuildOutput("")).toEqual({ ok: true });
  });
});

describe("daemon calls", () => {
  const realFetch = globalThis.fetch;
  let calls: { url: string; method: string; signal?: AbortSignal }[] = [];

  const stub = (impl: (url: string, init?: RequestInit) => Response) => {
    calls = [];
    globalThis.fetch = ((url: string, init?: RequestInit & { unix?: string }) => {
      calls.push({ url: String(url), method: init?.method ?? "GET", signal: init?.signal ?? undefined });
      return Promise.resolve(impl(String(url), init));
    }) as unknown as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("daemonReachable is false when the socket isn't there, not a throw", async () => {
    stub(() => {
      throw new Error("ENOENT /var/run/docker.sock");
    });
    expect(await daemonReachable()).toBe(false);
  });

  test("daemonReachable is true on a ping", async () => {
    stub(() => new Response("OK", { status: 200 }));
    expect(await daemonReachable()).toBe(true);
    expect(calls[0]?.url).toContain("/_ping");
  });

  test("a build passes the remote context, both tags and the sha build-arg", async () => {
    stub(() => new Response('{"stream":"done"}', { status: 200 }));
    await buildImage({
      remote: "https://github.com/o/r.git#main:apps/warbandeer-discord",
      tags: ["img:latest", "img:abc1234"],
      buildArgs: { GIT_SHA: "abc1234" },
    });
    const url = calls[0]!.url;
    expect(calls[0]!.method).toBe("POST");
    expect(decodeURIComponent(url)).toContain("remote=https://github.com/o/r.git#main:apps/warbandeer-discord");
    expect(decodeURIComponent(url)).toContain("t=img:latest");
    expect(decodeURIComponent(url)).toContain("t=img:abc1234");
    expect(decodeURIComponent(url)).toContain('buildargs={"GIT_SHA":"abc1234"}');
  });

  // #130: every daemon call is wrapped in `bounded()`, which hands `api()` a signal — `api()`
  // itself creates no bound, so these two only prove a signal is ATTACHED. Proving it actually
  // fires is the table further down; these stay as a cheap shape check.
  test("buildImage attaches an abort signal to the daemon request", async () => {
    stub(() => new Response('{"stream":"done"}', { status: 200 }));
    await buildImage({ remote: "https://github.com/o/r.git#main", tags: ["img:abc1234"], buildArgs: {} });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("an ordinary daemon call carries an abort signal too, not just the build", async () => {
    stub(() => new Response("", { status: 204 }));
    await stopContainer("abc");
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.signal!.aborted).toBe(false); // attached, but not already spent
  });

  // The signal has to actually abort a stuck call — not just be attached. A stub that never
  // resolves unless the signal fires stands in for a wedged dockerd; buildImage's own tiny
  // timeout override lets this run without waiting out the real 15-min bound.
  //
  // Goes through `settleWithin` like every other bound assertion. An explicit per-test timeout is
  // NOT enough on its own: bun's timeout is itself unref'd, so when a regressed bound leaves
  // nothing ref'd it cannot interrupt either, and the run wedges with no output. This test used to
  // rely on that timeout alone — mutating buildImage's bound was the one call site of fourteen
  // that survived, reaching a reviewer as a hung CI job rather than a red test. Worse, it runs
  // before the two body-read tests, so it suppressed those too.
  test(
    "buildImage rejects when the build exceeds its timeout instead of hanging forever",
    async () => {
      globalThis.fetch = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
          );
        })) as unknown as typeof fetch;
      const r = await settleWithin(
        buildImage({ remote: "https://github.com/o/r.git#main", tags: ["img:abc1234"], buildArgs: {} }, 20),
        "buildImage request",
      );
      expect(r.ok).toBe(false);
      expect((r as { e: Error }).e.message).toMatch(/timed out after 20ms/);
    },
    1000,
  );

  // The bound must cover the response BODY, not just the request. A daemon that answers with
  // headers and then wedges mid-body hangs exactly as hard — and this is the shape that caught a
  // first cut of #130, where the timer was retired the moment the headers landed and every
  // non-build call (inspectSelf included, which the issue names) was left unbounded again.
  // Headers land immediately, then the body never completes — and, as a real `fetch` body does,
  // the stream errors when the request's signal aborts. That last part is what makes this a
  // faithful double: a hand-built Response ignores the signal, a network one does not.
  const wedgedBody = (signal?: AbortSignal | null) =>
    new Response(
      new ReadableStream({
        start(controller) {
          signal?.addEventListener("abort", () => controller.error(signal.reason));
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  test(
    "a response whose body never completes is aborted too, not just a stalled request",
    async () => {
      stub((_url, init) => wedgedBody(init?.signal));
      const r = await settleWithin(inspectContainer("abc", 20), "inspectContainer");
      expect(r.ok).toBe(false);
      expect((r as { e: Error }).e.message).toMatch(/timed out after 20ms/);
    },
    1000,
  );

  test(
    "the build's body read is bounded by the same signal as its request",
    async () => {
      stub((_url, init) => wedgedBody(init?.signal));
      const r = await settleWithin(
        buildImage({ remote: "https://github.com/o/r.git#main", tags: ["img:abc1234"], buildArgs: {} }, 20),
        "buildImage body",
      );
      expect(r.ok).toBe(false);
      expect((r as { e: Error }).e.message).toMatch(/timed out after 20ms/);
    },
    1000,
  );

  // EVERY exported daemon call must be bounded, not just the two shapes spot-checked above.
  // Without this table the bound is per-call-site convention: `api()` takes whatever signal it is
  // handed, so a new call — or an edit handing one a signal that never fires — reopens #130's
  // defect with a fully green suite. Driven both ways: a request that never answers, and a
  // request that answers then wedges mid-body. `daemonReachable` swallows its own errors by
  // design, so it is asserted to RESOLVE false rather than reject; everything else must reject.
  const everyDaemonCall: [string, (timeoutMs: number) => Promise<unknown>][] = [
    ["daemonReachable", (t) => daemonReachable(t)],
    ["inspectSelf", (t) => inspectSelf(t)],
    ["inspectContainer", (t) => inspectContainer("abc", t)],
    ["tryInspectContainer", (t) => tryInspectContainer("abc", t)],
    ["buildImage", (t) => buildImage({ remote: "https://x/y.git#main", tags: ["i:abc1234"], buildArgs: {} }, t)],
    ["createContainer", (t) => createContainer("n", {} as never, t)],
    ["startContainer", (t) => startContainer("abc", t)],
    ["stopContainer", (t) => stopContainer("abc", 10, t)],
    ["removeContainer", (t) => removeContainer("abc", false, t)],
    ["renameContainer", (t) => renameContainer("abc", "n", t)],
    ["listImages", (t) => listImages(t)],
    ["inspectImage", (t) => inspectImage("abc", t)],
    ["removeImage", (t) => removeImage("i:abc1234", t)],
    ["tagImage", (t) => tagImage("i:abc1234", "i:latest", t)],
  ];

  // `inspectSelf` consults HOSTNAME first; pin it so the table drives that branch deterministically.
  const withHostname = (fn: () => Promise<void>) => async () => {
    process.env.HOSTNAME = "self-container-id";
    try {
      await fn();
    } finally {
      delete process.env.HOSTNAME;
    }
  };

  for (const [name, call] of everyDaemonCall) {
    test(
      `${name} is bounded when the daemon never answers`,
      withHostname(async () => {
        stub(() => new Response("", { status: 200 })); // replaced below; keeps `calls` reset
        globalThis.fetch = ((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
            );
          })) as unknown as typeof fetch;
        const settled = await settleWithin(call(20), name);
        if (name === "daemonReachable") {
          expect(settled).toEqual({ ok: true, v: false }); // swallows the abort, but must not hang
        } else {
          expect(settled.ok).toBe(false);
          expect((settled as { e: Error }).e.message).toMatch(/timed out after 20ms/);
        }
      }),
      1000,
    );

    test(
      `${name} is bounded when the daemon answers then wedges mid-body`,
      withHostname(async () => {
        stub((_url, init) => wedgedBody(init?.signal));
        // A call that reads no body settles on headers alone; one that does must abort. Either
        // way it must SETTLE within its bound rather than hang.
        await settleWithin(call(20), name);
      }),
      1000,
    );
  }

  // Every test above passes an explicit tiny `timeoutMs`; no production caller passes one at all
  // (`src/redeploy.ts` never does), so without this both defaults could be raised to infinity —
  // silently un-bounding the real bot — with the whole suite green. A value pin is the honest
  // guard here: the numbers are operational decisions, and changing one should require editing
  // this line and saying why in review.
  test("the default bounds are the reviewed values", async () => {
    const { DEFAULT_TIMEOUT_MS, BUILD_TIMEOUT_MS } = await import("./docker");
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000); // ample for every non-build call
    expect(BUILD_TIMEOUT_MS).toBe(900_000); // 15 min — clone + prod-deps install, 1-3 min typical
    expect(BUILD_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
  });

  // `inspectSelf` has two legs and the table above only ever drives the first: it pins HOSTNAME,
  // so the mountinfo fallback — the leg that runs when a compose file pins `hostname:` — was
  // reachable by no test at all, and its signal could be swapped for a never-firing one with the
  // whole suite green. Drive it explicitly: no HOSTNAME, and a stubbed /proc/self/mountinfo.
  test(
    "inspectSelf's mountinfo fallback is bounded too, not just the hostname leg",
    async () => {
      const realFile = Bun.file;
      const realHost = process.env.HOSTNAME;
      delete process.env.HOSTNAME;
      // The id has to be 64 hex for parseContainerId to accept it (a short id is rejected).
      (Bun as { file: unknown }).file = () => ({
        text: async () => `1 1 0:1 /containers/${"f".repeat(64)}/hostname /etc/hostname rw`,
      });
      try {
        stub((_url, init) => wedgedBody(init?.signal));
        const r = await settleWithin(inspectSelf(20), "inspectSelf fallback");
        expect(r.ok).toBe(false);
        expect((r as { e: Error }).e.message).toMatch(/timed out after 20ms/);
        // Proves the fallback leg actually ran, rather than the hostname leg being hit by accident.
        expect(calls[0]!.url).toContain("f".repeat(64));
      } finally {
        (Bun as { file: unknown }).file = realFile;
        if (realHost !== undefined) process.env.HOSTNAME = realHost;
      }
    },
    1000,
  );

  // The other half of the bound: a call that finishes well inside its budget must RETIRE its
  // timer, or every completed call leaves a live abort armed against a signal nobody is watching
  // — and in a suite, hundreds of them.
  test("a completed call clears its abort timer instead of leaving it armed", async () => {
    stub(() => new Response(JSON.stringify({ Id: "abc" }), { status: 200 }));
    await inspectContainer("abc", 20);
    const signal = calls[0]!.signal!;
    expect(signal.aborted).toBe(false);
    await Bun.sleep(60); // well past the 20ms bound
    expect(signal.aborted).toBe(false); // still false => clearTimeout ran
  });

  // The Engine API wants repo and tag as separate query params, not one combined "repo:tag"
  // value — this is the split `tagImage` exists to get right.
  test("tagImage splits the target into separate repo/tag query params", async () => {
    stub(() => new Response("", { status: 201 }));
    await tagImage("myrepo:abc1234", "myrepo:latest");
    expect(calls[0]!.method).toBe("POST");
    const url = decodeURIComponent(calls[0]!.url);
    expect(url).toContain("/images/myrepo:abc1234/tag?");
    expect(url).toContain("repo=myrepo");
    expect(url).toContain("tag=latest");
  });

  // Both are "the state we wanted" — treating them as errors would abort a handoff over a
  // container that had already done what we were asking for.
  test("stopping an already-stopped or already-gone container is not an error", async () => {
    for (const status of [304, 404]) {
      stub(() => new Response("", { status }));
      await stopContainer("abc");
    }
  });

  test("removing an already-gone container is not an error", async () => {
    stub(() => new Response("", { status: 404 }));
    await removeContainer("abc");
  });

  test("a real stop failure still throws", async () => {
    stub(() => new Response("boom", { status: 500 }));
    await expect(stopContainer("abc")).rejects.toThrow("docker stop abc failed: 500");
  });

  test("a real remove failure still throws", async () => {
    stub(() => new Response("boom", { status: 500 }));
    await expect(removeContainer("abc")).rejects.toThrow("docker rm abc failed: 500");
  });
});
