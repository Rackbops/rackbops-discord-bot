import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  adminAuditLine,
  adminRemovalError,
  auditLogLine,
  authorizeRequest,
  branchNamesFromApi,
  buildInvocation,
  createAccessJwtVerifier,
  createRunBotOps,
  describeAction,
  describeActor,
  effectiveAllowlist,
  escapeHtml,
  extractAccessJwt,
  extractBearerToken,
  handleAdmins,
  handleRequest,
  IDLE_TIMEOUT_SECONDS,
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
  SUBPROCESS_TIMEOUT_MS,
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

  // Spied rather than left to the pure adminAuditLine unit test alone — that only proves the
  // function's own formatting, not that handleAdmins actually calls and logs it (issue #53 item 3;
  // mirrors the identical rationale at the auditLogLine spy test below auditLogLine's own unit test —
  // a prior review round mutation-tested that exact wiring by deleting it and the suite stayed green
  // with only the pure-function test in place).
  test("POST logs an audit line for a real add, not for the already-an-admin no-op (issue #53 item 3)", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const store = makeStore({ bootstrap: ["boss@x.com"] });
      await handleAdmins(req("POST", { email: "new@x.com" }), store, admin);
      expect(logSpy).toHaveBeenCalledWith("[admin] admins: added new@x.com by me@x.com");
      logSpy.mockClear();

      await handleAdmins(req("POST", { email: "boss@x.com" }), store, admin); // already a bootstrap admin
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  test("DELETE logs an audit line for a real removal, not for a refused one (issue #53 item 3)", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const store = makeStore({ bootstrap: ["boss@x.com"], dynamic: ["gone@x.com"] });
      await handleAdmins(req("DELETE", { email: "boss@x.com" }), store, admin); // refused: bootstrap-pinned
      expect(logSpy).not.toHaveBeenCalled();

      await handleAdmins(req("DELETE", { email: "gone@x.com" }), store, admin);
      expect(logSpy).toHaveBeenCalledWith("[admin] admins: removed gone@x.com by me@x.com");
    } finally {
      logSpy.mockRestore();
    }
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

  test("describeActor names a service token's common_name when there's no email claim (issue #53 item 5)", () => {
    expect(describeActor({ via: "jwt", claims: { common_name: "warbandeer-ci" } })).toBe(
      'an Access session (service token "warbandeer-ci")',
    );
    // Regression: a real Access JWT with neither email nor common_name falls back exactly as before.
    expect(describeActor({ via: "jwt", claims: { sub: "abc" } })).toBe("an Access session (no email claim)");
    expect(describeActor({ via: "jwt", claims: { common_name: 123 as unknown as string } })).toBe(
      "an Access session (no email claim)",
    );
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

  test("auditLogLine returns null for reads and for no-op failures (logged elsewhere)", () => {
    const status: BotOpsInvocation = { args: ["status"], contentType: "application/json" };
    const logs: BotOpsInvocation = { args: ["logs"], contentType: "text/plain" };
    const envGet: BotOpsInvocation = { args: ["env-get"], contentType: "application/json" };
    const auth: Authorization = { via: "jwt", email: "roshne@gmail.com" };
    expect(auditLogLine(status, ok("{}"), auth)).toBeNull();
    expect(auditLogLine(logs, ok(""), auth)).toBeNull();
    expect(auditLogLine(envGet, ok("{}"), auth)).toBeNull();
    // restart has no "changed" concept, so a failed restart has nothing to attribute
    expect(auditLogLine(okRestart, { exitCode: 1, stdout: "", stderr: "boom" }, auth)).toBeNull();
    // an env-set that die()'d before touching .env (empty/non-JSON stdout) mutated nothing either
    expect(auditLogLine(okEnvSet, { exitCode: 1, stdout: "", stderr: "bot-ops: value is invalid" }, auth)).toBeNull();
    expect(auditLogLine(okEnvSet, { exitCode: 1, stdout: '{"changed":[]}', stderr: "" }, auth)).toBeNull();
  });

  test("auditLogLine attributes a failed env-set recreate when .env was already rewritten (issue #47)", () => {
    const auth: Authorization = { via: "bearer" };
    const result: BotOpsResult = {
      exitCode: 1,
      stdout: '{"ok":false,"changed":["WOW_REALM"],"backup":"/opt/x/.env.bak.1","log":"compose: image not found"}',
      stderr: "",
    };
    expect(auditLogLine(okEnvSet, result, auth)).toBe(
      "[admin] env-set (changed: WOW_REALM) — recreate FAILED by the ADMIN_TOKEN bearer token",
    );
  });

  // A timed-out env-set is the case issue #47's fix didn't cover: bot-ops.sh's cmd_env_set rewrites
  // .env BEFORE the killable recreate step, so a kill mid-recreate means stdout is empty — the
  // env-set-with-changed-keys branch above finds nothing and would otherwise return null, losing
  // the audit trail for a mutation that already happened (issue #53 item 1/2 follow-up, found in
  // review). Covers both restart and env-set — a timed-out restart has no ".env already mutated"
  // nuance, but the attempt itself is still worth a line for an operator investigating afterward.
  test("auditLogLine logs the bare fact of a timeout, even with empty stdout (issue #53 item 1/2)", () => {
    const auth: Authorization = { via: "jwt", email: "roshne@gmail.com" };
    const timedOutResult: BotOpsResult = { exitCode: 1, stdout: "", stderr: "", timedOut: true };
    expect(auditLogLine(okEnvSet, timedOutResult, auth)).toBe(
      "[admin] env-set timed out (killed after running past its limit) — attempted by roshne@gmail.com",
    );
    expect(auditLogLine(okRestart, timedOutResult, auth)).toBe(
      "[admin] restart timed out (killed after running past its limit) — attempted by roshne@gmail.com",
    );
  });
});

describe("adminAuditLine (issue #53 item 3)", () => {
  test("names the action, email, and actor", () => {
    expect(adminAuditLine("added", "new@x.com", { via: "jwt", email: "boss@x.com" })).toBe(
      "[admin] admins: added new@x.com by boss@x.com",
    );
    expect(adminAuditLine("removed", "gone@x.com", { via: "bearer" })).toBe(
      "[admin] admins: removed gone@x.com by the ADMIN_TOKEN bearer token",
    );
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

// Real-bash tests, mirroring bot-ops.test.ts's own convention for exercising a real subprocess
// rather than a stub: this is the one place the Bun.spawn timeout/killSignal wiring itself is
// proven to work, not just asserted by reading the code. No filesystem access happens (just
// `sleep`), so — unlike bot-ops.test.ts's Windows-specific bash resolution, which exists to avoid a
// WSL bash.exe seeing a different filesystem — a plain `Bun.which("bash")` is enough here; skips
// LOUDLY rather than passing vacuously when bash isn't on PATH.
const BASH = Bun.which("bash");
if (!BASH) {
  console.warn("[server.test] SKIPPING createRunBotOps real-subprocess tests: no bash on PATH");
}
describe.skipIf(!BASH)("createRunBotOps (issue #53 item 1/2: subprocess timeout)", () => {
  const scripts: string[] = [];
  function slowScript(body: string): string {
    const path = join(tmpdir(), `bot-ops-createRunBotOps-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    scripts.push(path);
    return path;
  }
  afterEach(() => {
    for (const path of scripts.splice(0)) rmSync(path, { force: true });
  });

  test("a process that outlives its timeout is killed and reported as timed out", async () => {
    const script = slowScript("sleep 5\necho should-not-print");
    const runBotOps = createRunBotOps(script, { timeoutMs: 100, killSignal: "SIGKILL" });
    const result = await runBotOps({ args: [], contentType: "text/plain" });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("should-not-print");
  }, 10000);

  test("a process finishing within its timeout is not marked as timed out, exit code/stdout intact", async () => {
    const script = slowScript("echo hi\nexit 3");
    const runBotOps = createRunBotOps(script, { timeoutMs: 5000 });
    const result = await runBotOps({ args: [], contentType: "text/plain" });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe("hi");
  });

  test("args and stdin are still passed through exactly as before", async () => {
    const script = slowScript('cat\necho "args: $*"');
    const runBotOps = createRunBotOps(script, { timeoutMs: 5000 });
    const result = await runBotOps({ args: ["env-set"], stdin: "KEY=value", contentType: "application/json" });
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("KEY=value");
    expect(result.stdout).toContain("args: env-set");
  });

  // A process whose exit code merely LOOKS like a signal kill (the conventional 128+signum
  // convention, e.g. 143 for SIGTERM) — but was never actually signaled at all — must not be
  // confused for one either. This guards the general shape of the fix: `timedOut` is written ONLY
  // by our own timer callback (a single assignment site in createRunBotOps — see its doc comment),
  // never inferred from `exitCode` or any other after-the-fact process state.
  //
  // A stronger regression test would kill the real subprocess with a genuine external signal
  // (unrelated to our own timer) and assert `timedOut` stays false — this is exactly the bug found
  // in review (an earlier version inferred `timedOut` from `proc.signalCode !== null`, which is
  // true for ANY signal-terminated exit, verified by probe against a real `proc.kill("SIGTERM")`
  // sent from outside the timeout timer). That's deliberately NOT automated here: simulating an
  // externally-caused signal kill portably across this repo's two real test environments (Windows
  // dev via Git Bash, Linux CI) isn't practical — probed directly during this review: Git Bash's
  // `kill -TERM $$` (self-signal) does not produce a real OS-level signal-terminated exit on
  // Windows (Bun reports `signalCode: null`, `exitCode: 0`), and `pkill`/`pgrep` aren't on PATH
  // there either. The fix's correctness rests on the single-assignment-site construction instead.
  test("an exit code that merely resembles a signal-kill convention (143) is not confused for one", async () => {
    const script = slowScript("exit 143"); // 128+SIGTERM, but never actually signaled
    const runBotOps = createRunBotOps(script, { timeoutMs: 5000 });
    const result = await runBotOps({ args: [], contentType: "text/plain" });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(143);
  });

  // Real bug found in round-2 review, reproduced and verified fixed against a real Linux kernel
  // (this repo's Windows dev box can't verify the fix itself — see the platform gate below — so
  // this was independently confirmed via WSL2 during review): bot-ops.sh's mutating subcommands run
  // `docker compose ...` through a command substitution — a genuine CHILD of the spawned bash, not a
  // tail-call `exec`. Killing only `proc` (bash) left that child running and still holding the SAME
  // stdout/stderr pipe FDs this function reads until EOF, so the timeout bounded nothing: measured
  // ~8000ms (the child's real duration) instead of the configured ~300ms, even though `timedOut` was
  // (correctly, by itself) still reported true. The fix spawns detached and kills the whole process
  // GROUP via `process.kill(-proc.pid, ...)` on a real kill. Windows has no such group-kill semantics
  // (falls back to killing just the direct child there — the admin panel only ever runs in a Linux
  // container in production, so that's an accepted, disclosed local-dev-only gap), which is exactly
  // why this specific test — the one that actually proves the group-kill closes the bug — only runs
  // on a real POSIX kernel; on Windows it would just re-measure that known, accepted gap.
  test.skipIf(process.platform === "win32")(
    "a grandchild spawned via command substitution (shaped like bot-ops.sh's real docker compose call) is killed too — the timeout actually bounds wall-clock time, not just `timedOut`",
    async () => {
      const script = slowScript('recreate_log="$(sleep 8; echo done)"\necho "$recreate_log"');
      const runBotOps = createRunBotOps(script, { timeoutMs: 300, killSignal: "SIGKILL" });
      const start = Date.now();
      const result = await runBotOps({ args: [], contentType: "text/plain" });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000); // the bug this guards: this used to take the real ~8000ms
      expect(result.timedOut).toBe(true);
      expect(result.stdout).toBe(""); // the grandchild's "done" must never have been captured
    },
    10000,
  );
});

describe("SUBPROCESS_TIMEOUT_MS / IDLE_TIMEOUT_SECONDS (issue #53 item 1/2)", () => {
  test("the values match the design, and idleTimeout leaves real margin over the subprocess timeout", () => {
    expect(SUBPROCESS_TIMEOUT_MS).toBe(90_000);
    expect(IDLE_TIMEOUT_SECONDS).toBe(120);
    expect(IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThan(SUBPROCESS_TIMEOUT_MS);
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

  test("a timed-out bot-ops.sh invocation returns a distinct 504, not the generic 502 (issue #53 item 1/2)", async () => {
    const res = await handleRequest(
      new Request("http://x/api/restart", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } }),
      {
        adminToken: TOKEN,
        indexHtml: INDEX_HTML,
        runBotOps: fakeRunBotOps({ exitCode: 1, stdout: "", stderr: "", timedOut: true }),
      },
    );
    expect(res.status).toBe(504);
  });

  // Spied rather than left to the pure auditLogLine unit test alone — mirrors the identical
  // rationale on the issue #47 test below: a prior review round mutation-tested this exact class of
  // wiring by deleting it and the suite stayed green with only the pure-function test in place.
  test("a timed-out env-set still logs an audit line despite empty stdout (issue #53 item 1/2, found in review)", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await handleRequest(
        new Request("http://x/api/env", {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: "BOT_BRANCH=main",
        }),
        {
          adminToken: TOKEN,
          indexHtml: INDEX_HTML,
          runBotOps: fakeRunBotOps({ exitCode: 1, stdout: "", stderr: "", timedOut: true }),
        },
      );
      expect(res.status).toBe(504);
      expect(logSpy).toHaveBeenCalledWith(
        "[admin] env-set timed out (killed after running past its limit) — attempted by the ADMIN_TOKEN bearer token",
      );
    } finally {
      logSpy.mockRestore();
    }
  });

  test("a failed env-set recreate returns its JSON stdout (backup/log), logs an audit line, not the empty stderr (issue #47)", async () => {
    const stdout = '{"ok":false,"changed":["WOW_REALM"],"backup":"/opt/x/.env.bak.1","log":"compose: image not found"}';
    // Spied rather than left to the pure auditLogLine unit test alone — that only proves the
    // function's own logic, not that handleRequest's failure branch actually calls and logs it
    // (a prior review round mutation-tested this exact wiring by deleting it: the suite stayed
    // green with only the unit test in place).
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await handleRequest(
        new Request("http://x/api/env", {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: "WOW_REALM=stormrage",
        }),
        {
          adminToken: TOKEN,
          indexHtml: INDEX_HTML,
          runBotOps: fakeRunBotOps({ exitCode: 1, stdout, stderr: "" }),
        },
      );
      expect(res.status).toBe(502);
      expect(await res.text()).toBe(stdout);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(logSpy).toHaveBeenCalledWith(
        "[admin] env-set (changed: WOW_REALM) — recreate FAILED by the ADMIN_TOKEN bearer token",
      );
    } finally {
      logSpy.mockRestore();
    }
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

// The panel's save path, pinned against the page's OWN source: the pure planEnvSave and saveEnv
// itself are lifted from index.html (between their ENV_SAVE_PLAN / ENV_SAVE markers) and evaluated
// here, so what issue #44 hinged on — the POST body carries ONLY the keys whose value changed, never
// an untouched field echoed back — is asserted on the real functions, not a re-implementation. The
// consumer boundary is what a green planEnvSave alone can't prove (a saveEnv that planned against
// `{}` instead of the loaded env, or posted every control, would leave the bug in place), so saveEnv
// is run against a stubbed page and the body it actually hands to api() is what's asserted.
describe("admin panel saveEnv posts only the changed keys (issue #44)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const planSrc = indexSrc.match(/\/\/ ENV_SAVE_PLAN:begin\n([\s\S]*?)\n\s*\/\/ ENV_SAVE_PLAN:end/)?.[1];
  const saveSrc = indexSrc.match(/\/\/ ENV_SAVE:begin\n([\s\S]*?)\n\s*\/\/ ENV_SAVE:end/)?.[1];
  // REQUIRED_KEYS lives outside the ENV_SAVE markers (the real page's saveEnv reaches it via
  // closure, in the single IIFE scope it shares with FIELD_META) — so the isolated eval below must
  // have it injected explicitly, extracted from source like planSrc/saveSrc are.
  const requiredKeysSrc = indexSrc.match(/REQUIRED_KEYS\s*=\s*(\[[^\]]*\])/)?.[1];
  const REQUIRED_KEYS = JSON.parse(requiredKeysSrc ?? "[]") as string[];
  type Plan = { changes: { key: string; before: string; now: string }[]; body: string };
  // "use strict" up front, matching the page's own IIFE (index.html:226): without it, a `Function`
  // body silently creates a global on an assignment to an un-injected or misspelled identifier
  // instead of throwing — the real (strict-mode) page would ReferenceError there instead.
  const planEnvSave = (loaded: Record<string, string>, current: Record<string, string>): Plan =>
    (new Function(`"use strict";\n${planSrc ?? ""}\nreturn planEnvSave;`)() as (
      l: typeof loaded,
      c: typeof current,
    ) => Plan)(loaded, current);

  /** Runs the page's real saveEnv with `controls` as the rendered fields and `loaded` as what
   *  GET /api/env returned, recording what it confirms and POSTs. Every page global saveEnv touches
   *  is injected: document (only #env-msg and the field controls are looked up), confirm, api,
   *  loadEnv/loadStatus (the post-save re-baseline), and loadedEnv. */
  interface FakePage {
    posts: { path: string; opts: { method?: string; body?: string; signal?: AbortSignal } }[];
    confirms: string[];
    msg: { textContent: string; className: string };
    reloads: number;
  }
  async function runSaveEnv(
    loaded: Record<string, string>,
    controls: Record<string, string>,
    opts: { confirm?: boolean; response?: { ok: boolean; text: string } } = {},
  ): Promise<FakePage> {
    const page: FakePage = { posts: [], confirms: [], msg: { textContent: "", className: "" }, reloads: 0 };
    const document = {
      getElementById: (id: string) => (id === "env-msg" ? page.msg : null),
      querySelectorAll: (selector: string) =>
        selector === "#env-fields [data-key]" ? Object.entries(controls).map(([key, value]) => ({ dataset: { key }, value })) : [],
    };
    const confirm = (text: string): boolean => {
      page.confirms.push(text);
      return opts.confirm ?? true;
    };
    const api = async (path: string, o: { method?: string; body?: string; signal?: AbortSignal }) => {
      page.posts.push({ path, opts: o });
      const r = opts.response ?? { ok: true, text: '{"ok":true,"changed":["ANNOUNCE_CHANNEL_ID"]}' };
      return { ok: r.ok, text: async () => r.text };
    };
    // A no-op fake (no real delay) — saveEnv's real timeoutSignal wiring is already covered for
    // real by the dedicated TIMEOUT_SIGNAL unit tests; this harness only needs to prove saveEnv
    // calls it and forwards the resulting signal into api() (issue #53 item 2).
    const timeoutSignal = (_ms: number) => ({ signal: new AbortController().signal, cancel: () => {} });
    const saveEnv = new Function(
      "document",
      "confirm",
      "api",
      "loadEnv",
      "loadStatus",
      "loadedEnv",
      "REQUIRED_KEYS",
      "MUTATION_TIMEOUT_MS",
      "timeoutSignal",
      `${planSrc ?? ""}\n${saveSrc ?? ""}\nreturn saveEnv;`,
    )(document, confirm, api, () => page.reloads++, () => {}, loaded, REQUIRED_KEYS, 110000, timeoutSignal) as () => Promise<void>;
    await saveEnv();
    return page;
  }

  test("both marked functions are present in the served page", () => {
    expect(planSrc).toContain("function planEnvSave(");
    expect(saveSrc).toContain("async function saveEnv(");
  });

  test("saveEnv POSTs only the changed fields, diffed against the LOADED env, and previews the same", async () => {
    // The issue's exact setup: two stored values the whitelist would reject, both untouched.
    const loaded = { DISCORD_SERVER_ID: "", ANNOUNCE_CHANNEL_ID: "111", ADMIN_USER_IDS: "123456, 234567", WOW_REALM: "stormrage" };
    const page = await runSaveEnv(loaded, { ...loaded, ANNOUNCE_CHANNEL_ID: "222" });
    expect(page.posts).toHaveLength(1);
    const [post] = page.posts;
    expect(post?.path).toBe("/api/env");
    expect(post?.opts.method).toBe("POST");
    expect(post?.opts.body).toBe("ANNOUNCE_CHANNEL_ID=222");
    // issue #53 item 2: the POST now carries a real AbortSignal, not none at all.
    expect(post?.opts.signal).toBeInstanceOf(AbortSignal);
    expect(page.confirms).toHaveLength(1);
    expect(page.confirms[0]).toContain('ANNOUNCE_CHANNEL_ID: "111" → "222"');
    expect(page.confirms[0]).not.toContain("ADMIN_USER_IDS");
    expect(page.msg).toEqual({ textContent: "Saved: ANNOUNCE_CHANNEL_ID", className: "msg ok" });
    expect(page.reloads).toBe(1); // re-baselined, so a second save diffs against the new state
  });

  test("saveEnv with nothing changed posts nothing and says so", async () => {
    const same = { ANNOUNCE_CHANNEL_ID: "111", WOW_REGION: "us" };
    const page = await runSaveEnv(same, { ...same });
    expect(page.posts).toEqual([]);
    expect(page.confirms).toEqual([]);
    expect(page.msg.textContent).toBe("No changes.");
  });

  test("a declined confirm posts nothing", async () => {
    const page = await runSaveEnv({ WOW_REGION: "us" }, { WOW_REGION: "eu" }, { confirm: false });
    expect(page.confirms).toHaveLength(1);
    expect(page.posts).toEqual([]);
    expect(page.reloads).toBe(0);
  });

  test("a rejected save surfaces bot-ops.sh's own message and re-baselines (issue #47)", async () => {
    const page = await runSaveEnv(
      { WOW_REGION: "us" },
      { WOW_REGION: "eu" },
      { response: { ok: false, text: "bot-ops: env-set: value for 'WOW_REGION' is invalid" } },
    );
    expect(page.msg).toEqual({ textContent: "Failed: bot-ops: env-set: value for 'WOW_REGION' is invalid", className: "msg error" });
    // .env may already have been rewritten even though this particular response is plain text
    // (a die() before any rewrite, in this case) — saveEnv can't tell the difference from the
    // response shape alone, so it re-baselines unconditionally on any failure.
    expect(page.reloads).toBe(1);
  });

  test("a failed recreate shows the compose error and backup path, not the raw JSON, and re-baselines (issue #47)", async () => {
    const page = await runSaveEnv(
      { WOW_REALM: "stormrage" },
      { WOW_REALM: "orgrimmar" },
      {
        response: {
          ok: false,
          text: '{"ok":false,"changed":["WOW_REALM"],"backup":"/opt/x/.env.bak.1","log":"compose: image not found"}',
        },
      },
    );
    expect(page.msg.className).toBe("msg error");
    expect(page.msg.textContent).toBe("Failed: compose: image not found\nBackup: /opt/x/.env.bak.1");
    expect(page.reloads).toBe(1);
  });

  test("the body carries only the keys whose value differs, in field order (not alphabetical)", () => {
    // WOW_REGION before ANNOUNCE_CHANNEL_ID: bot-ops.sh's own ALLOWED_ORDER puts WOW_REALM/WOW_REGION
    // ahead of ANNOUNCE_CHANNEL_ID's later cousins, so a real field order is never alphabetical — an
    // Object.keys(...).sort() mutant must fail this, not just happen to match by coincidence.
    const loaded = { WOW_REGION: "us", WOW_REALM: "stormrage", ANNOUNCE_CHANNEL_ID: "111", DISCORD_SERVER_ID: "" };
    const current = { WOW_REGION: "eu", WOW_REALM: "stormrage", ANNOUNCE_CHANNEL_ID: "222", DISCORD_SERVER_ID: "" };
    const plan = planEnvSave(loaded, current);
    expect(plan.body).toBe("WOW_REGION=eu\nANNOUNCE_CHANNEL_ID=222");
    expect(plan.changes).toEqual([
      { key: "WOW_REGION", before: "us", now: "eu" },
      { key: "ANNOUNCE_CHANNEL_ID", before: "111", now: "222" },
    ]);
  });

  test("an untouched field whose stored value the whitelist would reject is never sent", () => {
    // The issue's failure: this value round-trips unchanged, so it must not reach env-set at all.
    const loaded = { ADMIN_USER_IDS: "123456, 234567", ANNOUNCE_CHANNEL_ID: "111" };
    const plan = planEnvSave(loaded, { ...loaded, ANNOUNCE_CHANNEL_ID: "222" });
    expect(plan.body).toBe("ANNOUNCE_CHANNEL_ID=222");
    expect(plan.body).not.toContain("ADMIN_USER_IDS");
  });

  test("a field absent from the loaded env diffs against the empty string", () => {
    expect(planEnvSave({}, { WOW_REGION: "" }).changes).toEqual([]);
    expect(planEnvSave({}, { WOW_REGION: "eu" }).changes).toEqual([{ key: "WOW_REGION", before: "", now: "eu" }]);
  });

  test("clearing a value is a change (an empty value clears the key back to its default)", () => {
    expect(planEnvSave({ BOT_BRANCH: "dev" }, { BOT_BRANCH: "" }).body).toBe("BOT_BRANCH=");
  });

  test("no differences -> empty preview list and empty body", () => {
    const same = { A: "1", B: "" };
    expect(planEnvSave(same, { ...same })).toEqual({ changes: [], body: "" });
  });

  test("the confirm preview and the body name exactly the same keys", () => {
    const plan = planEnvSave({ A: "1", B: "2", C: "3" }, { A: "1", B: "x", C: "y" });
    expect(plan.body.split("\n").map((l) => l.split("=")[0])).toEqual(plan.changes.map((c) => c.key));
  });

  // Blanking a REQUIRED key (issue #45): the panel must refuse to submit before the confirm
  // dialog, not after a failed save — bot-ops.sh's env-set would reject it anyway, but only once
  // the container has already been recreated with the bad value.
  test("blanking a required field is refused before the confirm dialog — nothing is posted", async () => {
    const page = await runSaveEnv({ ANNOUNCE_CHANNEL_ID: "111", WOW_REGION: "us" }, { ANNOUNCE_CHANNEL_ID: "", WOW_REGION: "us" });
    expect(page.confirms).toEqual([]);
    expect(page.posts).toEqual([]);
    expect(page.msg).toEqual({ textContent: "ANNOUNCE_CHANNEL_ID is required and cannot be blank.", className: "msg error" });
    expect(page.reloads).toBe(0);
  });

  test("blanking a required field alongside an unrelated valid change blocks the WHOLE save", async () => {
    const page = await runSaveEnv({ ANNOUNCE_CHANNEL_ID: "111", WOW_REGION: "us" }, { ANNOUNCE_CHANNEL_ID: "", WOW_REGION: "eu" });
    expect(page.posts).toEqual([]); // the WOW_REGION change is not posted either
    expect(page.msg.className).toBe("msg error");
  });
});

describe("admin panel timeoutSignal (issue #53 item 1/2)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const timeoutSignalSrc = indexSrc.match(/\/\/ TIMEOUT_SIGNAL:begin\n([\s\S]*?)\n\s*\/\/ TIMEOUT_SIGNAL:end/)?.[1];
  const makeTimeoutSignal = () =>
    (new Function(`"use strict";\n${timeoutSignalSrc ?? ""}\nreturn timeoutSignal;`)() as (
      ms: number,
    ) => { signal: AbortSignal; cancel: () => void });

  test("is present in the served page", () => {
    expect(timeoutSignalSrc).toContain("function timeoutSignal(");
  });

  test("the signal aborts once ms elapses", async () => {
    const timeoutSignal = makeTimeoutSignal();
    const { signal } = timeoutSignal(10);
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal.aborted).toBe(true);
  });

  test("cancel() before the timeout elapses prevents the abort", async () => {
    const timeoutSignal = makeTimeoutSignal();
    const { signal, cancel } = timeoutSignal(10);
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal.aborted).toBe(false);
  });
});

describe("admin panel doRestart (issue #53 item 2)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const timeoutSignalSrc = indexSrc.match(/\/\/ TIMEOUT_SIGNAL:begin\n([\s\S]*?)\n\s*\/\/ TIMEOUT_SIGNAL:end/)?.[1];
  const restartSrc = indexSrc.match(/\/\/ RESTART:begin\n([\s\S]*?)\n\s*\/\/ RESTART:end/)?.[1];

  interface FakePage {
    posts: { path: string; opts: { method?: string; signal?: AbortSignal } }[];
    confirms: string[];
    msg: { textContent: string; className: string };
    statusLoads: number;
  }
  async function runDoRestart(opts: { confirm?: boolean; response?: { ok: boolean; text: string } } = {}): Promise<FakePage> {
    const page: FakePage = { posts: [], confirms: [], msg: { textContent: "", className: "" }, statusLoads: 0 };
    const document = { getElementById: (id: string) => (id === "restart-msg" ? page.msg : null) };
    const confirm = (text: string): boolean => {
      page.confirms.push(text);
      return opts.confirm ?? true;
    };
    const api = async (path: string, o: { method?: string; signal?: AbortSignal }) => {
      page.posts.push({ path, opts: o });
      const r = opts.response ?? { ok: true, text: "restarted" };
      return { ok: r.ok, text: async () => r.text };
    };
    const doRestart = new Function(
      "document",
      "confirm",
      "api",
      "loadStatus",
      "MUTATION_TIMEOUT_MS",
      `"use strict";\n${timeoutSignalSrc ?? ""}\n${restartSrc ?? ""}\nreturn doRestart;`,
    )(document, confirm, api, () => page.statusLoads++, 110000) as () => Promise<void>;
    await doRestart();
    return page;
  }

  test("is present in the served page", () => {
    expect(restartSrc).toContain("async function doRestart(");
  });

  test("a declined confirm never calls api()", async () => {
    const page = await runDoRestart({ confirm: false });
    expect(page.confirms).toHaveLength(1);
    expect(page.posts).toEqual([]);
  });

  test("a confirmed restart POSTs with a real AbortSignal, and re-loads status on success", async () => {
    const page = await runDoRestart();
    expect(page.posts).toHaveLength(1);
    const [post] = page.posts;
    expect(post?.path).toBe("/api/restart");
    expect(post?.opts.method).toBe("POST");
    // issue #53 item 2: the POST now carries a real AbortSignal, not none at all.
    expect(post?.opts.signal).toBeInstanceOf(AbortSignal);
    expect(post?.opts.signal?.aborted).toBe(false); // never actually timed out in this test
    expect(page.msg).toEqual({ textContent: "restarted", className: "msg ok" });
    expect(page.statusLoads).toBe(1);
  });

  test("a failed restart surfaces the response text as an error", async () => {
    const page = await runDoRestart({ response: { ok: false, text: "compose error" } });
    expect(page.msg).toEqual({ textContent: "Failed: compose error", className: "msg error" });
  });
});

describe("admin panel hasAccessSession (issue #53 item 6: probes via /api/whoami, not /api/status)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const timeoutSignalSrc = indexSrc.match(/\/\/ TIMEOUT_SIGNAL:begin\n([\s\S]*?)\n\s*\/\/ TIMEOUT_SIGNAL:end/)?.[1];
  const hasAccessSessionSrc = indexSrc.match(/\/\/ HAS_ACCESS_SESSION:begin\n([\s\S]*?)\n\s*\/\/ HAS_ACCESS_SESSION:end/)?.[1];

  function run(fetchImpl: (path: string, opts: unknown) => Promise<{ ok: boolean; json: () => Promise<unknown> }>): {
    calls: { path: string; opts: unknown }[];
    hasAccessSession: () => Promise<boolean>;
  } {
    const calls: { path: string; opts: unknown }[] = [];
    const fetch = (path: string, opts: unknown) => {
      calls.push({ path, opts });
      return fetchImpl(path, opts);
    };
    const hasAccessSession = new Function(
      "fetch",
      `"use strict";\n${timeoutSignalSrc ?? ""}\n${hasAccessSessionSrc ?? ""}\nreturn hasAccessSession;`,
    )(fetch) as () => Promise<boolean>;
    return { calls, hasAccessSession };
  }

  test("is present in the served page", () => {
    expect(hasAccessSessionSrc).toContain("async function hasAccessSession(");
  });

  test("probes /api/whoami, not /api/status, with credentials included and a real signal", async () => {
    const { calls, hasAccessSession } = run(async () => ({ ok: true, json: async () => ({ via: "jwt", email: null, claims: null }) }));
    await hasAccessSession();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.path).toBe("/api/whoami");
    const opts = call?.opts as { credentials?: string; signal?: AbortSignal };
    expect(opts.credentials).toBe("include");
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  test("true for a via:jwt whoami response — the only shape this unauthenticated probe can ever get back", async () => {
    const { hasAccessSession } = run(async () => ({ ok: true, json: async () => ({ via: "jwt" }) }));
    expect(await hasAccessSession()).toBe(true);
  });

  // via:"bearer" is not reachable from this call site (no Authorization header is ever sent), so
  // it's deliberately not treated as a pass here either — see the source comment.
  test("false for a via:bearer whoami response, even though the panel itself does authorize that way", async () => {
    const { hasAccessSession } = run(async () => ({ ok: true, json: async () => ({ via: "bearer" }) }));
    expect(await hasAccessSession()).toBe(false);
  });

  test("false for a non-2xx", async () => {
    const { hasAccessSession } = run(async () => ({ ok: false, json: async () => ({ via: "jwt" }) }));
    expect(await hasAccessSession()).toBe(false);
  });

  test("false for a 200 that isn't genuinely our whoami shape", async () => {
    const { hasAccessSession } = run(async () => ({ ok: true, json: async () => ({}) }));
    expect(await hasAccessSession()).toBe(false);
  });

  test("false (not a throw) when fetch itself rejects", async () => {
    const { hasAccessSession } = run(async () => {
      throw new Error("network error");
    });
    expect(await hasAccessSession()).toBe(false);
  });
});

// DMF_TIMEZONE's shape check is hand-duplicated like WOW_REALM's above: ALLOWED[DMF_TIMEZONE] in
// bot-ops.sh and TZ_SHAPE_RE in the panel (which filters the datalist so it never offers a zone the
// server rejects). #69 widened the server side to 3-segment / hyphen / "+" / no-slash zones and the
// panel's filter was left on the old exactly-one-slash shape, silently under-offering — pinned here
// so the two can't drift again. filterTimezones (not just TZ_SHAPE_RE) is lifted and called so a
// filter that stopped applying the regex — or stopped filtering at all — would fail this even
// though the regex string itself still matched bot-ops.sh's.
describe("DMF_TIMEZONE shape (bot-ops.sh ↔ panel datalist filter stay in sync)", () => {
  const botOpsSrc = readFileSync(new URL("../bot-ops.sh", import.meta.url), "utf8");
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const botOpsPattern = botOpsSrc.match(/\[DMF_TIMEZONE\]='([^']+)'/)?.[1];
  const filterSrc = indexSrc.match(/\/\/ TZ_FILTER:begin\n([\s\S]*?)\n\s*\/\/ TZ_FILTER:end/)?.[1];
  const panelPattern = filterSrc?.match(/TZ_SHAPE_RE\s*=\s*new RegExp\("([^"]+)"\)/)?.[1];
  const filterTimezones = (zones: string[]): string[] =>
    (new Function(`"use strict";\n${filterSrc ?? ""}\nreturn filterTimezones;`)() as (z: string[]) => string[])(zones);

  test("both source patterns are present and identical (mirror can't drift)", () => {
    expect(botOpsPattern).toBeDefined();
    expect(panelPattern).toBeDefined();
    expect(panelPattern).toBe(botOpsPattern);
  });

  test("every IANA zone this runtime knows survives filterTimezones, so the datalist offers all of them", () => {
    const zones: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    expect(zones.length).toBeGreaterThan(300); // a runtime with no zone list would make this vacuous
    expect(filterTimezones(zones)).toEqual(zones); // nothing real gets dropped
    const withJunk = [...zones, "Europe/Paris/x/y", "Europe Paris", "a;b", "a$(x)", ""];
    expect(filterTimezones(withJunk)).toEqual(zones); // and the junk actually gets filtered OUT
    expect(filterTimezones(["America/Indiana/Indianapolis", "America/Port-au-Prince", "Etc/GMT+1", "UTC"])).toEqual([
      "America/Indiana/Indianapolis",
      "America/Port-au-Prince",
      "Etc/GMT+1",
      "UTC",
    ]);
  });
});

// Which keys may never be blanked is hand-duplicated like WOW_REALM/DMF_TIMEZONE above: the
// authority is bot-ops.sh's REQUIRED set (env-set refuses an empty value for them, since they have
// no documented default — issue #45), mirrored by REQUIRED_KEYS in the panel so a blank submit is
// refused client-side instead of surfacing only after a failed, restart-triggering save.
describe("REQUIRED keys (bot-ops.sh ↔ panel REQUIRED_KEYS stay in sync)", () => {
  const botOpsSrc = readFileSync(new URL("../bot-ops.sh", import.meta.url), "utf8");
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const requiredBlock = botOpsSrc.match(/declare -A REQUIRED=\(([\s\S]*?)\)/)?.[1] ?? "";
  const botOpsRequired = [...requiredBlock.matchAll(/\[(\w+)\]=1/g)].map((m) => m[1]!).sort();
  const panelRequired = (JSON.parse(indexSrc.match(/REQUIRED_KEYS\s*=\s*(\[[^\]]*\])/)?.[1] ?? "[]") as string[]).sort();

  test("both source lists are present and identical (mirror can't drift)", () => {
    expect(botOpsRequired.length).toBeGreaterThan(0);
    expect(panelRequired).toEqual(botOpsRequired);
  });

  test("every REQUIRED key is itself a whitelisted ALLOWED key", () => {
    for (const key of botOpsRequired) expect(botOpsSrc).toMatch(new RegExp(`\\[${key}\\]='`));
  });
});
