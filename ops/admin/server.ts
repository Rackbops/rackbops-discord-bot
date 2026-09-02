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
    return "That admin is pinned via ADMIN_ALLOWED_EMAILS and can't be removed here — edit the env var on the box.";
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
 * management logic test without a real filesystem.
 */
export interface AdminStore {
  bootstrap: Set<string>;
  readDynamic: () => Promise<Set<string>>;
  writeDynamic: (emails: Set<string>) => Promise<void>;
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
  /** The static WOW_REALM chooser data (ops/admin/public/realms.json), served verbatim at
   * /realms.json for the panel to read. Absent when the file wasn't generated — the route then
   * 404s and the panel's WOW_REALM field degrades to a plain text input. */
  realmsJson?: string;
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

  if (req.method === "GET") return list();

  if (req.method === "POST" || req.method === "DELETE") {
    const parsed = (await req.json().catch(() => null)) as { email?: unknown } | null;
    const email = normalizeAdminEmail(typeof parsed?.email === "string" ? parsed.email : "");
    if (!email) return new Response("a valid email is required", { status: 400 });

    const dynamic = await store.readDynamic();
    try {
      if (req.method === "POST") {
        if (!store.bootstrap.has(email) && !dynamic.has(email)) {
          dynamic.add(email);
          await store.writeDynamic(dynamic);
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
      if (dynamic.delete(email)) await store.writeDynamic(dynamic);
      return await list();
    } catch (err) {
      // A store write failure (e.g. no config dir to persist to) becomes a clean 502, not an
      // unhandled throw out of the request handler.
      return new Response(`couldn't save the admin list: ${err}`, { status: 502 });
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
  // add/remove takes effect immediately), and pass it into the pure authorize decision.
  const allowedEmails = config.adminStore
    ? effectiveAllowlist(config.adminStore.bootstrap, await config.adminStore.readDynamic())
    : undefined;
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
    readDynamic: async () => {
      if (!adminsFile) return new Set();
      try {
        const parsed: unknown = JSON.parse(await Bun.file(adminsFile).text());
        const emails = (parsed as { emails?: unknown })?.emails;
        return new Set(
          (Array.isArray(emails) ? emails : [])
            .filter((e): e is string => typeof e === "string")
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean),
        );
      } catch {
        // Absent (the common first-run case), unreadable, or malformed — treat as no dynamic admins.
        return new Set();
      }
    },
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

  const config: HandlerConfig = { adminToken, indexHtml, realmsJson, runBotOps, verifyAccessJwt, adminStore };
  Bun.serve({ port: PORT, fetch: (req) => handleRequest(req, config) });
  console.log(`[admin] listening on :${PORT}`);
}
