// A small per-instance admin panel: an authenticated, thin wrapper around ops/bot-ops.sh's five
// subcommands (status/logs/restart/env-get/env-set). Runs as its own sidecar service (the
// profile-gated `admin` service in docker-compose.yml) so it stays reachable independently of
// the bot process. Two doors gate it — Cloudflare Access in front (network-level, not this
// file's concern) and door 2 below: a verified Access JWT primarily, an ADMIN_TOKEN bearer
// token as the fallback (OR, not AND — see authorizeRequest).
import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Constant-time compare — a length mismatch is an immediate, safe `false` (no byte scan). */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function extractBearerToken(authHeader: string | null): string | undefined {
  const m = authHeader?.match(/^Bearer (.+)$/);
  return m?.[1];
}

export function isAuthorized(authHeader: string | null, expectedToken: string): boolean {
  const provided = extractBearerToken(authHeader);
  return provided !== undefined && tokensMatch(provided, expectedToken);
}

export interface AccessIdentity {
  sub: string;
  email?: string;
  /** The full verified JWT payload — surfaced so the panel can show an operator their own Access
   * identity (all the claims Cloudflare Access hands us). Optional: test doubles and the
   * bearer-token path don't carry it. */
  claims?: Record<string, unknown>;
}

/** Never throws — resolves `null` for any failure (expired/malformed/wrong-aud/wrong-iss/bad
 * signature/JWKS-unreachable), so callers never need their own try/catch around it. */
export type VerifyAccessJwt = (jwt: string) => Promise<AccessIdentity | null>;

export function extractAccessJwt(req: Request): string | undefined {
  return req.headers.get("Cf-Access-Jwt-Assertion") ?? undefined;
}

/**
 * Parses a comma-separated `ADMIN_ALLOWED_EMAILS` value into a lowercase set, or `undefined` for
 * an unset/blank value — matching `ADMIN_USER_IDS`'s existing comma-separated-list convention
 * elsewhere in this repo. `undefined` (not an empty set) is the "not configured" sentinel so
 * `isEmailAllowed` can tell "no allow-list at all" apart from "an allow-list of zero people".
 */
export function parseAllowedEmails(raw: string | undefined): Set<string> | undefined {
  const emails = raw
    ?.split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return emails && emails.length > 0 ? new Set(emails) : undefined;
}

/**
 * When no allow-list is configured, every verified identity is allowed — this is what keeps an
 * instance that hasn't set ADMIN_ALLOWED_EMAILS yet behaving exactly as it did before this
 * option existed. Once set, an identity with no email claim (or one outside the list) is not
 * allowed via this path — it still falls through to the bearer-token check in
 * authorizeRequest, deliberately: the allow-list narrows who a *JWT* can authorize, it doesn't
 * touch the bearer token's own break-glass role.
 */
export function isEmailAllowed(email: string | undefined, allowedEmails: Set<string> | undefined): boolean {
  if (!allowedEmails) return true;
  return email !== undefined && allowedEmails.has(email.toLowerCase());
}

/**
 * The allow-list is a union of two sources: `bootstrap` (from the ADMIN_ALLOWED_EMAILS env var —
 * permanent, can't be edited from the panel, so it's the floor that keeps you from locking
 * yourself out) and `dynamic` (managed live through the panel). An empty union stays `undefined`
 * — the "no narrowing configured" sentinel that keeps a fresh instance behaving as it did before
 * any allow-list existed (see isEmailAllowed).
 */
export function effectiveAllowlist(bootstrap: Set<string>, dynamic: Set<string>): Set<string> | undefined {
  if (bootstrap.size === 0 && dynamic.size === 0) return undefined;
  return new Set([...bootstrap, ...dynamic]);
}

/** Trims/lowercases and shape-checks an email for the admin list, or `null` if it doesn't look
 * like one. Not RFC-exhaustive — just enough to reject obvious junk before it lands in the list. */
export function normalizeAdminEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Guardrails on removing an admin (emails already normalized): a bootstrap admin can't be
 * removed from the panel (it's env-pinned — the whole point of the floor), and you can't remove
 * yourself. Returns an error message to refuse with, or `null` if the removal is allowed. */
export function adminRemovalError(
  email: string,
  bootstrap: Set<string>,
  requesterEmail: string | undefined,
): string | null {
  if (bootstrap.has(email)) {
    return "That admin is pinned via ADMIN_ALLOWED_EMAILS and can't be removed here — edit the env var on the box and recreate the admin container (re-run install.sh's step 4) for the change to take effect.";
  }
  if (requesterEmail && email === requesterEmail) {
    return "You can't remove yourself.";
  }
  return null;
}

/**
 * The panel-managed admin allow-list. `bootstrap` (env, permanent) plus a `dynamic` set persisted
 * out-of-band. `readDynamic` is called fresh on every auth check so an add/remove takes effect
 * immediately with no restart; the whole thing is injected (I/O at the edges) so the routing and
 * management logic test without a real filesystem. `readDynamic` may throw (see
 * `readDynamicAdmins`) when the backing store is present but broken — callers must fail closed
 * on that, never swallow it back into "no dynamic admins" (issue #40's fail-open bug).
 */
export interface AdminStore {
  bootstrap: Set<string>;
  readDynamic: () => Promise<Set<string>>;
  writeDynamic: (emails: Set<string>) => Promise<void>;
}

/**
 * Reads and parses `admins.json`. Distinguishes "absent" (`ENOENT` — the common first-run case,
 * before any admin has ever been added from the panel) from "present but unreadable or
 * malformed": the former resolves an empty `Set`, matching pre-existing behavior; the latter
 * throws, so the caller can fail closed instead of silently treating a broken file as "no
 * narrowing configured" and reopening the panel to every Access identity. Non-string entries
 * inside an otherwise-valid array are still dropped silently (matches `branchNamesFromApi`'s
 * permissive-filter style elsewhere in this file) — only the file-level shape is treated as
 * broken. Exported (not left inline in the `import.meta.main` closure) so this distinction is
 * unit-tested directly against real files, not just stubbed away.
 */
export async function readDynamicAdmins(adminsFile: string): Promise<Set<string>> {
  const file = Bun.file(adminsFile);
  if (!(await file.exists())) return new Set();
  const parsed: unknown = JSON.parse(await file.text()); // malformed JSON propagates as a throw
  const emails = (parsed as { emails?: unknown })?.emails;
  if (!Array.isArray(emails)) {
    throw new Error(`${adminsFile}: "emails" must be an array (got ${typeof emails})`);
  }
  return new Set(
    emails
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Startup-time validation for the dynamic admin list — logs the file path and admin count on
 * success, or the parse/read error via `logError` when `admins.json` exists but is broken (this
 * exact silent failure is what issue #40 fixed: it used to be indistinguishable from "no dynamic
 * admins"). `log`/`logError` are injected (default to `console.log`/`console.error`) so the exact
 * message text is test-pinned rather than only ever eyeballed against a running container's logs.
 */
export async function logDynamicAdminsStartup(
  adminsFile: string | undefined,
  log: (msg: string) => void = console.log,
  logError: (msg: string) => void = console.error,
): Promise<void> {
  if (!adminsFile) {
    log("[admin] no BOT_OPS_CONFIG_DIR — dynamic admin list can't persist (ADMIN_ALLOWED_EMAILS still works)");
    return;
  }
  try {
    const dynamic = await readDynamicAdmins(adminsFile);
    log(`[admin] ${dynamic.size} dynamic admin(s) loaded from ${adminsFile}`);
  } catch (err) {
    logError(
      `[admin] ${adminsFile} exists but couldn't be read/parsed — dynamic admins fail closed (JWT auth narrows to nobody; ADMIN_TOKEN still works) until this is fixed: ${err}`,
    );
  }
}

/**
 * Trims and lowercases a raw `CLOUDFLARE_ACCESS_TEAM_DOMAIN` value, then rejects anything that
 * isn't a bare hostname — throws on a value carrying a scheme, port, or path (e.g. pasted with an
 * "https://" prefix still on it), which `new URL(...)` alone would silently accept as a garbage
 * host rather than reject. Lowercasing matters because DNS hostnames are case-insensitive but
 * jose's JWT issuer comparison is not — this is the value used for both the JWKS URL and the
 * issuer check, so it must match a real Cloudflare-issued token's `iss` claim exactly. Exported
 * (rather than inlined in `import.meta.main`, which the test suite never exercises) because this
 * exact logic was the site of three real bugs across earlier review rounds — a bogus port
 * silently accepted, an uppercase domain silently rejected, no whitespace handling — and needs
 * its own test coverage to guard against a regression.
 */
export function normalizeTeamDomain(raw: string): string {
  const teamDomain = raw.trim().toLowerCase();
  const jwksUrl = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
  // `.hostname` (not `.host`) so an explicit port is excluded from the parsed side and
  // therefore still trips this comparison instead of matching itself.
  if (jwksUrl.hostname !== teamDomain) {
    throw new Error(`doesn't look like a bare hostname (parsed as "${jwksUrl.hostname}") — omit any scheme, port, or path`);
  }
  return teamDomain;
}

/**
 * Factored apart from its `import.meta.main` wiring so tests can exercise the real jose
 * verification call (signature/aud/iss/exp checks included) against a local, no-network JWKS —
 * `jwks` accepts either `createRemoteJWKSet`'s or `createLocalJWKSet`'s return value, same shape.
 */
export function createAccessJwtVerifier(
  jwks: JWTVerifyGetKey,
  teamDomain: string,
  aud: string,
): VerifyAccessJwt {
  return async (jwt: string): Promise<AccessIdentity | null> => {
    try {
      const { payload } = await jwtVerify(jwt, jwks, {
        issuer: `https://${teamDomain}`,
        audience: aud,
        // Pinned explicitly rather than left to jose's default inference — guards against an
        // algorithm-confusion attack if a future key were ever served under an unexpected alg.
        algorithms: ["RS256"],
      });
      return typeof payload.sub === "string"
        ? {
            sub: payload.sub,
            email: typeof payload.email === "string" ? payload.email : undefined,
            claims: { ...payload },
          }
        : null;
    } catch {
      return null;
    }
  };
}

export type ContentType = "application/json" | "text/plain";

export interface BotOpsInvocation {
  args: string[];
  stdin?: string;
  contentType: ContentType;
}

export interface BotOpsResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the process was killed for running past its own timeout, not for its own nonzero
   * exit — lets handleRequest report a distinct 504 instead of a generic 502 (issue #53 item 1/2).
   * Optional so every existing fixture literal across the test suite stays valid unchanged. */
  timedOut?: boolean;
}

/**
 * Pure: maps a request's method/path/query/body onto a bot-ops.sh invocation, or `undefined`
 * for a route this panel doesn't recognise. No new bot-ops.sh capability is introduced here —
 * every branch maps 1:1 onto one of its five existing subcommands.
 */
export function buildInvocation(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  body: string | undefined,
): BotOpsInvocation | undefined {
  if (method === "GET" && pathname === "/api/status") {
    return { args: ["status"], contentType: "application/json" };
  }
  if (method === "GET" && pathname === "/api/logs") {
    const n = searchParams.get("n");
    return { args: n ? ["logs", n] : ["logs"], contentType: "text/plain" };
  }
  if (method === "POST" && pathname === "/api/restart") {
    return { args: ["restart"], contentType: "text/plain" };
  }
  if (method === "GET" && pathname === "/api/env") {
    return { args: ["env-get"], contentType: "application/json" };
  }
  if (method === "POST" && pathname === "/api/env") {
    return { args: ["env-set"], stdin: body ?? "", contentType: "application/json" };
  }
  return undefined;
}

/**
 * The two coordinated timeouts behind issue #53 item 1/2 — 120s comfortably outlasts 90s, giving a
 * real subprocess timeout's 504 room to reach the client before Bun's own socket idleTimeout would
 * cut the connection first. Exported as named constants (not inlined at their two call sites inside
 * `import.meta.main`) so the actual values, and the margin between them, are test-pinned rather than
 * only asserted by reading the code and its comments.
 *
 * Disclosed gap: `import.meta.main`'s own wiring of these into `Bun.spawn`/`Bun.serve` is NOT
 * exercised by this test suite — nothing below `if (import.meta.main)` runs on import (see this
 * file's own top comment), and a real end-to-end check of `idleTimeout` needs a live server and a
 * request held open past it. `createRunBotOps` itself IS covered by a real subprocess test; only the
 * two literal call sites that wire these constants into it and into `Bun.serve` are not.
 */
export const SUBPROCESS_TIMEOUT_MS = 90_000;
export const IDLE_TIMEOUT_SECONDS = 120;

/**
 * Builds the real `runBotOps` implementation: spawns `bash <botOpsSh> <args>`, piping stdin/stdout/
 * stderr, with a hard wall-clock timeout so a wedged subprocess (a hung dockerd, a slow image pull)
 * can never hang a request forever (issue #53 item 2) — `Bun.serve`'s own `idleTimeout` is the other
 * half of that fix, at the HTTP layer. `killSignal` defaults to SIGKILL: bot-ops.sh and the docker
 * CLI it shells out to have no cleanup worth a SIGTERM grace period.
 *
 * Deliberately does NOT use `Bun.spawn`'s own `timeout`/`killSignal` options: those surface no
 * dedicated "timed out" flag on the async `Subprocess` (only `spawnSync`'s result has one), and the
 * obvious proxy — a non-null `signalCode` once `exited` resolves — is wrong, verified by probe: a
 * process killed by an UNRELATED external signal (a redeploy handoff sending SIGTERM to this
 * container's children, an OOM kill) also leaves a non-null `signalCode`, indistinguishable from our
 * own timeout kill, which would mislabel it a "timeout" to the client and audit log when it wasn't
 * one. Racing `exited` against our own timer instead means `timedOut` is set ONLY when this function
 * itself decided to kill the process — never inferred from after-the-fact process state.
 *
 * `detached: true` (POSIX `setsid()` per Bun's own docs) makes the spawned `bash` the leader of its
 * OWN process group, so the timeout kill below can target `-proc.pid` (the whole group) rather than
 * just `proc.pid` (bash alone) — this is not cosmetic: bot-ops.sh's mutating subcommands run
 * `docker compose ...` via command substitution, a real CHILD of bash, not a tail-call `exec`. Killing
 * only bash leaves that child running and still holding the SAME stdout/stderr pipe FDs this function
 * reads until EOF, so the `Promise.all` below would keep waiting for however long the orphaned
 * `docker compose` call actually takes — not `opts.timeoutMs` — defeating the whole point of this
 * function. Verified by review with a real subprocess (a plain `sleep 8` shaped exactly like
 * `cmd_restart`'s `docker compose ... restart 2>&1`, `timeoutMs: 300`): killing just `proc` took the
 * full ~8s to resolve despite `timedOut` correctly flipping true; killing the process group (verified
 * separately against a real Linux kernel, since Windows has no such group-kill semantics — see the
 * platform check below) resolves in well under a second. `process.kill` (not `proc.kill`) is what
 * supports a negative-pid group target; Windows has no equivalent, so there this falls back to
 * killing just the direct child — an accepted local-dev-only gap, since this admin panel only ever
 * runs in a Linux container in production.
 *
 * Another disclosed, accepted gap from the same `detached` choice: in production (a container,
 * `exec`-form CMD, no `init: true`, so Bun IS PID 1) this is a non-issue — Linux tears down the
 * whole PID namespace, detached grandchildren included, the instant PID 1 exits, regardless of
 * process-group membership. It only matters for the bare, non-compose `bun run server.ts` dev mode
 * this file's `instanceName` fallback above already acknowledges as real: there, a detached child
 * now survives a Ctrl+C to the dev terminal (SIGINT no longer reaches a process outside the
 * terminal's own foreground process group), where it used to die along with the server. A wedged
 * local `docker compose` from an interrupted request can outlive the dev server until its own
 * subcommand finishes or 90s pass. Not fixed here: forwarding the server's own termination signals
 * into every in-flight process group is real scope beyond what this timeout fix needs.
 *
 * Factored out of `import.meta.main` (not left inline, as it used to be) so the timeout itself is
 * covered by a real, fast subprocess test rather than only asserted by reading the code.
 */
export function createRunBotOps(
  botOpsSh: string,
  opts: { timeoutMs: number; killSignal?: NodeJS.Signals },
): (invocation: BotOpsInvocation) => Promise<BotOpsResult> {
  return async (invocation) => {
    const proc = Bun.spawn(["bash", botOpsSh, ...invocation.args], {
      stdin: invocation.stdin !== undefined ? Buffer.from(invocation.stdin) : undefined,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const signal = opts.killSignal ?? "SIGKILL";
      if (process.platform === "win32") {
        proc.kill(signal);
        return;
      }
      try {
        process.kill(-proc.pid, signal); // negative pid: the whole process group, not just bash
      } catch (err) {
        // The dominant real case is a benign ESRCH (the group already fully exited on its own,
        // right around the timeout boundary) — but an unexpected failure here silently falls back
        // to killing just the direct child, which is exactly the round-2 bug this function fixes.
        // Logged so a recurrence is visible rather than silently re-eating an orphaned grandchild.
        console.error(`[admin] group kill failed (${err}) — falling back to the direct child only`);
        proc.kill(signal);
      }
    }, opts.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).finally(() => clearTimeout(timer));
    return { exitCode, stdout, stderr, timedOut };
  };
}

/** HTML-escapes a string for insertion into an HTML text/attribute context. */
export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/**
 * Bakes the instance name into every `__INSTANCE_NAME__` placeholder in the served HTML, once at
 * startup. Templated (not fetched at runtime from an /api/instance call) so the instance is
 * visible on the raw page immediately — including the locked gate, before any auth or any backend
 * call — which is the whole point of showing it: a guard against acting on the wrong instance's
 * tab. Escaped because, although BOT_OPS_PROJECT is operator-set deploy config rather than
 * attacker input, it reaches this string in an HTML context and must not be able to inject markup.
 */
export function renderIndexHtml(template: string, instanceName: string): string {
  const escaped = escapeHtml(instanceName);
  // Replacement passed as a function, not a string: in a string replacement `$&`, `$\``, `$'`,
  // `$$` are special sequences, so a name containing a `$` would otherwise be mangled. A function
  // return value is inserted verbatim, sidestepping that entirely.
  return template.replaceAll("__INSTANCE_NAME__", () => escaped);
}

/**
 * Pull a single value out of a .env file's text (`KEY=value`), stripping one layer of matching
 * surrounding quotes. Used to read GITHUB_REPO/GITHUB_TOKEN for the branch chooser directly from
 * the mounted config dir: the token is read on demand and never enters this process's environment
 * (so it stays out of `docker inspect`), and it's deliberately absent from bot-ops.sh's env-get
 * whitelist, so there's no other way to reach it. Returns undefined when the key isn't present.
 */
export function parseEnvValue(envText: string, key: string): string | undefined {
  for (const raw of envText.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith(key + "=")) {
      let v = line.slice(key.length + 1).trim();
      if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  return undefined;
}

/** Branch names out of a GitHub `GET /repos/{owner}/{repo}/branches` response body; tolerant of a
 *  non-array body or a nameless entry (both yield no name). */
export function branchNamesFromApi(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((b) => (b && typeof (b as { name?: unknown }).name === "string" ? (b as { name: string }).name : ""))
    .filter(Boolean);
}

export interface HandlerConfig {
  adminToken: string;
  indexHtml: string;
  /** The static WOW_REALM chooser data (ops/admin/public/realms.json), served verbatim at
   * /realms.json for the panel to read. Absent when the file wasn't generated — the route then
   * 404s and the panel's WOW_REALM field degrades to a plain text input. */
  realmsJson?: string;
  /** Lists the configured repo's branches (for the BOT_BRANCH chooser), or null on any failure.
   * Injected so the route tests without a real GitHub call; absent when no config dir is set, in
   * which case /api/branches 404s and the panel's BOT_BRANCH field degrades to a text input. */
  listBranches?: () => Promise<string[] | null>;
  /** Injected so request-handling logic tests without spawning a real subprocess. */
  runBotOps: (invocation: BotOpsInvocation) => Promise<BotOpsResult>;
  /** Absent (not a stub that always fails) when Access isn't configured for this instance — the
   * Cf-Access-Jwt-Assertion header is then never evaluated at all, closing any accidental-trust
   * gap outright rather than relying on a verifier that happens to always reject. */
  verifyAccessJwt?: VerifyAccessJwt;
  /** The panel-managed allow-list (bootstrap ∪ dynamic) that narrows who a *verified* JWT
   * authorizes, on top of whatever Cloudflare Access's own edge policy already allows through, and
   * the backing store for the add/remove-admins endpoints. Absent means no extra narrowing and no
   * management endpoints. Never applied to the bearer-token fallback. */
  adminStore?: AdminStore;
}

/** How a request authorized, carried through so mutating actions can be attributed. `email` is
 * present only on the JWT path when the token carried an email claim; the bearer path is
 * identity-blind by design. */
export interface Authorization {
  via: "jwt" | "bearer";
  email?: string;
  /** The full verified JWT claims, on the jwt path — for the panel's identity/profile view. */
  claims?: Record<string, unknown>;
}

/** Door 2, OR not AND: a valid Access JWT — from an identity the allow-list (if configured)
 * permits — authorizes on its own; the bearer token is the fallback for everything else JWT
 * auth doesn't cover (Access unconfigured, a transient JWKS-fetch failure, or an identity the
 * allow-list excludes) — checked whenever the JWT path doesn't succeed, for any reason, with no
 * classification of why. Returns how it authorized (for attribution) or `null` if it didn't. The
 * effective allow-list is passed in (computed once, at the I/O edge, from the current store state)
 * rather than read here, keeping this decision pure. */
export async function authorizeRequest(
  req: Request,
  config: HandlerConfig,
  allowedEmails: Set<string> | undefined,
): Promise<Authorization | null> {
  const jwt = extractAccessJwt(req);
  if (jwt && config.verifyAccessJwt) {
    const identity = await config.verifyAccessJwt(jwt);
    if (identity && isEmailAllowed(identity.email, allowedEmails)) {
      return { via: "jwt", email: identity.email, claims: identity.claims };
    }
  }
  if (isAuthorized(req.headers.get("Authorization"), config.adminToken)) {
    return { via: "bearer" };
  }
  return null;
}

/** A one-line audit description of who performed an action. The email when the JWT carried one;
 * on an email-less JWT, a Cloudflare Access service-token's `common_name` claim (its Client ID) —
 * the one identity such a token does carry (issue #53 item 5) — when present; otherwise a
 * description of the path, since the bearer token and a claims-less JWT genuinely have no identity
 * to name. */
export function describeActor(auth: Authorization): string {
  if (auth.email) return auth.email;
  if (auth.via === "jwt") {
    const commonName = auth.claims?.common_name;
    return typeof commonName === "string" && commonName
      ? `an Access session (service token "${commonName}")`
      : "an Access session (no email claim)";
  }
  return "the ADMIN_TOKEN bearer token";
}

/** Best-effort: pulls the `changed` key list out of env-set's JSON stdout, so the audit line can
 * name what was edited. Any parse failure (or a non-env-set action) yields an empty list rather
 * than throwing — the log is a convenience, never a correctness dependency. */
export function parseChangedKeys(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const changed = (parsed as { changed?: unknown })?.changed;
    return Array.isArray(changed) ? changed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** Human-readable action label for the audit log — `env-set` names the keys it changed. */
export function describeAction(invocation: BotOpsInvocation, stdout: string): string {
  const action = invocation.args[0] ?? "unknown";
  if (action === "env-set") {
    const changed = parseChangedKeys(stdout);
    return changed.length > 0 ? `env-set (changed: ${changed.join(", ")})` : "env-set (no changes)";
  }
  return action;
}

/** The audit line for a *successful mutating* action (restart/env-set), for a *failed* env-set
 * that still changed something, or `null` for a read or a no-op failure (reads aren't logged —
 * they're low-value and re-fetched on demand). Pure and exported so which actions get attributed
 * is test-pinned. */
export function auditLogLine(
  invocation: BotOpsInvocation,
  result: BotOpsResult,
  auth: Authorization,
): string | null {
  const action = invocation.args[0];
  if (action !== "restart" && action !== "env-set") return null;
  if (result.exitCode === 0) {
    return `[admin] ${describeAction(invocation, result.stdout)} by ${describeActor(auth)}`;
  }
  // A killed-for-timing-out env-set is the same "already mutated, don't lose the audit trail"
  // concern issue #47 fixed for a failed recreate — but worse: bot-ops.sh's cmd_env_set rewrites
  // .env FIRST and only emits its {changed,...} JSON after the (killable) `docker compose up -d
  // --force-recreate` call returns, so a kill mid-recreate means stdout is empty and there is no
  // changed-keys list to report — parseChangedKeys below would find nothing. Logging the bare fact
  // of the timeout is strictly better than the silence that would otherwise follow a real mutation
  // (issue #53 item 1/2 follow-up). Restart has no equivalent "already mutated before the slow
  // part" step, but a timed-out restart attempt is still worth a line: the container may now be in
  // a half-restarted state, and an operator investigating wants to know it was tried.
  if (result.timedOut) {
    return `[admin] ${action} timed out (killed after running past its limit) — attempted by ${describeActor(auth)}`;
  }
  // A failed recreate after .env was already rewritten is still a real mutation worth attributing
  // (issue #47) — env-set's own JSON says what changed even though the exit code is non-zero.
  // Anything else non-zero (a bad value die()'d before touching .env, any restart failure) has
  // nothing to attribute; the error path's console.error covers it instead.
  if (action === "env-set") {
    const changed = parseChangedKeys(result.stdout);
    if (changed.length > 0) {
      return `[admin] env-set (changed: ${changed.join(", ")}) — recreate FAILED by ${describeActor(auth)}`;
    }
  }
  return null;
}

/** The audit line for an admin-list mutation (add/remove) — the one mutation that grants panel
 * access to a new identity previously left no audit trail at all (issue #53 item 3). Pure and
 * exported, mirroring auditLogLine's shape, so the exact message is test-pinned. */
export function adminAuditLine(action: "added" | "removed", email: string, auth: Authorization): string {
  return `[admin] admins: ${action} ${email} by ${describeActor(auth)}`;
}

/** True when `text` parses as JSON — used on the failure path to prefer a subcommand's own JSON
 * stdout over stderr: env-set still emits its result (ok/changed/backup/log) there even when the
 * recreate step itself fails, and that's the only place the backup path and compose error survive
 * once .env has already been rewritten (issue #47). An early die() leaves stdout empty, so this
 * still falls through to the stderr fallback exactly as before. */
export function parsesAsJson(text: string): boolean {
  if (!text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * CSRF guard for state-changing requests. The panel is reached through an ambient Cloudflare
 * Access session cookie, so a cross-site page could otherwise ride it to POST/DELETE (e.g. add
 * an admin, restart the bot) on a logged-in operator's behalf. A browser always sends `Origin`
 * on a cross-origin write, so a present `Origin` whose host doesn't match this request's own host
 * is a forgery — reject it. A missing `Origin` is a non-browser client (curl, the bearer-token
 * CLI path) with no ambient cookie to abuse, so it's allowed. GETs aren't state-changing.
 */
export function isCrossSiteWrite(req: Request): boolean {
  if (req.method !== "POST" && req.method !== "DELETE") return false;
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true; // a malformed Origin header is not something to trust
  }
}

/**
 * GET/POST/DELETE /api/admins — the panel's own allow-list management, all server-native (never
 * shells out). GET lists bootstrap (env, permanent) and dynamic (panel-managed) admins. POST adds
 * a dynamic admin (a no-op if it's already a bootstrap or dynamic admin). DELETE removes one,
 * subject to adminRemovalError's guardrails. Reaching here at all means the requester already
 * passed the auth check against the *current* allow-list, which is what enforces "any current
 * admin can manage admins".
 */
export async function handleAdmins(req: Request, store: AdminStore, auth: Authorization): Promise<Response> {
  const list = () =>
    store
      .readDynamic()
      .then((dynamic) => jsonResponse({ bootstrap: [...store.bootstrap].sort(), dynamic: [...dynamic].sort() }));

  if (req.method === "GET") {
    try {
      return await list();
    } catch (err) {
      // A broken admins.json (unreadable/malformed) becomes a clean 502, not an unhandled throw.
      return new Response(`couldn't read the admin list: ${err}`, { status: 502 });
    }
  }

  if (req.method === "POST" || req.method === "DELETE") {
    const parsed = (await req.json().catch(() => null)) as { email?: unknown } | null;
    const email = normalizeAdminEmail(typeof parsed?.email === "string" ? parsed.email : "");
    if (!email) return new Response("a valid email is required", { status: 400 });

    try {
      // Reading dynamic is inside this try too — a broken admins.json throws here, not just on
      // the write below, and must surface as the same clean 502 rather than an unhandled throw.
      const dynamic = await store.readDynamic();
      if (req.method === "POST") {
        if (!store.bootstrap.has(email) && !dynamic.has(email)) {
          dynamic.add(email);
          await store.writeDynamic(dynamic);
          console.log(adminAuditLine("added", email, auth)); // issue #53 item 3
        }
        return await list();
      }
      // DELETE
      const err = adminRemovalError(email, store.bootstrap, auth.email?.toLowerCase());
      if (err) return new Response(err, { status: 400 });
      // Don't let the very last admin be removed with no env floor — that would silently revert the
      // panel to "anyone Access allows" (effectiveAllowlist → undefined), the opposite of the intent.
      if (store.bootstrap.size === 0 && dynamic.size === 1 && dynamic.has(email)) {
        return new Response(
          "That's the last admin and there's no ADMIN_ALLOWED_EMAILS floor — removing it would open the panel to everyone Access lets in. Add another admin, or set the env var, first.",
          { status: 400 },
        );
      }
      if (dynamic.delete(email)) {
        await store.writeDynamic(dynamic);
        console.log(adminAuditLine("removed", email, auth)); // issue #53 item 3
      }
      return await list();
    } catch (err) {
      // A store read failure (broken admins.json) or write failure (e.g. no config dir to
      // persist to) becomes a clean 502, not an unhandled throw out of the request handler.
      return new Response(`couldn't read or save the admin list: ${err}`, { status: 502 });
    }
  }

  return new Response("method not allowed", { status: 405 });
}

/** The whole request lifecycle, DI'd per CLAUDE.md's "keep I/O at the edges" convention (matches
 * updateReport.ts's injected-deliverer shape) — every dependency arrives as a parameter, nothing
 * is read from process.env or the filesystem inside this function. */
export async function handleRequest(req: Request, config: HandlerConfig): Promise<Response> {
  const url = new URL(req.url);

  // The page itself is unauthenticated at this layer — Cloudflare Access already gated getting
  // here, and the page has no content of its own; every real /api/* call still needs the token.
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return new Response(config.indexHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  // The static realm list for the WOW_REALM chooser. Public at this layer, exactly like the page
  // itself — it's non-secret data (WoW realm names) and Access already gated reaching the panel.
  // A GET, so isCrossSiteWrite never applies. 404 when unset so the panel falls back gracefully.
  if (req.method === "GET" && url.pathname === "/realms.json") {
    if (!config.realmsJson) return new Response("not found", { status: 404 });
    return new Response(config.realmsJson, { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  if (!url.pathname.startsWith("/api/")) {
    return new Response("not found", { status: 404 });
  }
  // Reject cross-site writes before auth even runs — a forged request must not be actioned no
  // matter whose ambient Access session it rides.
  if (isCrossSiteWrite(req)) {
    return new Response("cross-site request blocked", { status: 403 });
  }
  // Compute the current allow-list once, here at the I/O edge (fresh store read so a just-made
  // add/remove takes effect immediately), and pass it into the pure authorize decision. A thrown
  // readDynamic (admins.json present but broken) fails CLOSED to bootstrap-only: a *defined* Set
  // (even when bootstrap is itself empty) rather than effectiveAllowlist's `undefined` "nothing
  // configured" sentinel, so a broken dynamic file can never reopen the panel to every identity
  // (issue #40) — while a bootstrap-pinned admin's JWT still works untouched, since the dynamic
  // file's health was never what protected them. ADMIN_TOKEN is unaffected either way.
  let allowedEmails: Set<string> | undefined;
  if (config.adminStore) {
    try {
      allowedEmails = effectiveAllowlist(config.adminStore.bootstrap, await config.adminStore.readDynamic());
    } catch (err) {
      console.error(`[admin] couldn't read the dynamic admin list — failing closed to bootstrap-only: ${err}`);
      allowedEmails = new Set(config.adminStore.bootstrap);
    }
  }
  const auth = await authorizeRequest(req, config, allowedEmails);
  if (!auth) {
    return new Response("unauthorized", { status: 401 });
  }

  // Server-native (not a bot-ops.sh subcommand): lets the page show who it authenticated as. `email`
  // is null on the bearer path / an email-less JWT — the identity genuinely isn't known there.
  if (req.method === "GET" && url.pathname === "/api/whoami") {
    return new Response(
      JSON.stringify({ via: auth.via, email: auth.email ?? null, claims: auth.claims ?? null }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // The BOT_BRANCH chooser's live branch list. Server-native (never shells out), authenticated
  // like every /api/* route, and it reaches the GitHub API + reads GITHUB_TOKEN, so it stays gated
  // behind the auth check above. 404 (no lister configured) vs 502 (configured but the call failed)
  // is a distinction for HTTP/logs only — the panel treats any non-200 the same and falls back to a
  // text input.
  if (req.method === "GET" && url.pathname === "/api/branches") {
    if (!config.listBranches) return new Response("not found", { status: 404 });
    const branches = await config.listBranches();
    if (!branches) return new Response("branches unavailable", { status: 502 });
    return jsonResponse({ branches });
  }

  if (url.pathname === "/api/admins" && config.adminStore) {
    return handleAdmins(req, config.adminStore, auth);
  }

  const body = req.method === "POST" ? await req.text() : undefined;
  const invocation = buildInvocation(req.method, url.pathname, url.searchParams, body);
  if (!invocation) return new Response("not found", { status: 404 });

  const result = await config.runBotOps(invocation);
  if (result.exitCode !== 0) {
    console.error(
      `[admin] ${invocation.args[0]} failed (exit ${result.exitCode}) — requested by ${describeActor(auth)}: ${result.stderr.trim()}`,
    );
    // An env-set whose recreate step failed still mutated .env — attribute it (issue #47).
    const audit = auditLogLine(invocation, result, auth);
    if (audit) console.log(audit);
    // A distinct 504 for "we killed it ourselves after it ran too long" — not lumped in with a
    // generic 502, which is bot-ops.sh's own failure, a different condition (issue #53 item 1/2).
    if (result.timedOut) {
      return new Response("bot-ops.sh timed out", { status: 504 });
    }
    // Prefer stdout when it parses as JSON: that's env-set's own result (backup path, compose
    // error) surviving a failed recreate. stderr stays the fallback for an early die() that never
    // wrote any stdout at all.
    if (parsesAsJson(result.stdout)) {
      return new Response(result.stdout, { status: 502, headers: { "Content-Type": invocation.contentType } });
    }
    return new Response(result.stderr.trim() || "bot-ops.sh failed", { status: 502 });
  }
  // Attribute successful mutations (restart/env-set) — the audit trail today's who-changed-what
  // incidents needed. Reads aren't logged (auditLogLine returns null): they're low-value here.
  const audit = auditLogLine(invocation, result, auth);
  if (audit) console.log(audit);
  return new Response(result.stdout, { headers: { "Content-Type": invocation.contentType } });
}

// Everything below only runs when this file is the actual entry point (`bun run server.ts`),
// never on import — so a test file can import the logic above with zero side effects: no env
// read, no process.exit, no port bound. Mirrors config.ts's own import-time-env-read gotcha,
// solved the other way around (push the side effect behind a guard, rather than requiring every
// importer to prime the environment first).
if (import.meta.main) {
  const BOT_OPS_SH = process.env.BOT_OPS_SH ?? "/opt/rackbops-discord-bot/bin/bot-ops.sh";
  const PORT = Number(process.env.PORT ?? 8080);
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    console.error("[admin] ADMIN_TOKEN is not set — refusing to start with no door-2 auth configured");
    process.exit(1);
  }

  // BOT_OPS_PROJECT is the compose project (e.g. rackbops-discord-bot-debug) — the canonical
  // per-instance identity, already in this container's env (docker-compose.yml passes it, with
  // its own compose-level default). Fall back to the container name, then to a loud placeholder.
  // That placeholder only surfaces when the server runs OUTSIDE compose (e.g. a bare
  // `bun run server.ts`) with nothing set — under compose the compose default fills in first.
  const instanceName =
    process.env.BOT_OPS_PROJECT?.trim() || process.env.BOT_OPS_CONTAINER?.trim() || "unnamed instance";
  const indexHtml = renderIndexHtml(
    await Bun.file(new URL("./public/index.html", import.meta.url)).text(),
    instanceName,
  );
  console.log(`[admin] serving admin panel for instance "${instanceName}"`);

  // Optional: the generated realm list for the WOW_REALM chooser. Absent is fine — the panel then
  // renders WOW_REALM as a plain text input. Read once at startup; it's immutable in the image.
  let realmsJson: string | undefined;
  try {
    const realmsFile = Bun.file(new URL("./public/realms.json", import.meta.url));
    if (await realmsFile.exists()) {
      realmsJson = await realmsFile.text();
      console.log("[admin] WOW_REALM chooser data loaded (realms.json)");
    } else {
      console.log("[admin] no realms.json — WOW_REALM will be a free-text field");
    }
  } catch (err) {
    console.error(`[admin] couldn't read realms.json (WOW_REALM stays free-text): ${err}`);
  }

  const runBotOps = createRunBotOps(BOT_OPS_SH, { timeoutMs: SUBPROCESS_TIMEOUT_MS });

  const rawTeamDomain = process.env.CLOUDFLARE_ACCESS_TEAM_DOMAIN;
  const aud = process.env.CLOUDFLARE_ACCESS_AUD?.trim();
  let verifyAccessJwt: VerifyAccessJwt | undefined;
  if (rawTeamDomain && aud) {
    try {
      const teamDomain = normalizeTeamDomain(rawTeamDomain);
      const jwksUrl = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
      verifyAccessJwt = createAccessJwtVerifier(createRemoteJWKSet(jwksUrl), teamDomain, aud);
      console.log(`[admin] verifying Cloudflare Access JWTs for ${teamDomain}`);
    } catch (err) {
      // Must degrade to bearer-only, not crash startup, same as the unset case below.
      console.error(`[admin] couldn't set up Cloudflare Access JWT verification: ${err}`);
    }
  } else if (rawTeamDomain || aud) {
    console.warn(
      "[admin] CLOUDFLARE_ACCESS_TEAM_DOMAIN and CLOUDFLARE_ACCESS_AUD must both be set — ignoring, falling back to bearer-token-only auth",
    );
  } else {
    console.log("[admin] Cloudflare Access JWT verification not configured — bearer-token-only auth");
  }

  // The allow-list: ADMIN_ALLOWED_EMAILS as the permanent bootstrap floor, plus a dynamic set the
  // panel manages, persisted to admins.json in the config dir. The dynamic file lives beside .env
  // (BOT_OPS_CONFIG_DIR); without a config dir the bootstrap still works but there's nowhere to
  // persist changes, so writes fail loudly rather than silently dropping an added admin.
  const bootstrap = parseAllowedEmails(process.env.ADMIN_ALLOWED_EMAILS) ?? new Set<string>();
  const configDir = process.env.BOT_OPS_CONFIG_DIR?.trim();
  const adminsFile = configDir ? `${configDir}/admins.json` : undefined;
  const { chownSync, renameSync, statSync } = await import("node:fs");
  const adminStore: AdminStore = {
    bootstrap,
    readDynamic: () => (adminsFile ? readDynamicAdmins(adminsFile) : Promise.resolve(new Set<string>())),
    writeDynamic: async (emails) => {
      if (!adminsFile) throw new Error("BOT_OPS_CONFIG_DIR is not set — nowhere to persist admin changes");
      const tmp = `${adminsFile}.tmp`;
      await Bun.write(tmp, JSON.stringify({ emails: [...emails].sort() }, null, 2) + "\n");
      renameSync(tmp, adminsFile); // atomic replace, so a crash never leaves a half-written list
      // Preserve deploy-user ownership: this container runs as root, so a fresh admins.json would
      // otherwise be root-owned — leaving the deploy user unable to edit it over SSH (same
      // rationale as the bot-ops.sh env-set ownership fix, issue #20).
      try {
        const dir = statSync(configDir!);
        chownSync(adminsFile, dir.uid, dir.gid);
      } catch {
        /* best-effort: as the deploy user directly, the file is already correctly owned */
      }
    },
  };
  if (bootstrap.size > 0) {
    console.log(`[admin] ${bootstrap.size} bootstrap admin(s) from ADMIN_ALLOWED_EMAILS; more can be added in the panel`);
  } else {
    console.log("[admin] no ADMIN_ALLOWED_EMAILS bootstrap — any Access identity authorizes until admins are added");
  }
  await logDynamicAdminsStartup(adminsFile);

  // The BOT_BRANCH chooser's data source: the configured repo's branches from the GitHub API.
  // GITHUB_REPO/GITHUB_TOKEN are read on demand from the mounted .env (never this process's env, so
  // never in `docker inspect`), which also means a GITHUB_REPO edited in .env on the box is picked
  // up without restarting the admin service. The token is optional — a public repo lists
  // unauthenticated, just at a lower rate limit — and the result is cached briefly so repeated panel
  // loads don't burn the limit. Any failure resolves null, and the panel then renders BOT_BRANCH as
  // a plain text input.
  let branchCache: { repo: string; branches: string[]; at: number } | undefined;
  const BRANCH_TTL_MS = 5 * 60 * 1000;
  const listBranches: (() => Promise<string[] | null>) | undefined = configDir
    ? async () => {
        try {
          const envText = await Bun.file(`${configDir}/.env`).text();
          const repo = parseEnvValue(envText, "GITHUB_REPO");
          if (!repo) return null;
          if (branchCache && branchCache.repo === repo && Date.now() - branchCache.at < BRANCH_TTL_MS) {
            return branchCache.branches;
          }
          const token = parseEnvValue(envText, "GITHUB_TOKEN");
          const headers: Record<string, string> = {
            Accept: "application/vnd.github+json",
            "User-Agent": "rackbops-admin-panel", // GitHub 403s an API request that sends no User-Agent
          };
          if (token) headers.Authorization = `Bearer ${token}`;
          // per_page=100 is GitHub's max and this doesn't paginate: a repo with >100 branches lists
          // only the first page. The panel still shows a stored BOT_BRANCH beyond that as its own
          // option, so nothing is lost — and a bot repo is nowhere near 100 branches regardless.
          const res = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100`, {
            headers,
            signal: AbortSignal.timeout(8000), // don't let a stalled GitHub call hang the request
          });
          if (!res.ok) throw new Error(`GitHub branches API ${res.status}`);
          const branches = branchNamesFromApi(await res.json());
          branchCache = { repo, branches, at: Date.now() };
          return branches;
        } catch (err) {
          console.error(`[admin] couldn't list branches (BOT_BRANCH stays free-text): ${err}`);
          return null;
        }
      }
    : undefined;

  const config: HandlerConfig = { adminToken, indexHtml, realmsJson, listBranches, runBotOps, verifyAccessJwt, adminStore };
  // idleTimeout is in SECONDS (Bun's unit, not ms), default 10 — that default cuts a long
  // restart/env-set request out from under the client while bot-ops.sh is still legitimately
  // running (issue #53 item 1). See SUBPROCESS_TIMEOUT_MS/IDLE_TIMEOUT_SECONDS above for the margin.
  Bun.serve({ port: PORT, fetch: (req) => handleRequest(req, config), idleTimeout: IDLE_TIMEOUT_SECONDS });
  console.log(`[admin] listening on :${PORT}`);
}
