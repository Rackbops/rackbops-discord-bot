import { describe, expect, test } from "bun:test";
import { startHostHttp } from "./http";

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

  test("a body over maxBodyBytes is refused before the handler runs", async () => {
    let called = 0;
    const http = startHostHttp({ port: 0, maxBodyBytes: 1024, handle: async () => { called += 1; return new Response("ok"); }, log: quiet });
    try {
      const res = await fetch(`http://127.0.0.1:${http.port}/music/x`, { method: "POST", body: "x".repeat(64 * 1024) }).catch(() => undefined);
      expect(res === undefined || res.status === 413).toBe(true);
      expect(called).toBe(0);
    } finally {
      http.stop();
    }
  });

  test("stop() closes the listener", async () => {
    const http = startHostHttp({ port: 0, maxBodyBytes: 1024, handle: async () => new Response("ok"), log: quiet });
    http.stop();
    await Bun.sleep(10);
    await expect(fetch(`http://127.0.0.1:${http.port}/x`)).rejects.toThrow();
  });
});
