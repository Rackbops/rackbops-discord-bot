import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { settleWithin } from "../test/settleWithin";

const { fetchReleases, createIssue, ensureLabel, GITHUB_TIMEOUT_MS } = await import("./github");
const { fetchLatestBotSha, fetchShaRelation } = await import("./update");
const { config } = await import("./config");

/**
 * Every GitHub call carries a timeout (#88).
 *
 * Table-driven over ALL of them on purpose. A per-call-site convention is exactly what rots —
 * #130 shipped with 12 of 14 daemon calls un-boundable while the suite stayed green, because only
 * two shapes were spot-checked. The mutation this table exists to catch is deleting the `signal:`
 * from any one site.
 *
 * Both stubs model a genuinely hung socket rather than an error: one never answers at all, the
 * other answers headers and then wedges mid-body. The body case matters because these functions
 * all `await res.json()` after the fetch resolves — a bound that covered only the request would
 * miss it. (It doesn't: `AbortSignal.timeout` stays armed through the body read.)
 */
describe("every GitHub call is timeout-bounded, and every fetch(/fetchFn(/fetchImpl(/deps.fetch( call in src/ carries a signal", () => {
  // Every call takes an overridable timeout so each can be driven — and mutated —
  // independently, without waiting out the real 10s bound.
  const TINY = 20;

  const realFetch = globalThis.fetch;
  const realToken = config.githubToken;

  afterEach(() => {
    globalThis.fetch = realFetch;
    config.githubToken = realToken;
  });

  /** Never answers; rejects only when the request's signal aborts, as a hung socket would. */
  const neverAnswers = () =>
    ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
        );
      })) as unknown as typeof fetch;

  /** Headers land immediately, then the body never completes — and errors when the signal fires,
   *  which is what a real `fetch` body does. A hand-built Response ignores the signal entirely. */
  const wedgedBody = () =>
    ((_url: string, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () =>
                controller.error((init.signal as AbortSignal).reason),
              );
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )) as unknown as typeof fetch;

  // `fetchShaRelation` is deliberately absent: it never throws by contract, so it gets its own
  // outcome assertion below rather than a rejection assertion here.
  const throwingCalls: [string, () => Promise<unknown>][] = [
    ["fetchReleases", () => fetchReleases("owner/repo", TINY)],
    ["fetchLatestBotSha", () => fetchLatestBotSha(TINY)],
    ["createIssue", () => createIssue("owner/repo", "t", "b", [], TINY)],
  ];

  for (const [name, call] of throwingCalls) {
    for (const [shape, stub] of [
      ["never answers", neverAnswers],
      ["answers then wedges mid-body", wedgedBody],
    ] as const) {
      test(
        `${name} aborts when the socket ${shape}`,
        async () => {
          config.githubToken = "test-token"; // createIssue requires one
          globalThis.fetch = stub();
          const r = await settleWithin(call(), name);
          // Assert WHY it rejected, not just that it did. Without this the guard rests on an
          // unasserted precondition: drop the token line above and `createIssue` rejects with
          // "GITHUB_TOKEN is not set" instead, the suite stays green, and the mutation-catch
          // silently evaporates.
          expect(r.ok).toBe(false);
          expect((r as { e: Error }).e.name).toBe("TimeoutError");
        },
        2000,
      );
    }
  }

  // Best-effort by contract (#445, #503): it warns and reports `false` rather than throwing. What matters
  // is that it SETTLES — an unbounded hang here stalls /report just as hard as a throw would — and that
  // the timeout reads as "could not confirm the label", not as a rejection.
  test(
    "ensureLabel settles rather than hanging, and reports the label unconfirmed",
    async () => {
      config.githubToken = "test-token";
      globalThis.fetch = neverAnswers();
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const r = await settleWithin(ensureLabel("owner/repo", "bug", TINY), "ensureLabel");
        expect(r).toEqual({ ok: true, v: false });
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    },
    2000,
  );

  // fetchShaRelation swallows everything into a relation, so assert the OUTCOME, not a rejection.
  // `unknown` is what `decideUpdate` reads as the pre-ancestry fallback.
  test(
    "fetchShaRelation degrades a timeout to `unknown`, not a throw",
    async () => {
      globalThis.fetch = neverAnswers();
      const r = await settleWithin(fetchShaRelation("a".repeat(40), "b".repeat(40), TINY), "fetchShaRelation");
      expect(r).toEqual({ ok: true, v: "unknown" });
    },
    2000,
  );

  // The floor on the value, and why. Pinned so lowering it needs a deliberate edit here: a
  // timed-out compare becomes `unknown` -> `restart`, i.e. a real self-redeploy.
  test("the timeout is generous enough that a compare failure stays unlikely", () => {
    expect(GITHUB_TIMEOUT_MS).toBe(10_000);
  });

  // The table above is a hand-maintained literal list, so a SIXTH GitHub call added later is
  // simply absent from it rather than red — the same rot mode this file exists to prevent, one
  // level up again. This closes that: it reads the sources and requires every HTTP fetch in them to
  // carry a signal, so a new unbounded call fails here without anyone remembering to add a row.
  // Source-level for the same reason `index.test.ts` is: these modules can't be re-imported per
  // test, and the property is syntactic anyway. #500 item 12 widened it from github.ts and update.ts
  // to every non-test file under src/, and from the literal `fetch(` to the injected spellings
  // (`fetchFn(`, `fetchImpl(`, `deps.fetch(`) and to `signal` as a shorthand property. discord.js's
  // `client.channels.fetch(` / `users.fetch(` / `messages.fetch(` are cache reads, not HTTP calls, so a
  // `.` or word character before `fetch` keeps them out; and a line that starts as a comment is skipped
  // (docker.ts and plugins/index.ts say "fetch(" in prose), without stripping `//` globally, because the
  // URL template strings contain it. It is a NAME-based source heuristic, not a proof: a call spelled
  // `globalThis.fetch(`, `Bun.fetch(`, `fetch (`, an alias (`const f = fetch`), or a new helper name is not seen
  // at all (the count pin of eleven cannot help there), `ops/` is not scanned, and a `signal` word inside the
  // arguments only has to appear, even in a comment or an unrelated key.
  test("no fetch(, fetchFn(, fetchImpl( or deps.fetch( call in src/ is missing a signal", async () => {
    // Paren-balanced, not a regex: these calls close with `});`, and a first attempt at this
    // matching `\n\s*\);` found ZERO of them — so the loop body never ran and the test passed
    // vacuously while a deliberately-added unbounded sixth call sat right there. Hence the
    // explicit count assertion below: a scanner that finds nothing must fail, not pass.
    const CALL = /(?<![.\w])(?:fetch|fetchFn|fetchImpl)\(|\bdeps\.fetch\(/g;
    const argsOfEachFetchCall = (source: string): string[] => {
      const out: string[] = [];
      for (const m of source.matchAll(CALL)) {
        const lineStart = source.lastIndexOf("\n", m.index!) + 1;
        if (/^\s*(\/\/|\*|\/\*)/.test(source.slice(lineStart, m.index!))) continue;
        let depth = 1;
        let i = m.index! + m[0].length;
        for (; i < source.length && depth > 0; i++) {
          if (source[i] === "(") depth++;
          else if (source[i] === ")") depth--;
        }
        out.push(source.slice(m.index! + m[0].length, i - 1));
      }
      return out;
    };

    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = import.meta.dir; // the src/ directory (a URL pathname would keep %20 in a path with a space)
    const files = readdirSync(root, { recursive: true })
      .map((f) => String(f).replace(/\\/g, "/")) // Windows returns backslashes; sort and compare on one spelling
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && !f.includes("fixtures"))
      .sort();
    const sites: string[] = [];
    for (const file of files) {
      const source = await Bun.file(join(root, file)).text();
      for (const args of argsOfEachFetchCall(source)) {
        // Thrown rather than `expect`ed so the message can name the offending call — a bare
        // toContain on the whole argument text is unreadable, and truncating it for readability
        // is what made the first version of this assertion wrong.
        if (!/\bsignal\b/.test(args)) {
          throw new Error(`${file}: a fetch call carries no signal — ${args.trim().slice(0, 80)}`);
        }
        sites.push(file);
      }
    }
    // The eleven known HTTP call sites — a twelfth must be added here deliberately. Named, so a miss says which.
    expect(sites).toEqual([
      "docker.ts",
      "github.ts",
      "github.ts",
      "github.ts",
      "plugins/index.ts",
      "plugins/install.ts",
      "plugins/install.ts",
      "routing/post.ts",
      "routing/requests.ts",
      "update.ts",
      "update.ts",
    ]);
    expect(sites).toHaveLength(11);
  });

  // Pinning the constant is NOT enough on its own. Every test above drives its site with TINY, so
  // nothing above exercises the production configuration — the five `timeoutMs = GITHUB_TIMEOUT_MS`
  // defaults could each be changed to an arbitrary literal with the whole suite green (verified:
  // setting two of them to an hour left 891 pass / 0 fail). That is the same "per-call-site
  // convention rots" failure this file exists to prevent, one level up: the VALUE becomes the
  // unguarded convention. So call each site with no timeout at all and watch what it asks for.
  test("every site defaults to GITHUB_TIMEOUT_MS, not a literal of its own", async () => {
    config.githubToken = "test-token";
    globalThis.fetch = (() =>
      Promise.resolve(new Response("[]", { status: 200 }))) as unknown as typeof fetch;

    const spy = spyOn(AbortSignal, "timeout");
    try {
      await fetchReleases("owner/repo");
      await fetchLatestBotSha().catch(() => {}); // empty [] -> throws on no commits; irrelevant here
      await fetchShaRelation("a".repeat(40), "b".repeat(40));
      await createIssue("owner/repo", "t", "b", []).catch(() => {});
      await ensureLabel("owner/repo", "bug");

      expect(spy).toHaveBeenCalledTimes(5);
      for (const call of spy.mock.calls) expect(call[0]).toBe(GITHUB_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * `ensureLabel` answers whether the label exists afterwards and never throws (#445, #503 item 7): `/report`
 * files the issue without the label rather than fail over it. Mutation: removing the `try`/`catch` makes the
 * rejected-fetch row throw; returning `true` for every status makes the 500 row wrong.
 */
describe("ensureLabel reports whether the label exists, and never throws", () => {
  const realFetch = globalThis.fetch;
  const realToken = config.githubToken;
  let warn: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => {
    config.githubToken = "test-token";
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    config.githubToken = realToken;
    warn.mockRestore();
  });

  test("201 (created) and 422 (already there) are true, with no warning", async () => {
    for (const status of [201, 422]) {
      globalThis.fetch = (() => Promise.resolve(new Response("{}", { status }))) as unknown as typeof fetch;
      expect(await ensureLabel("owner/repo", "bug")).toBe(true);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test("another status is false, with one warning naming it", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch;
    expect(await ensureLabel("owner/repo", "bug")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("500");
  });

  test("a rejected fetch is false, with one warning, and never throws", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    expect(await ensureLabel("owner/repo", "bug")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("fetch failed");
  });

  test("without a token it is true and sends nothing", async () => {
    config.githubToken = undefined;
    let fetched = 0;
    globalThis.fetch = (() => {
      fetched++;
      return Promise.resolve(new Response("{}", { status: 201 }));
    }) as unknown as typeof fetch;
    expect(await ensureLabel("owner/repo", "bug")).toBe(true);
    expect(fetched).toBe(0);
  });
});
