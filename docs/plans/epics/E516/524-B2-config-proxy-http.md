<!-- Plan for sub-epic #524 of Epic #516 (Rackbops/rackbops-discord-bot), bundle B2: config validation, the
trusted-proxy lookup, privileged plugin intents and the keep-alive 503. Written by the orchestrating session
on 2026-10-15 against `main` @ `c783ad0`. Every file:line below was read from that tree; the implementer
re-reads each one on the tree it works from and corrects any that moved. -->

## Implementation plan -- #524 bundle B2: `src/config.ts`, `src/net/clientIp.ts`, `src/plugins/registry.ts`, `src/http.test.ts`

Children: **#494** (items 9, 10, 11, 12; item 13 is closed by reference), the rest of **#493** (items 4,
5, 6, 7) and the rest of **#495** (the config row and the XFF sentence of item 14). One PR, which closes
#493, #494 and #495. A behaviour change (two boot-time validations, the proxy lookup's bound, backoff and
logging, a new plugin skip reason), so the **three-reviewer gate** applies: you plus two read-only
adversarial reviewers with different lenses, up to four rounds, then report. Every coverage row is
mutation-tested in a scratch worktree, real output pasted.

Bundle B1 owns `src/ready.ts`, `src/dataDir.ts`, `src/bootLog.ts`, the `ClientReady` block of `index.ts`
(`:130-139`) and `storage.ts:20-69`; this bundle does not touch them. Start from `origin/main` once B1's PR
is open; if B1 merges first, `gh pr update-branch` resolves the `CONTEXT.md` and `index.test.ts` hunks,
which are disjoint.

### What is wrong, verified at `c783ad0`

- `src/config.ts:84-93`: `WATCHED_REPOS` tokens are split, trimmed and deduped (`list()`, `:70-77`) and
  never checked for shape; only the exact lowercase `none` switches the watcher off (`:87`), and
  `config.test.ts:117-122` pins `NONE` -> `["NONE"]` on purpose. `ops/bot-ops.sh:210`'s `env-set` row already
  requires `^(none|owner/repo(,owner/repo)*)$` with `[A-Za-z0-9_.-]`, so a hand-edited `.env` is the only
  way `None` reaches the bot, where it becomes `GET repos/None/releases` every tick. (#494 item 10; closes
  #500's item 11 by reference.)
- `config.ts:149`: `TRUSTED_PROXY_HOST` is checked against `[A-Za-z0-9.:[\]-]+`: `[fd00::1]` passes and can
  never resolve, an underscore (legal in a compose service name) is refused, and nothing canonicalizes an
  IPv6 spelling: `clientIp.ts:46-49` maps only `::ffff:x.x.x.x`, so `FD00::1` or `fd00:0:0:0:0:0:0:1` in
  the resolved set never equals the compressed lowercase form `srv.requestIP` reports. `TRUSTED_PROXY_HOST`
  is `RESERVED` in `bot-ops.sh:322`, so there is no `env-set` row to keep in step. (#494 item 9.)
- `config.test.ts:71-74` passes only unset required vars (`required()` at `config.ts:59-63` uses `!v`, so a
  blank is refused, untested); `:81-83` has `R_` as the only bad prefix (`{1,20}` at `:98` is untested at
  20/21); `.env.example:12-15` omits the cap. (#494 item 11.)
- `http.test.ts:181-194`: `if (second !== undefined) expect(second.status).toBe(503)` is skipped when the
  second fetch fails, and `called === 1` also holds if `stop()` closed the idle socket; the `closing` check
  (`http.ts:36`) is pinned only when Bun happens to reuse the connection. (#494 item 12.)
- `index.ts:332`: `await proxy.refresh()` runs `dns.lookup` with no bound (`clientIp.ts:29-32`) before the
  listener, routing, the boot state write and `markPluginStateReady`; on a missing name Docker's resolver
  forwards upstream and the wait is the resolver's timeout. (#493 item 4.)
- `clientIp.ts:74-80`: a failed lookup is swallowed with no log, `lastRefreshAt` was stamped at `:73`, so
  the next miss cannot refresh for 60 s (`:93`); `index.ts:324-325` says the first request sees the real
  set. (#493 item 5.)
- `src/plugins/registry.ts:192-205` unions any numeric intent an index entry declares into the Client;
  `index.ts:481`'s `client.login` has no catch. A privileged intent the operator has not enabled is refused
  at login, the process exits, `restart: unless-stopped` loops. The live index (fetched 2026-10-15) declares
  `intents: []` for all five plugins (`mcp`, `music`, `tracker`, `warbandeer`, `wow`), so a skip changes
  nothing deployed. (#493 item 6.)
- ADR-0004 decision 3 (`docs/adr/0004-...md:62-66`) says "A plugin never crashes the bot"; PR #539
  (#470) **declined** a process-level `unhandledRejection` handler and documented the limit in
  `src/plugins/contract.ts:415-418` and `CONTEXT.md:553-555`, but the ADR heading still reads as unconditional.
  (#493 item 7: documentation only, the handler stays declined.)
- `CONTEXT.md:158` says `config.ts` "throws at import time on missing required vars or an invalid
  `COMMAND_PREFIX`"; it also throws for `PLUGINS`, `PLUGIN_INDEX_URL`, `HTTP_PORT`, `TRUSTED_PROXY_HOST` and
  a mixed `none`, and the row names neither `releaseAnnounceChannelId` nor `httpPort` nor
  `trustedProxyHost`. `clientIp.ts:107-110` calls honoring the FIRST value "the same defensive convention as
  a standard `X-Forwarded-For` chain", where the trustworthy entry is the LAST one your own proxy appended;
  the analogy is backwards. (#495 item 14.)

### Decisions (defaults, named so the gate can contest them)

1. **`WATCHED_REPOS` tokens must match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`** — the class `bot-ops.sh:210`
   already accepts, so `env-set accepts => the bot boots` keeps holding (#430's invariant). Any case of
   `none` other than lowercase is refused by name with a hint, not accepted as the sentinel: the #342
   decision ("only the exact lowercase word is the switch") stands, and refusing matches what `env-set`
   already does.
2. **`TRUSTED_PROXY_HOST` is a hostname `^[A-Za-z0-9_.-]+$` or an IP literal `isIP(v) !== 0`** (brackets
   out, underscore in, any IPv6 spelling in). **`canonicalAddress` canonicalizes IPv6 through the URL
   parser** (`new URL(`http://[${a}]/`).hostname`, brackets stripped): probed on Bun 1.4.2,
   `FD00:0:0:0:0:0:0:1` -> `fd00::1`, `2001:DB8::0001` -> `2001:db8::1`, `64:ff9b::1.2.3.4` ->
   `64:ff9b::102:304`; a zone id (`fe80::1%eth0`) throws and is left as typed, lowercased. The
   `::ffff:x.x.x.x` check stays FIRST, since the URL form of it is `::ffff:a00:5`; and because an operator
   can type the mapped form in hex (`::ffff:a00:5`, or `0:0:0:0:0:ffff:10.0.0.5`, which the parser also
   turns into hex), a canonical result of the shape `::ffff:HHHH:HHHH` is mapped back to dotted IPv4 after
   the URL step, so every spelling of an IPv4-mapped address lands on the same `10.0.0.5` that Bun's
   `::ffff:10.0.0.5` peer does. The platform's WHATWG host parser is the one IPv6 normalizer the runtime
   ships; a hand-written expander would be a second one to get wrong.
3. **The boot refresh is bounded at `PROXY_BOOT_REFRESH_TIMEOUT_MS = 2_000`** (exported from `clientIp.ts`);
   `refresh(timeoutMs?)` resolves at the bound, the lookup keeps running and the set is replaced when it
   lands. Fail closed meanwhile (an empty set), which `isTrusted` already is.
4. **After a failed lookup the next miss may retry after `REFRESH_RETRY_MS = 5_000`**, not 60 s; a success
   re-arms the 60 s throttle. One lookup in flight at a time, as before, so a miss storm still cannot become a
   lookup storm.
5. **Logging in `clientIp.ts` through an injected `log`** (`index.ts` passes `console`): a warning once per
   failure streak, one line on the first successful resolve and on recovery, and one when the boot refresh
   hits its bound. Not per failure: a permanently-absent sidecar would otherwise log every 5 s under traffic.
6. **The host never requests a privileged gateway intent.** `selectPlugins` skips an entry whose declared
   intents carry any bit of `GuildMembers` (`1 << 1`), `GuildPresences` (`1 << 8`) or `MessageContent`
   (`1 << 15`) — a **mask** test, not a lookup, since the index only requires each intent to be a number
   (`src/plugins/index.ts:88`) and discord.js ORs them, so `32770` would otherwise slip past as "not 32768"
   — with a reason naming the bits; the skip lands in `state.json` and the panel like every other. It runs
   after the host-API check, so an entry that is skipped for its host API today keeps that reason (and
   `registry.test.ts:225-233`, which uses `[32768]` on a host-API mismatch to pin `keepOlder`'s
   intents clause, stays as it is). Bits are spelled out in `registry.ts` (it imports nothing but the
   contract's types, `registry.ts:1-4`); the test reads them off discord.js's `GatewayIntentBits`. A later
   env knob can widen the allowed set; nothing published needs it today. This is the graceful degradation
   ADR-0004 decision 3 promises, and the issue's other option — a second `Client` after a failed login —
   restructures boot.
7. **Documentation only for #493 item 7** (the limit, in the ADR), per #539's decision.
8. **Closed by reference:** #494 item 13 (the standby verify timer armed late) is `redeploy-15`'s, #492
   in #525. #500 item 11 (`github-announce-11`) is closed **in part** by decision 1: the shape check refuses
   `None` and a bare word; its other half — case-insensitive dedupe and keying of `WATCHED_REPOS`
   (`Rackbops/x,rackbops/x` announcing twice, a case change re-keying `seenReleaseIds`) — stays with #500,
   because lowercasing the key re-keys saved data, which is a live-data-path change for roshne to decide.
   Say exactly that in the PR body and in the comment on #500.
9. **`src/plugins/contract.ts:157-159` is left as it is**, though its comment ("a privileged one the
   operator has not enabled is a login failure") goes stale with decision 6: the plugins repo's
   `check-contract` needs its vendored `contract.d.ts` byte-identical to this file (PR #539's body), so even
   a comment edit forces a re-vendor PR there. Name it in the PR body as a follow-up for the next contract
   touch (there is already one owed from #430: the env-key comments).

### Step 1 -- `src/config.ts`

- Add `import { isIP } from "node:net";` at the top (the file has no imports today).
- After the mixed-`none` check (`:88-93`):

  ```ts
  // #494: each entry is `owner/repo` -- the class ops/bot-ops.sh's env-set row already enforces, so a value
  // env-set accepts still boots; a hand-edited .env with `None`, a bare word or a path used to become a repo
  // GitHub 404s every tick. Only the lowercase word `none` is the switch (#342); any other case is refused by
  // name with a hint rather than guessed at.
  const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const badRepo = releaseWatchOff ? undefined : watchedRepos.find((r) => !REPO_SHAPE.test(r));
  if (badRepo !== undefined) {
    throw new Error(
      `WATCHED_REPOS must be "none" or a comma-separated list of owner/repo, got "${badRepo}"` +
        (badRepo.toLowerCase() === "none" ? " (only the lowercase word none switches the release watcher off)" : ""),
    );
  }
  ```

- `:144-151` (`TRUSTED_PROXY_HOST`): comment -> "A hostname (letters, digits, `.`, `_`, `-` — a compose
  service name may carry an underscore) or an IP literal as `node:net`'s `isIP` reads it: IPv6 in any
  spelling, **without** brackets, which `dns.lookup` cannot resolve; `clientIp.ts` canonicalizes both sides
  of the comparison (#494)." Check:

  ```ts
  if (trustedProxyHost !== undefined && isIP(trustedProxyHost) === 0 && !/^[A-Za-z0-9_.-]+$/.test(trustedProxyHost)) {
    throw new Error(`TRUSTED_PROXY_HOST must be a hostname or IP address, got "${trustedProxyHost}"`);
  }
  ```

- `.env.example:12-15`: "Lowercase letters/numbers/-/_ only (Discord rule); leave blank" -> "1-20 characters
  of lowercase letters/numbers/-/_ (Discord rule); leave blank". `:19-23` (`WATCHED_REPOS`): add "Each
  entry must be `owner/repo`; only the lowercase word `none` turns polling off." The `TRUSTED_PROXY_HOST`
  comment: "An IP literal is also accepted" -> "An IP literal is also accepted (IPv6 in any spelling, no
  brackets)".

### Step 2 -- `src/net/clientIp.ts`

```ts
const REFRESH_THROTTLE_MS = 60_000;
/** After a failed lookup the next miss may retry this soon (#493): a sidecar that is not up yet at boot is
 *  trusted within seconds of appearing, not a minute, while a hot loop of misses still cannot become a hot loop
 *  of lookups (one in flight at a time, and never sooner than this). */
const REFRESH_RETRY_MS = 5_000;
/** How long `index.ts` waits on the boot-time refresh before it starts the listener anyway (#493). The lookup
 *  keeps running and trust lands when it does; requests meanwhile are untrusted (fail closed). */
export const PROXY_BOOT_REFRESH_TIMEOUT_MS = 2_000;

export interface TrustedProxy {
  isTrusted(peerAddress: string): boolean;
  /** Re-resolves `host` and replaces the cached address set. Never throws -- a failed lookup leaves the
   *  existing set in place and is logged once per failure streak. With `timeoutMs`, resolves after at most that
   *  long even if the lookup has not answered; the lookup keeps running and the set is replaced when it does. */
  refresh(timeoutMs?: number): Promise<void>;
}

export function canonicalAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (isIP(address) !== 6) return address;
  // #494: one spelling per IPv6 literal -- lowercase, zeros compressed, an embedded IPv4 tail in hex -- so an
  // operator's `FD00::1` or `fd00:0:0:0:0:0:0:1` equals the compressed form `srv.requestIP` reports. The
  // WHATWG URL parser is the one canonicalizer the runtime ships; it refuses a zone id, left as typed.
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return address.toLowerCase();
  }
  // An IPv4-mapped address the parser rendered in hex (`::ffff:a00:5`, from `::ffff:a00:5` itself or from
  // `0:0:0:0:0:ffff:10.0.0.5`) is the same peer Bun reports as `::ffff:10.0.0.5`: back to dotted IPv4.
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1]!, 16);
    const lo = parseInt(hexMapped[2]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return canonical;
}

export function createTrustedProxy(opts: {
  host: string | undefined;
  lookup?: (host: string) => Promise<string[]>;
  now?: () => number;
  log?: Pick<Console, "log" | "warn">;
}): TrustedProxy {
  const { host, log } = opts;
  const lookup = opts.lookup ?? defaultLookup;
  const now = opts.now ?? Date.now;
  let addresses = new Set<string>();
  let nextRefreshAt = -Infinity;
  let inFlight: Promise<void> | undefined;
  let failing = false;
  let everResolved = false;

  function doRefresh(): Promise<void> {
    if (host === undefined) return Promise.resolve();
    if (inFlight) return inFlight;
    nextRefreshAt = now() + REFRESH_THROTTLE_MS; // stamped before the await: one lookup in flight at a time
    const run = (async () => {
      try {
        addresses = new Set((await lookup(host)).map(canonicalAddress));
        nextRefreshAt = now() + REFRESH_THROTTLE_MS;
        if (!everResolved || failing) log?.log(`[http] TRUSTED_PROXY_HOST "${host}" resolved to ${addresses.size} address(es)`);
        everResolved = true;
        failing = false;
      } catch (err) {
        // Leave `addresses` as it was; say so once per streak, and let a miss retry soon (#493).
        nextRefreshAt = now() + REFRESH_RETRY_MS;
        if (!failing) log?.warn(`[http] TRUSTED_PROXY_HOST "${host}" did not resolve (${err}); CF-Connecting-IP stays untrusted until it does`);
        failing = true;
      }
    })();
    // Cleared AFTER the assignment settles, never from inside the body: a `lookup` that threw synchronously
    // used to run the body's `finally` before `inFlight` was even assigned, leaving a settled promise there
    // for good and no later lookup ever running (the same shape the old code had).
    inFlight = run.finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    isTrusted(peerAddress) {
      if (host === undefined) return false;
      const trusted = addresses.has(canonicalAddress(peerAddress));
      if (!trusted && now() >= nextRefreshAt) void doRefresh();
      return trusted;
    },
    refresh(timeoutMs) {
      const run = doRefresh();
      if (timeoutMs === undefined) return run;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log?.warn(`[http] TRUSTED_PROXY_HOST "${host}" has not resolved after ${timeoutMs}ms; starting with CF-Connecting-IP untrusted until it does`);
          resolve();
        }, timeoutMs);
      });
      return Promise.race([run.finally(() => clearTimeout(timer)), bound]);
    },
  };
}
```

Keep the existing comments where they still hold; update the `REFRESH_THROTTLE_MS` comment (`:23-26`) to
mention the retry window, and `:14-20`. Reword `:107-110`: "A repeated header collapses to one comma-joined
string per the Fetch `Headers` contract; only the FIRST value is honored. Cloudflare's edge sets this header
exactly once for a request that transited it, so a second value can only be something a caller appended.
(This is not an `X-Forwarded-For` chain, where the trustworthy hop is the LAST one your own proxy appended;
`CF-Connecting-IP` is single-valued by contract, which is why first-wins is right here and would be wrong
there.)"

### Step 3 -- `src/index.ts:324-333` and `src/index.test.ts:288-298`

- Import: `import { createTrustedProxy, PROXY_BOOT_REFRESH_TIMEOUT_MS } from "./net/clientIp";` (`:58`).
- `:324-333`:

  ```ts
      // #319: resolved (or explicitly never-trusted) before the listener binds, so the first request sees the
      // real address set when the sidecar answers within the bound. #493: bounded, so a sidecar that cannot be
      // resolved yet (a first `up`, a host reboot) delays command registration and the ready flag by at most
      // PROXY_BOOT_REFRESH_TIMEOUT_MS, not by the resolver's own timeout; the lookup keeps running and trust
      // lands when it does -- fail closed meanwhile. Failures and recoveries are logged by the proxy itself.
      const proxy = createTrustedProxy({ host: config.trustedProxyHost, log: console });
      if (config.trustedProxyHost === undefined) {
        console.log("[http] TRUSTED_PROXY_HOST is not set -- CF-Connecting-IP will never be trusted; every caller shares one rate-limit budget");
      } else {
        await proxy.refresh(PROXY_BOOT_REFRESH_TIMEOUT_MS);
      }
  ```

- `index.test.ts:288`: the regex becomes
  `/createTrustedProxy\(\{\s*host:\s*config\.trustedProxyHost,\s*log:\s*console\s*\}\)/g` (keep the `g`
  flag: the assertion counts matches, and without it `.length` is always 1); `:295-298`: both
  `"await proxy.refresh();"` pins become `"await proxy.refresh(PROXY_BOOT_REFRESH_TIMEOUT_MS);"`, and add
  `expect(source).toMatch(/import \{[^}]*\bPROXY_BOOT_REFRESH_TIMEOUT_MS\b[^}]*\} from "\.\/net\/clientIp";/)`
  and `expect(source).not.toMatch(/await proxy\.refresh\(\);/)` (the unbounded form is gone).

### Step 4 -- `src/plugins/registry.ts`

- Above `selectPlugins`:

  ```ts
  /** Discord's privileged gateway intents. An operator must enable each in the developer portal, and a
   *  Client built with one that is not enabled is refused at login: `client.login` rejects, the process exits,
   *  `restart: unless-stopped` loops (#493). The host never requests one -- an entry whose declared intents
   *  carry any of these bits is skipped, by name, before `collectIntents` can see it. A mask, not a lookup:
   *  the index only requires each intent to be a number and discord.js ORs them, so `32770` carries
   *  MessageContent as surely as `32768` does. The bits are discord.js's `GatewayIntentBits`, spelled out
   *  because this module imports nothing but the contract's types; `registry.test.ts` reads them off the
   *  library. A later env knob can widen the allowed set; nothing published today declares one. */
  const PRIVILEGED_INTENT_BITS: ReadonlyArray<readonly [number, string]> = [
    [1 << 1, "GuildMembers"],
    [1 << 8, "GuildPresences"],
    [1 << 15, "MessageContent"],
  ];

  /** The privileged intents `intents` carries, by name, or `[]`. */
  function privilegedIntentsIn(intents: readonly number[]): string[] {
    const names = new Set<string>();
    for (const value of intents) for (const [bit, name] of PRIVILEGED_INTENT_BITS) if ((value & bit) !== 0) names.add(name);
    return [...names];
  }
  ```

- In `selectPlugins`, after the closing brace of the host-API `if` (`:118`), before the #185 name check:

  ```ts
    const privileged = privilegedIntentsIn(entry.intents ?? []);
    if (privileged.length > 0) {
      selected.push({
        name: cfg.name,
        entry,
        pinnedVersion: cfg.version,
        skipped: `declares the privileged gateway intent${privileged.length > 1 ? "s" : ""} ${privileged.join(", ")} (in [${(entry.intents ?? []).join(", ")}]), which the host never requests`,
      });
      continue;
    }
  ```

  `registry.test.ts:225-233` (a host-API mismatch with `intents: [32768]` expecting `HOST_API_SKIP`) is left
  exactly as it is: the host-API check runs first, so its expectation still holds and it keeps guarding
  `keepOlder`'s intents clause.

- `:90-93` comment "and a privileged intent the operator hasn't enabled is an unrecoverable login failure"
  (it wraps across `:92-93`; anchor the Edit on one line) -> "(a privileged one is refused outright below,
  #493; a non-privileged one still changes the Client)".

### Step 5 -- `src/http.test.ts:181-194`

Replace the test with one over a raw keep-alive socket (`import { connect } from "node:net"`). What Bun
does here is platform-dependent: the auditor probed Bun 1.4.2 on Windows with exactly this shape and found
that `server.stop()` closes the idle kept-alive socket itself, so the second write gets no response and
`http.ts:36`'s `closing` branch is never reached through a kept-alive socket; Linux (CI) is unverified. So:

- connect to `127.0.0.1:http.port`; write `GET /x HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`;
  read until the response's headers and its `Content-Length` body have arrived (`ok`, 2 bytes); expect
  `HTTP/1.1 200` and `called === 1`.
- `http.stop()`; write the same request for `/y` on the **same** socket; race the next response against the
  socket's `close`/`end`/`error` events and a 2 s `Bun.sleep`, and record which won.
- **Assert, on every platform:** the race did not time out (a hung socket is the failure cloudflared would
  see), `called` is still 1 (the handler never ran again), and the outcome is one of exactly two: a response
  starting `HTTP/1.1 503` that carries `connection: close` (case-insensitive), or the socket closed with no
  bytes. Print the outcome and `process.platform` with `console.log` so the CI log says which branch Linux
  took; `socket.destroy()` in `finally`.
- Report both branches (local Windows, CI Linux) in the PR. If Linux also closes the socket, the `closing`
  check is unreachable through a kept-alive connection on both: keep it (it still answers a request Bun hands
  over after `stop()`, and costs nothing) but reword `http.ts:19-22`, `CONTEXT.md:162` and
  `docs/adr/0007-host-owned-http-router.md:61-62` ("including one on a connection cloudflared kept alive") to
  what is observed: Bun closes kept-alive connections on `stop()`, and the 503 is the backstop for a request
  it still hands over. If Linux answers the 503, the claim holds there and the docs say so per platform.
  Either way the claim ends pinned by a test that cannot pass vacuously.

### Step 6 -- docs, in the same PR

- `docs/adr/0004-plugins-fetched-from-a-published-manifest.md:62-66`, decision 3: after "where the baked-in
  connector refused to boot." append: "An entry that declares a privileged gateway intent (`GuildMembers`,
  `GuildPresences`, `MessageContent`) is skipped the same way, before the `Client` is built — the host never
  requests one, since a privileged intent the operator has not enabled is refused at login and would
  crash-loop every instance running that plugin (#493). The guarantee covers boot and every call the host
  makes into a plugin; work a plugin starts on its own — a timer, a listener, a promise nothing awaits — is
  outside it (Bun exits on an unhandled rejection and the host installs no process-level handler, #470;
  the contract says so on `activate()`)."
- `CONTEXT.md:158` (`src/config.ts` row): replace "throws at import time on missing required vars or an
  invalid `COMMAND_PREFIX`" with "throws at import time on: a missing or blank required var (`DISCORD_TOKEN`,
  `ANNOUNCE_CHANNEL_ID`); a `COMMAND_PREFIX` outside `[a-z0-9_-]{1,20}`; a `PLUGINS` token that is not `name`
  or `name@x.y.z(-pre)`, or one name in two tokens; a `PLUGIN_INDEX_URL` that is not http(s), `file://` or an
  absolute path; an `HTTP_PORT` outside 1-65535; a `TRUSTED_PROXY_HOST` that is neither a hostname nor an IP
  literal; a `WATCHED_REPOS` entry that is not `owner/repo`, or `none` mixed into a list (#494)"; and add the
  fields the row omits: `releaseAnnounceChannelId` (falls back to `announceChannelId`), `httpPort` (#220) and
  `trustedProxyHost` (#319, a hostname or an IP literal in any spelling, no brackets).
- `CONTEXT.md:163` (`src/net/clientIp.ts` row): the signature becomes `createTrustedProxy({ host, lookup?,
  now?, log? })`; add the IPv6 canonicalization (any spelling on either side, through the URL parser, with a
  hex-mapped IPv4 folded back to dotted), the failure/recovery log lines, the 5 s retry after a failed
  lookup, and the bounded boot refresh (`refresh(PROXY_BOOT_REFRESH_TIMEOUT_MS)` from `index.ts`); drop
  "never throws — a failed lookup keeps the previous set" only if you replace it with the fuller sentence.
- `src/plugins/contract.ts:157-159` is NOT edited (decision 9); say so in the PR body.
- `.env.example:13-14`'s prefix sentence and `registry.ts:92-93`'s comment wrap across lines: anchor each
  Edit on one line's worth of text.
- `CONTEXT.md`'s `src/plugins/registry.ts` row (grep `| \`src/plugins/registry.ts\` |`): add the
  privileged-intent skip and its reason text. Grep `privileged` across `CONTEXT.md` and `README.md` and
  update any sentence that still calls it an unrecoverable login failure.
- `CONTEXT.md:162` (`src/http.ts` row) only if step 5 took the second branch.

### Step 7 -- tests

`src/config.test.ts`:

| # | Test | Pins |
|---|---|---|
| T1 | `:117-122` becomes "WATCHED_REPOS=none turns the watcher off; any other spelling of none is refused by name" | `none`, ` none ` -> `[]`; `NONE`, `None` -> throws `/only the lowercase word none/` |
| T2 | "a WATCHED_REPOS entry that is not owner/repo is refused, naming it" (#494 item 10) | `foo`, `a/b/c`, `acme/`, `/thing`, `acme/thing beta` -> throws `/WATCHED_REPOS must be .* got "<token>"/`; `Acme/Thing.js, x_y/z-w` -> `["Acme/Thing.js", "x_y/z-w"]`; the mixed-none case (`:124-127`) still throws by name |
| T3 | "COMMAND_PREFIX is capped at 20 characters" (#494 item 11) | `"a".repeat(20)` passes through; `"a".repeat(21)` throws `/COMMAND_PREFIX/` |
| T4 | "a blank required var is refused like a missing one" | `{ DISCORD_TOKEN: "", ANNOUNCE_CHANNEL_ID: "100" }` throws `/DISCORD_TOKEN/`; `{ DISCORD_TOKEN: "t", ANNOUNCE_CHANNEL_ID: "" }` throws `/ANNOUNCE_CHANNEL_ID/` |
| T5 | `:373-377` extended: accepted verbatim | `cloudflared`, `cloud_flared`, `172.18.0.1`, `fd00::1`, `FD00::1`, `fd00:0:0:0:0:0:0:1`, `::ffff:10.0.0.5` |
| T6 | `:379-385` extended: refused | `tunnel host`, `a/b`, `[fd00::1]`, `fd00::1:` (not an IP, has a colon) |

`src/net/clientIp.test.ts` (import `canonicalAddress`, `PROXY_BOOT_REFRESH_TIMEOUT_MS`):

| # | Test | Pins |
|---|---|---|
| T7 | `canonicalAddress` / table | `::ffff:10.0.0.5` -> `10.0.0.5`; `::ffff:a00:5` -> `10.0.0.5`; `0:0:0:0:0:ffff:10.0.0.5` -> `10.0.0.5`; `FD00:0:0:0:0:0:0:1` -> `fd00::1`; `2001:DB8::0001` -> `2001:db8::1`; `64:ff9b::1.2.3.4` -> `64:ff9b::102:304`; `FE80::1%ETH0` -> `fe80::1%eth0`; `10.0.0.5`, `cloudflared` unchanged |
| T8 | "an IPv6 literal matches whatever spelling either side uses" | lookup `["FD00:0:0:0:0:0:0:1"]`, `isTrusted("fd00::1")` true; lookup `["fd00::1"]`, `isTrusted("FD00:0:0:0:0:0:0:1")` true; lookup `["::ffff:a00:5"]`, `isTrusted("::ffff:10.0.0.5")` true; `isTrusted("fd00::2")` false |
| T9 | "a failed lookup is retried after REFRESH_RETRY_MS on the next miss, and a success re-arms the full throttle" | fake clock; the fake `lookup` is `async` and rejects (never throws synchronously, as `clientIp.test.ts:97-98` does): it fails at `refresh()` (t=0); a miss at t=4_999 does not call lookup; a miss at t=5_000 does (now succeeding); a miss at t=5_001 and at t=64_999 does not; at t=65_000 it does |
| T10 | "a failure is warned once per streak, and the recovery logged once" | `log` spy; sequence success, fail, fail, success, success: after the first success one `log` line (`resolved to 1 address(es)`); after the two failures exactly one `warn` containing `did not resolve`; after the recovery a second `log` line; after the last success no new line (two `log`, one `warn` in all) |
| T11 | "the first successful resolve is logged" | fresh proxy with `log`; `refresh()` -> one `log` line |
| T12 | "refresh(timeoutMs) resolves at the bound when the lookup is slow, warns, and the lookup still lands" | `lookup: () => new Promise((r) => setTimeout(() => r(["10.0.0.5"]), 300))`; `await proxy.refresh(50)` returns in well under 300 ms (assert `< 250`); `isTrusted("10.0.0.5")` false; `warn` called with `has not resolved after 50ms`; `await Bun.sleep(400)`; `isTrusted("10.0.0.5")` true |
| T13 | "refresh() with no bound waits for the lookup" | the 300 ms lookup; `await proxy.refresh()`; `isTrusted` true at once |
| T14 | `PROXY_BOOT_REFRESH_TIMEOUT_MS` is 2000 | pin the constant |

`src/plugins/registry.test.ts` (import `GatewayIntentBits` from `discord.js` in the test only):

| # | Test | Pins |
|---|---|---|
| T15 | "an entry that declares a privileged intent is skipped, naming it, and a combined bitmask does not slip past" (#493 item 6) | for each of `GatewayIntentBits.GuildMembers`, `.GuildPresences`, `.MessageContent` (read off discord.js, not hard-coded): an entry with matching `hostApiVersion` and `intents: [bit]` is `skipped` matching `/privileged gateway intent <Name> \(in \[<bit>\]\)/`; `intents: [GatewayIntentBits.MessageContent | GatewayIntentBits.GuildMembers]` (32770) is skipped naming both `GuildMembers` and `MessageContent`; `intents: [512]` (GuildMessages) is selected |
| T16 | "the privileged bits are discord.js's" | `GatewayIntentBits.GuildMembers === 2`, `GuildPresences === 256`, `MessageContent === 32768` (so the literals in `registry.ts` are the library's) |
| T17 | "collectIntents never carries a privileged bit" | `collectIntents([1], selectPlugins(index, [{ name }], 1, []))` equals `[1]` for an entry declaring `[32768]` and for one declaring `[32770]` |

`src/http.test.ts`: step 5's test (T18).

### Coverage table

| Outcome | Step | Test | Mutation that must turn it red |
|---|---|---|---|
| a `WATCHED_REPOS` entry that is not `owner/repo` refuses boot, naming it | 1 | T2 | M1: delete the `REPO_SHAPE` block |
| `None`/`NONE` are refused with the hint, not polled | 1 | T1 | M1 again; M2: `releaseWatchOff = (...).trim().toLowerCase() === "none"` at `config.ts:87` (then `NONE` becomes `[]` and T1's throw goes red) |
| a 21-character prefix is refused | 1 | T3 | M3: `{1,20}` -> `{1,200}` |
| a blank required var is refused | 1 | T4 | M4: `if (!v)` -> `if (v === undefined)` |
| brackets are refused, an underscore and any IPv6 spelling accepted | 1 | T5, T6 | M5: restore the old character class |
| both sides of the trust comparison share one IPv6 spelling | 2 | T7, T8 | M6: return `address` for IPv6 in `canonicalAddress`; M6b: delete the hex-mapped fold (the `::ffff:a00:5` rows go red) |
| the mapped-IPv4 case still wins | 2 | T7 (first row), existing `:31-43` | M7: move the dotted mapped check below the URL step |
| a failed lookup retries in 5 s, not 60 | 2 | T9 | M8: `REFRESH_RETRY_MS` -> `REFRESH_THROTTLE_MS` in the catch |
| failures and recovery are logged once each | 2 | T10, T11 | M9: delete the `failing` flag (warn every time) -- T10's count red; M10: delete the warn -- red; M10b: the success condition `if (!everResolved)` alone (the recovery line vanishes; T10's second `log` count red) |
| the boot refresh is bounded and the late lookup still lands | 2, 3 | T12, T13, `index.test.ts` pins | M11: `refresh` ignores `timeoutMs`; M12: `index.ts` calls `refresh()` unbounded |
| a plugin declaring a privileged intent is skipped by name, combined bits included | 4 | T15, T17 | M13: delete the privileged block; M14: change `1 << 15` to `1 << 14` (T15 and T17 red); M14b: `intents.includes(bit)` instead of the mask (the 32770 rows go red) |
| the 503-after-stop claim is pinned | 5 | T18 | M15: delete `if (closing) return ...` at `http.ts:36` (red on a platform that answers the 503; equivalent on one that closes the socket -- report per platform); M15b: `stop()` no longer calls `server.stop()` (the second request is served, `called` 2, red everywhere) |
| the docs say what the code does | 6 | manual: reviewer B reads every edited sentence against the code | -- |

Run every mutation in a scratch copy (`git worktree add --detach <path> <sha>`), never in the tree the
tests or a reviewer are reading. Paste the red test's name per row in the PR.

### Checks, gate, PR

- `bun run check`; `bunx tsc --noEmit -p ops/tsconfig.json`; `bun run check` inside `ops/admin/`;
  `bun test` from the repo root, then `bun test --randomize` once. Name CI's Linux run as the evidence for
  the `ops/*` suites that skip here. The PR is not ready until CI is green.
- Review gate: reviewer A on correctness and failure modes (the `REPO_SHAPE` class against
  `bot-ops.sh:210` so `env-set accepts => the bot boots` still holds; `isIP` on zone ids and on `::ffff:`
  forms; the race between a timed-out boot refresh and a later `isTrusted` miss — `inFlight` must stop a
  second lookup; the `nextRefreshAt` stamp before the await; the raw-socket test on Linux CI vs Windows;
  the privileged bits); reviewer B on claims-vs-code, walking the coverage table and every edited comment,
  ADR and doc line against the merged tree. Both read-only, both handed the merged tree and the issues. Fix
  or decline every evidenced finding in writing; re-run the gate on the whole merged state after a
  behaviour fix.
- Branch `fix/524-B2-config-proxy-http`; commit and PR title
  `fix(config): validate WATCHED_REPOS and TRUSTED_PROXY_HOST, bound and log the proxy lookup, refuse privileged plugin intents (#493, #494, #495)`.
  Body: one line each `Closes #493`, `Closes #494`, `Closes #495` (B1 carried the other items; name B1's PR);
  the pasted checks; the mutation rows; the gate's rounds; which branch step 5 took on Windows and on CI;
  decisions 1-9 named as assumptions taken; the closed-by-reference lines (#494 item 13 -> #492; #500 item
  11 -> in part, this PR's `REPO_SHAPE`, the case-insensitive dedupe/keying half stays with #500; #493 item
  7 -> documented, handler declined in #539); the `contract.ts:157-159` follow-up. After the merge, comment
  on #500 naming the PR, the item and what of it remains (do not close it). Do not merge.

### Hand-off brief

```
EXECUTE AS WRITTEN
Repo: S:\Repos\rackbops-discord-bot. Work in a NEW worktree, never the shared checkout:
  git -C S:\Repos\rackbops-discord-bot worktree add S:\Repos\_wt\rdb-524-B2 origin/main -b fix/524-B2-config-proxy-http
Issues: Rackbops/rackbops-discord-bot #493 #494 #495 (sub-epic #524 of Epic #516). Read each issue body first.
Plan: docs/plans/epics/E516/524-B2-config-proxy-http.md on branch claude/524-plans:
  git -C S:\Repos\rackbops-discord-bot show origin/claude/524-plans:docs/plans/epics/E516/524-B2-config-proxy-http.md
Behaviour change: run your own three-reviewer gate (two read-only adversarial reviewers, different lenses), up to four rounds, then report instead of a fifth. Every mutation in a scratch worktree. Scratch files: task-unique names (pr-body-524B2.md, commit-msg-524B2.txt), read back before use. Report the PR link, the pasted checks, the mutation table, the gate's rounds, which branch step 5 took, and any deviation. Do not merge.
```
