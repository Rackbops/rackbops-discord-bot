import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  adminRemovalError,
  auditLogLine,
  authorizeRequest,
  branchNamesFromApi,
  buildInvocation,
  createAccessJwtVerifier,
  describeAction,
  describeActor,
  effectiveAllowlist,
  escapeHtml,
  extractAccessJwt,
  extractBearerToken,
  handleAdmins,
  handleRequest,
  isAuthorized,
  isCrossSiteWrite,
  isEmailAllowed,
  logDynamicAdminsStartup,
  normalizeAdminEmail,
  normalizeTeamDomain,
  parseAllowedEmails,
  parseChangedKeys,
  parseEnvValue,
  readDynamicAdmins,
  renderIndexHtml,
  tokensMatch,
  type AdminStore,
  type Authorization,
  type BotOpsInvocation,
  type BotOpsResult,
  type HandlerConfig,
} from "./server";

/** An in-memory AdminStore for tests — a real bootstrap set plus a mutable dynamic set. */
function makeStore(opts: { bootstrap?: string[]; dynamic?: string[] } = {}): AdminStore & { dynamic: Set<string> } {
  const dynamic = new Set(opts.dynamic ?? []);
  return {
    bootstrap: new Set(opts.bootstrap ?? []),
    dynamic,
    readDynamic: async () => new Set(dynamic),
    writeDynamic: async (emails) => {
      dynamic.clear();
      for (const e of emails) dynamic.add(e);
    },
  };
}

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

describe("effectiveAllowlist", () => {
  test("both empty -> undefined (no narrowing)", () => {
    expect(effectiveAllowlist(new Set(), new Set())).toBeUndefined();
  });

  test("unions bootstrap and dynamic, deduping", () => {
    const result = effectiveAllowlist(new Set(["a@x.com", "b@x.com"]), new Set(["b@x.com", "c@x.com"]));
    expect(result).toEqual(new Set(["a@x.com", "b@x.com", "c@x.com"]));
  });

  test("bootstrap-only or dynamic-only each narrow", () => {
    expect(effectiveAllowlist(new Set(["a@x.com"]), new Set())).toEqual(new Set(["a@x.com"]));
    expect(effectiveAllowlist(new Set(), new Set(["c@x.com"]))).toEqual(new Set(["c@x.com"]));
  });
});

// Verifier probe from issue #40, pinned as real tests: a well-formed admins.json parses; a
// trailing comma, or "emails" as an object instead of an array, both must fail LOUDLY (throw) —
// not be swallowed into "no dynamic admins", which is what let every one of those cases fail
// open to any Access identity.
describe("readDynamicAdmins", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "admins-json-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("absent file (first run) resolves an empty set, not an error", async () => {
    const result = await readDynamicAdmins(join(dir, "admins.json"));
    expect(result).toEqual(new Set());
  });

  test("well-formed file parses, trims, and lowercases", async () => {
    const file = join(dir, "admins.json");
    writeFileSync(file, JSON.stringify({ emails: [" Admin@X.com ", "b@x.com"] }));
    const result = await readDynamicAdmins(file);
    expect(result).toEqual(new Set(["admin@x.com", "b@x.com"]));
  });

  test("malformed JSON (trailing comma) throws", async () => {
    const file = join(dir, "admins.json");
    writeFileSync(file, '{"emails": ["a@x.com",]}');
    await expect(readDynamicAdmins(file)).rejects.toThrow();
  });

  test('"emails" as an object instead of an array throws', async () => {
    const file = join(dir, "admins.json");
    writeFileSync(file, JSON.stringify({ emails: { "a@x.com": true } }));
    await expect(readDynamicAdmins(file)).rejects.toThrow();
  });

  test("non-string entries in an otherwise-valid array are silently dropped, not a throw", async () => {
    const file = join(dir, "admins.json");
    writeFileSync(file, JSON.stringify({ emails: ["a@x.com", 42, null] }));
    const result = await readDynamicAdmins(file);
    expect(result).toEqual(new Set(["a@x.com"]));
  });
});

describe("logDynamicAdminsStartup", () => {
  function capture() {
    const logs: string[] = [];
    const errors: string[] = [];
    return { logs, errors, log: (m: string) => logs.push(m), logError: (m: string) => errors.push(m) };
  }

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "admins-json-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("no config dir -> one log line, no error", async () => {
    const { logs, errors, log, logError } = capture();
    await logDynamicAdminsStartup(undefined, log, logError);
    expect(logs.length).toBe(1);
    expect(errors.length).toBe(0);
  });

  test("absent file -> logs the path and a count of 0", async () => {
    const file = join(dir, "admins.json");
    const { logs, errors, log, logError } = capture();
    await logDynamicAdminsStartup(file, log, logError);
    expect(errors.length).toBe(0);
    expect(logs[0]).toContain(file);
    expect(logs[0]).toContain("0");
  });

  test("populated file -> logs the path and the real count", async () => {
    const file = join(dir, "admins.json");
    writeFileSync(file, JSON.stringify({ emails: ["a@x.com", "b@x.com"] }));
    const { logs, errors, log, logError } = capture();
    await logDynamicAdminsStartup(file, log, logError);
    expect(errors.length).toBe(0);
    expect(logs[0]).toContain(file);
    expect(logs[0]).toContain("2");
  });

  test("malformed file -> logs the error via logError, names the file, never claims success", async () => {
    const file = join(dir, "admins.json");
    writeFileSync(file, "{not json");
    const { logs, errors, log, logError } = capture();
    await logDynamicAdminsStartup(file, log, logError);
    expect(logs.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain(file);
  });
});

describe("normalizeAdminEmail", () => {
  test("trims and lowercases a valid email", () => {
    expect(normalizeAdminEmail("  Roshne@Gmail.COM ")).toBe("roshne@gmail.com");
  });

  test("rejects junk", () => {
    expect(normalizeAdminEmail("")).toBeNull();
    expect(normalizeAdminEmail("not-an-email")).toBeNull();
    expect(normalizeAdminEmail("no@domain")).toBeNull();
    expect(normalizeAdminEmail("has space@x.com")).toBeNull();
    expect(normalizeAdminEmail("@x.com")).toBeNull();
  });
});

describe("adminRemovalError", () => {
  const bootstrap = new Set(["boss@x.com"]);

  test("refuses removing a bootstrap admin", () => {
    expect(adminRemovalError("boss@x.com", bootstrap, "other@x.com")).toMatch(/ADMIN_ALLOWED_EMAILS/);
  });

  test("refuses removing yourself", () => {
    expect(adminRemovalError("me@x.com", bootstrap, "me@x.com")).toMatch(/yourself/);
  });

  test("allows removing another dynamic admin", () => {
    expect(adminRemovalError("someone@x.com", bootstrap, "me@x.com")).toBeNull();
  });

  test("with no requester identity (bearer), only the bootstrap guard applies", () => {
    expect(adminRemovalError("someone@x.com", bootstrap, undefined)).toBeNull();
    expect(adminRemovalError("boss@x.com", bootstrap, undefined)).toMatch(/ADMIN_ALLOWED_EMAILS/);
  });
});

describe("handleAdmins", () => {
  const bearer: Authorization = { via: "bearer" };
  const admin: Authorization = { via: "jwt", email: "me@x.com" };
  const req = (method: string, body?: unknown) =>
    new Request("http://x/api/admins", {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  test("GET lists bootstrap and dynamic, both sorted", async () => {
    const store = makeStore({ bootstrap: ["b@x.com", "a@x.com"], dynamic: ["d@x.com", "c@x.com"] });
    const res = await handleAdmins(req("GET"), store, bearer);
    expect(await res.json()).toEqual({ bootstrap: ["a@x.com", "b@x.com"], dynamic: ["c@x.com", "d@x.com"] });
  });

  test("POST adds a normalized dynamic admin and persists it", async () => {
    const store = makeStore({ bootstrap: ["boss@x.com"] });
    const res = await handleAdmins(req("POST", { email: " New@X.com " }), store, admin);
    expect(res.status).toBe(200);
    expect(store.dynamic.has("new@x.com")).toBe(true);
    expect(await res.json()).toEqual({ bootstrap: ["boss@x.com"], dynamic: ["new@x.com"] });
  });

  test("POST an email already in bootstrap is a no-op (stays permanent, not duplicated into dynamic)", async () => {
    const store = makeStore({ bootstrap: ["boss@x.com"] });
    await handleAdmins(req("POST", { email: "boss@x.com" }), store, admin);
    expect(store.dynamic.size).toBe(0);
  });

  test("POST rejects an invalid email with 400 and writes nothing", async () => {
    const store = makeStore();
    const res = await handleAdmins(req("POST", { email: "nope" }), store, admin);
    expect(res.status).toBe(400);
    expect(store.dynamic.size).toBe(0);
  });

  test("DELETE removes a dynamic admin", async () => {
    const store = makeStore({ dynamic: ["gone@x.com", "stay@x.com"] });
    const res = await handleAdmins(req("DELETE", { email: "gone@x.com" }), store, admin);
    expect(res.status).toBe(200);
    expect(store.dynamic.has("gone@x.com")).toBe(false);
    expect(store.dynamic.has("stay@x.com")).toBe(true);
  });

  test("DELETE refuses a bootstrap admin (400), leaving it in place", async () => {
    const store = makeStore({ bootstrap: ["boss@x.com"], dynamic: ["d@x.com"] });
    const res = await handleAdmins(req("DELETE", { email: "boss@x.com" }), store, admin);
    expect(res.status).toBe(400);
    expect(store.bootstrap.has("boss@x.com")).toBe(true);
  });

  test("DELETE refuses removing yourself (400)", async () => {
    const store = makeStore({ dynamic: ["me@x.com"] });
    const res = await handleAdmins(req("DELETE", { email: "me@x.com" }), store, admin);
    expect(res.status).toBe(400);
    expect(store.dynamic.has("me@x.com")).toBe(true);
  });

  test("a bearer requester (no identity) can still remove a dynamic admin", async () => {
    const store = makeStore({ bootstrap: ["boss@x.com"], dynamic: ["someone@x.com"] });
    const res = await handleAdmins(req("DELETE", { email: "someone@x.com" }), store, bearer);
    expect(res.status).toBe(200);
    expect(store.dynamic.has("someone@x.com")).toBe(false);
  });

  test("refuses removing the last admin when there's no bootstrap floor (would open to everyone)", async () => {
    const store = makeStore({ dynamic: ["only@x.com"] }); // no bootstrap
    const res = await handleAdmins(req("DELETE", { email: "only@x.com" }), store, bearer);
    expect(res.status).toBe(400);
    expect(store.dynamic.has("only@x.com")).toBe(true);
  });

  test("removing the last DYNAMIC admin is fine when a bootstrap floor remains", async () => {
    const store = makeStore({ bootstrap: ["boss@x.com"], dynamic: ["only@x.com"] });
    const res = await handleAdmins(req("DELETE", { email: "only@x.com" }), store, bearer);
    expect(res.status).toBe(200);
    expect(store.dynamic.size).toBe(0);
  });

  test("a store write failure surfaces as a 502, not an unhandled throw", async () => {
    const store: AdminStore = {
      bootstrap: new Set(["boss@x.com"]),
      readDynamic: async () => new Set(),
      writeDynamic: async () => {
        throw new Error("no config dir");
      },
    };
    const res = await handleAdmins(req("POST", { email: "new@x.com" }), store, bearer);
    expect(res.status).toBe(502);
  });

  test("a store read failure (broken admins.json) surfaces as a 502 on GET, not an unhandled throw", async () => {
    const store: AdminStore = {
      bootstrap: new Set(["boss@x.com"]),
      readDynamic: async () => {
        throw new Error("admins.json: unexpected token");
      },
      writeDynamic: async () => {},
    };
    const res = await handleAdmins(req("GET"), store, bearer);
    expect(res.status).toBe(502);
  });

  test("a store read failure (broken admins.json) surfaces as a 502 on POST, not an unhandled throw", async () => {
    const store: AdminStore = {
      bootstrap: new Set(["boss@x.com"]),
      readDynamic: async () => {
        throw new Error("admins.json: unexpected token");
      },
      writeDynamic: async () => {},
    };
    const res = await handleAdmins(req("POST", { email: "new@x.com" }), store, bearer);
    expect(res.status).toBe(502);
  });
});

describe("isCrossSiteWrite", () => {
  const write = (method: string, headers: Record<string, string> = {}) =>
    new Request("http://panel.example/api/admins", { method, headers });

  test("a GET is never a cross-site write, whatever the Origin", () => {
    expect(isCrossSiteWrite(new Request("http://panel.example/api/status", { headers: { Origin: "http://evil.com" } }))).toBe(false);
  });

  test("a POST/DELETE with no Origin header is allowed (non-browser client)", () => {
    expect(isCrossSiteWrite(write("POST"))).toBe(false);
    expect(isCrossSiteWrite(write("DELETE"))).toBe(false);
  });

  test("a same-origin POST/DELETE is allowed", () => {
    expect(isCrossSiteWrite(write("POST", { Origin: "http://panel.example" }))).toBe(false);
    expect(isCrossSiteWrite(write("POST", { Origin: "https://panel.example" }))).toBe(false); // host matches; scheme not compared
    expect(isCrossSiteWrite(write("DELETE", { Origin: "http://panel.example" }))).toBe(false);
  });

  test("a cross-origin POST/DELETE is blocked", () => {
    expect(isCrossSiteWrite(write("POST", { Origin: "http://evil.com" }))).toBe(true);
    expect(isCrossSiteWrite(write("DELETE", { Origin: "http://evil.com" }))).toBe(true);
  });

  test("a malformed Origin is treated as cross-site", () => {
    expect(isCrossSiteWrite(write("POST", { Origin: "not a url" }))).toBe(true);
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

  test("a valid token resolves the identity, with the full claims attached", async () => {
    const jwt = await signToken();
    const result = await verify(jwt);
    expect(result?.sub).toBe("user@example.com");
    expect(result?.email).toBeUndefined();
    // The full verified payload is carried through for the panel's Identity view.
    expect(result?.claims).toMatchObject({ sub: "user@example.com", iss: `https://${TEAM_DOMAIN}`, aud: AUD });
    expect(typeof result?.claims?.exp).toBe("number");
  });

  test("the identity's email claim is carried when present", async () => {
    const jwt = await signToken({ email: "roshne@gmail.com" });
    const result = await verify(jwt);
    expect(result?.email).toBe("roshne@gmail.com");
    expect(result?.claims?.email).toBe("roshne@gmail.com");
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

describe("authorizeRequest", () => {
  const TOKEN = "the-real-token";
  const INDEX_HTML = "<html></html>";
  const fakeRunBotOps = async (): Promise<BotOpsResult> => ({ exitCode: 0, stdout: "", stderr: "" });

  function baseConfig(overrides: Partial<HandlerConfig> = {}): HandlerConfig {
    return { adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: fakeRunBotOps, ...overrides };
  }

  test("bearer matches, no Access header -> via bearer, no email", async () => {
    const req = new Request("http://x/", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await authorizeRequest(req, baseConfig(), undefined)).toEqual({ via: "bearer" });
  });

  test("a verified Access JWT authorizes on its own and carries the email", async () => {
    const req = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    const verifyAccessJwt = async () => ({ sub: "user@example.com", email: "user@example.com" });
    expect(await authorizeRequest(req, baseConfig({ verifyAccessJwt }), undefined)).toEqual({
      via: "jwt",
      email: "user@example.com",
    });
  });

  test("a verified JWT with no email claim authorizes via jwt with email undefined", async () => {
    const req = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    const verifyAccessJwt = async () => ({ sub: "user@example.com" });
    expect(await authorizeRequest(req, baseConfig({ verifyAccessJwt }), undefined)).toEqual({ via: "jwt", email: undefined });
  });

  test("an Access header with no verifier configured is inert — falls to the bearer check", async () => {
    const req = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    expect(await authorizeRequest(req, baseConfig(), undefined)).toBeNull();
    const reqWithBearer = new Request("http://x/", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt", Authorization: `Bearer ${TOKEN}` },
    });
    expect(await authorizeRequest(reqWithBearer, baseConfig(), undefined)).toEqual({ via: "bearer" });
  });

  test("a JWT that fails verification falls through to the bearer check", async () => {
    const verifyAccessJwt = async () => null;
    const req = new Request("http://x/", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt", Authorization: `Bearer ${TOKEN}` },
    });
    expect(await authorizeRequest(req, baseConfig({ verifyAccessJwt }), undefined)).toEqual({ via: "bearer" });
    const reqNoBearer = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    expect(await authorizeRequest(reqNoBearer, baseConfig({ verifyAccessJwt }), undefined)).toBeNull();
  });

  test("both fail -> null", async () => {
    const verifyAccessJwt = async () => null;
    const req = new Request("http://x/", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt", Authorization: "Bearer wrong" },
    });
    expect(await authorizeRequest(req, baseConfig({ verifyAccessJwt }), undefined)).toBeNull();
  });

  test("a verified JWT for an allow-listed email authorizes on its own, carrying the email", async () => {
    const verifyAccessJwt = async () => ({ sub: "x", email: "roshne@gmail.com" });
    const allowed = new Set(["roshne@gmail.com"]);
    const req = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    expect(await authorizeRequest(req, baseConfig({ verifyAccessJwt }), allowed)).toEqual({
      via: "jwt",
      email: "roshne@gmail.com",
    });
  });

  test("a verified JWT for a non-allow-listed email falls through to the bearer check", async () => {
    const verifyAccessJwt = async () => ({ sub: "x", email: "nazuraki@gmail.com" });
    const allowed = new Set(["roshne@gmail.com"]);
    const reqWithBearer = new Request("http://x/", {
      headers: { "Cf-Access-Jwt-Assertion": "some-jwt", Authorization: `Bearer ${TOKEN}` },
    });
    expect(await authorizeRequest(reqWithBearer, baseConfig({ verifyAccessJwt }), allowed)).toEqual({
      via: "bearer",
    });
    const reqNoBearer = new Request("http://x/", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } });
    expect(await authorizeRequest(reqNoBearer, baseConfig({ verifyAccessJwt }), allowed)).toBeNull();
  });
});

describe("describeActor / describeAction / parseChangedKeys / auditLogLine", () => {
  const okRestart: BotOpsInvocation = { args: ["restart"], contentType: "text/plain" };
  const okEnvSet: BotOpsInvocation = { args: ["env-set"], stdin: "", contentType: "application/json" };
  const ok = (stdout = ""): BotOpsResult => ({ exitCode: 0, stdout, stderr: "" });

  test("describeActor names the email when present, else the auth path", () => {
    expect(describeActor({ via: "jwt", email: "roshne@gmail.com" })).toBe("roshne@gmail.com");
    expect(describeActor({ via: "jwt" })).toBe("an Access session (no email claim)");
    expect(describeActor({ via: "bearer" })).toBe("the ADMIN_TOKEN bearer token");
  });

  test("parseChangedKeys pulls string keys from env-set JSON, tolerating anything else", () => {
    expect(parseChangedKeys('{"changed":["BOT_BRANCH","WOW_REALM"]}')).toEqual(["BOT_BRANCH", "WOW_REALM"]);
    expect(parseChangedKeys('{"changed":[]}')).toEqual([]);
    expect(parseChangedKeys("{}")).toEqual([]);
    expect(parseChangedKeys("not json")).toEqual([]);
    expect(parseChangedKeys('{"changed":[1,"OK",null]}')).toEqual(["OK"]);
  });

  test("describeAction names env-set's changed keys, and restart plainly", () => {
    expect(describeAction(okEnvSet, '{"changed":["BOT_BRANCH"]}')).toBe("env-set (changed: BOT_BRANCH)");
    expect(describeAction(okEnvSet, '{"changed":[]}')).toBe("env-set (no changes)");
    expect(describeAction(okRestart, "")).toBe("restart");
  });

  test("auditLogLine logs successful mutations with the actor", () => {
    expect(auditLogLine(okRestart, ok(), { via: "jwt", email: "roshne@gmail.com" })).toBe(
      "[admin] restart by roshne@gmail.com",
    );
    expect(auditLogLine(okEnvSet, ok('{"changed":["GUILD_ID"]}'), { via: "bearer" })).toBe(
      "[admin] env-set (changed: GUILD_ID) by the ADMIN_TOKEN bearer token",
    );
  });

  test("auditLogLine returns null for reads and for failures (logged elsewhere)", () => {
    const status: BotOpsInvocation = { args: ["status"], contentType: "application/json" };
    const logs: BotOpsInvocation = { args: ["logs"], contentType: "text/plain" };
    const envGet: BotOpsInvocation = { args: ["env-get"], contentType: "application/json" };
    const auth: Authorization = { via: "jwt", email: "roshne@gmail.com" };
    expect(auditLogLine(status, ok("{}"), auth)).toBeNull();
    expect(auditLogLine(logs, ok(""), auth)).toBeNull();
    expect(auditLogLine(envGet, ok("{}"), auth)).toBeNull();
    // a mutation that FAILED (non-zero exit) isn't logged here — the error path logs it instead
    expect(auditLogLine(okRestart, { exitCode: 1, stdout: "", stderr: "boom" }, auth)).toBeNull();
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
      { ...config(), adminStore: makeStore({ bootstrap: ["roshne@gmail.com"] }) },
    );
    expect(res.status).toBe(200);
  });

  test("a valid real JWT for a non-allow-listed email is unauthorized with no bearer token", async () => {
    const jwt = await signToken({ email: "nazuraki@gmail.com" });
    const res = await handleRequest(
      new Request("http://x/api/status", { headers: { "Cf-Access-Jwt-Assertion": jwt } }),
      { ...config(), adminStore: makeStore({ bootstrap: ["roshne@gmail.com"] }) },
    );
    expect(res.status).toBe(401);
  });

  test("a dynamically-added admin's JWT authorizes (the dynamic allow-list takes effect live)", async () => {
    // Bootstrap allows only roshne; nazuraki is added to the dynamic set — then nazuraki's JWT
    // must authorize, with no restart, proving handleRequest reads the store fresh per request.
    const store = makeStore({ bootstrap: ["roshne@gmail.com"] });
    store.dynamic.add("nazuraki@gmail.com");
    const jwt = await signToken({ email: "nazuraki@gmail.com" });
    const res = await handleRequest(
      new Request("http://x/api/status", { headers: { "Cf-Access-Jwt-Assertion": jwt } }),
      { ...config(), adminStore: store },
    );
    expect(res.status).toBe(200);
  });

  test("a valid real JWT for a non-allow-listed email still authorizes via a correct bearer token", async () => {
    const jwt = await signToken({ email: "nazuraki@gmail.com" });
    const res = await handleRequest(
      new Request("http://x/api/status", {
        headers: { "Cf-Access-Jwt-Assertion": jwt, Authorization: `Bearer ${TOKEN}` },
      }),
      { ...config(), adminStore: makeStore({ bootstrap: ["roshne@gmail.com"] }) },
    );
    expect(res.status).toBe(200);
  });

  // Issue #40's acceptance bullet: a broken admins.json used to be indistinguishable from an
  // absent one, so with no bootstrap floor it collapsed the allow-list to "unconfigured" and let
  // any verified identity in. These three tests pin: the fix (fails closed), the regression guard
  // (absent file is unaffected), and that the fail-closed path doesn't over-reach into bootstrap.
  test("a broken admins.json + empty bootstrap fails CLOSED: a verified JWT for any email is unauthorized", async () => {
    const brokenStore: AdminStore = {
      bootstrap: new Set(),
      readDynamic: async () => {
        throw new Error("admins.json: unexpected token");
      },
      writeDynamic: async () => {},
    };
    const jwt = await signToken({ email: "anyone@example.com" });
    const res = await handleRequest(
      new Request("http://x/api/status", { headers: { "Cf-Access-Jwt-Assertion": jwt } }),
      { ...config(), adminStore: brokenStore },
    );
    expect(res.status).toBe(401);
  });

  test("an absent admins.json (first run) + empty bootstrap still behaves as before: any verified JWT authorizes", async () => {
    const res = await handleRequest(
      new Request("http://x/api/status", { headers: { "Cf-Access-Jwt-Assertion": await signToken({ email: "anyone@example.com" }) } }),
      { ...config(), adminStore: makeStore() }, // makeStore()'s readDynamic resolves an empty set, never throws
    );
    expect(res.status).toBe(200);
  });

  test("a broken admins.json doesn't lock out a bootstrap-pinned admin's JWT", async () => {
    const brokenStore: AdminStore = {
      bootstrap: new Set(["roshne@gmail.com"]),
      readDynamic: async () => {
        throw new Error("admins.json: unexpected token");
      },
      writeDynamic: async () => {},
    };
    const jwt = await signToken({ email: "roshne@gmail.com" });
    const res = await handleRequest(
      new Request("http://x/api/status", { headers: { "Cf-Access-Jwt-Assertion": jwt } }),
      { ...config(), adminStore: brokenStore },
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

describe("parseEnvValue", () => {
  const env = 'GITHUB_REPO=owner/name\nGITHUB_TOKEN="ghp_secret"\nQUOTED=\'v=1\'\nEMPTY=\nSPACED= trimmed \r\nOTHER=x';
  test("reads an unquoted value", () => expect(parseEnvValue(env, "GITHUB_REPO")).toBe("owner/name"));
  test("strips one layer of double quotes", () => expect(parseEnvValue(env, "GITHUB_TOKEN")).toBe("ghp_secret"));
  test("strips single quotes and keeps an inner '='", () => expect(parseEnvValue(env, "QUOTED")).toBe("v=1"));
  test("an empty value is an empty string", () => expect(parseEnvValue(env, "EMPTY")).toBe(""));
  test("trims surrounding whitespace and a trailing CR", () => expect(parseEnvValue(env, "SPACED")).toBe("trimmed"));
  test("a missing key is undefined", () => expect(parseEnvValue(env, "NOPE")).toBeUndefined());
  test("matches a whole key, not a prefix", () => expect(parseEnvValue("GITHUB_REPOSITORY=x", "GITHUB_REPO")).toBeUndefined());
});

describe("branchNamesFromApi", () => {
  test("extracts names from the GitHub branches shape", () => {
    expect(branchNamesFromApi([{ name: "main" }, { name: "dev" }])).toEqual(["main", "dev"]);
  });
  test("drops nameless / malformed entries", () => {
    expect(branchNamesFromApi([{ name: "main" }, {}, { name: 5 }, null])).toEqual(["main"]);
  });
  test("a non-array body yields no branches", () => {
    expect(branchNamesFromApi({ message: "Not Found" })).toEqual([]);
    expect(branchNamesFromApi(null)).toEqual([]);
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

  test("serves /realms.json unauthenticated when configured", async () => {
    const realmsJson = '{"regions":{"us":[{"slug":"eitrigg","name":"Eitrigg"}]}}';
    // No Authorization header — proves the route is served before the auth gate, like the page.
    const res = await handleRequest(new Request("http://x/realms.json"), {
      adminToken: TOKEN,
      indexHtml: INDEX_HTML,
      realmsJson,
      runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(realmsJson);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("404s /realms.json when no realm data was generated", async () => {
    const res = await handleRequest(new Request("http://x/realms.json"), {
      adminToken: TOKEN,
      indexHtml: INDEX_HTML,
      runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(res.status).toBe(404);
  });

  const branchCfg = (overrides: Partial<HandlerConfig> = {}): HandlerConfig => ({
    adminToken: TOKEN,
    indexHtml: INDEX_HTML,
    runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }),
    ...overrides,
  });
  const authed = (path: string) => new Request("http://x" + path, { headers: { Authorization: `Bearer ${TOKEN}` } });

  test("/api/branches returns the listed branches to an authorized caller", async () => {
    const res = await handleRequest(authed("/api/branches"), branchCfg({ listBranches: async () => ["main", "dev"] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ branches: ["main", "dev"] });
  });

  test("/api/branches 502s when the lookup fails (null)", async () => {
    const res = await handleRequest(authed("/api/branches"), branchCfg({ listBranches: async () => null }));
    expect(res.status).toBe(502);
  });

  test("/api/branches 404s when no branch lister is configured", async () => {
    const res = await handleRequest(authed("/api/branches"), branchCfg());
    expect(res.status).toBe(404);
  });

  test("/api/branches requires auth (no token -> 401, never calls the lister)", async () => {
    let called = false;
    const res = await handleRequest(new Request("http://x/api/branches"), branchCfg({ listBranches: async () => { called = true; return ["main"]; } }));
    expect(res.status).toBe(401);
    expect(called).toBe(false);
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

  test("GET /api/whoami reports the verified email and full claims on the JWT path, without touching bot-ops.sh", async () => {
    let botOpsCalls = 0;
    const claims = { sub: "roshne@gmail.com", email: "roshne@gmail.com", iss: "https://team.example", aud: "aud", exp: 123 };
    const res = await handleRequest(
      new Request("http://x/api/whoami", { headers: { "Cf-Access-Jwt-Assertion": "some-jwt" } }),
      {
        adminToken: TOKEN,
        indexHtml: INDEX_HTML,
        runBotOps: async () => {
          botOpsCalls++;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        verifyAccessJwt: async () => ({ sub: "roshne@gmail.com", email: "roshne@gmail.com", claims }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "jwt", email: "roshne@gmail.com", claims });
    expect(botOpsCalls).toBe(0); // whoami is server-native, never shells out
  });

  test("GET /api/whoami on the bearer path reports via:bearer with null email and null claims", async () => {
    const res = await handleRequest(
      new Request("http://x/api/whoami", { headers: { Authorization: `Bearer ${TOKEN}` } }),
      { adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: "bearer", email: null, claims: null });
  });

  test("GET /api/whoami still requires auth", async () => {
    const res = await handleRequest(new Request("http://x/api/whoami"), {
      adminToken: TOKEN,
      indexHtml: INDEX_HTML,
      runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(res.status).toBe(401);
  });

  test("authenticated GET /api/admins routes to the store and never shells out", async () => {
    let botOpsCalls = 0;
    const res = await handleRequest(
      new Request("http://x/api/admins", { headers: { Authorization: `Bearer ${TOKEN}` } }),
      {
        adminToken: TOKEN,
        indexHtml: INDEX_HTML,
        runBotOps: async () => {
          botOpsCalls++;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        adminStore: makeStore({ bootstrap: ["boss@x.com"], dynamic: ["d@x.com"] }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bootstrap: ["boss@x.com"], dynamic: ["d@x.com"] });
    expect(botOpsCalls).toBe(0);
  });

  test("/api/admins requires auth", async () => {
    const res = await handleRequest(new Request("http://x/api/admins"), {
      adminToken: TOKEN,
      indexHtml: INDEX_HTML,
      runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }),
      adminStore: makeStore(),
    });
    expect(res.status).toBe(401);
  });

  test("/api/admins is a 404 when no adminStore is configured", async () => {
    const res = await handleRequest(
      new Request("http://x/api/admins", { headers: { Authorization: `Bearer ${TOKEN}` } }),
      { adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }) },
    );
    expect(res.status).toBe(404);
  });

  test("POST/DELETE /api/admins require auth (401 without it)", async () => {
    for (const method of ["POST", "DELETE"]) {
      const res = await handleRequest(
        new Request("http://x/api/admins", { method, body: JSON.stringify({ email: "e@x.com" }) }),
        { adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }), adminStore: makeStore() },
      );
      expect(res.status).toBe(401);
    }
  });

  test("a cross-site POST is blocked with 403 before auth even runs", async () => {
    const res = await handleRequest(
      new Request("http://x/api/admins", {
        method: "POST",
        // valid bearer, but a foreign Origin — the CSRF guard rejects it regardless.
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://evil.example" },
        body: JSON.stringify({ email: "attacker@evil.com" }),
      }),
      { adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }), adminStore: makeStore() },
    );
    expect(res.status).toBe(403);
  });

  test("a same-origin POST passes the CSRF guard", async () => {
    const store = makeStore();
    const res = await handleRequest(
      new Request("http://x/api/admins", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://x" },
        body: JSON.stringify({ email: "new@x.com" }),
      }),
      { adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "", stderr: "" }), adminStore: store },
    );
    expect(res.status).toBe(200);
    expect(store.dynamic.has("new@x.com")).toBe(true);
  });
});

// WOW_REALM slug validation lives in TWO hand-duplicated places: the authority is bot-ops.sh's
// ALLOWED[WOW_REALM] regex (bash, on the box), mirrored by REALM_SLUG_RE in the panel's index.html
// (client JS that filters the realm chooser). This block reads both from source and pins them so
// they can't drift, then pins the behaviour that matters — the accented EU realm slugs Blizzard's
// connected-realm search only matches in their accented form (its ASCII-folded spelling returns zero
// results, verified against the live API) must validate; URL/shell-metacharacter and out-of-charset
// input must not. It runs in JS, so it mirrors bash ERE for this simple pattern rather than proving
// the bash engine itself — the on-box env-set check does that.
describe("WOW_REALM slug validation (bot-ops.sh ↔ panel filter stay in sync)", () => {
  const botOpsSrc = readFileSync(new URL("../bot-ops.sh", import.meta.url), "utf8");
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const botOpsPattern = botOpsSrc.match(/\[WOW_REALM\]='([^']+)'/)?.[1];
  const panelPattern = indexSrc.match(/REALM_SLUG_RE\s*=\s*\/(.+?)\/\s*;/)?.[1];

  test("both source patterns are present and identical (mirror can't drift)", () => {
    expect(botOpsPattern).toBeDefined();
    expect(panelPattern).toBeDefined();
    expect(panelPattern).toBe(botOpsPattern);
  });

  // The 7 EU realms Blizzard only matches by their accented slug, plus plain-ASCII controls.
  const mustAccept = [
    "aggra-português",
    "chants-éternels",
    "confrérie-du-thorium",
    "festung-der-stürme",
    "la-croisade-écarlate",
    "marécage-de-zangar",
    "pozzo-delleternità",
    "eitrigg",
    "hyjal",
    "thorium-brotherhood",
  ];
  // Whitespace, shell/URL metacharacters, path traversal, uppercase, out-of-charset symbols, empty,
  // and over-length must never validate — the value is interpolated into a URL and shown in Discord.
  const mustReject = [
    "chants eternels",
    "a&b",
    "a=b",
    "a$(x)",
    "a`x`",
    "a;b",
    "a|b",
    "a/b",
    "a?b",
    "a#b",
    "a%b",
    "a@b",
    "a<b",
    "a>b",
    "a'b",
    'a"b',
    "a\\b",
    "../etc",
    "Hyjal",
    "a÷b",
    "a×b",
    "",
    "x".repeat(41),
  ];

  test("accepts real accented + ASCII slugs, rejects unsafe / out-of-charset input", () => {
    const re = new RegExp(botOpsPattern ?? "(?!)");
    for (const slug of mustAccept) expect(re.test(slug)).toBe(true);
    for (const bad of mustReject) expect(re.test(bad)).toBe(false);
  });
});
