// Child-process fixture for src/docker.test.ts's real-transport test (#459). Not a test file itself: the
// parent spawns it with DOCKER_SOCKET pointing at a path this process serves, it drives src/docker.ts's
// REAL fetch over that socket, prints one JSON object on stdout, and exits.
//
// Why a child: src/docker.ts reads DOCKER_SOCKET once at import and the suite runs in one process with one
// module registry, so the path cannot be changed for one test; and the point is the real `fetch(url,
// { unix })` plus the real abort, which every in-process test stubs away. Expects from the parent:
// DOCKER_SOCKET, and the inherited test env (src/docker.ts imports ./github, which imports ./config, so
// DISCORD_TOKEN and ANNOUNCE_CHANNEL_ID must be set -- the preload sets them in the parent's process.env).
const socket = process.env.DOCKER_SOCKET;
if (!socket) throw new Error("DOCKER_SOCKET must be set by the parent");

const server = Bun.serve({
  unix: socket,
  fetch(req) {
    const path = new URL(req.url).pathname;
    // The daemon's ping answers. `/containers/hang/json` never answers at all; `/containers/wedge/json`
    // sends headers and one body byte and then never closes -- the shape that caught #130's first cut,
    // where the bound was retired the moment the headers landed.
    if (path === "/_ping") return new Response("OK");
    if (path === "/containers/wedge/json") {
      return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{")) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Promise<Response>(() => {});
  },
});

const { daemonReachable, inspectContainer } = await import("../src/docker");
const ping = await daemonReachable(2_000);
async function bounded(id: string): Promise<{ ok: boolean; message?: string; elapsedMs: number }> {
  const started = Date.now();
  try {
    await inspectContainer(id, 100);
    return { ok: true, elapsedMs: Date.now() - started };
  } catch (err) {
    return { ok: false, message: (err as Error).message, elapsedMs: Date.now() - started };
  }
}
const hang = await bounded("hang");
const wedge = await bounded("wedge");
// Without this the wedge case could silently become a second copy of the hang case (a renamed path in the
// handler above would send nothing at all): prove the wedge handler really sends its headers, which is the
// part that distinguishes it. A handler that sent none would leave this fetch waiting until the server's own
// request timeout (about 10 s) drops the connection and the child exits 1, or the parent's spawn timeout
// kills it -- red, not green.
const probe = new AbortController();
const wedgeResponse = await fetch("http://docker/containers/wedge/json", { unix: socket, signal: probe.signal });
const wedgeStatus = wedgeResponse.status;
probe.abort();
await wedgeResponse.body?.cancel().catch(() => {});
server.stop(true);
console.log(JSON.stringify({ ping, hang, wedge, wedgeStatus }));
process.exit(0);
