// Shared client-IP resolution for the host's HTTP router (docs/adr/0007-host-owned-http-router.md
// decision 2's trust caveat; #319). `CF-Connecting-IP` is set by Cloudflare's edge for anything
// that genuinely transits its network, but nothing about a raw HTTP request proves it actually
// came that way -- a header is just text a caller supplies. ADR-0007 documented this exact gap
// itself ("nothing re-verifies it"). This module is that verification: the header is honored only
// from a peer address that resolves to the deployment's own Cloudflare Tunnel sidecar
// (`TRUSTED_PROXY_HOST`); everything else falls back to the real connection peer, so an untrusted
// caller can never claim a fresh identity per request. Copied from Rackbops/rackbops-bot-plugins#70
// (packages/net/clientIp.ts) rather than published as a package -- the two repos don't share one.
// That repo owns it (Epic #269 decision 4); behaviour changes there are mirrored here by hand.
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export interface TrustedProxy {
  /** Synchronous, so a listener's per-request hot path never awaits a DNS lookup. Checks the
   *  CURRENTLY cached address set; see `refresh()` for how that set gets populated. */
  isTrusted(peerAddress: string): boolean;
  /** Re-resolves `host` and replaces the cached address set. Never throws -- a transient DNS
   *  failure leaves the existing set (if any) in place rather than revoking trust that was already
   *  established, or crashing a plugin's `activate()` over a momentarily-unreachable resolver; it is
   *  logged once per failure streak (#493). With `timeoutMs`, resolves after at most that long even if
   *  the lookup has not answered; the lookup keeps running and the set is replaced when it does. */
  refresh(timeoutMs?: number): Promise<void>;
}

/** Re-resolution is capped at once per this window, triggered by a cache miss in `isTrusted`
 *  (never by a timer) -- compose can recreate the tunnel sidecar with a new address at any time,
 *  but a hot loop of misses (an attacker deliberately varying its own address) must not turn into a
 *  hot loop of DNS lookups either. A successful lookup re-arms this full window. */
const REFRESH_THROTTLE_MS = 60_000;
/** After a FAILED lookup the next miss may retry this soon (#493): a sidecar that is not up yet at boot is
 *  trusted within seconds of appearing, not a minute, while a hot loop of misses still cannot become a hot loop
 *  of lookups (one in flight at a time, and never sooner than this). */
const REFRESH_RETRY_MS = 5_000;
/** How long `index.ts` waits on the boot-time refresh before it starts the listener anyway (#493). The lookup
 *  keeps running and trust lands when it does; requests meanwhile are untrusted (fail closed). */
export const PROXY_BOOT_REFRESH_TIMEOUT_MS = 2_000;

async function defaultLookup(host: string): Promise<string[]> {
  const results = await dnsLookup(host, { all: true });
  return results.map((r) => r.address);
}

/**
 * One spelling per address, so the resolved set and the peer `isTrusted` is asked about compare equal
 * whichever form either arrives in.
 *
 * An IPv4-mapped IPv6 address (`::ffff:x.x.x.x`) comes down to its plain IPv4 form. Found during round-2
 * gate testing: `Bun.serve` with no explicit `hostname` (every call site in this repo) binds dual-stack,
 * and an IPv4 peer connecting to that listener is reported by `srv.requestIP()` in mapped notation --
 * confirmed directly (`bun -e` against a real listener), not assumed. `dns.promises.lookup` never returns
 * that notation for an IPv4 result, so without this the trusted-address Set and the peer address
 * `isTrusted` is asked to check would never match for a real IPv4 tunnel sidecar: the whole fix would
 * silently never engage.
 *
 * Any other IPv6 literal is canonicalized through the URL parser (#494): lowercase, zeros compressed, an
 * embedded IPv4 tail in hex, so an operator's `FD00::1` or `fd00:0:0:0:0:0:0:1` equals the compressed form
 * `srv.requestIP` reports. The WHATWG host parser is the one IPv6 normalizer the runtime ships; it refuses
 * a zone id, so that is dropped first (Bun 1.4.2 on Windows reports a link-local peer without one, so a zone
 * could never match; dropping it on both sides makes the comparison hold whichever way a platform reports
 * it). Applied on BOTH sides of the comparison. Anything else (a plain IPv4 address, a hostname) passes
 * through unchanged.
 */
export function canonicalAddress(address: string): string {
  // First, and on its own: the dotted mapped form is what Bun reports for every IPv4 peer, so the common
  // request skips the URL parse below (which would reach the same answer through the hex fold).
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (isIP(address) !== 6) return address;
  // A zone id (`fe80::1%eth0`, `fe80::1%8`) is dropped: `isIP` accepts it and `dns.lookup` returns it, but Bun
  // reports a link-local peer WITHOUT one (probed on Bun 1.4.2, Windows), so a zone could never match the peer.
  // Dropped on both sides, the comparison holds whichever way a platform reports it.
  const zoneAt = address.indexOf("%");
  const bare = zoneAt === -1 ? address : address.slice(0, zoneAt);
  let canonical: string;
  try {
    canonical = new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    return bare.toLowerCase();
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

/**
 * `opts.host` is the compose hostname of the Cloudflare Tunnel sidecar in front of this listener
 * (env `TRUSTED_PROXY_HOST`; see `.env.example` for the deployed example value). `undefined` means
 * "not configured": `isTrusted` always returns `false` and the header is never honored -- fail
 * closed, matching every other unconfigured-feature rule in this repo. `opts.lookup`/`opts.now` are
 * test seams; production always resolves real DNS and reads the real clock. `opts.log` receives the
 * proxy's own lines: the first successful resolve, a failure (once per streak), the recovery, and a boot
 * refresh that hit its bound (#493).
 */
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
        // A success keeps the full-window stamp set above; only a failure shortens it (below).
        if (!everResolved || failing) log?.log(`[http] TRUSTED_PROXY_HOST "${host}" resolved to ${addresses.size} address(es)`);
        everResolved = true;
        failing = false;
      } catch (err) {
        // Leave `addresses` as it was -- see the interface doc comment. Say so once per streak, and let a
        // miss retry soon (#493).
        nextRefreshAt = now() + REFRESH_RETRY_MS;
        if (!failing) log?.warn(`[http] TRUSTED_PROXY_HOST "${host}" did not resolve (${err}); CF-Connecting-IP stays untrusted until it does`);
        failing = true;
      }
    })();
    // Cleared AFTER the assignment settles, never from inside the body: a `lookup` that threw synchronously
    // used to run the body's `finally` before `inFlight` was even assigned, leaving a settled promise there
    // for good and no later lookup ever running.
    inFlight = run.finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    isTrusted(peerAddress: string): boolean {
      if (host === undefined) return false;
      const trusted = addresses.has(canonicalAddress(peerAddress));
      // Fire-and-forget: THIS call still answers from the address set as it stood when the
      // request arrived. The miss that triggers a refresh is itself still correctly untrusted --
      // refreshing can only help a LATER request, never retroactively change this one's answer.
      if (!trusted && now() >= nextRefreshAt) void doRefresh();
      return trusted;
    },
    refresh(timeoutMs?: number): Promise<void> {
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

/**
 * `CF-Connecting-IP` is honored only when `peerAddress` is a trusted proxy address AND the header
 * is present and a syntactically valid IP literal -- an untrusted peer, a missing header, or a
 * header that isn't an IP all fall back to `peerAddress` itself, which in turn falls back to
 * `"unknown"` if the caller has no peer address to report (Bun's `requestIP` can return `null` for
 * a request over an already-closed socket).
 *
 * A repeated header collapses to one comma-joined string per the Fetch `Headers` contract.
 * Cloudflare's edge sets this header to exactly one value, so a header containing a comma is not
 * something Cloudflare produced: it is distrusted outright (fall back to `peerAddress`), never
 * parsed for a "first" or "last" value (Rackbops/rackbops-bot-plugins#181).
 */
export function clientIpFrom(req: Request, peerAddress: string | undefined, proxy: TrustedProxy): string {
  if (peerAddress !== undefined && proxy.isTrusted(peerAddress)) {
    const header = req.headers.get("CF-Connecting-IP");
    if (header !== null) {
      // `isIP` rejects any string containing a comma, so a multi-valued header never validates.
      const value = header.trim();
      if (isIP(value) !== 0) return value;
    }
  }
  return peerAddress ?? "unknown";
}
