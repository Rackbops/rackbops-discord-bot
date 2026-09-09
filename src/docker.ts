// Minimal Docker Engine API client over the daemon socket.
//
// Bun's fetch speaks unix sockets natively (`fetch(url, { unix })`), so this needs no
// dependency — the host in the URL is ignored, the socket decides where it goes.
//
// Paths are deliberately unversioned (`/containers/…`, not `/v1.43/containers/…`): the daemon
// then answers with its own current version, so this doesn't break against an older or newer
// Docker than whichever one it was written on.

import { clampUpstreamBody } from "./github";

const SOCKET = "/var/run/docker.sock";
const BASE = "http://docker";

// Every daemon call is bounded, so a genuinely hung socket (connected, far end never responds and
// never closes — a network partition, a wedged `dockerd`) fails cleanly instead of leaving an
// `await` unsettled forever, which is what turned a stuck build into a silent announce outage
// (#130).
//
// The bound spans the response BODY read, not just the request. That is the whole point: a daemon
// that answers with headers and then wedges mid-body hangs just as hard, and for `/build` the body
// IS the build (it streams back as JSONL). So the unit of bounding is `bounded()` — one signal
// wrapping a whole operation, request and body together — never a per-`fetch` bound that is
// retired the moment the headers land.
//
// Deliberately an `AbortController` + a ref'd `setTimeout`, NOT `AbortSignal.timeout()`: Bun backs
// `AbortSignal.timeout` with an UNREF'd timer, so whether it fires at all depends on something
// ELSE holding the event loop open. (Measured on Bun 1.3.14: awaiting an `AbortSignal.timeout(20)`
// with nothing else ref'd never resolves; with any ref'd timer alive it fires on schedule.)
//
// In a running bot something else generally does hold it open — `startScheduler`'s 60s
// `setInterval`, and `resolveBootMode`'s own ref'd `withTimeout` on the one pre-login call — so
// this is not a claim that some specific production path would hang. It is that the guarantee
// would be *conditional on an invariant nothing enforces*, held up by unrelated code that no one
// editing it would know they had to preserve. It already fails under test, which is exactly where
// the gap surfaced. A ref'd timer fires unconditionally and needs no such reasoning, which is the
// point. `clearTimeout` on completion is what keeps a finished call from leaving one pending.
export const DEFAULT_TIMEOUT_MS = 60_000;
/** The one long call: the remote-context build is clone + prod-deps install, 1-3 min typical. */
export const BUILD_TIMEOUT_MS = 900_000; // 15 min

/**
 * Run `fn` under an abort signal that fires after `ms`, retiring the timer once it settles.
 *
 * `fn` must do ALL of its work inside — including reading the response body — because the signal
 * is what bounds that read, and the `finally` disarms it. Splitting the fetch and the body across
 * this boundary silently un-bounds the body, which is the hang this exists to prevent.
 */
async function bounded<T>(ms: number, what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`docker ${what} timed out after ${ms}ms`)), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

export interface ContainerInspect {
  Id: string;
  Name: string;
  Image: string;
  State: { Running: boolean; Status: string; ExitCode: number; StartedAt?: string };
  Config: { Image: string; Env: string[]; Labels: Record<string, string>; User?: string };
  HostConfig: {
    Binds?: string[] | null;
    RestartPolicy?: { Name: string; MaximumRetryCount?: number };
    NetworkMode?: string;
    Init?: boolean | null;
  };
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; RW: boolean }[];
  NetworkSettings: { Networks: Record<string, { Aliases?: string[] | null }> };
}

/** Body for `POST /containers/create` — only the fields this bot actually sets. */
export interface CreateContainerSpec {
  Image: string;
  Env: string[];
  Labels: Record<string, string>;
  /** Carried over from the original, so the replacement can still reach the daemon socket. */
  User?: string;
  HostConfig: {
    Binds: string[];
    RestartPolicy: { Name: string };
    NetworkMode?: string;
    Init?: boolean;
  };
  /** Service aliases (e.g. compose's `bot`) the network resolves the container by, beyond its
   *  own name — dropped otherwise, since Docker never infers them from the container being
   *  recreated. */
  NetworkingConfig?: { EndpointsConfig: Record<string, { Aliases?: string[] }> };
}

/** One daemon request under a caller-supplied signal. Always called from inside `bounded`. */
async function api(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, { ...init, unix: SOCKET, signal });
}

async function ok(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  const res = await api(path, signal, init);
  if (!res.ok) {
    throw new Error(`docker ${init.method ?? "GET"} ${path} failed: ${res.status} ${clampUpstreamBody(await res.text())}`);
  }
  return res;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Whether the daemon socket is actually reachable — the one precondition for self-update. */
export async function daemonReachable(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  try {
    return await bounded(timeoutMs, "ping", async (s) => (await api("/_ping", s)).ok);
  } catch {
    return false;
  }
}

/**
 * This container's id, read out of its own mountinfo. Docker bind-mounts `/etc/hostname`,
 * `/etc/resolv.conf` and friends from `…/containers/<id>/…` on the host, so the id is spelled
 * out in the mount source even under cgroup v2 — where `/proc/self/cgroup` is just `0::/` and
 * tells you nothing.
 */
export function parseContainerId(mountinfo: string): string | undefined {
  const m = mountinfo.match(/\/(?:docker\/)?containers\/([0-9a-f]{64})\//);
  return m?.[1];
}

/**
 * Inspect the container this process is running in.
 *
 * Hostname first: Docker sets it to the short container id, and the daemon resolves a short id
 * fine — one request, no parsing. Mountinfo is the fallback for the case that breaks it, a
 * `hostname:` pinned in the compose file, where the name would resolve to nothing (or worse,
 * to some other container that happens to be called that).
 */
export async function inspectSelf(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ContainerInspect> {
  // ONE bound across both attempts, not one each. Two nested bounds would make the worst case
  // 2 x timeoutMs (a fast non-ok hostname inspect, then a wedge on the fallback) — undocumented,
  // and 120s on the default. It also gave the fallback its own bound that only a Linux-only test
  // could reach, so it could be widened without any test noticing.
  return bounded(timeoutMs, "inspect self", async (s) => {
    const host = process.env.HOSTNAME;
    if (host) {
      const res = await api(`/containers/${encodeURIComponent(host)}/json`, s);
      if (res.ok) return (await res.json()) as ContainerInspect;
    }
    const id = parseContainerId(await Bun.file("/proc/self/mountinfo").text());
    if (!id) throw new Error("cannot determine own container id (not running under Docker?)");
    return (await (await ok(`/containers/${encodeURIComponent(id)}/json`, s)).json()) as ContainerInspect;
  });
}

export async function inspectContainer(id: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ContainerInspect> {
  return bounded(
    timeoutMs,
    `inspect ${id}`,
    async (s) => (await (await ok(`/containers/${encodeURIComponent(id)}/json`, s)).json()) as ContainerInspect,
  );
}

/** `undefined` when the container is gone — a removal that already happened is not an error. */
export async function tryInspectContainer(
  id: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ContainerInspect | undefined> {
  return bounded(timeoutMs, `inspect ${id}`, async (s) => {
    const res = await api(`/containers/${encodeURIComponent(id)}/json`, s);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`docker inspect ${id} failed: ${res.status}`);
    return (await res.json()) as ContainerInspect;
  });
}

/**
 * A build is a stream of JSONL progress objects that ends 200 whether or not it worked —
 * the failure is *inside* the body, as an `{"error": …}` line. Reading the status alone
 * would call every broken build a success.
 */
export function parseBuildOutput(body: string): { ok: boolean; error?: string } {
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let parsed: { error?: string; errorDetail?: { message?: string } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a partial/non-JSON line is progress noise, not a verdict
    }
    const error = parsed.errorDetail?.message ?? parsed.error;
    if (error) return { ok: false, error };
  }
  return { ok: true };
}

/**
 * Build an image from a **remote** context: the daemon fetches the source itself, so the bot
 * image needs no git binary, no tar handling, and no scratch space of its own.
 * `remote` is a git URL of the form `https://host/owner/repo.git#ref:subdir`.
 */
export async function buildImage(
  o: {
    remote: string;
    tags: string[];
    buildArgs: Record<string, string>;
  },
  // Overridable so a test can drive the abort path without waiting out the real 15-min bound.
  timeoutMs = BUILD_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  const params = new URLSearchParams({
    remote: o.remote,
    buildargs: JSON.stringify(o.buildArgs),
    // `remote` with a `#ref:subdir` fragment makes that subdir the context root, so the
    // Dockerfile path is relative to it — not to the repo root.
    dockerfile: "Dockerfile",
    forcerm: "1",
  });
  for (const t of o.tags) params.append("t", t);
  // The bound spans the streamed body read as well as the request: the build streams back as the
  // response body, so `res.text()` — not the connect — is where a wedged build actually hangs.
  return bounded(timeoutMs, "build", async (s) => {
    const res = await ok(`/build?${params}`, s, { method: "POST" });
    return parseBuildOutput(await res.text());
  });
}

export async function createContainer(
  name: string,
  spec: CreateContainerSpec,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const params = new URLSearchParams({ name });
  return bounded(timeoutMs, `create ${name}`, async (s) => {
    const res = await ok(`/containers/create?${params}`, s, json(spec));
    return ((await res.json()) as { Id: string }).Id;
  });
}

export async function startContainer(id: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await bounded(timeoutMs, `start ${id}`, (s) =>
    ok(`/containers/${encodeURIComponent(id)}/start`, s, { method: "POST" }),
  );
}

export async function stopContainer(id: string, timeoutSec = 10, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const params = new URLSearchParams({ t: String(timeoutSec) });
  await bounded(timeoutMs, `stop ${id}`, async (s) => {
    const res = await api(`/containers/${encodeURIComponent(id)}/stop?${params}`, s, { method: "POST" });
    // 304 = already stopped, 404 = already gone. Both are the state we wanted.
    if (!res.ok && res.status !== 304 && res.status !== 404) {
      throw new Error(`docker stop ${id} failed: ${res.status} ${clampUpstreamBody(await res.text())}`);
    }
  });
}

export async function removeContainer(id: string, force = false, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const params = new URLSearchParams(force ? { force: "1" } : {});
  await bounded(timeoutMs, `rm ${id}`, async (s) => {
    const res = await api(`/containers/${encodeURIComponent(id)}?${params}`, s, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      throw new Error(`docker rm ${id} failed: ${res.status} ${clampUpstreamBody(await res.text())}`);
    }
  });
}

export async function renameContainer(id: string, name: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const params = new URLSearchParams({ name });
  await bounded(timeoutMs, `rename ${id}`, (s) =>
    ok(`/containers/${encodeURIComponent(id)}/rename?${params}`, s, { method: "POST" }),
  );
}

/**
 * `POST /containers/{id}/update` (Engine API >= 1.22) — the only field this bot ever changes on a
 * running container: its restart policy. Takes effect instantly, no restart needed. Rejected for
 * a container created with `AutoRemove`; `buildCreateSpec` never sets that, so this is unconditional
 * here. #160: used to restore the ORIGINAL's real restart policy onto the now-verified replacement
 * before the original is stopped — see `redeploy.ts`'s `takeOver`. Never pass
 * `{ Name: "on-failure", MaximumRetryCount: 0 }` — Docker reads `0` as unlimited, not zero.
 */
export async function updateContainer(
  id: string,
  hostConfig: { RestartPolicy: { Name: string; MaximumRetryCount?: number } },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await bounded(timeoutMs, `update ${id}`, (s) =>
    ok(`/containers/${encodeURIComponent(id)}/update`, s, json(hostConfig)),
  );
}

export interface ImageSummary {
  Id: string;
  RepoTags: string[] | null;
  Created: number;
}

export async function listImages(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ImageSummary[]> {
  return bounded(timeoutMs, "list images", async (s) => (await (await ok("/images/json", s)).json()) as ImageSummary[]);
}

/** Just enough of `GET /images/{id}/json` to read an image's own baked-in `ENV`. */
export async function inspectImage(
  id: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ Config: { Env: string[] } }> {
  return bounded(
    timeoutMs,
    `inspect image ${id}`,
    async (s) =>
      (await (await ok(`/images/${encodeURIComponent(id)}/json`, s)).json()) as { Config: { Env: string[] } },
  );
}

/** Best-effort: an image still referenced by a container refuses to delete, which is correct. */
export async function removeImage(tag: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await bounded(timeoutMs, `rmi ${tag}`, async (s) => {
    const res = await api(`/images/${encodeURIComponent(tag)}`, s, { method: "DELETE" });
    if (!res.ok) console.warn(`[redeploy] could not remove image ${tag}: ${res.status}`);
  });
}

/**
 * Points `target` (e.g. `repo:latest`) at the image currently named `source` (e.g. `repo:abc1234`,
 * or an image id) — the Engine API's own "move a tag" primitive (`POST
 * /images/{name}/tag?repo=&tag=`), so the daemon never re-pulls or re-builds anything. `repo` and
 * `tag` are separate query params, not a single combined `repo:tag` value — `target` is split on
 * its last colon to produce them.
 */
export async function tagImage(source: string, target: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const i = target.lastIndexOf(":");
  const params = new URLSearchParams({ repo: target.slice(0, i), tag: target.slice(i + 1) });
  await bounded(timeoutMs, `tag ${source}`, (s) =>
    ok(`/images/${encodeURIComponent(source)}/tag?${params}`, s, { method: "POST" }),
  );
}
