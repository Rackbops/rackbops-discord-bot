import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WarbandeerDeps } from "./server";
import { loadCharacterSnapshotsFrom } from "./characters";
import { mintLinkCode, removeLinkedAccount, type LinksState } from "./links";
// server.ts imports the `config` singleton (resolved from process.env at import time), so
// prime the required vars before pulling the module in — see config.test.ts / state.test.ts.
// (The type-only import above is erased at compile time and never runs server.ts itself.)
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
const { createProductionDeps, createRateLimiter, handleRequest, startWarbandeerServer, warbandeerServerRunning } =
  await import("./server");

describe("createRateLimiter", () => {
  test("allows up to max calls within the window, then rejects", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: () => 0 });
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(false);
  });

  test("resets after the window elapses", () => {
    let t = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(false);
    t = 1001;
    expect(limiter.allow("k")).toBe(true);
  });

  test("tracks each key independently", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => 0 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(false);
  });
});

// A permissive default deps object every test overrides pieces of — mirrors
// ops/admin/server.test.ts's DI'd handleRequest style, no real Bun.serve listener bound.
function makeDeps(overrides: Partial<WarbandeerDeps> = {}): WarbandeerDeps {
  return {
    maxBodyBytes: 1024,
    rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
    authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
    redeemCode: async () => ({ ok: true, token: "device-token" }),
    authenticate: () => ({ discordUserId: "1", accountLabel: "Main" }),
    storeCharacters: async () => ({ ok: true }),
    ...overrides,
  };
}

function req(method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(`http://x${path}`, { method, body: opts.body, headers: opts.headers });
}

describe("handleRequest — POST /link", () => {
  test("mints a token on a valid redemption", async () => {
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code: "ABC12345", accountLabel: "Main" }) }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "device-token" });
  });

  test("400s when code or accountLabel is missing", async () => {
    const res = await handleRequest(req("POST", "/link", { body: JSON.stringify({ code: "ABC12345" }) }), "1.2.3.4", makeDeps());
    expect(res.status).toBe(400);
  });

  test("surfaces the redeem failure's own message", async () => {
    const deps = makeDeps({ redeemCode: async () => ({ ok: false, error: "code expired" }) });
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code: "ABC12345", accountLabel: "Main" }) }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("code expired");
  });

  test("429s once the per-IP rate limit trips", async () => {
    const deps = makeDeps({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) });
    const body = JSON.stringify({ code: "ABC12345", accountLabel: "Main" });
    const first = await handleRequest(req("POST", "/link", { body }), "1.2.3.4", deps);
    const second = await handleRequest(req("POST", "/link", { body }), "1.2.3.4", deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  test("a different IP gets its own rate-limit bucket", async () => {
    const deps = makeDeps({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) });
    const body = JSON.stringify({ code: "ABC12345", accountLabel: "Main" });
    const first = await handleRequest(req("POST", "/link", { body }), "1.2.3.4", deps);
    const second = await handleRequest(req("POST", "/link", { body }), "5.6.7.8", deps);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  test("400s an accountLabel over the length cap", async () => {
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code: "ABC12345", accountLabel: "x".repeat(65) }) }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test("400s an empty accountLabel", async () => {
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code: "ABC12345", accountLabel: "   " }) }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test("normalizes the submitted code (trims whitespace, uppercases) before redeeming", async () => {
    let receivedCode: string | undefined;
    const deps = makeDeps({
      redeemCode: async (code) => {
        receivedCode = code;
        return { ok: true, token: "t" };
      },
    });
    await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code: "  abc12345  ", accountLabel: "Main" }) }),
      "1.2.3.4",
      deps,
    );
    expect(receivedCode).toBe("ABC12345");
  });
});

describe("handleRequest — POST /characters", () => {
  test("204s on a successful authenticated push", async () => {
    const res = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(204);
  });

  test("401s with no Authorization header", async () => {
    const res = await handleRequest(req("POST", "/characters", { body: "{}" }), "1.2.3.4", makeDeps());
    expect(res.status).toBe(401);
  });

  test("401s on a garbage Authorization header (not Bearer-shaped)", async () => {
    const res = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "garbage" } }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(401);
  });

  test("401s on a well-formed but unknown token", async () => {
    const deps = makeDeps({ authenticate: () => undefined });
    const res = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer nope" } }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(401);
  });

  test("413s an oversized body (streamed check) without ever calling storeCharacters", async () => {
    let called = false;
    const deps = makeDeps({
      maxBodyBytes: 10,
      storeCharacters: async () => {
        called = true;
        return { ok: true };
      },
    });
    const res = await handleRequest(
      req("POST", "/characters", { body: "x".repeat(1000), headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(413);
    expect(called).toBe(false);
  });

  test("413s on a declared-oversized Content-Length before the body is ever read", async () => {
    let called = false;
    const deps = makeDeps({
      maxBodyBytes: 10,
      storeCharacters: async () => {
        called = true;
        return { ok: true };
      },
    });
    // The actual body is tiny; only the header lies. The pre-check must reject on the header
    // alone — this proves it runs and doesn't depend on the streamed byte-count check.
    const res = await handleRequest(
      req("POST", "/characters", {
        body: "{}",
        headers: { Authorization: "Bearer real-token", "Content-Length": "999999" },
      }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(413);
    expect(called).toBe(false);
  });

  test("400s invalid JSON", async () => {
    const res = await handleRequest(
      req("POST", "/characters", { body: "{not json", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  test("surfaces a validation failure from storeCharacters as 400", async () => {
    const deps = makeDeps({ storeCharacters: async () => ({ ok: false, error: "characters must be an array" }) });
    const res = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("characters must be an array");
  });

  test("429s once the per-token rate limit trips, keyed by TOKEN not IP", async () => {
    // Same token, DIFFERENT IPs — if the limit were actually keyed by IP (or by the shared
    // characters-ip bucket) rather than by token, the second call would use a fresh bucket and
    // pass. It doesn't: proves the per-token key is what's actually enforced.
    const deps = makeDeps({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) });
    const first = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      deps,
    );
    const second = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "5.6.7.8",
      deps,
    );
    expect(first.status).toBe(204);
    expect(second.status).toBe(429);
  });

  test("a request from a different token gets its own rate-limit bucket", async () => {
    const deps = makeDeps({
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
      authenticate: (token) => ({ discordUserId: token, accountLabel: "Main" }),
    });
    // Different IPs too, so only the per-token bucket (not the pre-auth per-IP one) is under
    // test here — same-IP-different-token is covered by the pre-auth IP limiter's own tests
    // below, which is a real, separate bucket that a shared same-IP call would also trip.
    const first = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer token-a" } }),
      "1.2.3.4",
      deps,
    );
    const second = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer token-b" } }),
      "5.6.7.8",
      deps,
    );
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
  });

  test("an unauthenticated flood from one IP is rate-limited (on the separate authFailureLimiter) before authenticate is even called", async () => {
    let authCalls = 0;
    const deps = makeDeps({
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
      authenticate: () => {
        authCalls += 1;
        return undefined;
      },
    });
    const first = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer nope" } }),
      "9.9.9.9",
      deps,
    );
    const second = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer nope" } }),
      "9.9.9.9",
      deps,
    );
    expect(first.status).toBe(401);
    expect(second.status).toBe(429); // the SECOND request never even reaches authenticate
    expect(authCalls).toBe(1);
  });

  test("the unauthenticated-IP rate limit is independent per IP", async () => {
    const deps = makeDeps({
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }),
      authenticate: () => undefined,
    });
    const first = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer nope" } }),
      "1.1.1.1",
      deps,
    );
    const second = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer nope" } }),
      "2.2.2.2",
      deps,
    );
    expect(first.status).toBe(401);
    expect(second.status).toBe(401); // not 429 — a different IP, its own bucket
  });

  test("the pre-auth IP bucket is charged on every request, success or failure (known tradeoff — see docs/adr/0001)", async () => {
    // NOT a guarantee that success is exempt — it isn't. This pins the actual current behavior
    // (a higher ceiling than the per-token limit is the mitigation, not exemption) so a future
    // change to "only charge on failure" is a deliberate decision, not an accidental regression
    // either direction.
    const deps = makeDeps({ authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) });
    const success = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      deps,
    );
    const next = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: "Bearer real-token" } }),
      "1.2.3.4",
      deps,
    );
    expect(success.status).toBe(204);
    expect(next.status).toBe(429); // the successful request above already spent the one slot
  });
});

describe("handleRequest — unknown routes", () => {
  test("404s anything else", async () => {
    const res = await handleRequest(req("GET", "/"), "1.2.3.4", makeDeps());
    expect(res.status).toBe(404);
  });
});

/**
 * Exercises the REAL auth + persistence wiring end to end — every other suite above injects a
 * fake `WarbandeerDeps`. Uses `createProductionDeps`'s `overrides` (a fresh in-memory
 * `LinksState`, a no-op `persistLinks`, and a temp `charactersBaseDir` per test) so this never
 * touches the real `data/links.json`/`data/characters/` — round 2 of review flagged an earlier
 * version of this suite for writing through the real singleton, which risked clobbering an
 * operator's actual link data if `bun test` were ever run against a live bot's data directory.
 * This is exactly the seam where this connector's most serious defects hid behind an all-stubs
 * test suite (concurrent-write data loss, and zero coverage that `authenticate` resolves the
 * RIGHT account rather than e.g. always the first one) — real `redeemLinkCode`/
 * `upsertLinkedAccount`/`findAccountByToken`/`saveCharacterSnapshotTo` all run for real here, just
 * against throwaway state instead of the live files.
 */
describe("createProductionDeps — real auth + persistence wiring", () => {
  let localLinksState: LinksState;
  let charactersDir: string;

  beforeEach(() => {
    localLinksState = { pending: [], accounts: {} };
    charactersDir = mkdtempSync(join(tmpdir(), "warbandeer-server-realwiring-test-"));
  });
  afterEach(() => {
    rmSync(charactersDir, { recursive: true, force: true });
  });

  function realDeps(): WarbandeerDeps {
    return createProductionDeps({
      linksState: localLinksState,
      persistLinks: async () => {},
      charactersBaseDir: charactersDir,
    });
  }

  let nextId = 100000000000000000n;
  function freshId(): string {
    nextId += 1n;
    return nextId.toString();
  }

  /** Mints+redeems a code the way `/link` really does, against the local throwaway state. */
  async function linkRealAccount(deps: WarbandeerDeps, discordUserId: string, accountLabel: string): Promise<string> {
    const { code, state } = mintLinkCode(localLinksState, discordUserId, Date.now());
    localLinksState.pending = state.pending;
    localLinksState.accounts = state.accounts;
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code, accountLabel }) }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  test("mint -> POST /link -> POST /characters resolves and stores under the RIGHT account", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    const token = await linkRealAccount(deps, discordUserId, "Main");

    const pushRes = await handleRequest(
      req("POST", "/characters", {
        body: JSON.stringify({ characters: [{ realm: "Test" }] }),
        headers: { Authorization: `Bearer ${token}` },
      }),
      "1.2.3.4",
      deps,
    );
    expect(pushRes.status).toBe(204);

    const stored = await loadCharacterSnapshotsFrom(charactersDir, discordUserId);
    expect(stored.snapshots).toHaveLength(1);
    expect(stored.snapshots[0]?.accountLabel).toBe("Main");
    expect(stored.snapshots[0]?.characters).toEqual([{ realm: "Test" }]);
  });

  test("a user's token can never write into a DIFFERENT user's file", async () => {
    const userA = freshId();
    const userB = freshId();
    const deps = realDeps();
    const tokenA = await linkRealAccount(deps, userA, "Main");
    await linkRealAccount(deps, userB, "Main");

    const pushAsA = await handleRequest(
      req("POST", "/characters", {
        body: JSON.stringify({ characters: [{ tag: "belongs-to-A" }] }),
        headers: { Authorization: `Bearer ${tokenA}` },
      }),
      "1.2.3.4",
      deps,
    );
    expect(pushAsA.status).toBe(204);

    const [storedA, storedB] = await Promise.all([
      loadCharacterSnapshotsFrom(charactersDir, userA),
      loadCharacterSnapshotsFrom(charactersDir, userB),
    ]);
    expect(storedA.snapshots).toHaveLength(1);
    expect(storedB.snapshots).toHaveLength(0);
  });

  test("unlink actually revokes — a later push with the old token 401s", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    const token = await linkRealAccount(deps, discordUserId, "Main");

    const removal = removeLinkedAccount(localLinksState, discordUserId, "Main");
    expect(removal).toBeDefined();
    if (removal) localLinksState.accounts = removal.state.accounts;

    const pushRes = await handleRequest(
      req("POST", "/characters", { body: "{}", headers: { Authorization: `Bearer ${token}` } }),
      "1.2.3.4",
      deps,
    );
    expect(pushRes.status).toBe(401);
  });

  test("concurrent pushes for the same user's two linked accounts both land — end-to-end regression for the storage fix", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    const tokenMain = await linkRealAccount(deps, discordUserId, "Main");
    const tokenAlts = await linkRealAccount(deps, discordUserId, "Alts");

    const [resMain, resAlts] = await Promise.all([
      handleRequest(
        req("POST", "/characters", {
          body: JSON.stringify({ characters: [{ tag: "main" }] }),
          headers: { Authorization: `Bearer ${tokenMain}` },
        }),
        "1.2.3.4",
        deps,
      ),
      handleRequest(
        req("POST", "/characters", {
          body: JSON.stringify({ characters: [{ tag: "alts" }] }),
          headers: { Authorization: `Bearer ${tokenAlts}` },
        }),
        "1.2.3.4",
        deps,
      ),
    ]);
    expect(resMain.status).toBe(204);
    expect(resAlts.status).toBe(204);

    const stored = await loadCharacterSnapshotsFrom(charactersDir, discordUserId);
    expect(stored.snapshots.map((s) => s.accountLabel).sort()).toEqual(["Alts", "Main"]);
  });

  test("a 21st linked account is rejected once MAX_LINKED_ACCOUNTS_PER_USER is reached", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    for (let i = 0; i < 20; i++) {
      await linkRealAccount(deps, discordUserId, `Label${i}`);
    }
    const { code, state } = mintLinkCode(localLinksState, discordUserId, Date.now());
    localLinksState.pending = state.pending;
    localLinksState.accounts = state.accounts;
    const res = await handleRequest(
      req("POST", "/link", { body: JSON.stringify({ code, accountLabel: "OneTooMany" }) }),
      "1.2.3.4",
      deps,
    );
    expect(res.status).toBe(400);
    expect(localLinksState.accounts[discordUserId]).toHaveLength(20);
  });

  test("re-linking an EXISTING label at the cap still works (rotate, not append)", async () => {
    const discordUserId = freshId();
    const deps = realDeps();
    for (let i = 0; i < 20; i++) {
      await linkRealAccount(deps, discordUserId, `Label${i}`);
    }
    // Re-linking "Label0" (already present) must not be treated as a 21st NEW account.
    const newToken = await linkRealAccount(deps, discordUserId, "Label0");
    expect(localLinksState.accounts[discordUserId]).toHaveLength(20);
    const owner = deps.authenticate(newToken);
    expect(owner?.accountLabel).toBe("Label0");
  });
});

/**
 * Exercises the real `Bun.serve` wiring `startWarbandeerServer` sets up — a real listening
 * socket (port 0 = OS-assigned free port), real `fetch()` calls, real header/IP resolution.
 * Fake `WarbandeerDeps` throughout, so this never touches `links.json`/`data/characters/` — it's
 * testing the HTTP transport layer, not the auth/persistence wiring (see the suite above for
 * that).
 */
describe("startWarbandeerServer — real listener", () => {
  test("serves real HTTP requests end to end and tracks running state", async () => {
    const deps: WarbandeerDeps = {
      maxBodyBytes: 1024,
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      redeemCode: async () => ({ ok: true, token: "device-token" }),
      authenticate: () => undefined,
      storeCharacters: async () => ({ ok: true }),
    };
    expect(warbandeerServerRunning()).toBe(false);
    const { stop, port } = startWarbandeerServer(0, deps); // 0 = OS-assigned free port
    try {
      expect(warbandeerServerRunning()).toBe(true);
      expect(port).toBeGreaterThan(0);

      const notFound = await fetch(`http://localhost:${port}/nope`);
      expect(notFound.status).toBe(404);

      const linked = await fetch(`http://localhost:${port}/link`, {
        method: "POST",
        body: JSON.stringify({ code: "ABC12345", accountLabel: "Main" }),
      });
      expect(linked.status).toBe(200);
      expect(await linked.json()).toEqual({ token: "device-token" });
    } finally {
      stop();
      expect(warbandeerServerRunning()).toBe(false);
    }
  });

  test("an oversized body over REAL HTTP gets a clean 413, not a dropped connection", async () => {
    // Round-2 finding: with Bun.serve's maxRequestBodySize set equal to deps.maxBodyBytes, Bun's
    // own transport-layer limit fired FIRST and reset the connection (ECONNRESET) before
    // readBodyWithCap's app-level check ever ran — the documented 413 was unreachable in
    // production despite passing in unit tests that call handleRequest directly. This is the
    // regression test: a real fetch() over a real socket must see 413, not a thrown network error.
    const deps: WarbandeerDeps = {
      maxBodyBytes: 1024,
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      redeemCode: async () => ({ ok: true, token: "t" }),
      authenticate: () => ({ discordUserId: "1", accountLabel: "Main" }),
      storeCharacters: async () => ({ ok: true }),
    };
    const { stop, port } = startWarbandeerServer(0, deps);
    try {
      const res = await fetch(`http://localhost:${port}/characters`, {
        method: "POST",
        headers: { Authorization: "Bearer t" },
        body: "x".repeat(5000), // over deps.maxBodyBytes, well under maxRequestBodySize
      });
      expect(res.status).toBe(413);
    } finally {
      stop();
    }
  });

  test("a second listener sees the running flag through both starts", async () => {
    const deps: WarbandeerDeps = {
      maxBodyBytes: 1024,
      rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      authFailureLimiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      redeemCode: async () => ({ ok: true, token: "t" }),
      authenticate: () => undefined,
      storeCharacters: async () => ({ ok: true }),
    };
    const first = startWarbandeerServer(0, deps);
    first.stop();
    expect(warbandeerServerRunning()).toBe(false);
    const second = startWarbandeerServer(0, deps);
    expect(warbandeerServerRunning()).toBe(true);
    second.stop();
    expect(warbandeerServerRunning()).toBe(false);
  });
});
