/**
 * Await `p`, but fail loudly if it outlives `ms` instead of hanging.
 *
 * **Every timeout/bound assertion in this repo must go through this.** A regressed bound leaves
 * nothing ref'd, and bun's own per-test timeout is itself unref'd, so it cannot interrupt — the
 * suite wedges with no output until the CI job limit rather than going red. That is strictly worse
 * than having no test: a hung job gets re-run, not investigated. The `Bun.sleep` here is ref'd, so
 * it always wins that race and turns a wedge into a clean failure.
 *
 * It is also what makes an `AbortSignal.timeout` assertion work at all under a stubbed `fetch`.
 * Bun backs that signal with an UNREF'D timer, so with a socketless mock and nothing else ref'd it
 * never fires — measured. Against a real hung socket it does fire, because the in-flight socket is
 * itself a ref'd handle. This helper's ref'd sleep supplies, in the test, what the socket supplies
 * in production. Do not "simplify" it to a per-test timeout argument.
 */
export async function settleWithin<T>(
  p: Promise<T>,
  label: string,
  ms = 500,
): Promise<{ ok: true; v: T } | { ok: false; e: Error }> {
  const outcome = await Promise.race([
    p.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e: e as Error }),
    ),
    Bun.sleep(ms).then(() => null),
  ]);
  if (outcome === null) throw new Error(`${label} hung past its bound — never aborted`);
  return outcome;
}
