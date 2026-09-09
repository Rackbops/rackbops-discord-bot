import { afterEach, describe, expect, test } from "bun:test";

// github.ts imports the `config` singleton (resolved from process.env at import time), so
// prime the required vars before pulling the module in — see config.test.ts.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
const {
  clampReply,
  clampUpstreamBody,
  createIssue,
  decideReleaseAnnouncements,
  fetchReleases,
  createReachabilityLog,
  githubHeaders,
} = await import("./github");
const { config } = await import("./config");

const rel = (id: number) => ({ id, name: `v${id}`, tag: `v${id}`, url: `https://x/${id}` });

describe("clampUpstreamBody", () => {
  test("passes short text through unchanged", () => {
    expect(clampUpstreamBody("not found")).toBe("not found");
  });

  test("keeps only the first line", () => {
    expect(clampUpstreamBody("line one\nline two\nline three")).toBe("line one");
  });

  test("trims surrounding whitespace on the first line", () => {
    expect(clampUpstreamBody("  spaced out  \nrest")).toBe("spaced out");
  });

  test("caps at the default 300 chars and appends a truncation suffix", () => {
    const body = "x".repeat(500);
    const clamped = clampUpstreamBody(body);
    expect(clamped.length).toBe(301); // 300 chars + the … suffix
    expect(clamped.endsWith("…")).toBe(true);
    expect(clamped.startsWith("x".repeat(300))).toBe(true);
  });

  test("respects a caller-supplied max", () => {
    expect(clampUpstreamBody("x".repeat(50), 10)).toBe(`${"x".repeat(10)}…`);
  });

  test("text at exactly the limit is not truncated", () => {
    const body = "x".repeat(300);
    expect(clampUpstreamBody(body)).toBe(body);
    expect(clampUpstreamBody(body).endsWith("…")).toBe(false);
  });

  // A body with an early newline (see the next test) doesn't actually exercise the length cap —
  // the first-line split alone already gets it under `max`. This one has no newline at all, so it
  // genuinely drives both rules at once: the whole several-KB body is "line one" until the cap cuts it.
  test("a multi-KB single-line HTML body is cut by the length cap, not just the line split", () => {
    const html = `<html><body>Bad Gateway</body></html>${"<div>filler</div>".repeat(500)}`;
    const clamped = clampUpstreamBody(html);
    expect(clamped.length).toBeLessThanOrEqual(301);
    expect(clamped.endsWith("…")).toBe(true);
  });

  test("a genuinely multi-line HTML error page keeps only the (short) first line", () => {
    const html = `<!doctype html>\n${"<div>filler</div>".repeat(500)}`; // several KB, but line 1 is short
    expect(clampUpstreamBody(html)).toBe("<!doctype html>"); // fits whole — no truncation suffix
  });

  // #189 review round 2: plain `text.slice(0, max)` slices by UTF-16 code unit, so a non-BMP
  // character (e.g. an emoji, a surrogate pair) landing exactly at the cut point would split it
  // into a lone surrogate — garbling the trailing character once re-encoded. `sliceUtf16` drops
  // that one trailing unit instead. (A first attempt at this fix switched to counting *code
  // points* instead of code units — see the next test for why that was itself a regression.)
  test("does not split a surrogate pair sitting right at the cut point", () => {
    const emoji = "\u{1F600}"; // U+1F600, a surrogate pair in UTF-16 (2 code units, 1 code point)
    const body = "x".repeat(299) + emoji + "y".repeat(10); // the pair straddles the 300-char cut
    const clamped = clampUpstreamBody(body);
    // A valid string has no lone surrogate: every high surrogate is immediately followed by its low.
    for (let i = 0; i < clamped.length; i++) {
      const code = clamped.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        expect(clamped.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(clamped.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
      }
    }
    expect(clamped.endsWith("…")).toBe(true);
  });

  // THE regression this round exists to close: a code-point-counting cap lets an astral-heavy
  // body (each character = 2 UTF-16 units, 1 code point) through at up to ~2x the real unit count
  // Discord enforces — reintroducing #186's own bug through the fix meant to prevent it.
  test("an emoji-heavy body is still bounded by UTF-16 units, not code points", () => {
    const body = "\u{1F600}".repeat(500); // 500 code points, 1000 UTF-16 units — over the 300 cap
    const clamped = clampUpstreamBody(body);
    expect(clamped.length).toBeLessThanOrEqual(301); // UTF-16 length, the unit Discord counts in
    expect(clamped.endsWith("…")).toBe(true);
  });
});

describe("clampReply", () => {
  test("passes short text through unchanged", () => {
    expect(clampReply("all good")).toBe("all good");
  });

  test("caps at the default 1900 chars and appends a truncation suffix", () => {
    const text = "y".repeat(3000);
    const clamped = clampReply(text);
    expect(clamped.length).toBe(1901); // 1900 chars + the … suffix
    expect(clamped.endsWith("…")).toBe(true);
  });

  test("text at exactly the limit is not truncated", () => {
    const text = "y".repeat(1900);
    expect(clampReply(text)).toBe(text);
  });

  test("respects a caller-supplied max", () => {
    expect(clampReply("y".repeat(20), 5)).toBe(`${"y".repeat(5)}…`);
  });

  // Same surrogate-pair hazard as clampUpstreamBody (#189 review) — pin it here too.
  test("does not split a surrogate pair sitting right at the cut point", () => {
    const emoji = "\u{1F600}";
    const text = "y".repeat(1899) + emoji + "z".repeat(10);
    const clamped = clampReply(text);
    for (let i = 0; i < clamped.length; i++) {
      const code = clamped.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        expect(clamped.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(clamped.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
      }
    }
  });

  // THE round-2 regression, pinned for clampReply too: a code-point-counting cap would let this
  // through at ~3800 UTF-16 units — nearly double Discord's real 2000-char content limit — and
  // reintroduce the exact "editReply throws, interaction left thinking" bug #186 exists to close.
  test("an emoji-heavy message is still bounded by UTF-16 units, not code points", () => {
    const text = "\u{1F600}".repeat(1900); // 1900 code points, 3800 UTF-16 units
    const clamped = clampReply(text);
    expect(clamped.length).toBeLessThanOrEqual(1901); // UTF-16 length, the unit Discord counts in
    expect(clamped.endsWith("…")).toBe(true);
  });
});

// #132: the one place every GitHub request-header shape is assembled — update.ts's read-only
// apiHeaders and this file's own fetchReleases/createIssue/ensureLabel all route through this.
describe("githubHeaders", () => {
  const realToken = config.githubToken;
  afterEach(() => {
    config.githubToken = realToken;
  });

  test("read headers (default) omit Authorization when no token is configured", () => {
    config.githubToken = "";
    const headers = githubHeaders();
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["User-Agent"]).toBe("rackbops-discord-bot");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
  });

  test("read headers include Authorization when a token is configured", () => {
    config.githubToken = "test-token";
    expect(githubHeaders().Authorization).toBe("Bearer test-token");
  });

  // The exact wording matters: this string is what an admin actually sees when a /report create-issue
  // or ensureLabel call fails for a missing token — changing it silently would be a real regression.
  test("write headers throw the exact message when no token is configured", () => {
    config.githubToken = "";
    expect(() => githubHeaders({ write: true })).toThrow("GITHUB_TOKEN is not set — cannot write to GitHub");
  });

  test("write headers add Content-Type and Authorization when a token is configured", () => {
    config.githubToken = "test-token";
    const headers = githubHeaders({ write: true });
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["User-Agent"]).toBe("rackbops-discord-bot");
  });
});

describe("createIssue — upstream body clamping (#55, #186)", () => {
  const realFetch = globalThis.fetch;
  const realToken = config.githubToken;
  afterEach(() => {
    globalThis.fetch = realFetch;
    config.githubToken = realToken;
  });

  // The mutation this guards: removing `clampUpstreamBody(...)` at github.ts's create-issue throw
  // site lets a multi-KB GitHub error page straight into the thrown message, which is exactly what
  // blows Discord's 2000-char editReply cap and strands the interaction (#55).
  test("a 5 KB GitHub 502 body yields a thrown message well under 400 chars", async () => {
    config.githubToken = "test-token";
    const bigHtmlBody = `<html><body>Bad Gateway</body></html>${"x".repeat(5000)}`;
    globalThis.fetch = (() => new Response(bigHtmlBody, { status: 502 })) as unknown as typeof fetch;
    await expect(createIssue("owner/repo", "t", "b", [])).rejects.toThrow();
    try {
      await createIssue("owner/repo", "t", "b", []);
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(400);
      expect((err as Error).message).toContain("GitHub create-issue failed: 502");
      expect((err as Error).message).toContain("Bad Gateway");
    }
  });
});

describe("decideReleaseAnnouncements", () => {
  test("a never-polled repo (undefined) seeds silently — announces nothing, remembers all", () => {
    const { toAnnounce, nextSeen } = decideReleaseAnnouncements([rel(3), rel(2), rel(1)], undefined);
    expect(toAnnounce).toEqual([]);
    expect(nextSeen).toEqual([3, 2, 1]);
  });

  test("announces only unseen releases, oldest-first, and appends them to seen", () => {
    // GitHub returns newest-first: 4 and 3 are new, 2/1 already seen.
    const { toAnnounce, nextSeen } = decideReleaseAnnouncements(
      [rel(4), rel(3), rel(2), rel(1)],
      [1, 2],
    );
    expect(toAnnounce.map((r) => r.id)).toEqual([3, 4]); // oldest-first
    expect(nextSeen).toEqual([1, 2, 3, 4]);
  });

  test("nothing new leaves seen unchanged", () => {
    const { toAnnounce, nextSeen } = decideReleaseAnnouncements([rel(2), rel(1)], [1, 2]);
    expect(toAnnounce).toEqual([]);
    expect(nextSeen).toEqual([1, 2]);
  });

  test("a repo seeded with zero releases still announces its genuine first release later", () => {
    // Seeded empty (repo had no releases at first poll) → seen is [] (defined, not undefined).
    const { toAnnounce, nextSeen } = decideReleaseAnnouncements([rel(1)], []);
    expect(toAnnounce.map((r) => r.id)).toEqual([1]);
    expect(nextSeen).toEqual([1]);
  });
});

describe("fetchReleases", () => {
  const realFetch = globalThis.fetch;
  const stub = (impl: () => Promise<Response> | Response) => {
    globalThis.fetch = impl as unknown as typeof fetch;
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const apiRelease = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    name: `v${id}`,
    tag_name: `v${id}`,
    html_url: `https://x/${id}`,
    draft: false,
    prerelease: false,
    ...over,
  });

  test("maps the API payload and drops drafts", async () => {
    stub(() => json([apiRelease(2), apiRelease(1, { draft: true })]));
    expect(await fetchReleases("owner/repo")).toEqual([
      { id: 2, name: "v2", tag: "v2", url: "https://x/2" },
    ]);
  });

  test("an unnamed release falls back to its tag", async () => {
    stub(() => json([apiRelease(1, { name: null })]));
    expect((await fetchReleases("owner/repo"))?.[0]?.name).toBe("v1");
  });

  // The whole point of the null: a repo the token can't see must not throw once a minute.
  test("404 is null — the repo is missing or invisible to the token", async () => {
    stub(() => new Response("", { status: 404 }));
    expect(await fetchReleases("roshne/artifact-console")).toBeNull();
  });

  // A repo with no releases is a 200 with [], never a 404 — so it stays distinguishable
  // from an unreachable one, and still seeds a (defined, empty) seen-id list.
  test("a releaseless repo is an empty list, not null", async () => {
    stub(() => json([]));
    expect(await fetchReleases("owner/repo")).toEqual([]);
  });

  // Everything that isn't a standing 404 stays loud: these are outages worth seeing.
  for (const status of [401, 403, 429, 500, 502]) {
    test(`${status} still throws`, async () => {
      stub(() => new Response("", { status }));
      await expect(fetchReleases("owner/repo")).rejects.toThrow(
        `GitHub releases query failed for owner/repo: ${status}`,
      );
    });
  }
});

describe("createReachabilityLog", () => {
  test("a repo that fails forever reports once, not once per poll", () => {
    const log = createReachabilityLog();
    expect(log.observe("a/b", false)).toBe("lost");
    expect(log.observe("a/b", false)).toBeNull();
    expect(log.observe("a/b", false)).toBeNull();
  });

  test("a healthy repo is silent from the start", () => {
    const log = createReachabilityLog();
    expect(log.observe("a/b", true)).toBeNull();
    expect(log.observe("a/b", true)).toBeNull();
  });

  test("coming back reports once, and can be lost again afterwards", () => {
    const log = createReachabilityLog();
    log.observe("a/b", false);
    expect(log.observe("a/b", true)).toBe("recovered");
    expect(log.observe("a/b", true)).toBeNull();
    expect(log.observe("a/b", false)).toBe("lost");
  });

  test("repos are tracked independently, so one bad repo can't mute another", () => {
    const log = createReachabilityLog();
    expect(log.observe("a/b", false)).toBe("lost");
    expect(log.observe("c/d", false)).toBe("lost");
    expect(log.observe("a/b", true)).toBe("recovered");
    expect(log.observe("c/d", false)).toBeNull();
  });
});
