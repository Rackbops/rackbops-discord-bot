import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { startHostHttp } from "./http";
import { createTrustedProxy, type TrustedProxy } from "./net/clientIp";

// #319: a proxy the loopback peer addresses Bun's OWN fetch/listener pair report for this test file
// resolve to trusted -- IPv4, IPv6, and IPv4-mapped-IPv6, since which form appears is platform-
// dependent (src/net/clientIp.test.ts pins the mapped-form canonicalization itself; this just needs
// every form the CI/dev machines this suite actually runs on could report).
async function trusted(addrs: string[]): Promise<TrustedProxy> {
  const proxy = createTrustedProxy({ host: "tunnel", lookup: async () => addrs });
  await proxy.refresh();
  return proxy;
}
const LOOPBACK_ADDRS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const untrusted = (): TrustedProxy => createTrustedProxy({ host: undefined });

// A real listener on an OS-assigned port (0), driven by fetch: what the tunnel sees, minus the tunnel.
describe("startHostHttp (#220)", () => {
  const quiet = { log: () => {}, error: () => {} };

  test("hands each request to the handler with CF-Connecting-IP as the client's address", async () => {
    const seen: string[] = [];
    const http = startHostHttp({
      port: 0,
      maxBodyBytes: 1024,
      handle: async (request, clientIp) => {
        seen.push(`${new URL(request.url).pathname} ${clientIp}`);
        return new Response("ok");
      },
      log: quiet,
      proxy: await trusted(LOOPBACK_ADDRS),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${http.port}/music/x`, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
      expect(await res.text()).toBe("ok");
      await fetch(`http://127.0.0.1:${http.port}/music/y`);
      expect(seen[0]).toBe("/music/x 203.0.113.9");
      expect(seen[1]).toMatch(/^\/music\/y (127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/); // the socket's address without the header
    } finally {
      http.stop();
    }
  });

  test("an untrusted peer's CF-Connecting-IP is ignored -- keyed by the socket address", async () => {
    const seen: string[] = [];
    const http = startHostHttp({
      port: 0,
      maxBodyBytes: 1024,
      handle: async (_request, clientIp) => {
        seen.push(clientIp);
        return new Response("ok");
      },
      log: quiet,
      proxy: await trusted(["10.0.0.5"]), // the real peer (loopback) is never in this set
    });
    try {
      await fetch(`http://127.0.0.1:${http.port}/music/x`, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
      expect(seen[0]).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    } finally {
      http.stop();
    }
  });

  test("with TRUSTED_PROXY_HOST unset the header is never honoured", async () => {
    const seen: string[] = [];
    const http = startHostHttp({
      port: 0,
      maxBodyBytes: 1024,
      handle: async (_request, clientIp) => {
        seen.push(clientIp);
        return new Response("ok");
      },
      log: quiet,
      proxy: untrusted(),
    });
    try {
      await fetch(`http://127.0.0.1:${http.port}/music/x`, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
      expect(seen[0]).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/);
    } finally {
      http.stop();
    }
  });

  test("a body over maxBodyBytes is refused before the handler runs", async () => {
    let called = 0;
    const http = startHostHttp({
      port: 0, maxBodyBytes: 1024, handle: async () => { called += 1; return new Response("ok"); }, log: quiet,
      proxy: untrusted(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${http.port}/music/x`, { method: "POST", body: "x".repeat(64 * 1024) }).catch(() => undefined);
      expect(res === undefined || res.status === 413).toBe(true);
      expect(called).toBe(0);
    } finally {
      http.stop();
    }
  });

  test("an empty CF-Connecting-IP falls back to the socket's address", async () => {
    const seen: string[] = [];
    const http = startHostHttp({
      port: 0, maxBodyBytes: 1024, handle: async (_r, ip) => { seen.push(ip); return new Response("ok"); }, log: quiet,
      proxy: untrusted(),
    });
    try {
      await fetch(`http://127.0.0.1:${http.port}/x`, { headers: { "CF-Connecting-IP": "" } });
      expect(seen[0]).not.toBe("");
      expect(seen[0]).not.toBe("unknown");
    } finally {
      http.stop();
    }
  });

  test("with the real router, a chunked body over the cap is refused before any plugin code runs", async () => {
    const { routeHttpRequest } = await import("./plugins/host");
    let called = 0;
    const lp = {
      entry: { name: "music" },
      version: "1.0.0",
      running: true,
      plugin: { http: async () => { called += 1; return new Response("ok"); } },
    } as unknown as Parameters<typeof routeHttpRequest>[0][number];
    const http = startHostHttp({
      port: 0,
      maxBodyBytes: 1024,
      handle: (request, ip) => routeHttpRequest([lp], request, ip, { info: () => {}, warn: () => {}, error: () => {} }, 60_000, 1024),
      log: quiet,
      proxy: untrusted(),
    });
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 16; i += 1) controller.enqueue(new Uint8Array(512));
          controller.close();
        },
      });
      const res = await fetch(`http://127.0.0.1:${http.port}/music/x`, { method: "POST", body, duplex: "half" } as RequestInit);
      expect(res.status).toBe(413);
      expect(called).toBe(0);
    } finally {
      http.stop();
    }
  });

  test("with the real router, a chunked body within the cap reaches the plugin whole, as a plain sized body", async () => {
    const { routeHttpRequest } = await import("./plugins/host");
    const seen: string[] = [];
    const lp = {
      entry: { name: "music" },
      version: "1.0.0",
      running: true,
      plugin: {
        http: async (request: Request) => {
          seen.push(`${(await request.arrayBuffer()).byteLength} te=${request.headers.get("transfer-encoding")} cl=${request.headers.get("content-length")}`);
          return new Response("ok");
        },
      },
    } as unknown as Parameters<typeof routeHttpRequest>[0][number];
    const http = startHostHttp({
      port: 0,
      maxBodyBytes: 4096,
      handle: (request, ip) => routeHttpRequest([lp], request, ip, { info: () => {}, warn: () => {}, error: () => {} }, 60_000, 4096),
      log: quiet,
      proxy: untrusted(),
    });
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 4; i += 1) controller.enqueue(new Uint8Array(500));
          controller.close();
        },
      });
      const res = await fetch(`http://127.0.0.1:${http.port}/music/x`, { method: "POST", body, duplex: "half" } as RequestInit);
      expect(res.status).toBe(200);
      expect(seen).toEqual(["2000 te=null cl=2000"]);
    } finally {
      http.stop();
    }
  });

  // #494 item 12: over ONE raw keep-alive socket (node:net), so the second request provably rides the same
  // connection -- `fetch` may open a fresh one, and then the old test passed without ever reaching the 503.
  // What Bun does with an idle kept-alive socket on `server.stop()` is platform-dependent: on Windows (Bun
  // 1.4.2) it closes the socket itself, so the `closing` branch in http.ts is not reached through a
  // kept-alive connection there; the outcome on Linux is whatever the CI log line below says. On every
  // platform the guarantee that matters holds and is asserted: the handler never runs again, and the
  // connection ends in exactly one of two ways -- a 503 with `Connection: close`, or closed with no bytes --
  // never hung (what cloudflared would see) and never served.
  test("after stop(), a request on the SAME kept-alive connection is answered 503 + Connection: close or the socket is closed -- never served, never hung", async () => {
    let called = 0;
    const http = startHostHttp({
      port: 0, maxBodyBytes: 1024, handle: async () => { called += 1; return new Response("ok"); }, log: quiet,
      proxy: untrusted(),
    });
    const socket = connect({ host: "127.0.0.1", port: http.port });
    let received = "";
    let ended = false;
    const watchers = new Set<() => void>();
    const poke = () => { for (const w of [...watchers]) w(); };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { received += chunk; poke(); });
    for (const event of ["close", "end", "error"]) socket.on(event, () => { ended = true; poke(); });
    const request = (path: string) =>
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`;
    // Headers and the whole `Content-Length` body have arrived.
    const complete = (): boolean => {
      const end = received.indexOf("\r\n\r\n");
      if (end === -1) return false;
      const length = Number(/content-length:\s*(\d+)/i.exec(received.slice(0, end))?.[1] ?? "0");
      return received.length >= end + 4 + length;
    };
    const waitFor = (ready: () => boolean, ms: number): Promise<"ready" | "ended" | "timeout"> =>
      new Promise((resolve) => {
        const finish = (outcome: "ready" | "ended" | "timeout") => { clearTimeout(timer); watchers.delete(check); resolve(outcome); };
        const check = () => { if (ready()) finish("ready"); else if (ended) finish("ended"); };
        const timer = setTimeout(() => finish("timeout"), ms);
        watchers.add(check);
        check();
      });
    try {
      await new Promise<void>((resolve, reject) => { socket.once("connect", () => resolve()); socket.once("error", reject); });
      socket.write(request("/x"));
      expect(await waitFor(complete, 2000)).toBe("ready");
      expect(received.startsWith("HTTP/1.1 200")).toBe(true);
      expect(called).toBe(1);

      http.stop();
      received = "";
      socket.write(request("/y")); // the same socket, after stop()
      const outcome = await waitFor(complete, 2000);
      console.log(`[http.test] after stop() on a kept-alive socket (${process.platform}): ${outcome === "ready" ? `answered ${received.split("\r\n")[0]}` : outcome === "ended" ? `socket closed, ${received.length} bytes` : "NO ANSWER"}`);
      // Mutation: a stop() that leaves the handler live makes `called` 2 here; deleting `if (closing)` in
      // http.ts is invisible on a platform that closes the socket itself (see above) and red on one that does not.
      expect(outcome).not.toBe("timeout");
      expect(called).toBe(1);
      if (outcome === "ready") {
        expect(received.startsWith("HTTP/1.1 503")).toBe(true);
        expect(received.toLowerCase()).toContain("connection: close");
      } else {
        expect(received).toBe("");
      }
    } finally {
      socket.destroy();
      http.stop();
    }
  });

  test("stop() closes the listener", async () => {
    const http = startHostHttp({
      port: 0, maxBodyBytes: 1024, handle: async () => new Response("ok"), log: quiet, proxy: untrusted(),
    });
    http.stop();
    await Bun.sleep(10);
    await expect(fetch(`http://127.0.0.1:${http.port}/x`)).rejects.toThrow();
  });
});
