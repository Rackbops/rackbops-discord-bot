// Child-process fixture for src/docker.test.ts (#459). Not a test file itself. The parent spawns it with
// BOT_DOCKER_SOCKET set to the EMPTY string -- a blank `BOT_DOCKER_SOCKET=` line in the operator's .env -- and it
// prints the `unix` option src/docker.ts's api() really hands to fetch.
//
// Why a child: src/docker.ts reads the variable once at import. `resolveDockerSocket` is pinned in-process
// (src/docker.test.ts), but only a fresh import can show that the module-level constant actually goes
// through it -- the predicate pinned and the consumer not is how `?? default` could come back green.
// Expects from the parent: the inherited test env (src/docker.ts imports ./github, which imports ./config,
// so DISCORD_TOKEN and ANNOUNCE_CHANNEL_ID must be set -- the preload sets them in the parent's process.env).
const seen: (string | undefined)[] = [];
globalThis.fetch = ((_url: string, init?: RequestInit & { unix?: string }) => {
  seen.push(init?.unix);
  return Promise.resolve(new Response("OK"));
}) as unknown as typeof fetch;

const { daemonReachable } = await import("../src/docker");
const reachable = await daemonReachable(2_000);
console.log(JSON.stringify({ reachable, unix: seen }));
process.exit(0);
