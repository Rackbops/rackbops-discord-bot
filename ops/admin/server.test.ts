import { describe, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  buildInvocation,
  createAccessJwtVerifier,
  escapeHtml,
  extractAccessJwt,
  extractBearerToken,
  handleRequest,
  isAuthorized,
  isEmailAllowed,
  isRequestAuthorized,
  normalizeTeamDomain,
  parseAllowedEmails,
  renderIndexHtml,
  tokensMatch,
  type BotOpsResult,
  type HandlerConfig,
} from "./server";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const AUD = "test-application-aud";
const KID = "test-key-1";

// Generated once for the whole file — a real RSA keypair and a real local (no-network) JWKS, so
// every test below exercises jose's actual signature/aud/iss/exp verification, not a mock of it.
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
jwk.kid = KID;
jwk.alg = "RS256";
const jwks = createLocalJWKSet({ keys: [jwk] });

// A second, separate keypair/JWKS for the algorithm-pin test below, whose JWK deliberately omits
// `alg` — with it present (as jwk above has), jose's own key-selection already narrows candidate
// keys to RS256 regardless of createAccessJwtVerifier's explicit `algorithms` option, which would
// mask whether that option does anything. Omitting it here means the option is the only thing
// standing between an RS384-signed token and acceptance, so this genuinely exercises that line —
// verified by temporarily deleting it from server.ts and confirming this exact test then fails.
const { publicKey: unpinnedPublicKey, privateKey: unpinnedPrivateKey } = await generateKeyPair("RS384");
const unpinnedJwk = await exportJWK(unpinnedPublicKey);
const unpinnedJwks = createLocalJWKSet({ keys: [unpinnedJwk] });

interface TokenOverrides {
  iss?: string;
  aud?: string;
  omitSub?: boolean;
  expiresInSeconds?: number;
  email?: string;
}

async function signToken(overrides: TokenOverrides = {}): Promise<string> {
  const { iss = `https://${TEAM_DOMAIN}`, aud = AUD, omitSub = false, expiresInSeconds = 3600, email } = overrides;
  let builder = new SignJWT(email !== undefined ? { email } : {})
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuedAt()
    .setIssuer(iss)
    .setAudience(aud);
  if (!omitSub) builder = builder.setSubject("user@example.com");
  builder = builder.setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds);
  return builder.sign(privateKey);
}

function tamperSignature(jwt: string): string {
  const parts = jwt.split(".");
  const sig = parts[2] ?? "";
  const flippedChar = sig[0] === "A" ? "B" : "A";
  parts[2] = flippedChar + sig.slice(1);
  return parts.join(".");
}

describe("tokensMatch", () => {
  test("equal tokens match", () => {
    expect(tokensMatch("abc123", "abc123")).toBe(true);
  });

  test("different tokens of the same length don't match", () => {
    expect(tokensMatch("abc123", "abc124")).toBe(false);
  });

  test("different-length tokens don't match (and don't throw)", () => {
    expect(tokensMatch("short", "a-much-longer-token")).toBe(false);
  });

  test("empty strings match each other but not a real token", () => {
    expect(tokensMatch("", "")).toBe(true);
    expect(tokensMatch("", "abc123")).toBe(false);
  });
});

describe("extractBearerToken", () => {
  test("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
  });

  test("undefined for a missing header", () => {
    expect(extractBearerToken(null)).toBeUndefined();
  });

  test("undefined for a header missing the Bearer prefix", () => {
    expect(extractBearerToken("abc123")).toBeUndefined();
  });

  test("undefined for a different auth scheme", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeUndefined();
  });
});

describe("isAuthorized", () => {
  const TOKEN = "the-real-token";

  test("true for a matching bearer token", () => {
    expect(isAuthorized("Bearer the-real-token", TOKEN)).toBe(true);
  });

  test("false for a wrong token", () => {
    expect(isAuthorized("Bearer wrong", TOKEN)).toBe(false);
  });

  test("false for a missing header", () => {
    expect(isAuthorized(null, TOKEN)).toBe(false);
  });

  test("false for an empty bearer value, never treated as matching an empty expected token", () => {
    expect(isAuthorized("Bearer ", "")).toBe(false);
  });
});

describe("extractAccessJwt", () => {
  test("extracts the header value when present", () => {
    const req = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "abc.def.ghi" } });
    expect(extractAccessJwt(req)).toBe("abc.def.ghi");
  });

  test("undefined when the header is absent", () => {
    expect(extractAccessJwt(new Request("http://x/"))).toBeUndefined();
  });
});

describe("parseAllowedEmails", () => {
  test("undefined for undefined, empty, or whitespace-only input", () => {
    expect(parseAllowedEmails(undefined)).toBeUndefined();
    expect(parseAllowedEmails("")).toBeUndefined();
    expect(parseAllowedEmails("   ")).toBeUndefined();
    expect(parseAllowedEmails(" , , ")).toBeUndefined();
  });

  test("a single email becomes a one-element, lowercased set", () => {
    expect(parseAllowedEmails("Roshne@Gmail.com")).toEqual(new Set(["roshne@gmail.com"]));
  });

  test("a comma-separated list is split, trimmed, and lowercased", () => {
    expect(parseAllowedEmails("a@x.com, B@Y.COM ,  c@z.com")).toEqual(new Set(["a@x.com", "b@y.com", "c@z.com"]));
  });

  test("blank entries in the list are dropped, not turned into an empty-string match", () => {
    expect(parseAllowedEmails("a@x.com,,b@y.com,")).toEqual(new Set(["a@x.com", "b@y.com"]));
  });
});

describe("isEmailAllowed", () => {
  test("no allow-list configured -> any email (or none) is allowed", () => {
    expect(isEmailAllowed("anyone@example.com", undefined)).toBe(true);
    expect(isEmailAllowed(undefined, undefined)).toBe(true);
  });

  test("allow-list configured, email present and listed -> true", () => {
    expect(isEmailAllowed("roshne@gmail.com", new Set(["roshne@gmail.com"]))).toBe(true);
  });

  test("allow-list configured, comparison is case-insensitive", () => {
    expect(isEmailAllowed("Roshne@Gmail.com", new Set(["roshne@gmail.com"]))).toBe(true);
  });

  test("allow-list configured, email present but not listed -> false", () => {
    expect(isEmailAllowed("nazuraki@gmail.com", new Set(["roshne@gmail.com"]))).toBe(false);
  });

  test("allow-list configured, no email claim on the identity -> false, not vacuously true", () => {
    expect(isEmailAllowed(undefined, new Set(["roshne@gmail.com"]))).toBe(false);
  });
});

describe("normalizeTeamDomain", () => {
  test("a correct lowercase hostname passes through unchanged", () => {
    expect(normalizeTeamDomain("test-team.cloudflareaccess.com")).toBe("test-team.cloudflareaccess.com");
  });

  test("mixed case is lowercased, not rejected", () => {
    expect(normalizeTeamDomain("Test-Team.CloudflareAccess.COM")).toBe("test-team.cloudflareaccess.com");
  });

  test("leading/trailing whitespace is trimmed", () => {
    expect(normalizeTeamDomain("  test-team.cloudflareaccess.com  ")).toBe("test-team.cloudflareaccess.com");
  });

  test("an accidental https:// prefix is rejected, not silently accepted as a garbage host", () => {
    expect(() => normalizeTeamDomain("https://test-team.cloudflareaccess.com")).toThrow();
  });

  test("a bogus port is rejected, not silently accepted by matching the port-inclusive host", () => {
    expect(() => normalizeTeamDomain("test-team.cloudflareaccess.com:1234")).toThrow();
  });

  test("a trailing path is rejected", () => {
    expect(() => normalizeTeamDomain("test-team.cloudflareaccess.com/extra")).toThrow();
  });

  test("empty or whitespace-only input is rejected", () => {
    expect(() => normalizeTeamDomain("")).toThrow();
    expect(() => normalizeTeamDomain("   ")).toThrow();
  });
});

describe("createAccessJwtVerifier", () => {
  const verify = createAccessJwtVerifier(jwks, TEAM_DOMAIN, AUD);

  test("a valid token resolves the identity", async () => {
    const jwt = await signToken();
    expect(await verify(jwt)).toEqual({ sub: "user@example.com", email: undefined });
  });

  test("an expired token resolves null", async () => {
    const jwt = await signToken({ expiresInSeconds: -10 });
    expect(await verify(jwt)).toBeNull();
  });

  test("the wrong audience resolves null", async () => {
    const jwt = await signToken({ aud: "some-other-application" });
    expect(await verify(jwt)).toBeNull();
  });

  test("the wrong issuer resolves null", async () => {
    const jwt = await signToken({ iss: "https://someone-elses-team.cloudflareaccess.com" });
    expect(await verify(jwt)).toBeNull();
  });

  test("a tampered signature resolves null", async () => {
    const jwt = tamperSignature(await signToken());
    expect(await verify(jwt)).toBeNull();
  });

  test("a malformed token string resolves null, doesn't throw", async () => {
    expect(await verify("not-a-jwt")).toBeNull();
    expect(await verify("")).toBeNull();
  });

  test("a token missing the sub claim resolves null", async () => {
    const jwt = await signToken({ omitSub: true });
    expect(await verify(jwt)).toBeNull();
  });

  test("an alg:none token with otherwise-valid claims is rejected, not accepted on claims alone", async () => {
    // Hand-built rather than signed — the forged, unsigned shape an algorithm-confusion attack
    // would submit. Rejected here by jose's own hardcoded refusal of "none", independent of the
    // `algorithms: ["RS256"]` option — see the next test for one that actually depends on it.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: `https://${TEAM_DOMAIN}`,
        aud: AUD,
        sub: "user@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    const jwt = `${header}.${payload}.`;
    expect(await verify(jwt)).toBeNull();
  });

  test("a differently-signed-but-validly-signed token is rejected by the algorithm pin", async () => {
    // Unlike the alg:none case above, this token is genuinely, correctly signed — just with
    // RS384 instead of RS256, against a JWKS entry with no `alg` field of its own to narrow
    // candidate keys. Without createAccessJwtVerifier's explicit `algorithms: ["RS256"]` option,
    // jose would find this key a valid candidate and accept it; deleting that option makes this
    // test start failing (confirmed by hand before committing this).
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS384" })
      .setIssuedAt()
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(AUD)
      .setSubject("user@example.com")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(unpinnedPrivateKey);
    const unpinnedVerify = createAccessJwtVerifier(unpinnedJwks, TEAM_DOMAIN, AUD);
    expect(await unpinnedVerify(jwt)).toBeNull();
  });
});

describe("isRequestAuthorized", () => {
  const TOKEN = "the-real-token";
  const INDEX_HTML = "<html></html>";
  const fakeRunBotOps = async (): Promise<BotOpsResult> => ({ exitCode: 0, stdout: "", stderr: "" });

  function baseConfig(overrides: Partial<HandlerConfig> = {}): HandlerConfig {
    return { adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: fakeRunBotOps, ...overrides };
  }

  test("bearer matches, no Access header -> true", async () => {
    const req = new Request("http://x/", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await isRequestAuthorized(req, baseConfig())).toBe(true);
  });

  test("a verified Access JWT authorizes on its own, bearer missing or wrong", async () => {
    const req = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    const verifyAccessJwt = async () => ({ sub: "user@example.com" });
    expect(await isRequestAuthorized(req, baseConfig({ verifyAccessJwt }))).toBe(true);
  });

  test("an Access header with no verifier configured is inert — falls to the bearer check", async () => {
    const req = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    expect(await isRequestAuthorized(req, baseConfig())).toBe(false);
    const reqWithBearer = new Request("http://x/", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt", Authorization: `Bearer ${TOKEN}` },
    });
    expect(await isRequestAuthorized(reqWithBearer, baseConfig())).toBe(true);
  });

  test("a JWT that fails verification falls through to the bearer check", async () => {
    const verifyAccessJwt = async () => null;
    const req = new Request("http://x/", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt", Authorization: `Bearer ${TOKEN}` },
    });
    expect(await isRequestAuthorized(req, baseConfig({ verifyAccessJwt }))).toBe(true);
    const reqNoBearer = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    expect(await isRequestAuthorized(reqNoBearer, baseConfig({ verifyAccessJwt }))).toBe(false);
  });

  test("both fail -> false", async () => {
    const verifyAccessJwt = async () => null;
    const req = new Request("http://x/", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt", Authorization: "Bearer wrong" },
    });
    expect(await isRequestAuthorized(req, baseConfig({ verifyAccessJwt }))).toBe(false);
  });

  test("a verified JWT for an allow-listed email authorizes on its own", async () => {
    const verifyAccessJwt = async () => ({ sub: "x", email: "roshne@gmail.com" });
    const adminAllowedEmails = new Set(["roshne@gmail.com"]);
    const req = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    expect(await isRequestAuthorized(req, baseConfig({ verifyAccessJwt, adminAllowedEmails }))).toBe(true);
  });

  test("a verified JWT for a non-allow-listed email falls through to the bearer check", async () => {
    const verifyAccessJwt = async () => ({ sub: "x", email: "nazuraki@gmail.com" });
    const adminAllowedEmails = new Set(["roshne@gmail.com"]);
    const reqWithBearer = new Request("http://x/", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt", Authorization: `Bearer ${TOKEN}` },
    });
    expect(await isRequestAuthorized(reqWithBearer, baseConfig({ verifyAccessJwt, adminAllowedEmails }))).toBe(true);
    const reqNoBearer = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    expect(await isRequestAuthorized(reqNoBearer, baseConfig({ verifyAccessJwt, adminAllowedEmails }))).toBe(false);
  });
});

describe("handleRequest — real Cloudflare Access JWT", () => {
  const TOKEN = "the-real-token";
  const INDEX_HTML = "<html></html>";
  const verifyAccessJwt = createAccessJwtVerifier(jwks, TEAM_DOMAIN, AUD);

  function config(): HandlerConfig {
    return {
      adminToken: TOKEN,
      indexHtml: INDEX_HTML,
      runBotOps: async () => ({ exitCode: 0, stdout: '{"running":true}', stderr: "" }),
      verifyAccessJwt,
    };
  }

  test("a valid real JWT authorizes with no bearer token sent at all", async () => {
    const jwt = await signToken();
    const res = await handleRequest(new Request("http://x/api/status", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), config());
    expect(res.status).toBe(200);
  });

  test("an expired real JWT with no bearer token is unauthorized", async () => {
    const jwt = await signToken({ expiresInSeconds: -10 });
    const res = await handleRequest(new Request("http://x/api/status", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), config());
    expect(res.status).toBe(401);
  });

  test("a valid real JWT for an allow-listed email authorizes with no bearer token", async () => {
    const jwt = await signToken({ email: "roshne@gmail.com" });
    const res = await handleRequest(
      new Request("http://x/api/status", { headers: { "Cf-Access-Jwt-Assertion": jwt } }),
      { ...config(), adminAllowedEmails: new Set(["roshne@gmail.com"]) },
    );
    expect(res.status).toBe(200);
  });

  test("a valid real JWT for a non-allow-listed email is unauthorized with no bearer token", async () => {
    const jwt = await signToken({ email: "nazuraki@gmail.com" });
    const res = await handleRequest(
      new Request("http://x/api/status", { headers: { "Cf-Access-Jwt-Assertion": jwt } }),
      { ...config(), adminAllowedEmails: new Set(["roshne@gmail.com"]) },
    );
    expect(res.status).toBe(401);
  });

  test("a valid real JWT for a non-allow-listed email still authorizes via a correct bearer token", async () => {
    const jwt = await signToken({ email: "nazuraki@gmail.com" });
    const res = await handleRequest(
      new Request("http://x/api/status", {
        headers: { "Cf-Access-Jwt-Assertion": jwt, Authorization: `Bearer ${TOKEN}` },
      }),
      { ...config(), adminAllowedEmails: new Set(["roshne@gmail.com"]) },
    );
    expect(res.status).toBe(200);
  });

  test("a tampered real JWT with no bearer token is unauthorized", async () => {
    const jwt = tamperSignature(await signToken());
    const res = await handleRequest(new Request("http://x/api/status", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), config());
    expect(res.status).toBe(401);
  });

  test("a tampered real JWT alongside a correct bearer token still authorizes (fallback engages)", async () => {
    const jwt = tamperSignature(await signToken());
    const res = await handleRequest(
      new Request("http://x/api/status", {
        headers: { "Cf-Access-Jwt-Assertion": jwt, Authorization: `Bearer ${TOKEN}` },
      }),
      config(),
    );
    expect(res.status).toBe(200);
  });
});

describe("escapeHtml", () => {
  test("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" foo='y'>&`)).toBe("&lt;a href=&quot;x&quot; foo=&#39;y&#39;&gt;&amp;");
  });

  test("leaves an ordinary instance name untouched", () => {
    expect(escapeHtml("rackbops-discord-bot-debug")).toBe("rackbops-discord-bot-debug");
  });
});

describe("renderIndexHtml", () => {
  test("replaces every __INSTANCE_NAME__ placeholder with the escaped name", () => {
    const template = "<title>Bot Admin — __INSTANCE_NAME__</title><span>__INSTANCE_NAME__</span>";
    expect(renderIndexHtml(template, "prod-bot")).toBe(
      "<title>Bot Admin — prod-bot</title><span>prod-bot</span>",
    );
  });

  test("escapes a name containing markup so it can't inject into the page", () => {
    expect(renderIndexHtml("<span>__INSTANCE_NAME__</span>", '<img src=x onerror="alert(1)">')).toBe(
      "<span>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</span>",
    );
  });

  test("a template with no placeholder is returned unchanged", () => {
    expect(renderIndexHtml("<title>Bot Admin</title>", "whatever")).toBe("<title>Bot Admin</title>");
  });

  test("a name containing $-sequences is inserted literally, not treated as a replacement pattern", () => {
    // `$&`/`$$`/`$\`` are special in a replaceAll replacement *string*; the name must still render
    // verbatim (after HTML-escaping), which is why the replacement is a function, not a string.
    expect(renderIndexHtml("<span>__INSTANCE_NAME__</span>", "a$$b")).toBe("<span>a$$b</span>");
    expect(renderIndexHtml("<span>__INSTANCE_NAME__</span>", "$&z")).toBe("<span>$&amp;z</span>");
  });
});

describe("buildInvocation", () => {
  const noBody = undefined;

  test("GET /api/status -> status, json", () => {
    expect(buildInvocation("GET", "/api/status", new URLSearchParams(), noBody)).toEqual({
      args: ["status"],
      contentType: "application/json",
    });
  });

  test("GET /api/logs with no ?n -> logs, text", () => {
    expect(buildInvocation("GET", "/api/logs", new URLSearchParams(), noBody)).toEqual({
      args: ["logs"],
      contentType: "text/plain",
    });
  });

  test("GET /api/logs?n=50 -> logs 50", () => {
    expect(buildInvocation("GET", "/api/logs", new URLSearchParams("n=50"), noBody)).toEqual({
      args: ["logs", "50"],
      contentType: "text/plain",
    });
  });

  test("POST /api/restart -> restart, text", () => {
    expect(buildInvocation("POST", "/api/restart", new URLSearchParams(), noBody)).toEqual({
      args: ["restart"],
      contentType: "text/plain",
    });
  });

  test("GET /api/env -> env-get, json", () => {
    expect(buildInvocation("GET", "/api/env", new URLSearchParams(), noBody)).toEqual({
      args: ["env-get"],
      contentType: "application/json",
    });
  });

  test("POST /api/env carries the body as stdin -> env-set, json", () => {
    expect(buildInvocation("POST", "/api/env", new URLSearchParams(), "ANNOUNCE_CHANNEL_ID=123")).toEqual({
      args: ["env-set"],
      stdin: "ANNOUNCE_CHANNEL_ID=123",
      contentType: "application/json",
    });
  });

  test("wrong method on a known path is unrecognised", () => {
    expect(buildInvocation("POST", "/api/status", new URLSearchParams(), noBody)).toBeUndefined();
    expect(buildInvocation("DELETE", "/api/env", new URLSearchParams(), noBody)).toBeUndefined();
  });

  test("unknown path is unrecognised", () => {
    expect(buildInvocation("GET", "/api/nonexistent", new URLSearchParams(), noBody)).toBeUndefined();
  });
});

describe("handleRequest", () => {
  const TOKEN = "test-token";
  const INDEX_HTML = "<html>admin panel</html>";

  function fakeRunBotOps(result: BotOpsResult) {
    return async () => result;
  }

  test("serves the index page unauthenticated", async () => {
    const res = await handleRequest(new Request("http://x/"), {
      adminToken: TOKEN,
      indexHtml: INDEX_HTML,
      runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  test("rejects an /api/* call with no token", async () => {
    const res = await handleRequest(new Request("http://x/api/status"), {
      adminToken: TOKEN,
      indexHtml: INDEX_HTML,
      runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "{}", stderr: "" }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects an /api/* call with the wrong token", async () => {
    const res = await handleRequest(
      new Request("http://x/api/status", { headers: { Authorization: "Bearer wrong" } }),
      { adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "{}", stderr: "" }) },
    );
    expect(res.status).toBe(401);
  });

  test("a correctly authorized call passes stdout through with the right content type", async () => {
    const res = await handleRequest(
      new Request("http://x/api/status", { headers: { Authorization: `Bearer ${TOKEN}` } }),
      {
        adminToken: TOKEN,
        indexHtml: INDEX_HTML,
        runBotOps: fakeRunBotOps({ exitCode: 0, stdout: '{"running":true}', stderr: "" }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"running":true}');
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });

  test("a non-zero bot-ops.sh exit surfaces stderr with a 502, not the exit code as-is", async () => {
    const res = await handleRequest(
      new Request("http://x/api/env", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: "BOT_BRANCH=not valid",
      }),
      {
        adminToken: TOKEN,
        indexHtml: INDEX_HTML,
        runBotOps: fakeRunBotOps({ exitCode: 1, stdout: "", stderr: "bot-ops: value for 'BOT_BRANCH' is invalid" }),
      },
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("bot-ops: value for 'BOT_BRANCH' is invalid");
  });

  test("an unrecognised authenticated route is a 404, not silently 200", async () => {
    const res = await handleRequest(
      new Request("http://x/api/nonexistent", { headers: { Authorization: `Bearer ${TOKEN}` } }),
      { adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }) },
    );
    expect(res.status).toBe(404);
  });

  test("a non-/api path that isn't the index is a 404", async () => {
    const res = await handleRequest(new Request("http://x/favicon.ico"), {
      adminToken: TOKEN,
      indexHtml: INDEX_HTML,
      runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(res.status).toBe(404);
  });
});
