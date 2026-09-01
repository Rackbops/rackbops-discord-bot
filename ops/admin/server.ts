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

export interface HandlerConfig {
  adminToken: string;
  indexHtml: string;
  /** Injected so request-handling logic tests without spawning a real subprocess. */
  runBotOps: (invocation: BotOpsInvocation) => Promise<BotOpsResult>;
  /** Absent (not a stub that always fails) when Access isn't configured for this instance — the
   * Cf-Access-Jwt-Assertion header is then never evaluated at all, closing any accidental-trust
   * gap outright rather than relying on a verifier that happens to always reject. */
  verifyAccessJwt?: VerifyAccessJwt;
  /** Narrows who a *verified* JWT authorizes, on top of whatever Cloudflare Access's own edge
   * policy already allows through — e.g. a shared "Allow trusted users" Access policy covers
   * several apps' worth of people, only some of whom should be able to act on this one. Absent
   * means no extra narrowing (see isEmailAllowed). Never applied to the bearer-token fallback. */
  adminAllowedEmails?: Set<string>;
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
 * classification of why. Returns how it authorized (for attribution) or `null` if it didn't. */
export async function authorizeRequest(req: Request, config: HandlerConfig): Promise<Authorization | null> {
  const jwt = extractAccessJwt(req);
  if (jwt && config.verifyAccessJwt) {
    const identity = await config.verifyAccessJwt(jwt);
    if (identity && isEmailAllowed(identity.email, config.adminAllowedEmails)) {
      return { via: "jwt", email: identity.email, claims: identity.claims };
    }
  }
  if (isAuthorized(req.headers.get("Authorization"), config.adminToken)) {
    return { via: "bearer" };
  }
  return null;
}

/** A one-line audit description of who performed an action. The email when the JWT carried one;
 * otherwise a description of the path, since the bearer token and an email-less JWT genuinely
 * have no identity to name. */
export function describeActor(auth: Authorization): string {
  if (auth.email) return auth.email;
  return auth.via === "jwt" ? "an Access session (no email claim)" : "the ADMIN_TOKEN bearer token";
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

/** The audit line for a *successful mutating* action (restart/env-set), or `null` for a read or a
 * failure (reads aren't logged — they're low-value and re-fetched on demand; failures are logged
 * separately on the error path). Pure and exported so which actions get attributed is test-pinned. */
export function auditLogLine(
  invocation: BotOpsInvocation,
  result: BotOpsResult,
  auth: Authorization,
): string | null {
  const action = invocation.args[0];
  if (action !== "restart" && action !== "env-set") return null;
  if (result.exitCode !== 0) return null;
  return `[admin] ${describeAction(invocation, result.stdout)} by ${describeActor(auth)}`;
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

  if (!url.pathname.startsWith("/api/")) {
    return new Response("not found", { status: 404 });
  }
  const auth = await authorizeRequest(req, config);
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

  const body = req.method === "POST" ? await req.text() : undefined;
  const invocation = buildInvocation(req.method, url.pathname, url.searchParams, body);
  if (!invocation) return new Response("not found", { status: 404 });

  const result = await config.runBotOps(invocation);
  if (result.exitCode !== 0) {
    console.error(
      `[admin] ${invocation.args[0]} failed (exit ${result.exitCode}) — requested by ${describeActor(auth)}: ${result.stderr.trim()}`,
    );
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

  const runBotOps = async (invocation: BotOpsInvocation): Promise<BotOpsResult> => {
    const proc = Bun.spawn(["bash", BOT_OPS_SH, ...invocation.args], {
      stdin: invocation.stdin !== undefined ? Buffer.from(invocation.stdin) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  };

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

  const adminAllowedEmails = parseAllowedEmails(process.env.ADMIN_ALLOWED_EMAILS);
  if (adminAllowedEmails) {
    console.log(`[admin] restricting JWT auth to ${adminAllowedEmails.size} allow-listed email(s)`);
  } else {
    console.log("[admin] ADMIN_ALLOWED_EMAILS not set — any identity Access already let through authorizes");
  }

  const config: HandlerConfig = { adminToken, indexHtml, runBotOps, verifyAccessJwt, adminAllowedEmails };
  Bun.serve({ port: PORT, fetch: (req) => handleRequest(req, config) });
  console.log(`[admin] listening on :${PORT}`);
}
