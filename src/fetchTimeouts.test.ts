import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
describe("every GitHub call is timeout-bounded", () => {
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

  // Best-effort by contract: it warns rather than throwing on a bad status. What matters is that
  // it SETTLES — an unbounded hang here stalls /report just as hard as a throw would.
  test(
    "ensureLabel settles rather than hanging",
    async () => {
      config.githubToken = "test-token";
      globalThis.fetch = neverAnswers();
      await settleWithin(ensureLabel("owner/repo", "bug", TINY), "ensureLabel");
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
  // level up again. This closes that: it reads the sources and requires every `fetch(` in them to
  // carry a signal, so a new unbounded call fails here without anyone remembering to add a row.
  // Source-level for the same reason `index.test.ts` is: these modules can't be re-imported per
  // test, and the property is syntactic anyway.
  test("no fetch( in github.ts or update.ts is missing a signal", async () => {
    // Paren-balanced, not a regex: these calls close with `});`, and a first attempt at this
    // matching `\n\s*\);` found ZERO of them — so the loop body never ran and the test passed
    // vacuously while a deliberately-added unbounded sixth call sat right there. Hence the
    // explicit count assertion below: a scanner that finds nothing must fail, not pass.
    const argsOfEachFetchCall = (source: string): string[] => {
      const out: string[] = [];
      for (const m of source.matchAll(/\bfetch\(/g)) {
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

    let checked = 0;
    for (const file of ["./github.ts", "./update.ts"]) {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      for (const args of argsOfEachFetchCall(source)) {
        // Thrown rather than `expect`ed so the message can name the offending call — a bare
        // toContain on the whole argument text is unreadable, and truncating it for readability
        // is what made the first version of this assertion wrong.
        if (!args.includes("signal:")) {
          throw new Error(`${file}: a fetch( call carries no signal — ${args.trim().slice(0, 80)}`);
        }
        checked++;
      }
    }
    expect(checked).toBe(5); // the five known calls — a sixth must be added here deliberately
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
