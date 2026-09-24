// The host's HTTP listener (#220, docs/adr/0007-host-owned-http-router.md). The only thing here that
// touches `Bun.serve`; which plugin answers a request, and how it is bounded, is `routeHttpRequest`
// (plugins/host.ts), pure and tested without a socket. Started from index.ts's `activate()` — after
// `takeOver()`, so a standby never binds it — and only when `HTTP_PORT` is set. `docker-compose.yml`
// publishes no host port for it: the only way in is the instance's own tunnel.

/** One request, as the router needs it: the `Request` and the client's address. */
export type HostHttpHandler = (request: Request, clientIp: string) => Promise<Response>;

/**
 * Binds `port` on every interface inside the container (the tunnel reaches the bot over the compose
 * network, which a loopback bind would refuse) and hands each request to `handle`. `CF-Connecting-IP`
 * is the client's address when present — trusted with the same caveat as the plugins' own servers
 * (ADR-0007 decision 2) — else the socket's. `maxBodyBytes` is enforced by Bun before `handle` runs.
 */
export function startHostHttp(opts: {
  port: number;
  maxBodyBytes: number;
  handle: HostHttpHandler;
  log: Pick<Console, "log" | "error">;
}): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: opts.port,
    maxRequestBodySize: opts.maxBodyBytes,
    idleTimeout: 30,
    fetch: (req, srv) => {
      const clientIp = req.headers.get("CF-Connecting-IP") ?? srv.requestIP(req)?.address ?? "unknown";
      return opts.handle(req, clientIp);
    },
    // `handle` never rejects (routeHttpRequest answers every failure itself); this is the backstop.
    error: (err) => {
      opts.log.error("[http] request failed", err);
      return new Response("Internal error\n", { status: 500 });
    },
  });
  const boundPort = server.port ?? opts.port;
  opts.log.log(`[http] plugin router listening on :${boundPort}`);
  return { port: boundPort, stop: () => server.stop() };
}
