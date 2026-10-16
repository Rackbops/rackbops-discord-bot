<!-- Plan for #530 bundle L2 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #530): the Low items in the release
path -- #499 (all five items) and what #500 left unaddressed when it was closed (items 10 and 12). Written by the
orchestrating session on 2026-10-16 against the R3 head `4fa85aa` (PR #571; main @ `57596b8` plus R3's tests and text);
audited read-only before it was committed (round 1: three blockers, all applied -- the widened fetch scan matched two
comment lines; the page-warning test let its `every(...)` guard and its first-poll guard be deleted, because the
resulting TypeError is swallowed by the per-repo catch; the rate-limit test let `=== "0"` be loosened and never reached
the "unknown time" branch; and GitHub answers a limit hit with a 429 as well as a 403 -- plus the self-update cost,
"only"-claims and `.env.example` facts corrected). #571 merged as 146fdc5 while this was audited, so main now holds
R3's text and tests and the lines below hold on main. Round 2 found no blocker: the "what can still re-post" lists
gained the stale-snapshot path (#507), two sentences gained the 429, the 14-release case now re-seeds, G3 is nested
in the fetchReleases describe, and the scan is credited to `fetchTimeouts.test.ts`. The implementer re-reads each one on the tree it works from and corrects any that moved. Nothing else in
flight touches these files (L1 edits `commands.ts`/`report.ts`; S4b edits `redeploy.ts`/`index.ts`). -->

## Implementation plan -- #530 L2: the release path's Lows -- pin the per-repo wiring, say when a page overflowed, stop a walk when a stop is pending, mark pre-releases, bound the name, name the rate limit, and scan every fetch

Children: **#499** (items 4-8 -- closes it) and **#500** items **10** and **12** (#500 is already closed: its item 9
landed in PR #566, item 11's shape check in PR #552 with the case-insensitive remainder roshne's live-data-path call,
item 13 is #507's under #526; this bundle finishes 10 and 12, after which #500's box on #530 is ticked). One PR, branch
`fix/530-L2-releases`, worktree `S:\Repos\_wt\rdb-530-L2` cut from `origin/main` **after PR #571 (R3) has merged**
(this bundle extends R3's T-F and the texts R3 rewrote). Behaviour changes (new log lines, a pre-release marker, a
name fallback and clamp, a walk that stops, a rate-limit message) -> the **three-reviewer gate** applies; every changed
line mutation-tested in a scratch worktree.

### What is wrong, verified at `4fa85aa`

- **#499 item 4 (per-repo wiring unpinned).** R3's T-F (`src/announce.test.ts:507-536`) now drives
  `checkRepoReleases` through a 404 and a recovery and pins the URL (`per_page=15`), the announcement text and the
  persisted list. Still unpinned at that level: the request carries `githubHeaders()` (`src/github.ts:62` ->
  `:184-195`: `Authorization: Bearer <token>` when `config.githubToken` is set, `Accept`, `User-Agent`; mutate
  `:62` to `headers: {}` and the suite stays green, since `github.test.ts:149-172` pins `githubHeaders` in
  isolation), and the two reachability log lines (`src/announce.ts:482-485` warn on "lost", `:495` log on
  "recovered"; T-F silences both spies and asserts nothing about them).
- **#499 item 5 (one page, no warning).** `fetchReleases` asks for `per_page=15` (`:61`), one page, drafts dropped
  after the fetch (`:76`). A repo that published more non-draft releases than that between two polls (or whose
  older release sorts behind 15 newer ones) never has the rest fetched, announced or recorded, and nothing says so.
  `ReleaseAnnouncements.toAnnounce`'s comment (`:81`) says "oldest-first (so a burst reads in publish order)";
  the order is GitHub's list order reversed (newest-first by creation), which is publish order for ordinary
  tagging and not otherwise.
- **#499 item 6 ("restarts never re-announce" is at-least-once).** `CONTEXT.md:237` ("Restarts never
  re-announce.") and `README.md:238` ("restarts never repeat an announcement"). `commitReleaseAnnouncements`
  (`src/announce.ts:516-536`) posts (`:532`) and then persists (`:534`), two awaits; an exit between them, a
  `saveState` that fails (or a save lost before it reaches disk: `src/state.ts:78` does not fsync), or two
  walks overlapping (`src/github.ts`'s header) re-posts a release on the next poll. `src/state.ts:20` states the
  same "never" ("Persisted so restarts never re-announce something already posted."). A restart is protected by
  the tick's critical section, but `checkReleases` (`:455-470`) never consults `restartPending()` between repos,
  so a pending shutdown (which waits for the section only up to its grace) walks every remaining repo.
- **#499 item 7 (pre-releases).** `fetchReleases` parses `prerelease` (`:73`) and drops it (`:77`); the
  announcement (`src/announce.ts:498`) says "New release" for a `v2.0.0-rc.1` too, and the final release posts a
  second time. No doc or test says which was meant; every fixture sets `prerelease: false`
  (`github.test.ts:255`, `announce.test.ts:513`).
- **#499 item 8 (name unbounded, empty name).** `name: r.name ?? r.tag_name` (`:77`) falls back on `null` only, so
  an empty-string name renders as `****`; the announcement (`:498`) interpolates the name with no length bound,
  while every other user-visible string in the repo is clamped (`clampReply`, `sliceUtf16`). A name long enough
  to push the post past Discord's 2000 units makes `send` reject every poll, and since `commitReleaseAnnouncements`
  throws on the first failed post, that release and every newer one for the repo wait until it leaves the
  15-window. The issue also suggests skipping a release that fails with a non-rate-limit 4xx; see Decision 5.
- **#500 item 10 (no rate-limit handling).** Without `GITHUB_TOKEN`, GitHub allows 60 requests an hour per address;
  each watched repo costs four an hour (`RELEASE_POLL_GAP_MS` 15 min) and, with `AUTO_UPDATE=true`
  (`src/config.ts:180` defaults it off), the self-update check one more per poll -- two when the running build
  differs from the newest commit, since the compare call is made only then (`src/update.ts:264-269`) -- so around
  14 repos exhaust it and later repos answer 403 (GitHub's docs: a primary-limit hit is a 403 or a 429 with
  `x-ratelimit-remaining: 0`) on every poll, each logged by the per-repo catch (`src/announce.ts:466-468`) as
  "GitHub releases query failed for X: 403" with no hint. `README.md:33` (which documents `WATCHED_REPOS` and
  `GITHUB_TOKEN`) says nothing about it and `.env.example:25` says only that the token "raises the rate limit",
  with no numbers. ETag/`If-None-Match` is not implemented.
- **#500 item 12 (the timeout scan's scope).** `src/fetchTimeouts.test.ts:21` titles the describe "every GitHub
  call is timeout-bounded"; its source scan (`:135-168`) reads only `./github.ts` and `./update.ts`, matches only
  the literal `fetch(` (`:142`), requires `signal:` with a colon (`:161`) and pins `checked` at 5 (`:167`). A call
  through `fetchFn(`/`fetchImpl(`/`deps.fetch(`, or in another module, or passing `signal` as a shorthand
  property, is outside it. `CONTEXT.md:196` says "All five calls carry `AbortSignal.timeout(GITHUB_TIMEOUT_MS)`"
  in the `github.ts` row, which has three (the other two are `update.ts`'s). The real HTTP call sites in `src/`
  (every one already carries a signal, checked by reading each): `github.ts:61`, `:208`, `:227`; `update.ts:116`,
  `:149`; `docker.ts:109` (shorthand `signal`); `plugins/index.ts:171` (`fetchFn`); `plugins/install.ts:182`
  (`fetchImpl`), `:390` (`deps.fetch`); `routing/requests.ts:330` and `routing/post.ts:150` (`fetchFn`). Eleven.
  discord.js's `client.channels.fetch(` / `users.fetch(` / `messages.fetch(` are not HTTP calls and must stay out
  of the scan (the current `\bfetch\(` would match them if the scan were widened naively, since `.` is a word
  boundary).

### Decisions (defaults, named so the gate can contest them)

1. **Pre-releases are announced, marked.** The text becomes `📦 New pre-release: **<name>**` for one; filtering
   them would hide real news, and an unmarked one is what the issue objects to. A `prerelease: boolean` field is
   added to `Release` (required, so every constructor says what it means). A pre-release later promoted to a
   release in place keeps its id and is not announced a second time; the docs say so.
2. **The name is bounded and never empty:** `r.name || r.tag_name` (null AND empty fall back to the tag), and the
   announcement renders `clampReply(release.name, RELEASE_NAME_MAX)` with `RELEASE_NAME_MAX = 200` (capped at 200
   UTF-16 units with `clampReply`'s suffix; `clampReply` is `github.ts`'s, already exported, and takes no first
   line -- a multi-line name stays multi-line). 200 plus the head and the URL stays far under 2000.
3. **A full page of unseen releases warns once per poll, in `checkRepoReleases`**, keyed on the page size the
   request asks for (`RELEASES_PER_PAGE = 15`, exported from `github.ts` and used in the URL): when the repo has
   a seen list (not a first poll) and all `RELEASES_PER_PAGE` non-draft releases returned are unseen, warn that
   anything older was not fetched. A page padded with drafts can under-warn (fewer than 15 survive the filter),
   and the warning repeats each poll while the posts keep failing (the list does not advance); the comment says
   so. No pagination: a cheap warning is what the verifier asked for.
4. **A walk stops between repos once a restart or shutdown is pending** (`restartPending()`, already imported in
   `announce.ts:10`, the same predicate `onTick` uses to start no new work), logging once; the remaining repos are
   polled by the next walk -- the next boot's startup catch-up (`lastReleasePollAt` starts at 0), or the next
   15-minute poll when this process carries on after a failed handoff (`endHandoff` resumes it and the stamp
   taken on entry stands). The at-least-once cases that remain -- an exit in the instant between a post and its
   save, a save that fails or never reaches disk, two walks overlapping -- are what the docs now say instead of
   "never".
5. **No skip-on-4xx.** With the name bounded, a permanent 4xx from length cannot happen; a 4xx from permissions
   or a deleted channel affects every release alike and should keep failing loudly (and retrying next poll) rather
   than silently skipping releases. Declined in writing in the PR and on #499.
6. **Rate limit: documented, and the limit response names its reset.** `fetchReleases` throws, on a 403 or a 429
   whose `x-ratelimit-remaining` is `0` (GitHub's docs: a primary-limit hit is either), a message naming the reset
   time (`x-ratelimit-reset`, epoch seconds, printed as ISO) and `GITHUB_TOKEN`; any other 403 or 429 keeps today's
   message. `README.md:33` gains the arithmetic. No
   ETag/`If-None-Match`: a token is the fix, and conditional requests still count toward an unauthenticated
   limit when they miss.
7. **The timeout scan covers every HTTP fetch site in `src/`** (non-test files), with a call matcher that
   excludes discord.js's `.fetch(` and accepts `signal` as a shorthand property; the count becomes 11 and is
   asserted, so a twelfth site is a deliberate edit. The describe title says what it checks.

### Step 1 -- `src/github.ts`

1a. Beside `GITHUB_TIMEOUT_MS` (`:43`):

```ts
/** One page of a repo's releases per poll (#499): the newest `RELEASES_PER_PAGE`, drafts dropped afterwards.
 *  `checkRepoReleases` warns when a whole page is new, since anything older is never fetched. */
export const RELEASES_PER_PAGE = 15;
```

1b. `Release` (`:45-50`) gains `prerelease: boolean;` after `url`, with the comment
`/** GitHub's pre-release flag; the announcement says "pre-release" for one (#499). */`.

1c. `fetchReleases` (`:60-78`): the URL uses the constant; the 403 rate-limit message; `||` and `prerelease` in the
map:

```ts
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
    const at = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : "an unknown time";
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
    // `||`, not `??` (#499): an empty-string name is as nameless as a null one, and would render as `****`.
    .map((r) => ({ id: r.id, name: r.name || r.tag_name, tag: r.tag_name, url: r.html_url, prerelease: r.prerelease }));
}
```

1d. `ReleaseAnnouncements.toAnnounce`'s comment (`:81`) becomes:
`/** Releases to post now, oldest-first: GitHub's list reversed (newest first in practice; the API docs name no sort key), which is publish order for ordinary tagging and not necessarily for a release cut later from an older commit. */`

### Step 2 -- `src/announce.ts`

2a. Imports: `:8` becomes
`import { clampReply, fetchReleases, decideReleaseAnnouncements, createReachabilityLog, RELEASES_PER_PAGE, type Release } from "./github";`
(`restartPending` is already imported at `:10`).

2b. Beside `RELEASE_POLL_GAP_MS` (`:29`):

```ts
/** The most of a release's name the announcement shows (#499): past it, `clampReply`'s suffix. A name is free text
 *  on GitHub; unbounded, one long enough would make every post for that repo fail and block the newer ones. */
export const RELEASE_NAME_MAX = 200;
```

2c. `checkReleases`'s loop (`:463-469`) becomes:

```ts
  for (const repo of repos) {
    // #499 item 6: a restart or shutdown pending mid-walk ends the walk here, between repos, instead of racing the
    // drain's grace through the ones left; they are polled by the next walk (the next boot's startup catch-up, or
    // the next 15-minute poll when this process carries on after a failed handoff).
    if (restartPending()) {
      console.log(`[release] a restart or shutdown is pending — stopping the walk before ${repo}`);
      return;
    }
    try {
      await checkRepo(repo);
    } catch (err) {
      console.error(`[release] ${repo}`, err);
    }
  }
```

2d. `checkRepoReleases` (`:478-504`): after the "reachable again" log (`:494-496`) and before
`commitReleaseAnnouncements`, the page warning; the announcement text marks pre-releases and clamps the name:

```ts
  const seen = state.seenReleaseIds[repo];
  // #499 item 5: one page per poll. A whole page of new releases on a repo we have polled before means older ones
  // may exist that were never fetched and never will be (they are not recorded either). Keyed on the page size the
  // request asked for; a page padded with drafts (dropped by fetchReleases) can slip under it, which is accepted,
  // and the line repeats each poll while the posts below keep failing, since the list does not advance.
  if (seen !== undefined && releases.length >= RELEASES_PER_PAGE && releases.every((r) => !seen.includes(r.id))) {
    console.warn(
      `[release] ${repo}: every one of the ${releases.length} releases on the page is new — anything older was not fetched and will not be announced`,
    );
  }
  await commitReleaseAnnouncements(releases, seen, {
    announce: (release) =>
      announce(
        client,
        "release",
        `📦 New ${release.prerelease ? "pre-release" : "release"}: **${clampReply(release.name, RELEASE_NAME_MAX)}**\n${release.url}`,
      ),
    persist: async (committed) => {
      state.seenReleaseIds[repo] = committed;
      await saveState();
    },
  });
```

(`state.seenReleaseIds[repo]` was read inline at `:497`; the local `seen` replaces it so the two reads agree, and
the persist callback's parameter is renamed so it does not shadow it.)

2e. `commitReleaseAnnouncements`'s docstring (`:512-514`), last sentence, becomes: "a throw partway through a
multi-release burst must not discard the ids of releases already posted, or the next poll re-announces them. Among
what remains at-least-once (#499; CONTEXT.md's Behavior section lists the rest): an exit in the instant between a
post and its save, or a save that fails, re-posts that one release next poll."

### Step 3 -- `src/fetchTimeouts.test.ts` (#500 item 12)

3a. `:21`: `describe("every GitHub call is timeout-bounded", () => {` becomes
`describe("every GitHub call is timeout-bounded, and every HTTP fetch in src/ carries a signal", () => {`.

3b. The scan test (`:135-168`) becomes a scan of every non-test `.ts` under `src/`:

```ts
  test("no HTTP fetch anywhere in src/ is missing a signal", async () => {
    // Paren-balanced, not a regex, for the reason the first version of this test learned (a regex found zero
    // calls and passed vacuously). The matcher takes a bare `fetch(`, `fetchFn(`, `fetchImpl(` or `deps.fetch(`
    // and NOT discord.js's `client.channels.fetch(` / `users.fetch(` / `messages.fetch(`, which are cache reads,
    // not HTTP calls (hence the look-behind: no `.` or word character before `fetch`). `signal` counts with a
    // colon or as a shorthand property (docker.ts). #500 item 12 widened this from two files to the tree.
    const CALL = /(?<![.\w])(?:fetch|fetchFn|fetchImpl)\(|\bdeps\.fetch\(/g;
    const argsOfEachFetchCall = (source: string): string[] => {
      const out: string[] = [];
      for (const m of source.matchAll(CALL)) {
        // A mention in a comment is not a call (docker.ts:3 and plugins/index.ts:166 say "fetch(" in prose): skip a
        // match whose line starts as a comment. Never strip `//` globally -- the URL template strings contain it.
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
      .map(String)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && !f.includes("fixtures"))
      .sort();
    let checked = 0;
    const sites: string[] = [];
    for (const file of files) {
      const source = await Bun.file(join(root, file)).text();
      for (const args of argsOfEachFetchCall(source)) {
        if (!/\bsignal\b/.test(args)) {
          throw new Error(`${file}: a fetch call carries no signal — ${args.trim().slice(0, 80)}`);
        }
        checked++;
        sites.push(file.replace(/\\/g, "/"));
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
    expect(checked).toBe(11);
  });
```

If `readdirSync`'s `recursive` option returns paths with backslashes on Windows (it does), the `replace` above
normalises them; the sort is on the raw names, so if the order differs from the literal on one platform, sort
`sites` before comparing instead and say so in the PR. The comment at `:129-134` above the test is updated to say
the scan now covers the tree, why discord.js's cache fetches are excluded, and why comment lines are skipped (on
`4fa85aa` the matcher without that skip finds 13 "sites", two of them prose: `docker.ts:3`, `plugins/index.ts:166`).

### Step 4 -- docs

- `CONTEXT.md:196` (the `github.ts` row): old `All five calls carry `AbortSignal.timeout(GITHUB_TIMEOUT_MS)``
  -> new `All five GitHub calls (the three here and `update.ts`'s two) carry `AbortSignal.timeout(GITHUB_TIMEOUT_MS)``;
  and old ``fetchReleases(repo)` (drafts filtered;` -> new ``fetchReleases(repo)` (drafts filtered, `prerelease` carried through so the announcement says pre-release, an empty name falls back to the tag, a 403 or 429 with `x-ratelimit-remaining: 0` names its reset time and `GITHUB_TOKEN`, #499/#500;`;
  and after the sentence that now reads `All five GitHub calls (the three here and `update.ts`'s two) carry `AbortSignal.timeout(GITHUB_TIMEOUT_MS)`` append, inside the same row, ` (`fetchTimeouts.test.ts` also scans every HTTP fetch site in `src/` for a signal -- eleven today -- so a new unbounded call anywhere fails that test, #500)`.
  (The row is one long line; anchor each Edit on the exact substring.)
- `CONTEXT.md:237`: old `Restarts never re-announce.` -> new `A restart never re-announces a release whose save landed before the new process started: each id is persisted right after its post (`commitReleaseAnnouncements`), and a walk stops between repos once a restart or shutdown is pending (`checkReleases`, #499). What can still re-post a release: an exit in the instant between its post and its save, a save that fails or never reaches disk, two walks overlapping (`github.ts`'s header), or a self-update replacement that booted from a stale `state.json` snapshot (#507, open).`
- `src/state.ts:20`: old `Persisted so restarts never re-announce something already posted.` -> new `Persisted so a restart does not re-announce a release whose save landed (CONTEXT.md's Behavior section lists what can still repeat one).`
- `CONTEXT.md:174` (the `announce.ts` row), old `so when it answers again it announces what was published meanwhile (at most the newest 15 the API page returns;` -> new `so when it answers again it announces what was published meanwhile (at most the newest 15 the API page returns, and a whole page of new releases on a repo polled before warns that older ones were not fetched, #499;`. Also in that row, old `routes releases via `channelFor()`` -> new `names a pre-release as one and clamps the name to `RELEASE_NAME_MAX` (#499); routes releases via `channelFor()``.
- `README.md:238`: old `so restarts never repeat an announcement.` -> new `so a restart does not repeat an announcement whose save landed before the new process started (each release is saved right after it is posted; an exit in the instant between the two, or a save that fails, can repeat that one release).`
- `README.md:239`: append ` A pre-release is announced as one (`New pre-release`; one later promoted in place is not announced again), and a release name longer than 200 characters is shortened in the post.`
- `CONTEXT.md:176` (the `announce.test.ts` row) and `:177` (the `github.test.ts` row): append the new tests in one
  clause each (A1-A5; G1-G4), anchored on each row's last sentence (Grep the row's end). The widened scan is
  `fetchTimeouts.test.ts`'s, which has no row of its own: it is named in the `github.ts` row above, nowhere else.
- `README.md:33`: old `and starts announcing on its own if it later becomes visible.` -> new `and starts announcing on its own if it later becomes visible. Without `GITHUB_TOKEN`, GitHub allows 60 requests an hour per address: each watched repo costs four an hour, and with `AUTO_UPDATE=true` the self-update check one more per poll (two when the running build differs from the newest commit), so around 14 repos exhaust it and the rest fail with a 403 or 429 (the log names the reset time) until the window resets — set `GITHUB_TOKEN` (5,000 an hour) when watching more than a handful.`
  Check each README substring is present exactly once before editing (Grep).

### Step 5 -- tests

**`src/github.test.ts`.**
- `rel` (`:16`) gains `prerelease: false`; `apiRelease` (`:249-257`) already sets `prerelease: false`; the expected
  object at `:262` gains `prerelease: false`.
- **G1 (#499-7):** `test("carries the pre-release flag through", …)`: `stub(() => json([apiRelease(1, { prerelease: true })]))`
  -> `(await fetchReleases("owner/repo"))?.[0]?.prerelease` is `true`.
- **G2 (#499-8):** `test("an empty-string name falls back to its tag, like a null one", …)`:
  `apiRelease(1, { name: "" })` -> name `"v1"`.
- **G3 (#500-10):** a describe `the rate limit (#500 item 10)` NESTED inside `describe("fetchReleases", …)`
  (`:237-293`), so it shares its `stub`/`json` helpers and the `afterEach` that restores `fetch`, with:
  - `stub(() => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1760616000" } }))`
    -> rejects with a message containing `rate limit exhausted`, `2025-10-16T12:00:00.000Z` (that epoch's ISO) and
    `GITHUB_TOKEN`; the same with `status: 429` -> the same message.
  - a 403 with `x-ratelimit-remaining: "42"` -> the bare `GitHub releases query failed for owner/repo: 403` (a 403
    that is not the limit: a permission refusal); a 403 WITHOUT the headers -> the bare message too.
  - remaining `"0"` with a reset header that is absent, `""`, `"soon"` or `"0"` -> the message says
    `resets at an unknown time; set GITHUB_TOKEN` (the fallback branch).
- **G4 (#499-5):** `expect(RELEASES_PER_PAGE).toBe(15)` and, in the "maps the API payload" test or beside it, the
  URL the stub received contains `per_page=15`. The `stub` helper (`github.test.ts:239`) is typed `impl: () => …`;
  widen it to `impl: (url: string) => Promise<Response> | Response` (the runtime cast already passes the argument
  through) so a test can record the URL.

**`src/announce.test.ts`.**
- The `release` helper (`:1051-1056`) gains `prerelease: false`; T-F's `gh` (`:513`, hoisted below) already sets
  `prerelease: false` and T-F's expected `sent` strings are unchanged (the names are short, no suffix).
- **A1 (#499-4), extends T-F (`:507-536`):** set `config.githubToken = "t-l2-probe"` for the test (save and restore
  in the `finally`); record each fetch's `init` in the stub; after the two polls assert, for every recorded call,
  `init.headers` has `Authorization: "Bearer t-l2-probe"`, `Accept: "application/vnd.github+json"` and
  `"User-Agent": "rackbops-discord-bot"`; assert the warn spy was called once with
  `[release] rackbops/came-back-probe is unreachable (missing, or GITHUB_TOKEN cannot see it) — skipping it quietly until it answers again`
  and the log spy once with `[release] rackbops/came-back-probe is reachable again` (filter the log spy's calls for
  `[release]`: `announceTo` also logs `[announce]` lines through it).
- Hoist T-F's local `gh` helper (`:513`) to the describe's scope, extended to take overrides
  (`gh(id, over: Record<string, unknown> = {})`), so A2 and A4 share it; T-F's own assertions are unchanged.
- **A2 (#499-5):** `test("a whole page of new releases on a repo polled before warns that older ones were not fetched (#499)", …)`:
  same harness as T-F (fake client, fetch stub, quiet warn/log spies, plus a `console.error` spy):
  - `state.seenReleaseIds[repo] = [1]`; the stub answers 15 releases `gh(17) … gh(3)` (ids 3-17, none seen) ->
    exactly one warn line starting `[release] rackbops/page-probe: every one of the 15 releases on the page is new`;
    15 announcements.
  - a fresh case, NOT a continuation: re-seed `state.seenReleaseIds[repo] = [1]` and answer 14 new releases with ids
    not used above (`gh(100) … gh(87)`) -> no such warn (reusing ids 17-4 against the list the first case left
    behind would pass with the `>= RELEASES_PER_PAGE - 1` mutant alive; this is the case that kills M5).
  - `seen` undefined (first poll) and 15 releases -> no warn, nothing announced, **`console.error` not called**, and
    `state.seenReleaseIds[repo]` equals the 15 ids (a `TypeError` on a missing `seen !== undefined` guard is
    swallowed by the per-repo catch, `announce.ts:466-468`, so "no warn" alone would pass that mutant).
  - a full page with every id already seen -> no warn; a full page with one id seen -> no warn (pins the
    `every(...)` guard: without it a healthy repo with 15 releases warns on every poll).
  Clean up `state.seenReleaseIds[repo]` in `finally`.
- **A3 (#499-6):** in the `checkReleases (#342)` describe:
  `test("a restart pending mid-walk stops the walk between repos (#499)", …)`: `setExitFn` stub recording exits
  (import `setExitFn`, `resetForTest as resetRestartForTest`, `requestRestart`, `RESTART_EXIT_CODE` from
  `./restart`; the file already imports these for #460's tests, reuse), `checkReleases(client, ["a/b", "c/d", "e/f"], async (repo) => { calls.push(repo); if (repo === "a/b") requestRestart("mid-walk"); })`
  -> `calls` is `["a/b"]`, `exits` is `[RESTART_EXIT_CODE]` (critical depth 0: the request exited into the stub at
  once and stays pending), one log line `[release] a restart or shutdown is pending — stopping the walk before c/d`;
  `resetRestartForTest()` in `finally`. And the complement: with no restart pending all three are called (the
  existing "calls checkRepo once per repo" test, `:452-461`, already pins it; cite it).
- **A4 (#499-7, #499-8):** `test("a pre-release is announced as one, and a long name is clamped (#499)", …)`: T-F's
  harness with `state.seenReleaseIds[repo] = []`, the stub answering `[gh(2, { prerelease: true }), gh(1, { name: "x".repeat(600) })]`
  -> `sent[0]` starts with `📦 New release: **xxxx` and is shorter than 300 characters and contains `clampReply`'s
  truncation suffix (read it from `clampReply`'s tests, `github.test.ts:95-139`, the suffix test at `:100-105`);
  `sent[1]` starts with `📦 New pre-release: **v2**`.
- **A5 (constants):** `expect(RELEASE_NAME_MAX).toBe(200)`.

### Mutation table (run in a scratch worktree, never in the shared tree)

Commit the work in progress first, then:

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-530-L2-mut fix/530-L2-releases
cd /s/Repos/_wt/rdb-530-L2-mut && bun install --frozen-lockfile
```

Apply one mutation at a time there, run `bun test src/announce.test.ts src/github.test.ts src/fetchTimeouts.test.ts`,
record the failing test, revert (`git -C /s/Repos/_wt/rdb-530-L2-mut checkout -- .`), next; remove the worktree at the
end (`git -C /s/repos/rackbops-discord-bot worktree remove /s/Repos/_wt/rdb-530-L2-mut`).

| # | Mutation (production line, after the steps) | Test that must fail |
|---|---|---|
| M1 | `github.ts` fetchReleases: `headers: githubHeaders()` -> `headers: {}` | A1 (no Authorization) |
| M2 | `checkRepoReleases`: delete the "is unreachable … skipping it quietly" warn | A1 |
| M3 | `checkRepoReleases`: delete the "is reachable again" log | A1 |
| M4 | `announce.ts` page warning: delete the `console.warn` | A2 |
| M5 | page warning: `>= RELEASES_PER_PAGE` -> `>= RELEASES_PER_PAGE - 1` | A2 (the 14-release case warns) |
| M6 | page warning: drop `seen !== undefined &&` (`bun test` does not typecheck, so the mutant runs as is; `tsc` rejects it -- `'seen' is possibly 'undefined'` -- which matters only if the mutant must also pass `bun run check`, then `(seen as number[]).includes` or a `// @ts-expect-error` above the `if`) | A2's first-poll case (`console.error` called: the `TypeError` is swallowed by the per-repo catch, and the seen list is not written) |
| M6b | page warning: drop `releases.every((r) => !seen.includes(r.id))` | A2 (the all-seen and one-seen cases warn) |
| M6c | page warning: `.every` -> `.some` | A2 (the one-seen case warns) |
| M7 | `checkReleases`: delete the `if (restartPending()) { ... }` block | A3 |
| M8 | fetchReleases map: `prerelease: r.prerelease` -> `prerelease: false` | G1, A4 |
| M9 | announcement text: drop the `pre-release` branch (always "release") | A4 |
| M10 | fetchReleases map: `r.name \|\| r.tag_name` -> `r.name ?? r.tag_name` | G2 |
| M11 | announcement text: `clampReply(release.name, RELEASE_NAME_MAX)` -> `release.name` | A4 |
| M12 | `RELEASE_NAME_MAX = 200` -> `2000` | A4 (length), A5 |
| M13 | fetchReleases: delete the rate-limit `if` | G3 |
| M14 | fetchReleases: `=== "0"` -> `!== null` in the rate-limit test | G3's remaining-`"42"` case |
| M14b | fetchReleases: drop the `Number.isFinite(reset) && reset > 0` guard | G3's reset cases: absent, `""` and `"0"` print `1970-01-01T00:00:00.000Z`, `"soon"` throws a RangeError |
| M14c | fetchReleases: `reset > 0` -> `reset >= 0` | G3's absent, `""` and `"0"` reset cases (1970 instead of "an unknown time") |
| M14d | fetchReleases: drop `\|\| res.status === 429` | G3's 429 case |
| M15 | `RELEASES_PER_PAGE = 15` -> `30` | G4 (URL), T-F's URL pin |
| M16 | `fetchTimeouts.test.ts` scan: remove `signal` from `docker.ts:109`'s object (a production mutation the scan must catch) | the scan test |
| M17 | scan matcher: drop the look-behind (`(?<![.\w])`) | the scan test (discord.js `.fetch(` sites appear, no signal) |

### Coverage table

| Bullet | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| #499-4: the per-repo request carries the auth headers; lost/recovered are logged once each | 5 (A1) | A1 | M1, M2, M3 |
| #499-5: a full page of new releases warns; the order comment is honest | 1a, 1d, 2d | A2, G4 | M4, M5, M6, M6b, M6c, M15 |
| #499-6: a walk stops when a stop is pending; the docs say at-least-once truthfully | 2c, 2e, 4 | A3 (+ docs by the lens-B audit) | M7 |
| #499-7: a pre-release is marked | 1b, 1c, 2d | G1, A4 | M8, M9 |
| #499-8: an empty name falls back to the tag; the name is bounded; skip-on-4xx declined in writing | 1c, 2b, 2d | G2, A4, A5 | M10, M11, M12 |
| #500-10: the unauthenticated ceiling is documented; a rate-limit 403 or 429 names its reset and the fix | 1c, 4 | G3 | M13, M14, M14b, M14c, M14d |
| #500-12: the scan covers every HTTP fetch site in `src/`; the CONTEXT row counts right | 3, 4 | scan test | M16, M17 |

### Verification (run from the worktree root; paste real output in the PR)

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && cd ../..
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
cd ops/admin && bun run check && cd ../..
bun test src/announce.test.ts src/github.test.ts src/fetchTimeouts.test.ts src/state.test.ts test/stateGuard.test.ts
bun test --randomize src/announce.test.ts
bun test
```

- The full `bun test` is slow on this box (the `ops/` subprocess tests): run it in the background and paste its tail.
- A3 sets restart state and A1/A2/A4 mutate `config.githubToken` and `state.seenReleaseIds`; every `finally` restores
  them, and the test-state guard fails the test that does not.
- The README/CONTEXT substrings: Grep each old substring before editing (exactly one hit) and after (none).

### Acceptance to paste per issue

- **#499:** A1-A5, G1, G2, G4 pass lines; M1, M4, M7, M8, M10, M11 failing output; the new announcement text for a
  pre-release and for a 600-character name (from A4's `sent`); the decline of skip-on-4xx with Decision 5's reason.
- **#500 (items 10 and 12):** G3's pass line and M13's failing output; the scan test's pass line listing the eleven
  sites and M16's failing output; the new `README.md:33` sentence and the corrected `CONTEXT.md:196` fragment.
  Comment on the closed #500 naming the PR and the two items; then tick #499 and #500 on #530.

### PR

- Title: `fix(release): mark pre-releases, bound the name, warn on a full page, stop a walk when a stop is pending, name the rate limit, and scan every fetch for a signal (#499, #500)`.
- Body: one line per item, Decisions 1-7, the typecheck + test output, the mutation table. End with `Closes #499.` on
  its own line; name #500 as "Part of #500 (items 10 and 12; the issue is already closed)".
- After merge: tick #499 and #500 on #530 (byte-exact; the body is CRLF); comment on #500.

### Out of scope, on purpose

- Pagination or ETag/`If-None-Match` (Decisions 3 and 6).
- Skipping a release that fails with a 4xx (Decision 5).
- `WATCHED_REPOS` case-insensitive keying (#500 item 11's remainder): roshne's call, a saved-data key.
- Reloading `state.json` after a handoff (#500 item 13): #507 under #526.
