// A small per-instance admin panel: an authenticated, thin wrapper around ops/bot-ops.sh's five
// subcommands (status/logs/restart/env-get/env-set). Runs as its own sidecar service (the
// profile-gated `admin` service in docker-compose.yml) so it stays reachable independently of
// the bot process. Two doors gate it — Cloudflare Access in front (network-level, not this
// file's concern) and door 2 below: a verified Access JWT primarily, an ADMIN_TOKEN bearer
// token as the fallback (OR, not AND — see isRequestAuthorized).
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
 * isRequestAuthorized, deliberately: the allow-list narrows who a *JWT* can authorize, it doesn't
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
        ? { sub: payload.sub, email: typeof payload.email === "string" ? payload.email : undefined }
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

/** Door 2, OR not AND: a valid Access JWT — from an identity the allow-list (if configured)
 * permits — authorizes on its own; the bearer token is the fallback for everything else JWT
 * auth doesn't cover (Access unconfigured, a transient JWKS-fetch failure, or an identity the
 * allow-list excludes) — checked whenever the JWT path doesn't succeed, for any reason, with no
 * classification of why. */
export async function isRequestAuthorized(req: Request, config: HandlerConfig): Promise<boolean> {
  const jwt = extractAccessJwt(req);
  if (jwt && config.verifyAccessJwt) {
    const identity = await config.verifyAccessJwt(jwt);
    if (identity && isEmailAllowed(identity.email, config.adminAllowedEmails)) {
      return true;
    }
  }
  return isAuthorized(req.headers.get("Authorization"), config.adminToken);
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
  if (!(await isRequestAuthorized(req, config))) {
    return new Response("unauthorized", { status: 401 });
  }

  const body = req.method === "POST" ? await req.text() : undefined;
  const invocation = buildInvocation(req.method, url.pathname, url.searchParams, body);
  if (!invocation) return new Response("not found", { status: 404 });

  const result = await config.runBotOps(invocation);
  if (result.exitCode !== 0) {
    console.error(`[admin] ${invocation.args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    return new Response(result.stderr.trim() || "bot-ops.sh failed", { status: 502 });
  }
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

  const indexHtml = await Bun.file(new URL("./public/index.html", import.meta.url)).text();

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
