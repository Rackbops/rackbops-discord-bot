// Direct unit tests for the shared client-IP trust boundary (#319, copied from
// Rackbops/rackbops-bot-plugins#70's packages/net/clientIp.test.ts). http.test.ts covers the REAL
// Bun.serve wiring end to end; these pin the pure decision logic itself, one case at a time, with a
// fake DNS lookup and a fake clock so nothing here touches a real resolver or a real timer.
import { describe, expect, test } from "bun:test";
import { canonicalAddress, clientIpFrom, createTrustedProxy, PROXY_BOOT_REFRESH_TIMEOUT_MS } from "./clientIp";

function fakeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://test.invalid/", { headers });
}

describe("createTrustedProxy / isTrusted", () => {
  test("header trusted only when the peer is a resolved proxy address", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);
    expect(proxy.isTrusted("10.0.0.6")).toBe(false);
  });

  test("header ignored from an untrusted peer", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    const req = fakeRequest({ "CF-Connecting-IP": "203.0.113.9" });
    expect(clientIpFrom(req, "10.0.0.99", proxy)).toBe("10.0.0.99");
  });

  // Round-2 gate finding: `Bun.serve` with no explicit `hostname` (every call site in this repo)
  // binds dual-stack, and reports a REAL IPv4 peer's address in IPv4-mapped-IPv6 notation
  // (`::ffff:x.x.x.x`) -- confirmed directly against a live listener, not assumed. `dns.lookup`
  // never returns that notation, so both directions of the mismatch need their own case.
  test("an IPv4-mapped-IPv6 peer address (Bun's dual-stack notation) still matches a plain IPv4 "
    + "resolved address", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    expect(proxy.isTrusted("::ffff:10.0.0.5")).toBe(true);
    expect(proxy.isTrusted("::ffff:10.0.0.6")).toBe(false);
  });

  test("a resolved address that itself comes back mapped still matches a plain IPv4 peer", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["::ffff:10.0.0.5"] });
    await proxy.refresh();
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);
  });

  test("invalid header value falls back to the peer", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    const req = fakeRequest({ "CF-Connecting-IP": "not-an-ip" });
    expect(clientIpFrom(req, "10.0.0.5", proxy)).toBe("10.0.0.5");
  });

  test("unset host: never trusted, no throw", async () => {
    const proxy = createTrustedProxy({ host: undefined });
    await proxy.refresh(); // must not throw even though there's nothing to resolve
    expect(proxy.isTrusted("10.0.0.5")).toBe(false);
    const req = fakeRequest({ "CF-Connecting-IP": "203.0.113.9" });
    expect(clientIpFrom(req, "10.0.0.5", proxy)).toBe("10.0.0.5");
  });

  test("a miss triggers at most one refresh per 60 s", async () => {
    let calls = 0;
    let now = 0;
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        calls += 1;
        return ["10.0.0.5"];
      },
      now: () => now,
    });
    await proxy.refresh(); // the explicit startup refresh -- 1 call
    expect(calls).toBe(1);

    // A miss (a peer that never resolves) at t=0: still within the throttle window of the startup
    // refresh (which just ran at t=0), so it must NOT trigger a second call.
    proxy.isTrusted("10.0.0.99");
    await Promise.resolve(); // let the fire-and-forget microtask (if any) settle
    expect(calls).toBe(1);

    // Advance past the 60s throttle window; the next miss must trigger exactly one more call.
    now = 60_000;
    proxy.isTrusted("10.0.0.99");
    await Promise.resolve();
    expect(calls).toBe(2);

    // Immediately after, still within THIS new window: no third call yet.
    proxy.isTrusted("10.0.0.99");
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  test("a resolution failure leaves the previous address set in place, not thrown", async () => {
    let shouldFail = false;
    let now = 0;
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        if (shouldFail) throw new Error("ENOTFOUND");
        return ["10.0.0.5"];
      },
      now: () => now,
    });
    await proxy.refresh();
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);

    shouldFail = true;
    now = 60_000;
    await proxy.refresh(); // an explicit refresh call still surfaces no throw
    expect(proxy.isTrusted("10.0.0.5")).toBe(true); // old set kept, not cleared
  });
});

// #494 item 9: one spelling per IPv6 literal, so an operator's `FD00::1` or `fd00:0:0:0:0:0:0:1` equals the
// compressed lowercase form Bun's `srv.requestIP` reports.
describe("canonicalAddress", () => {
  test("maps every spelling of an address to one form", () => {
    const table: Array<[string, string]> = [
      ["::ffff:10.0.0.5", "10.0.0.5"], // Bun's dual-stack notation for an IPv4 peer
      ["::ffff:a00:5", "10.0.0.5"], // the same address typed in hex
      ["0:0:0:0:0:ffff:10.0.0.5", "10.0.0.5"], // ... or in long form with a dotted tail
      ["FD00:0:0:0:0:0:0:1", "fd00::1"],
      ["2001:DB8::0001", "2001:db8::1"],
      ["64:ff9b::1.2.3.4", "64:ff9b::102:304"], // an embedded IPv4 tail comes out in hex
      // The hex fold, with bytes above 15 and 4-digit groups (a fold that masks, shifts or matches too little
      // gets `::ffff:a00:5`, whose bytes are all below 16, right by accident).
      ["::ffff:ac12:1", "172.18.0.1"],
      ["::ffff:c0a8:101", "192.168.1.1"],
      ["::ffff:ffff:ffff", "255.255.255.255"],
      ["FE80::1%ETH0", "fe80::1"], // a zone id is dropped: Bun reports a link-local peer without one
      ["fe80::b1c9:ea7d:c0c5:bd23%8", "fe80::b1c9:ea7d:c0c5:bd23"],
      ["10.0.0.5", "10.0.0.5"],
      ["cloudflared", "cloudflared"],
      ["Not-An-Address", "Not-An-Address"], // anything that is not an IPv6 literal passes through untouched
      // The mapped folds are anchored: only a WHOLE `::ffff:<ipv4>` address is an IPv4 peer. An unanchored
      // regex would fold each of these into 10.0.0.5, and a foreign IPv6 peer would be trusted as the sidecar.
      ["2001:db8::ffff:a00:5", "2001:db8::ffff:a00:5"],
      ["::ffff:a00:5:1", "::ffff:a00:5:1"],
      ["::ffff:1:2:3", "::ffff:1:2:3"],
      ["2001:db8::ffff:10.0.0.5", "2001:db8::ffff:a00:5"], // a dotted tail on a NON-mapped address is only hexed
      ["2001::ffff:10.0.0.5", "2001::ffff:a00:5"],
      ["::ffff:10.0.0.5%8", "10.0.0.5"], // zone dropped first, then the same mapped address
      ["::ffff:10.0.0.5.9", "::ffff:10.0.0.5.9"], // not an address at all: a prefix match must not fold it
      ["::ffff:10.0.0.5:1", "::ffff:10.0.0.5:1"],
    ];
    for (const [input, expected] of table) expect(canonicalAddress(input)).toBe(expected);
  });

  // The dotted form is what Bun reports for EVERY IPv4 peer (dual-stack listener), so the per-request hot
  // path must not pay for the URL parser; the hex fold would reach the same answer, only slower, which is
  // why nothing but a count of `new URL` calls can see the fast path.
  test("the dotted IPv4-mapped form never reaches the URL parser", () => {
    const RealURL = globalThis.URL;
    let parsed = 0;
    class CountingURL extends RealURL {
      constructor(...args: ConstructorParameters<typeof URL>) {
        parsed += 1;
        super(...args);
      }
    }
    globalThis.URL = CountingURL as typeof URL;
    try {
      expect(canonicalAddress("::ffff:10.0.0.5")).toBe("10.0.0.5");
      expect(parsed).toBe(0);
      expect(canonicalAddress("fd00::1")).toBe("fd00::1");
      expect(parsed).toBe(1); // the counter works: any other IPv6 literal does take the parser
    } finally {
      globalThis.URL = RealURL;
    }
  });
});

describe("createTrustedProxy -- IPv6 spellings (#494)", () => {
  test("an IPv6 literal matches whatever spelling either side uses", async () => {
    const longForm = createTrustedProxy({ host: "cloudflared", lookup: async () => ["FD00:0:0:0:0:0:0:1"] });
    await longForm.refresh();
    expect(longForm.isTrusted("fd00::1")).toBe(true);
    expect(longForm.isTrusted("fd00::2")).toBe(false);

    const compressed = createTrustedProxy({ host: "cloudflared", lookup: async () => ["fd00::1"] });
    await compressed.refresh();
    expect(compressed.isTrusted("FD00:0:0:0:0:0:0:1")).toBe(true);

    // `dns.lookup` returns a link-local address WITH its zone (`...%8`); Bun reports the peer without one.
    const zoned = createTrustedProxy({ host: "cloudflared", lookup: async () => ["fe80::b1c9:ea7d:c0c5:bd23%8"] });
    await zoned.refresh();
    expect(zoned.isTrusted("fe80::b1c9:ea7d:c0c5:bd23")).toBe(true);
    expect(zoned.isTrusted("fe80::b1c9:ea7d:c0c5:bd24")).toBe(false);

    const mappedHex = createTrustedProxy({ host: "cloudflared", lookup: async () => ["::ffff:a00:5"] });
    await mappedHex.refresh();
    expect(mappedHex.isTrusted("::ffff:10.0.0.5")).toBe(true);
    expect(mappedHex.isTrusted("10.0.0.5")).toBe(true);
  });
});

// #493 items 4 and 5: a failed lookup is retried soon, logged once per streak, and the boot wait is bounded.
describe("createTrustedProxy -- failures, logging and the boot bound (#493)", () => {
  const settle = () => Bun.sleep(0);

  test("a failed lookup is retried after the retry window on the next miss, and a success re-arms the full throttle", async () => {
    let calls = 0;
    let now = 0;
    let fail = true;
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        calls += 1;
        if (fail) throw new Error("ENOTFOUND");
        return ["10.0.0.5"];
      },
      now: () => now,
    });
    await proxy.refresh(); // t=0: fails
    expect(calls).toBe(1);

    now = 4_999;
    proxy.isTrusted("10.0.0.99");
    await settle();
    expect(calls).toBe(1); // still inside the retry window

    fail = false;
    now = 5_000;
    proxy.isTrusted("10.0.0.99"); // Mutation: the retry window equal to the 60 s throttle leaves this at 1.
    await settle();
    expect(calls).toBe(2);
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);

    for (const t of [5_001, 64_999]) {
      now = t;
      proxy.isTrusted("10.0.0.99");
      await settle();
      expect(calls).toBe(2); // the success re-armed the full 60 s window (from t=5000)
    }
    now = 65_000;
    proxy.isTrusted("10.0.0.99");
    await settle();
    expect(calls).toBe(3);
  });

  // No backoff, by decision: a name that never resolves is retried every REFRESH_RETRY_MS under traffic, which
  // is one lookup per 5 s and one warning in total. Pinned so "only the first failure retries soon" is not
  // mistaken for a harmless variant.
  test("repeated failures keep retrying every retry window, and warn once", async () => {
    let calls = 0;
    let now = 0;
    const warns: string[] = [];
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        calls += 1;
        throw new Error("ENOTFOUND");
      },
      now: () => now,
      log: { log: () => {}, warn: (m: string) => warns.push(m) },
    });
    await proxy.refresh(); // t=0: the first failure
    for (const [t, expected] of [[4_999, 1], [5_000, 2], [9_999, 2], [10_000, 3], [14_999, 3], [15_000, 4]] as const) {
      now = t;
      proxy.isTrusted("10.0.0.99");
      await Bun.sleep(0);
      expect(calls, `t=${t}`).toBe(expected);
    }
    expect(warns).toHaveLength(1);
  });

  test("a failure is warned once per streak, and the recovery logged once", async () => {
    const outcomes = ["ok", "fail", "fail", "ok", "ok"];
    const logs: string[] = [];
    const warns: string[] = [];
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: async () => {
        if (outcomes.shift() === "fail") throw new Error("ENOTFOUND");
        return ["10.0.0.5"];
      },
      log: { log: (m: string) => logs.push(m), warn: (m: string) => warns.push(m) },
    });
    await proxy.refresh();
    expect([logs.length, warns.length]).toEqual([1, 0]);
    expect(logs[0]).toContain('TRUSTED_PROXY_HOST "cloudflared" resolved to 1 address(es)');
    await proxy.refresh();
    await proxy.refresh();
    expect([logs.length, warns.length]).toEqual([1, 1]); // Mutation: no `failing` flag warns on the second failure too.
    expect(warns[0]).toContain("did not resolve");
    expect(warns[0]).toContain("ENOTFOUND");
    await proxy.refresh();
    expect([logs.length, warns.length]).toEqual([2, 1]); // the recovery is said once
    expect(logs[1]).toContain("resolved to 1 address(es)");
    await proxy.refresh();
    expect([logs.length, warns.length]).toEqual([2, 1]); // a steady success is silent
  });

  test("the first successful resolve is logged", async () => {
    const logs: string[] = [];
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5", "10.0.0.6"], log: { log: (m: string) => logs.push(m), warn: () => {} } });
    await proxy.refresh();
    expect(logs).toEqual(['[http] TRUSTED_PROXY_HOST "cloudflared" resolved to 2 address(es)']);
  });

  const slowLookup = (ms: number, calls: { n: number }) => () => {
    calls.n += 1;
    return new Promise<string[]>((resolve) => setTimeout(() => resolve(["10.0.0.5"]), ms));
  };

  test("refresh(timeoutMs) resolves at the bound when the lookup is slow, warns, and the lookup still lands", async () => {
    const warns: string[] = [];
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: slowLookup(500, { n: 0 }), log: { log: () => {}, warn: (m: string) => warns.push(m) } });
    const started = performance.now();
    await proxy.refresh(50);
    // Mutation: a refresh that ignores its bound waits the full 500 ms.
    expect(performance.now() - started).toBeLessThan(400);
    expect(proxy.isTrusted("10.0.0.5")).toBe(false); // fail closed until the lookup lands
    expect(warns.some((w) => w.includes("has not resolved after 50ms"))).toBe(true);
    await Bun.sleep(700);
    expect(proxy.isTrusted("10.0.0.5")).toBe(true); // the late lookup replaced the set
  });

  test("a lookup that answers inside the bound leaves no late warning behind", async () => {
    const warns: string[] = [];
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"], log: { log: () => {}, warn: (m: string) => warns.push(m) } });
    await proxy.refresh(50);
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);
    // Mutation: a bound whose timer is never cleared fires its "has not resolved" warning 50 ms later, after
    // a perfectly healthy boot.
    await Bun.sleep(120);
    expect(warns).toEqual([]);
  });

  // The old code cleared `inFlight` from the body's own `finally`, which ran BEFORE `inFlight` was assigned when
  // `lookup` threw synchronously, leaving a settled promise there for good: no later lookup ever ran.
  test("a lookup that throws synchronously does not wedge later refreshes", async () => {
    let calls = 0;
    const proxy = createTrustedProxy({
      host: "cloudflared",
      lookup: ((): Promise<string[]> => {
        calls += 1;
        throw new Error("sync boom");
      }) as (host: string) => Promise<string[]>,
      log: { log: () => {}, warn: () => {} },
    });
    await proxy.refresh();
    await proxy.refresh();
    expect(calls).toBe(2);
  });

  test("a miss while a timed-out boot lookup is still running does not start a second lookup", async () => {
    const calls = { n: 0 };
    let now = 0;
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: slowLookup(300, calls), now: () => now, log: { log: () => {}, warn: () => {} } });
    await proxy.refresh(20);
    expect(calls.n).toBe(1);
    now = 61_000; // past the throttle, so a miss WOULD refresh -- but one lookup is already in flight
    proxy.isTrusted("10.0.0.99");
    await Bun.sleep(0);
    expect(calls.n).toBe(1);
    await Bun.sleep(400);
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);
  });

  test("refresh() with no bound waits for the lookup", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: slowLookup(100, { n: 0 }) });
    await proxy.refresh();
    expect(proxy.isTrusted("10.0.0.5")).toBe(true);
  });

  test("the boot bound is 2 seconds", () => {
    expect(PROXY_BOOT_REFRESH_TIMEOUT_MS).toBe(2000);
  });
});

describe("clientIpFrom", () => {
  test("a trusted peer with a valid header is keyed by the header's first value", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    const req = fakeRequest({ "CF-Connecting-IP": "203.0.113.9, 10.0.0.5" });
    expect(clientIpFrom(req, "10.0.0.5", proxy)).toBe("203.0.113.9");
  });

  test("no peer address at all falls back to \"unknown\"", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    const req = fakeRequest({ "CF-Connecting-IP": "203.0.113.9" });
    expect(clientIpFrom(req, undefined, proxy)).toBe("unknown");
  });

  test("a trusted peer with no header at all falls back to the peer address", async () => {
    const proxy = createTrustedProxy({ host: "cloudflared", lookup: async () => ["10.0.0.5"] });
    await proxy.refresh();
    const req = fakeRequest();
    expect(clientIpFrom(req, "10.0.0.5", proxy)).toBe("10.0.0.5");
  });
});
