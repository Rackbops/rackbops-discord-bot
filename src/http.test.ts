import { describe, expect, test } from "bun:test";
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

  test("after stop(), a request on an already-open (kept-alive) connection gets a 503, not the handler", async () => {
    let called = 0;
    const http = startHostHttp({
      port: 0, maxBodyBytes: 1024, handle: async () => { called += 1; return new Response("ok"); }, log: quiet,
      proxy: untrusted(),
    });
    const first = await fetch(`http://127.0.0.1:${http.port}/x`); // opens a keep-alive connection
    await first.text();
    http.stop();
    const second = await fetch(`http://127.0.0.1:${http.port}/x`).catch(() => undefined);
    // Either the reused connection is answered 503, or the socket is already gone; the handler never runs again.
    if (second !== undefined) expect(second.status).toBe(503);
    expect(called).toBe(1);
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
