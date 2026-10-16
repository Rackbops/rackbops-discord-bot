import { config } from "./config";

/**
 * Bound on every GitHub call (#88). Without one, a genuinely hung socket — TCP-connected, far end
 * never responds and never closes — leaves the promise unsettled forever. Since #87 that freezes
 * `guardedTick`'s shared `tickInFlight`, and worse, `update.ts`'s `checkInFlight` latch never
 * clears, so `/update` answers `busy` for the life of the process. The 5-minute tick watchdog
 * releases the former and cannot touch the latter.
 *
 * **The budget is aggregate, not per-call.** `checkReleases` walks `config.watchedRepos`
 * *serially* (`announce.ts`), so a tick's **GitHub-fetch** budget is
 * `N_repos x TIMEOUT + 2 x TIMEOUT (the update check) + 2 x 5s (the plugin index)` — at 10s,
 * `10N + 30` seconds. Five repos is 80s. It stays strictly under `TICK_WATCHDOG_MS` (300s) up to
 * **26** repos; 27 hits it exactly and 28 exceeds it. Past that, a tick that spends its whole GitHub
 * budget outlives the watchdog, which logs and frees `tickInFlight` (from about 30 repos the tick is
 * still inside `checkReleases` at that point). The next tick then starts, and the two generations do not
 * redo each other's gap-gated work: each gap-gated core check (releases, self-update, plugin updates,
 * discovery) stamps its poll time at poll START and is gated on a 15-minute gap (`announce.ts`), so the
 * new generation skips the releases walk the hung tick stamped on entry, runs -- if their own gaps have
 * elapsed -- the later checks the hung tick never reached and stamps them, and the hung tick's tail then
 * skips those in turn; the request drain is single-flight, and a plugin tick whose previous call is
 * still running is skipped (#217) -- plugin ticks carry no stamp, so the hung tick's tail runs any whose
 * previous call has finished. Two `checkReleases` walks overlap only once one walk itself outlasts
 * `RELEASE_POLL_GAP_MS` (900s) -- about 90 repos ALL hanging to the timeout -- and even then each id is
 * persisted right after its announce, so an overlap can re-announce only a release that both walks reach
 * before the first has persisted it (#438). What a tick past the watchdog does cost is the watchdog's
 * error line and a generation running beside the hung one's tail (the hung tick also keeps its hold on
 * the critical section until it ends, as before). Adding many watched repos still means revisiting this
 * budget.
 *
 * Deliberately "GitHub-fetch budget" and not "the tick's worst case": the same tick can also spend
 * discord.js REST retries per announced release, and on the `restart` path a whole `redeploy()`
 * under `BUILD_TIMEOUT_MS`. A tick's genuine worst case exceeds the watchdog at any repo count.
 *
 * Not tighter than 10s: a timed-out `fetchShaRelation` degrades to `relation: "unknown"`, which
 * `decideUpdate` resolves to **`"restart"`** — a real self-redeploy. On the exit-75 fallback the
 * `attemptedUpdateToSha` marker suppresses the repeat, but on the socket-mounted path the swap
 * *succeeds*, and since `redeploy` builds the exact compared sha, a running build that was `ahead`
 * gets swapped onto an OLDER commit — after which the replacement reads `current` and clears the
 * marker, so nothing reverts it. Pre-existing (any compare 5xx did this too), but it is why this
 * value should stay generous.
 */
export const GITHUB_TIMEOUT_MS = 10_000;

/** One page of a repo's releases per poll (#499): the newest `RELEASES_PER_PAGE`, drafts dropped afterwards.
 *  `checkRepoReleases` warns when a whole page is new, since anything older is never fetched. */
export const RELEASES_PER_PAGE = 15;

export interface Release {
  id: number;
  name: string;
  tag: string;
  url: string;
  /** GitHub's pre-release flag; the announcement says "pre-release" for one (#499). */
  prerelease: boolean;
}

/**
 * A watched repo's releases, or `null` when GitHub answers 404 — the repo doesn't exist, or
 * `GITHUB_TOKEN` can't see it (GitHub deliberately 404s a private repo rather than 403ing it,
 * so the two are indistinguishable from here). That is a standing condition, not a blip, so it
 * returns rather than throws and lets the caller skip the repo quietly; every other failure —
 * a rate-limit hit (a 403 or 429 with `x-ratelimit-remaining: 0`, whose message names the reset time
 * and `GITHUB_TOKEN`, #500), 401 bad token, 5xx — still throws, so a real outage stays loud. A repo
 * with no releases answers 200 with `[]`, so it never reaches the 404 path.
 */
export async function fetchReleases(repo: string, timeoutMs = GITHUB_TIMEOUT_MS): Promise<Release[] | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 404) return null;
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    // #500 item 10: GitHub answers a primary rate-limit hit with a 403 or a 429 and `x-ratelimit-remaining: 0`
    // (its REST docs); the unauthenticated limit is 60 requests an hour per address. Say when it resets and what
    // lifts it, instead of a bare status per repo per poll.
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const resetAt = new Date(reset * 1000);
    // A missing, non-numeric, zero or out-of-range (Infinity, 1e20: an Invalid Date, which toISOString throws on) value
    // is "unknown", never a thrown RangeError that would swallow this message.
    const at = reset > 0 && !Number.isNaN(resetAt.getTime()) ? resetAt.toISOString() : "an unknown time";
    throw new Error(`GitHub rate limit exhausted (releases query for ${repo}) — resets at ${at}; set GITHUB_TOKEN to raise it`);
  }
  if (!res.ok) throw new Error(`GitHub releases query failed for ${repo}: ${res.status}`);
  const data = (await res.json()) as {
    id: number;
    name: string | null;
    tag_name: string;
    html_url: string;
    draft: boolean;
    prerelease: boolean;
  }[];
  return data
    .filter((r) => !r.draft)
    // `||` and a trim, not `??` (#499): an empty or blank name is as nameless as a null one, and would render as `****`.
    .map((r) => ({ id: r.id, name: r.name?.trim() || r.tag_name, tag: r.tag_name, url: r.html_url, prerelease: r.prerelease }));
}

export interface ReleaseAnnouncements {
  /** Releases to post now, oldest-first: GitHub's list reversed (newest first in practice; the API docs name no
   *  sort key), which is publish order for ordinary tagging and not necessarily for a release cut later from an
   *  older commit. */
  toAnnounce: Release[];
  /** The repo's new seen-id list to persist. */
  nextSeen: number[];
}

/**
 * Decide what to announce for one repo. `seen` is the repo's persisted seen-id list, or
 * `undefined` when it has never been polled — the first poll seeds silently (announce
 * nothing, remember everything) so a freshly watched repo never dumps its backlog. A repo
 * seeded with no releases keeps a defined (empty) list, so its genuine first release later
 * still announces.
 */
export function decideReleaseAnnouncements(
  releases: Release[],
  seen: number[] | undefined,
): ReleaseAnnouncements {
  if (seen === undefined) return { toAnnounce: [], nextSeen: releases.map((r) => r.id) };
  const seenSet = new Set(seen);
  const toAnnounce = releases.filter((r) => !seenSet.has(r.id)).reverse();
  return { toAnnounce, nextSeen: [...seen, ...toAnnounce.map((r) => r.id)] };
}

export type ReachabilityTransition = "lost" | "recovered";

export interface ReachabilityLog {
  /**
   * Record one observation of `repo` and report whether it changed state: `"lost"` on the
   * first failure, `"recovered"` when it answers again, `null` while it stays as it was.
   * Log only on a transition and a repo that is unreachable for good reports itself once
   * instead of once per poll.
   */
  observe(repo: string, reachable: boolean): ReachabilityTransition | null;
  /** How many repos are recorded unreachable right now (what the test-state guard reads). */
  unreachableCount(): number;
}

/** Deliberately in-memory: a restart re-reports a still-unreachable repo exactly once, which
 * is the right amount of noise after a redeploy. */
export function createReachabilityLog(): ReachabilityLog {
  const unreachable = new Set<string>();
  return {
    observe(repo, reachable) {
      if (reachable) return unreachable.delete(repo) ? "recovered" : null;
      if (unreachable.has(repo)) return null;
      unreachable.add(repo);
      return "lost";
    },
    unreachableCount: () => unreachable.size,
  };
}

export interface CreatedIssue {
  number: number;
  url: string;
}

/**
 * `text.slice(0, max)` bounds UTF-16 code units — the same unit Discord's content-length limit
 * counts in — but can cut a surrogate pair (e.g. an emoji) in half, leaving a lone high surrogate
 * at the end that mangles on the way out. Dropping that one trailing unit keeps the true
 * ≤`max`-unit bound (round 2 of #189's review: an earlier fix switched to counting *code points*
 * instead, which silently let an emoji-heavy body through roughly 2x over Discord's real cap).
 * Exported for `report.ts`'s `reportAnnouncement` (#445): a UTF-16 slice that never ends in a high surrogate.
 */
export function sliceUtf16(text: string, max: number): string {
  const cut = text.slice(0, max);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Clamp raw upstream text before it's embedded in a thrown message: first line only (a GitHub
 * 5xx can answer with several KB of HTML), trimmed and capped to `max` chars with a `…` suffix on
 * truncation. Applied at every `res.text()` embed under `src/` that can end up in an `Error`
 * message — without it, a long body blows Discord's 2000-char reply cap and `editReply` throws,
 * leaving the interaction "thinking" until the token expires (#55, #186).
 */
export function clampUpstreamBody(text: string, max = 300): string {
  const line = (text.split("\n")[0] ?? "").trim();
  return line.length > max ? `${sliceUtf16(line, max)}…` : line;
}

/**
 * Defensive clamp for anything about to go into an `editReply` failure path. `clampUpstreamBody`
 * already bounds what an upstream body contributes to an `Error.message`, but a failure message
 * can carry other text too (a thrown validation error, a stack-free JS error) — this is the last
 * line of defense so *any* long message can't strand the interaction, not just an upstream one.
 */
export function clampReply(text: string, max = 1900): string {
  return text.length > max ? `${sliceUtf16(text, max)}…` : text;
}

/**
 * #132: the one place every GitHub request-header shape in this repo's `src/` is assembled
 * (`update.ts`'s `fetchLatestBotSha`/`fetchShaRelation` call this directly -- update.ts's own
 * former `apiHeaders` wrapper is gone, folded into this function). Default (read) is
 * Accept + User-Agent, plus `Authorization` when a token is configured -- reading is fine
 * unauthenticated, just rate-limited harder. `{ write: true }` additionally REQUIRES a token
 * (this repo's only write paths, `createIssue`/`ensureLabel`, need `repo`/`issues:write` scope) and
 * adds `Content-Type`. `ops/admin/server.ts`'s own copies are a separate package with a different
 * User-Agent (`rackbops-admin-panel`) -- deliberately not consolidated with this one.
 */
export function githubHeaders(opts?: { write?: boolean }): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "rackbops-discord-bot",
  };
  if (opts?.write) {
    if (!config.githubToken) throw new Error("GITHUB_TOKEN is not set — cannot write to GitHub");
    headers["Content-Type"] = "application/json";
  }
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;
  return headers;
}

/** Create a GitHub issue. Requires GITHUB_TOKEN with issues:write on `repo`. */
export async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels: string[],
  timeoutMs = GITHUB_TIMEOUT_MS,
): Promise<CreatedIssue> {
  // Bounded like the read paths. Not tick-reachable — this runs from `/report` — but `ensureLabel`
  // and `createIssue` are awaited back-to-back in `report.ts`, so an unbounded hang here leaves the
  // user's interaction dead with no follow-up, and the worst case is 2x the timeout.
  const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: githubHeaders({ write: true }),
    body: JSON.stringify({ title, body, labels }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`GitHub create-issue failed: ${res.status} ${clampUpstreamBody(await res.text())}`);
  const data = (await res.json()) as { number: number; html_url: string };
  return { number: data.number, url: data.html_url };
}

/** Idempotently ensure a label exists: `true` when it does afterwards (201 created; 422, which with a constant
 *  name and colour reads as "already exists" here — GitHub documents it as a validation failure, or throttling, not as "already exists"), `false` when it could not be confirmed (another
 *  status, a network error, the timeout) — logged, never thrown, so a caller can file without the label rather
 *  than fail the report over it (#445, #503). `true` without a token too: create-issue cannot run without one
 *  either, and the caller refuses earlier. */
export async function ensureLabel(repo: string, name: string, timeoutMs = GITHUB_TIMEOUT_MS): Promise<boolean> {
  if (!config.githubToken) return true;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/labels`, {
      method: "POST",
      headers: githubHeaders({ write: true }),
      body: JSON.stringify({ name, color: "ededed" }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok || res.status === 422) return true;
    console.warn(`ensureLabel "${name}" on ${repo}: ${res.status}`);
    return false;
  } catch (err) {
    console.warn(`ensureLabel "${name}" on ${repo}: ${(err as Error).message}`);
    return false;
  }
}
