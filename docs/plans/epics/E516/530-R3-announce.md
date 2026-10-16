<!-- Plan for #530 bundle R3 (Rackbops/rackbops-discord-bot, Epic #516 -> sub-epic #530): #437, #438, #439, #460 -- the
`src/announce.ts` tick and seen-list set. Written by the orchestrating session on 2026-10-16 against `main` @ `d1234d7`
(R1 merged); audited read-only before it was committed (16 findings, all applied -- the one that changed the design:
the rewritten #438 text claimed the generation after a watchdog-freed tick "skips all three" gated checks, which is
false because a tick hung inside the releases walk never reached the later checks, so their stamps are stale and the
new generation runs them once; the audit also found the self-update stamp-at-start and the boot-write ordering unpinned,
so T-D2 and T-G were added; a second, narrow audit of the rewrite found one overclaim -- "every core check" stamps
and gates, where only the four gap-gated ones do -- and a mutant for T-G that an existing test also caught, both
fixed). Every file:line below was read from that tree; the implementer re-reads each one on the tree
it works from and corrects any that moved. -->

## Implementation plan -- #530 R3: pin the tick's cadence gates and restart safety; say truthfully what a returning repo and a tick past the watchdog do

Children: **#437** (S), **#438** (S), **#439** (S), **#460** (S). One PR, branch `fix/530-R3-announce`, worktree
`S:\Repos\_wt\rdb-530-R3` cut from `origin/main`. Closes all four; tick their boxes on #530.

**Prerequisite: PR #566 (R2) merged first.** It edits the same `CONTEXT.md:196` row this plan edits (a single long
line), and a conflict on a `CONTEXT.md` row is an escalation. Branch from `origin/main` only once #566 is on it; if
main moves again while you work, merge main and re-apply the Step 3 substring edits by hand if either row conflicts.

**No production behaviour changes.** The PR rewrites two false comments/docs (#437, #438) and adds tests that pin
lines no test reaches today (#439, #460). So it is not in the three-reviewer lane: it gets the **single
claims-vs-code audit pass** the personal rules give a docs change that asserts facts, **plus the mutation table
below executed in a scratch worktree** (every production line a new test claims to pin is flipped and the named
test must fail). If the implementer finds it must change a production line after all, say so in the PR and the
full gate applies to that line.

### What is wrong, verified at `d1234d7`

- **#437.** `src/announce.ts:487-488` says a repo that was unreachable "comes back seeds silently rather than
  announcing everything published while it was invisible"; `CONTEXT.md:174` says "so it seeds silently if it
  returns". Neither is true. The unreachable path (`:480-490`) returns without touching
  `state.seenReleaseIds[repo]`; when the repo answers again, `:494` hands that same **defined** list to
  `commitReleaseAnnouncements`, and `decideReleaseAnnouncements` (`src/github.ts:82-90`) seeds silently only when
  `seen === undefined` (`:86`). So every release on the one page `fetchReleases` reads (`per_page=15`,
  `src/github.ts:49`; drafts dropped after the fetch, `:64`, so they count toward the 15) that is not in the list
  is announced, oldest first; anything older than that page is neither announced nor recorded (#499's
  github-announce-5 is about that bound). The same holds for a repo removed from `WATCHED_REPOS` and re-added:
  its key is never pruned (`src/state.ts:170-173` only caps each list at `RELEASE_ID_CAP` = 100, `:36`).
  `README.md:239` ("each watched repo's first release poll seeds silently; only releases published after that
  are announced") and `CONTEXT.md:250` are accurate and stay. Nothing pins the come-back behaviour:
  `src/github.test.ts:207-211` and `src/announce.test.ts:872-882` pin the never-polled case only. Note the 404
  path is the only one that returns `null` (`src/github.ts:41-54`): a 401 from a bad token throws and stays
  loud; what passes silently is a token that cannot *see* the repo (GitHub 404s a private repo it cannot read).
- **#438.** `src/github.ts:13-17` says past 26 watched repos "the watchdog releases `tickInFlight` while the
  tick is still inside `checkReleases`, the next tick starts, and two generations race the same un-persisted
  `seenReleaseIds`"; `CONTEXT.md:196` says 26 "is the ceiling before a tick's GitHub budget alone reaches
  `TICK_WATCHDOG_MS` and re-opens #87's duplicate-announcement race". The arithmetic (`10N + 30 < 300` up to
  N = 26) is right; the consequence is not. `checkReleases` stamps `lastReleasePollAt` on entry
  (`src/announce.ts:460`), and the `releases` check runs only when `shouldPollReleases(Date.now(),
  lastReleasePollAt)` passes (`:225`), which needs `RELEASE_POLL_GAP_MS` = 15 minutes (`:29`, `:391-394`). When
  the watchdog frees the guard at 300 s (`:185-194`), the next generation starts and skips the releases walk.
  The checks after it in `tickChecks` (`:220-287`: self-update `:231`, the request drain `:243`, plugin
  updates `:262`, discovery `:279`, then the plugin ticks) were never reached by the hung tick, so their stamps
  are whatever the last healthy tick left: the new generation runs each of them if its own gap has elapsed and
  stamps it (self-update stamp `:313`, gap `:308-310`; plugin-update stamp `:263`, gap `:319-322`; discovery
  `:280`), and when the hung tick's walk finally ends its tail reaches those checks and skips them on the fresh
  stamps. So no gap-gated check runs twice within its gap, in either order (the request drain and the plugin
  ticks have no stamp and no gap: they are gated otherwise, next). The request drain is single-flight
  (`:243-252`) and a plugin tick whose previous call is still running is skipped (`src/plugins/host.ts:629-631`,
  #217). Each release id is also persisted right after its announce (`:527-532`), so nothing is "un-persisted"
  across a batch. Two `checkReleases` walks can only overlap once one walk itself outlasts the 15-minute gap:
  with every fetch bounded at `GITHUB_TIMEOUT_MS` = 10 s (`src/github.ts:31`, `:51`) that is about 90 repos all
  hanging to the timeout (`10 x 90 = 900` plus per-call overhead), or fewer with Discord sends stalling between
  repos (the case the header's next paragraph already names as outside the GitHub budget). Even then
  `decideReleaseAnnouncements` runs once per repo (`:518`), so an overlapping walk that decides before the first
  walk's persist can re-announce that one repo's pending releases (usually one), never every repo's. One more
  correction: "while the tick is still inside `checkReleases`" holds only from about 30 repos (`10 x 30 = 300`
  plus per-call overhead); below that the walk has ended by 300 s and it is the update check and plugin index
  after it that overrun.
- **#439.** The 15-minute release cadence is two links, neither tested: the gate at `src/announce.ts:225` and
  the stamp at `:460`. `src/announce.test.ts:345-372` pins `shouldPollReleases` in isolation; `:412-425` pins
  that `checkReleases` stamps (so deleting `:460` alone IS caught today -- the issue predates that test); but
  nothing runs the `releases` check from `tickChecks`, so replacing the gate with an unconditional
  `checkReleases(client)` (every 60 s tick polls every repo) leaves the suite green.
- **#460.** `onTick` (`:296-306`) bails on `restartPending()` (`:297`) and wraps the whole tick in
  `withCritical` (`:304`); the `pluginUpdates` check is gated on `pluginStateReady` (`:262`) and the
  `autoUpdate` check on `config.autoUpdate` (`:231`). The only source-regex pin in `announce.test.ts` covers the
  `pluginRequests` gate (`:116-138`). `onTick` is not exported; `startScheduler` (`:65-70`) is, and it fires
  the first tick synchronously and returns its promise (`:67-69`, pinned by `:587-633`), which is how the tests
  below reach `onTick` without exporting it or injecting deps. The ready half of the `pluginUpdates` gate is
  pinned (`:488-505` runs it with `markPluginStateReady()`); the off half is not. The true half of the
  `autoUpdate` gate is pinned (`:473-486`); the off half, its 15-minute gap and its stamp-at-start are not
  (moving `lastUpdatePollAt = Date.now()` after `await checkForUpdate()` in `checkAutoUpdate`, `:312-315`,
  leaves the whole suite green -- the audit tried it). The claim "`markPluginStateReady()` runs after the boot
  `writePluginState`" (`src/index.ts:457` -> `:491`) is what makes the `pluginStateReady` gate meaningful, and
  it is pinned by nothing: `src/index.test.ts:152-179` orders `markPluginStateReady(` only against
  `reportPluginUpdateOutcome` (`:172`), `:423-428` orders it after the boot drain, and the only
  `writePluginState` lookup (`:75`) belongs to a #509 test.

### Decisions (defaults, named so the audit and the PR can contest them)

1. **#437 keeps the behaviour and fixes the words.** A repo that answers again announces what was published
   while it was unreachable -- at most the newest 15 releases the API page returns, minus those already seen,
   oldest first -- and a repo re-added to `WATCHED_REPOS` does the same. Re-seeding on recovery would silently
   drop real releases on a passing 404 (a token that could not see the repo for a while), and `README.md:239`
   already describes the kept behaviour. This is a product fork; the kept behaviour is the documented one, and
   roshne can reverse it on #437, in which case T-F flips with it.
2. **#438 rewrites the consequence, not the number.** 26 stays as the point past which a fully-hung tick
   outlives the watchdog; what follows it is the true consequence (no gap-gated check runs twice within its
   gap across the two generations; a releases overlap needs a walk longer than the gap). No in-flight flag is added around
   `checkReleases`: the stamp-at-start plus the gate is already that flag, and T-E pins it. The self-update
   check's stamp-at-start, which the rewritten text also asserts, gets its own pin (T-D2).
3. **Behavioural tests over source-regex pins** wherever an exported surface reaches the line: `tickChecks(...)`
   for a single check, `startScheduler(...)` (with `setInterval` recorded, not started, as `:597-600` does) for
   `onTick`. Bun's `setSystemTime` (from `bun:test`; probed on Bun 1.4.2) **freezes** `Date.now()` at the given
   instant -- it does not offset the clock -- until the next call, leaves timers and `Bun.sleep` on the real
   clock, and `setSystemTime()` with no argument restores the real clock; the exact `toBe(T0)` assertions
   below rely on the freeze. `onTick` stays unexported. The one source-order pin (T-G) is for `index.ts`, which no
   test imports.
4. **No new production seams.** `RELEASE_POLL_GAP_MS`/`UPDATE_POLL_GAP_MS` stay module-private; the tests use a
   local `GAP_MS = 15 * 60 * 1000` as `:324`/`:346` do, which pins the value.

### Step 1 -- `src/github.ts` (#438): the header's consequence

Replace lines `:13-17` in full (the block from the line that starts "`10N + 30` seconds." through the line that
ends "revisiting this number.") with:

```ts
 * `10N + 30` seconds. Five repos is 80s. It stays strictly under `TICK_WATCHDOG_MS` (300s) up to
 * **26** repos; 27 hits it exactly and 28 exceeds it. Past that, a tick whose every GitHub call hangs to
 * its timeout outlives the watchdog, which logs and frees `tickInFlight` (from about 30 repos the tick is
 * still inside `checkReleases` at that point). The next tick then starts, and the two generations do not
 * redo each other's work: each gap-gated core check (releases, self-update, plugin updates, discovery)
 * stamps its poll time at poll START and is gated on a 15-minute gap (`announce.ts`), so the new
 * generation skips the releases walk the hung tick stamped on entry, runs -- if their own gaps have
 * elapsed -- the later checks the hung tick never reached and stamps them, and the hung tick's tail then
 * skips those in turn; the request drain is single-flight and a plugin tick whose previous call is still
 * running is skipped (#217). Two `checkReleases` walks overlap only once one walk itself outlasts
 * `RELEASE_POLL_GAP_MS` (900s) -- about 90 repos ALL hanging to the timeout -- and even then each id is
 * persisted right after its announce, so an overlap can re-announce at most one repo's pending releases
 * (usually one), never every repo's (#438). What a tick past the watchdog does cost is the watchdog's
 * error line and a generation running beside the hung one's tail. Adding many watched repos still means
 * revisiting this budget.
```

Line `:12` ("`N_repos x TIMEOUT + 2 x TIMEOUT (the update check) + 2 x 5s (the plugin index)` -- at 10s,") stays.

### Step 2 -- `src/announce.ts` (#437): the come-back comment

Replace `:487-488`:

```ts
    // Leave its seen-id list untouched, so a repo that comes back seeds silently rather
    // than announcing everything published while it was invisible.
```

with:

```ts
    // Leave its seen-id list untouched: when the repo answers again, commitReleaseAnnouncements announces
    // what was published meanwhile (the non-draft releases on the one page fetchReleases reads -- at most the
    // newest 15 -- that are not in the list, oldest first), and only a repo with NO list, its first-ever poll,
    // seeds silently (#437). A 404 that passes (a token that could not see the repo for a while; GitHub 404s
    // a private repo it cannot read) must not cost real announcements.
```

No other line of `announce.ts` changes.

### Step 3 -- `CONTEXT.md` (#437, #438): two rows, one substring each

Both rows are single long lines; anchor an Edit on the exact substring (never ending at a space). The strings
below are plain text: the backticks in them are the file's own backticks, nothing is escaped.

`:174` (the `announce.ts` row). Old:

```
so it seeds silently if it returns
```

New:

```
so when it answers again it announces what was published meanwhile (at most the newest 15 the API page returns; only a repo's first-ever poll seeds silently, #437)
```

`:196` (the `github.ts` row). Old:

```
so **26** watched repos is the ceiling before a tick's GitHub budget alone reaches `TICK_WATCHDOG_MS` and re-opens #87's duplicate-announcement race.
```

New:

```
so past **26** watched repos a tick whose every call hangs to the timeout outlives `TICK_WATCHDOG_MS`; the watchdog then logs and frees the guard, and the next tick skips the releases walk the hung tick stamped on entry and runs (if due) the later checks it never reached, stamping them so the hung tick's tail skips those in turn — each gap-gated check (releases, self-update, plugin updates, discovery) stamps at poll start and gates on a 15-minute gap, so #87's duplicate-announcement race is not re-opened: two `checkReleases` walks overlap only once one walk itself outlasts `RELEASE_POLL_GAP_MS` (about 90 repos all hanging to the timeout), and each id is persisted right after its announce even then (#438).
```

**The phrase check, before and after.** With the Grep tool (ripgrep syntax; a shell `grep` is refused by the
hook), pattern `seeds silently if it returns|comes back seeds silently|is the ceiling before|un-persisted`,
over `CONTEXT.md`, `README.md` and `src/**/*.ts`. Before the edits it must find exactly four lines
(`CONTEXT.md:174`, `CONTEXT.md:196`, `src/announce.ts:487`, `src/github.ts:16`) -- run it first, so the
after-check is known to be able to match. After Steps 1-3 it must find nothing. Paste both results in the PR.

### Step 4 -- `src/announce.test.ts`: the seven tests

Imports. Line `:1` gains `setSystemTime`:
`import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";`. After `:37` add:

```ts
const { state } = await import("./state");
const { requestRestart, setExitFn, resetForTest: resetRestartForTest, RESTART_EXIT_CODE } = await import("./restart");
```

The insertion points below are line numbers of the file as it is at `d1234d7`; each insertion shifts the ones
after it, so apply them bottom-up, or anchor on the quoted text rather than the number.

**T-E (#439, #438) -- the releases check's cadence, inside the `checkReleases (#342)` describe (`:405-460`,
which already has `afterEach(resetPollStateForTest)`):**

```ts
  // #439: the 15-minute cadence is the gate at tickChecks' `releases` check plus the stamp checkReleases takes on
  // entry; shouldPollReleases is pinned in isolation above, this drives the two links. #438: the stamp is taken at
  // poll START (before the first fetch goes out), which is what keeps a later tick from re-entering a walk that is
  // still running, whatever the tick watchdog does to the guard.
  test("the releases tick check polls at startup, not again inside the gap, and again once the gap has elapsed (#439, #438)", async () => {
    const GAP_MS = 15 * 60 * 1000;
    const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let stampedAtFirstFetch: number | undefined;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      stampedAtFirstFetch ??= announceStateForTest().lastReleasePollAt;
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch);
    try {
      setSystemTime(new Date(T0));
      const releases = tickChecks(client, []).find((c) => c.name === "releases")!;
      const polls = () => fetchSpy.mock.calls.length;
      const perPoll = config.watchedRepos.length;
      expect(perPoll).toBeGreaterThan(0);

      await releases.run(); // startup catch-up: lastReleasePollAt was 0
      expect(polls()).toBe(perPoll);
      expect(announceStateForTest().lastReleasePollAt).toBe(T0);
      expect(stampedAtFirstFetch).toBe(T0); // stamped before the first fetch went out (#438)

      await releases.run(); // straight away again: nothing
      setSystemTime(new Date(T0 + GAP_MS - 1));
      await releases.run(); // one ms short of the gap: still nothing
      expect(polls()).toBe(perPoll);
      expect(announceStateForTest().lastReleasePollAt).toBe(T0);

      setSystemTime(new Date(T0 + GAP_MS));
      await releases.run(); // the gap elapsed: polls every repo once more, and re-stamps
      expect(polls()).toBe(2 * perPoll);
      expect(announceStateForTest().lastReleasePollAt).toBe(T0 + GAP_MS);
    } finally {
      setSystemTime();
      fetchSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
```

**T-F (#437) -- a returning repo announces its backlog, same describe:**

```ts
  // #437: the unreachable path leaves the repo's seen-id list as it was, so when the repo answers again the
  // releases it published meanwhile ARE announced (oldest first) -- only a repo with no list seeds silently.
  test("a repo that was unreachable announces what was published meanwhile once it answers again (#437)", async () => {
    const repo = "rackbops/came-back-probe";
    const sent: string[] = [];
    const fakeClient = {
      channels: { fetch: async () => ({ isSendable: () => true, send: async (m: string) => void sent.push(m) }) },
    } as unknown as Client;
    const gh = (id: number) => ({ id, name: `v${id}`, tag_name: `v${id}`, html_url: `https://example.test/r/${id}`, draft: false, prerelease: false });
    let answer = () => new Response("not found", { status: 404 });
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => answer()) as unknown as typeof fetch);
    const quiet = [spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
    state.seenReleaseIds[repo] = [1, 2];
    try {
      await checkReleases(fakeClient, [repo]); // unreachable: skipped, list untouched, nothing posted
      expect(state.seenReleaseIds[repo]).toEqual([1, 2]);
      expect(sent).toEqual([]);

      answer = () => new Response(JSON.stringify([gh(4), gh(3), gh(2), gh(1)]), { status: 200 });
      await checkReleases(fakeClient, [repo]); // back: 3 and 4 were published meanwhile -> announced, oldest first
      expect(sent.map((m) => m.split("\n")[0])).toEqual(["📦 New release: **v3**", "📦 New release: **v4**"]);
      expect(state.seenReleaseIds[repo]).toEqual([1, 2, 3, 4]); // persisted through the real saveState (awaited by checkReleases)
    } finally {
      delete state.seenReleaseIds[repo]; // `state` is the shared singleton (dataIsolation.test.ts does the same)
      fetchSpy.mockRestore();
      for (const spy of quiet) spy.mockRestore();
    }
  });
```

**T-C, T-D and T-D2 (#460, #438) -- the two check gates' off halves, the self-update gap and its stamp, in the
`announceStateForTest's poll state` describe (`:464-506`, `afterEach(resetPollStateForTest)`), after `:505`:**

```ts
  // #460: pluginUpdates is gated on the boot state.json write having landed; `:488` above pins the ready half.
  test("the pluginUpdates check does nothing before markPluginStateReady: no stamp, no index fetch (#460)", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    try {
      expect(announceStateForTest().pluginStateReady).toBe(false);
      await tickChecks({} as unknown as Client, []).find((c) => c.name === "pluginUpdates")!.run().catch(() => {});
      expect(announceStateForTest().lastPluginPollAt).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // #460: the autoUpdate check is gated on AUTO_UPDATE and on its own 15-minute gap (no startup special case:
  // lastUpdatePollAt = 0 is simply older than any gap); `:473` above pins that it stamps when on.
  test("the autoUpdate check does nothing with AUTO_UPDATE off, and polls once per 15-minute gap with it on (#460)", async () => {
    const GAP_MS = 15 * 60 * 1000;
    const T0 = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
    const realAuto = config.autoUpdate;
    const realSha = config.gitSha;
    config.gitSha = undefined; // checkForUpdate answers "disabled" at once, with no network call (as `:477`)
    try {
      const autoUpdate = tickChecks({} as unknown as Client, []).find((c) => c.name === "autoUpdate")!;
      setSystemTime(new Date(T0));
      config.autoUpdate = false;
      await autoUpdate.run();
      expect(announceStateForTest().lastUpdatePollAt).toBe(0); // off: not even stamped

      config.autoUpdate = true;
      await autoUpdate.run();
      expect(announceStateForTest().lastUpdatePollAt).toBe(T0);
      setSystemTime(new Date(T0 + GAP_MS - 1));
      await autoUpdate.run();
      expect(announceStateForTest().lastUpdatePollAt).toBe(T0); // inside the gap: skipped
      setSystemTime(new Date(T0 + GAP_MS));
      await autoUpdate.run();
      expect(announceStateForTest().lastUpdatePollAt).toBe(T0 + GAP_MS); // the gap elapsed: polled again
    } finally {
      setSystemTime();
      config.autoUpdate = realAuto;
      config.gitSha = realSha;
    }
  });

  // #438: the self-update stamp is taken at poll START, before checkForUpdate's first GitHub call goes out -- the
  // same property T-E pins for releases, and what the github.ts header relies on. With a sha set, checkForUpdate
  // (update.ts:250-318) reaches fetchLatestBotSha's fetch; the stub throws, checkForUpdate's finally clears its
  // in-flight latch, and the check rejects -- swallowed here (nothing is logged on this path).
  test("the autoUpdate check stamps before its first fetch (#438)", async () => {
    const realAuto = config.autoUpdate;
    const realSha = config.gitSha;
    config.autoUpdate = true;
    config.gitSha = "0123456789abcdef0123456789abcdef01234567";
    let stampedAtFetch: number | undefined;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      stampedAtFetch ??= announceStateForTest().lastUpdatePollAt;
      throw new Error("offline");
    }) as unknown as typeof fetch);
    try {
      expect(announceStateForTest().lastUpdatePollAt).toBe(0);
      await tickChecks({} as unknown as Client, []).find((c) => c.name === "autoUpdate")!.run().catch(() => {});
      expect(fetchSpy).toHaveBeenCalled();
      expect(stampedAtFetch).toBeGreaterThan(0); // already stamped when the first GitHub call went out
    } finally {
      fetchSpy.mockRestore();
      config.autoUpdate = realAuto;
      config.gitSha = realSha;
    }
  });
```

**T-A and T-B (#460) -- `onTick`'s restart safety, a new describe placed right after the
`startScheduler returns the first tick's promise (#548)` describe (`:587-633`), sharing its set-up shape
(`setInterval` recorded, `fetch` offline, `WATCHED_REPOS` empty, warnings quiet):**

```ts
// #460: onTick is not exported; startScheduler fires the first tick synchronously and returns its promise (above),
// which is how these reach it. The two lines pinned here are the ones restart.ts's header relies on: no new tick
// once a restart/handoff/shutdown is pending, and the whole tick is one critical section.
describe("onTick's restart safety (#460)", () => {
  afterEach(() => {
    resetTickGuardForTest();
    resetDiscoveryGapForTest();
    resetPollStateForTest();
    resetRestartForTest(); // clears `pending` and any armed deferral
  });

  // Stands up one scheduler tick with every real-network check quiet. The exit stub is each test's own (installed
  // around the call), so a check can read the exits list while the tick is still running.
  const tickWith = async (extra: TickCheck[], arrange: () => void = () => {}): Promise<void> => {
    const realRepos = config.watchedRepos;
    config.watchedRepos = []; // the release check polls nothing, but still stamps when it RUNS
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((_fn: unknown, _ms: number) => 0) as unknown as typeof setInterval; // recorded, not started
    const quiet = [spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "log").mockImplementation(() => {})];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    try {
      arrange();
      await startScheduler({} as unknown as Client, extra); // the first tick's own promise (#548)
    } finally {
      fetchSpy.mockRestore();
      for (const spy of quiet) spy.mockRestore();
      globalThis.setInterval = realSetInterval;
      config.watchedRepos = realRepos;
    }
  };

  test("a tick started while a restart is pending runs no check at all -- not even the core ones", async () => {
    const exits: number[] = [];
    const restoreExit = setExitFn((code) => void exits.push(code));
    let ran = false;
    try {
      await tickWith(
        [{ name: "extra", run: async () => void (ran = true) }],
        () => requestRestart("pending before the tick"), // critical depth 0: exits (into the stub) at once, stays pending
      );
    } finally {
      restoreExit();
    }
    expect(exits).toEqual([RESTART_EXIT_CODE]);
    expect(ran).toBe(false);
    expect(announceStateForTest().lastReleasePollAt).toBe(0); // the releases check did not run either
  });

  test("a restart requested by a check lands only once the whole tick's critical section has closed", async () => {
    const exits: number[] = [];
    const restoreExit = setExitFn((code) => void exits.push(code));
    let exitedBeforeCheckEnded: boolean | undefined;
    try {
      await tickWith([
        {
          name: "restarter",
          run: async () => {
            requestRestart("a check wants a restart"); // inside the tick's critical section: deferred, not exited
            await Bun.sleep(5);
            exitedBeforeCheckEnded = exits.length > 0;
          },
        },
      ]);
    } finally {
      restoreExit();
    }
    expect(exitedBeforeCheckEnded).toBe(false); // deferred: the tick holds the critical section
    expect(exits).toEqual([RESTART_EXIT_CODE]); // and landed when the tick's section closed (endCritical -> doExit)
  });
});
```

`requestRestart` inside T-B arms the 30-minute deferral timer (`src/restart.ts:369-370`); `endCritical`'s
`doExit` clears it (`:240`, `:389-390`) when the tick's section closes, and the `afterEach`'s
`resetRestartForTest()` clears `pending` -- so nothing outlives the test. (`doExit` also runs the #446 exit hooks,
`:392`; none is registered here.)

**The stale header of the `runTick` describe** (`:515-518`) -- replace exactly these four lines:

```ts
// Scoped to runTick's isolation guarantee (issue #43). checkReleases is exported with injectable deps
// (#342) and tested above; the remaining core checks (checkAutoUpdate, and the plugin-request/update
// passes) call real discord.js / GitHub APIs and aren't exported, so this exercises the actual
// extracted isolation mechanism onTick delegates to, rather than mocking discord.js's Client end-to-end.
```

with:

```ts
// Scoped to runTick's isolation guarantee (issue #43). checkReleases is exported with injectable deps
// (#342) and tested above; the remaining core checks call real discord.js / GitHub APIs and their gates
// are driven through tickChecks and startScheduler (#439, #460: the cadence tests above, the restart-safety
// describe below), so this exercises the actual extracted isolation mechanism onTick delegates to, rather
// than mocking discord.js's Client end-to-end.
```

Wording only.

### Step 5 -- `src/index.test.ts` (#460): T-G, the boot-write order

In the test `installs+loads plugins inside activate() before rest.put, and activates before the scheduler`
(`:152-179`), add the lookup beside `markReady` (`:164`) and one assertion beside `:172`:

```ts
    const writeState = source.indexOf("await writePluginState({", activateFn);
```

add `writeState` to the `for (const pos of [...])` list at `:166`, and after `:172`:

```ts
    // #460: the pluginUpdates tick (and /plugins' writes) are gated on pluginStateReady precisely so they cannot
    // race this one-time whole-file write; the flag must flip only after it.
    expect(writeState).toBeLessThan(markReady);
```

### Mutation table (run in a scratch worktree, never in the shared tree)

Commit the work in progress first (the detached tree is cut from the branch's committed head), then:

```bash
git -C /s/repos/rackbops-discord-bot worktree add --detach /s/Repos/_wt/rdb-530-R3-mut fix/530-R3-announce
cd /s/Repos/_wt/rdb-530-R3-mut && bun install --frozen-lockfile
```

Apply one mutation at a time in `/s/Repos/_wt/rdb-530-R3-mut`, run
`bun test src/announce.test.ts src/github.test.ts src/index.test.ts` there, record the failing test name(s),
revert (`git -C /s/Repos/_wt/rdb-530-R3-mut checkout -- .`), next. Remove the worktree at the end
(`git -C /s/repos/rackbops-discord-bot worktree remove /s/Repos/_wt/rdb-530-R3-mut`).

| # | Mutation (production line at `d1234d7`) | Test that must fail (first failing assertion) |
|---|---|---|
| M1 | `src/announce.ts:225`: `if (shouldPollReleases(Date.now(), lastReleasePollAt)) await checkReleases(client);` -> `await checkReleases(client);` | T-E (second run polls again) |
| M2 | `:225`: pass `0` instead of `lastReleasePollAt` | T-E |
| M3 | `:460`: delete `lastReleasePollAt = Date.now();` | T-E (stamp 0, re-polls) and `:412` |
| M4 | `:460` moved to after the `for` loop (stamp at poll END) | T-E (`stampedAtFirstFetch` is 0) |
| M5 | `:487-490`: replace `return;` on the unreachable path with `delete state.seenReleaseIds[repo]; return;` | T-F ("list untouched": received `undefined`) |
| M5b | `:491-493`: add `delete state.seenReleaseIds[repo];` inside the `"recovered"` branch (re-seed on recovery) | T-F (nothing announced) |
| M6 | `src/github.ts:86`: `if (seen === undefined)` -> `if (seen === undefined \|\| seen.length > 0)` | T-F, `github.test.ts:213`, `:223`, `announce.test.ts:862` |
| M7 | `:262`: `if (pluginStateReady && shouldPollPluginUpdates())` -> `if (shouldPollPluginUpdates())` | T-C |
| M8 | `:231`: `if (config.autoUpdate && shouldPollUpdate())` -> `if (shouldPollUpdate())` | T-D (stamped while off) |
| M9 | `:309`: `return Date.now() - lastUpdatePollAt >= UPDATE_POLL_GAP_MS;` -> `return true;` | T-D (stamped at T0 + GAP - 1) |
| M10 | `:297`: delete `if (restartPending()) return;` | T-A (`exits` is `[75, 75]`: the second from `endCritical`; then `ran`) |
| M11 | `:304`: `withCritical(() => runTick(tickChecks(client, extraChecks)))` -> `runTick(tickChecks(client, extraChecks))` | T-B (exit before the check ended) |
| M12 | `:393`: `>=` -> `>` in `shouldPollReleases` | `:356`, `:365`, and T-E's last leg |
| M13 | `:313`: move `lastUpdatePollAt = Date.now();` to after `await checkForUpdate();` | T-D2 (`stampedAtFetch` is 0) |
| M14 | `src/index.ts`: move the whole boot-write `try { ... } catch (err) { ... }` block (`:453-475`, the one holding `await writePluginState({` at `:457`) to just below `markPluginStateReady();` (`:491`) | T-G only (the cruder mutant -- hoisting `markPluginStateReady();` above the `try {` at `:453` -- is also caught by the existing `:428` drain-order test, so it would not show T-G's worth) |

A mutant that survives is an unguarded claim: fix the test, do not weaken the table.

### Coverage table

| Bullet (the one observable outcome each finding demands) | Step(s) | Test | Mutation that fails it |
|---|---|---|---|
| #437: the code comment and `CONTEXT.md:174` say a returning repo announces what it missed (at most the page of 15) and only a first-ever poll seeds silently; the behaviour is pinned | 2, 3, 4 (T-F) | T-F | M5, M5b, M6 |
| #438: `github.ts` header and `CONTEXT.md:196` state the true consequence of a tick past the watchdog (no gap-gated check runs twice within its gap; a releases overlap needs a walk longer than the gap); stamp-at-start is pinned for releases and self-update | 1, 3, 4 (T-E, T-D2) | T-E (stamp leg), T-D2 | M4, M13 |
| #439: the `releases` check polls once at startup, not inside the 15-minute gap, again after it | 4 (T-E) | T-E | M1, M2, M3, M12 |
| #460: no tick starts while a restart is pending | 4 (T-A) | T-A | M10 |
| #460: the whole tick is one critical section | 4 (T-B) | T-B | M11 |
| #460: `pluginUpdates` is gated on the boot state write, and that flag flips only after the write | 4 (T-C), 5 (T-G) | T-C, T-G | M7, M14 |
| #460: `autoUpdate` is gated on `AUTO_UPDATE` and its gap | 4 (T-D) | T-D | M8, M9 |
| (docs claim) the phrase check finds four lines before and none after | 3 | manual (Step 3's Grep) | n/a |

### Verification (run from the worktree root; paste real output in the PR)

```bash
bun install --frozen-lockfile
cd ops/admin && bun install --frozen-lockfile && cd ../..
bun run check
bunx tsc --noEmit -p ops/tsconfig.json
cd ops/admin && bun run check && cd ../..
bun test src/announce.test.ts src/github.test.ts src/index.test.ts src/state.test.ts src/dataIsolation.test.ts test/stateGuard.test.ts
bun test --randomize src/announce.test.ts
bun test
```

- The full `bun test` is slow on this box (the `ops/` subprocess tests take minutes per file): run it in the
  background and paste its tail.
- The randomized run matters here: T-E, T-D and T-D2 move the system clock and T-A/T-B set restart state; every
  `finally`/`afterEach` above restores it, and the test-state guard (`test/stateGuard.ts`) fails the test that
  does not. A guard failure naming `src/restart.ts`, `src/update.ts` or `src/announce.ts` after one of the new
  tests is a cleanup bug in that test, not a flake.
- The Step 3 phrase check: four lines before the edits, none after.
- Paste the mutation table with the failing test name per row.

### Acceptance to paste per issue (none of the four has an `## Acceptance` section; these are the outcomes they demand)

- **#437:** the Step 3 phrase check (before and after); T-F's pass line; M5 and M5b's failing output.
- **#438:** the new `src/github.ts:13-27` and `CONTEXT.md:196` text; T-E's and T-D2's pass lines; M4 and M13's
  failing output.
- **#439:** T-E's pass line; M1 and M3's failing output.
- **#460:** T-A, T-B, T-C, T-D, T-G pass lines; M7, M8, M10, M11, M14's failing output.

### PR

- Title: `test(announce): pin the tick's cadence gates and restart safety; say what a returning repo and a tick past the watchdog really do (#437, #438, #439, #460)` -- match the log's `type(scope): subject (#N)` shape.
- Body: the four findings in one line each, the decision in Decisions 1 (behaviour kept, words fixed; roshne
  can reverse it), the typecheck + test output, the mutation table, the phrase check. GitHub needs one closing
  keyword per issue, so end with four lines: `Closes #437.` / `Closes #438.` / `Closes #439.` / `Closes #460.`
- After merge: tick the four boxes on #530 (byte-exact; the body is CRLF).

### Out of scope, on purpose

- No in-flight flag around `checkReleases` (#438's alternative): the stamp-at-start gate is that flag.
- No pruning of stale `seenReleaseIds` keys for repos no longer watched: a separate, data-path change if ever wanted.
- `README.md:239` stays: it is accurate.
- #499/#500 (release-fetch limits -- the page bound named above -- and rate-limit handling) are their own Low group.
