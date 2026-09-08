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
  createPluginIndexLister,
  createRunBotOps,
  DEFAULT_PLUGIN_INDEX_URL,
  describeAction,
  describeActor,
  effectiveAllowlist,
  escapeHtml,
  extractAccessJwt,
  extractBearerToken,
  handleAdmins,
  handleRequest,
  HOST_API_VERSION,
  IDLE_TIMEOUT_SECONDS,
  isAuthorized,
  isCrossSiteWrite,
  isEmailAllowed,
  logDynamicAdminsStartup,
  mergePluginsView,
  ADMIN_API_VERSION,
  ADMIN_ASSET_HOST,
  ADMIN_ASSET_MAX_BYTES,
  resolveAdminBundleUrl,
  resolvePluginProxyUrl,
  serveAdminBundle,
  servePluginProxy,
  makeAdminAssetFetcher,
  normalizeAdminEmail,
  normalizeTeamDomain,
  parseAllowedEmails,
  parseChangedKeys,
  parseEnvValue,
  parsePluginIndex,
  parsePluginRequestInput,
  readDynamicAdmins,
  resolveAdminsFile,
  resolveAdminStorePaths,
  renderIndexHtml,
  SUBPROCESS_TIMEOUT_MS,
  tokensMatch,
  type AdminStore,
  type Authorization,
  type BotOpsInvocation,
  type BotOpsResult,
  type AdminAssetResult,
  type HandlerConfig,
  type PluginIndex,
  type PluginsView,
  type PluginStatusEntry,
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
// Issue #60 item 4 named TWO sites that accepted a relative BOT_OPS_CONFIG_DIR: ops/bot-ops.sh
// (fixed by the guard loop there) and this one, which builds the admins.json path. This is the
// panel process reading the variable itself — separate from, and not covered by, createRunBotOps
// spawning bot-ops.sh, which inherits process.env and so gets the script's own guard.
describe("resolveAdminsFile rejects a relative BOT_OPS_CONFIG_DIR (issue #60 item 4)", () => {
  test("an absolute config dir yields the admins.json path beside .env", () => {
    expect(resolveAdminsFile("/opt/rackbops-discord-bot/debug")).toBe("/opt/rackbops-discord-bot/debug/admins.json");
  });

  test("surrounding whitespace is trimmed before the check, not after", () => {
    expect(resolveAdminsFile("  /opt/bot  ")).toBe("/opt/bot/admins.json");
  });

  for (const relative of [".", "./config", "config", "../bot", "opt/bot"]) {
    test(`a relative dir (${relative}) throws, naming the variable and the value`, () => {
      // The whole quoted phrase, not the value alone: for "." a bare toThrow(value) matches almost
      // any message, including this one's own trailing sentence.
      expect(() => resolveAdminsFile(relative)).toThrow(`BOT_OPS_CONFIG_DIR must be an absolute path, got "${relative}"`);
    });
  }

  // A Windows-shaped path is relative on the Linux container the panel actually runs in, so it
  // must be rejected here even though node:path's isAbsolute would accept it on this dev box.
  test("a Windows-absolute path is still rejected — the panel is Linux-only", () => {
    expect(() => resolveAdminsFile("C:\\opt\\bot")).toThrow("must be an absolute path");
  });

  // Unset stays the supported degraded mode: bootstrap-only, no persistence. It must NOT throw,
  // or a panel with no config dir at all would stop starting.
  for (const [label, value] of [
    ["unset", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ] as const) {
    test(`${label} is undefined, not a throw — bootstrap-only is still supported`, () => {
      expect(resolveAdminsFile(value)).toBeUndefined();
    });
  }
});

// The consumer boundary for the guard above. Round 2 of the review gate showed that reverting the
// entry point's two wiring statements to their pre-guard shape left all 919 tests green — the fix
// was pinned, its *use* was not, which is the "break lives between changed and unchanged code"
// failure mode. resolveAdminStorePaths makes the pairing testable; the source scan below pins that
// the entry point actually calls it, since nothing can execute `import.meta.main` from a test.
describe("resolveAdminStorePaths keeps configDir and adminsFile in agreement", () => {
  test("both defined, sharing a base, when the value is absolute", () => {
    expect(resolveAdminStorePaths({ BOT_OPS_CONFIG_DIR: "/opt/bot" })).toEqual({
      configDir: "/opt/bot",
      adminsFile: "/opt/bot/admins.json",
    });
  });

  test("both undefined when unset — never one without the other", () => {
    expect(resolveAdminStorePaths({})).toEqual({ configDir: undefined, adminsFile: undefined });
  });

  test("configDir is the trimmed value, so statSync and the .env reads see what adminsFile is built from", () => {
    const { configDir, adminsFile } = resolveAdminStorePaths({ BOT_OPS_CONFIG_DIR: "  /opt/bot  " });
    expect(configDir).toBe("/opt/bot");
    expect(adminsFile).toBe("/opt/bot/admins.json");
    expect(adminsFile!.startsWith(configDir!)).toBe(true);
  });

  test("a relative value throws rather than returning a half-resolved pair", () => {
    expect(() => resolveAdminStorePaths({ BOT_OPS_CONFIG_DIR: "./config" })).toThrow("must be an absolute path");
  });
});

test("the panel entry point resolves its paths through the guard, not from raw env", () => {
  const serverSrc = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const marker = "if (import.meta.main) {";
  const entry = serverSrc.slice(serverSrc.indexOf(marker));
  expect(entry).toContain(marker); // the block still exists; guards against a silent no-op scan
  expect(entry).toContain("resolveAdminStorePaths(process.env)");
  // The exact pre-guard shape, which must not come back. Scoped to the entry block so the
  // definitions above (which legitimately mention both) can't satisfy it.
  expect(entry).not.toMatch(/process\.env\.BOT_OPS_CONFIG_DIR\?\.trim\(\)/);
  expect(entry).not.toMatch(/\$\{configDir\}\/admins\.json/);
});

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
    expect(parseChangedKeys('{"changed":["BOT_BRANCH","REPORT_ROLE_ID"]}')).toEqual(["BOT_BRANCH", "REPORT_ROLE_ID"]);
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
      stdout: '{"ok":false,"changed":["REPORT_ROLE_ID"],"backup":"/opt/x/.env.bak.1","log":"compose: image not found"}',
      stderr: "",
    };
    expect(auditLogLine(okEnvSet, result, auth)).toBe(
      "[admin] env-set (changed: REPORT_ROLE_ID) — recreate FAILED by the ADMIN_TOKEN bearer token",
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

  // /api/plugins gathers PLUGINS + installed state via bot-ops.sh (env-get + status) and the index
  // via the injected lister, then returns mergePluginsView. runBotOps is called twice with different
  // args, so the fake dispatches on the subcommand.
  const pluginsBotOps = (statusStdout: string, envStdout: string) => async (inv: BotOpsInvocation): Promise<BotOpsResult> => {
    if (inv.args[0] === "status") return { exitCode: 0, stdout: statusStdout, stderr: "" };
    if (inv.args[0] === "env-get") return { exitCode: 0, stdout: envStdout, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const sampleIndex: PluginIndex = {
    schemaVersion: 1,
    plugins: [
      { name: "warbandeer", version: "1.0.0", description: "Warband tools", releases: [{ version: "1.0.0", publishedAt: "2026-01-01", url: "u", notes: "n" }] },
      { name: "raidhelper", version: "2.0.0", description: "Raid helper" },
    ],
  };

  test("/api/plugins merges the index, installed state, and PLUGINS into the view", async () => {
    const status = JSON.stringify({ plugins: [{ name: "warbandeer", enabled: true, installedVersion: "1.0.0", configured: true, missingEnv: [], active: true }] });
    const res = await handleRequest(
      authed("/api/plugins"),
      branchCfg({ runBotOps: pluginsBotOps(status, JSON.stringify({ PLUGINS: "warbandeer" })), listPluginIndex: async () => sampleIndex }),
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as PluginsView;
    expect(view.indexError).toBeUndefined();
    expect(view.pluginsValue).toBe("warbandeer");
    expect(view.plugins.map((p) => p.name)).toEqual(["warbandeer", "raidhelper"]);
    const wb = view.plugins.find((p) => p.name === "warbandeer");
    expect(wb).toMatchObject({ enabled: true, installedVersion: "1.0.0", active: true, inIndex: true, latestVersion: "1.0.0" });
    const rh = view.plugins.find((p) => p.name === "raidhelper")!;
    expect(rh).toMatchObject({ enabled: false, active: false, inIndex: true, latestVersion: "2.0.0" });
    expect(rh.installedVersion).toBeUndefined();
  });

  test("/api/plugins degrades to a 200 with indexError (not a 502) when the index can't be loaded", async () => {
    const status = JSON.stringify({ plugins: [{ name: "warbandeer", enabled: true, installedVersion: "1.0.0", configured: true, missingEnv: [], active: true }] });
    const res = await handleRequest(
      authed("/api/plugins"),
      branchCfg({ runBotOps: pluginsBotOps(status, JSON.stringify({ PLUGINS: "warbandeer" })), listPluginIndex: async () => null }),
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as PluginsView;
    expect(view.indexError).toBeTruthy();
    // Still lists the installed plugin (state-only) so the panel renders what's installed.
    expect(view.plugins.map((p) => p.name)).toEqual(["warbandeer"]);
    expect(view.plugins[0]).toMatchObject({ enabled: true, inIndex: false, installedVersion: "1.0.0" });
  });

  test("/api/plugins with no index lister configured returns 200 + indexError, state only", async () => {
    const status = JSON.stringify({ plugins: [{ name: "warbandeer", installedVersion: "1.0.0", active: true }] });
    const res = await handleRequest(authed("/api/plugins"), branchCfg({ runBotOps: pluginsBotOps(status, JSON.stringify({ PLUGINS: "warbandeer" })) }));
    expect(res.status).toBe(200);
    const view = (await res.json()) as PluginsView;
    expect(view.indexError).toBeTruthy();
    expect(view.plugins.map((p) => p.name)).toEqual(["warbandeer"]);
  });

  test("/api/plugins tolerates a malformed status/env payload (non-array plugins, non-string PLUGINS)", async () => {
    const res = await handleRequest(
      authed("/api/plugins"),
      branchCfg({ runBotOps: pluginsBotOps(JSON.stringify({ plugins: "oops" }), JSON.stringify({ PLUGINS: 5 })), listPluginIndex: async () => sampleIndex }),
    );
    expect(res.status).toBe(200);
    const view = (await res.json()) as PluginsView;
    expect(view.pluginsValue).toBe(""); // a non-string PLUGINS coerces to empty, no crash
    expect(view.plugins.map((p) => p.name)).toEqual(["warbandeer", "raidhelper"]); // index-only, none enabled
    expect(view.plugins.every((p) => !p.enabled)).toBe(true);
  });

  test("/api/plugins surfaces a stateError (not a silent empty view) when env-get fails", async () => {
    // A failed env-get returns empty stdout; without the exit-code check the route would report a
    // false-empty PLUGINS baseline and the panel would let a Save wipe the real selection.
    const failingBotOps = async (inv: BotOpsInvocation): Promise<BotOpsResult> =>
      inv.args[0] === "env-get"
        ? { exitCode: 1, stdout: "", stderr: "bot-ops: cannot read .env" }
        : { exitCode: 0, stdout: JSON.stringify({ plugins: [{ name: "warbandeer", installedVersion: "1.0.0", active: true }] }), stderr: "" };
    const res = await handleRequest(authed("/api/plugins"), branchCfg({ runBotOps: failingBotOps, listPluginIndex: async () => sampleIndex }));
    expect(res.status).toBe(200);
    const view = (await res.json()) as PluginsView;
    expect(view.stateError).toBeTruthy();
  });

  test("/api/plugins surfaces a stateError when status fails too", async () => {
    const failingStatus = async (inv: BotOpsInvocation): Promise<BotOpsResult> =>
      inv.args[0] === "status"
        ? { exitCode: 1, stdout: "", stderr: "docker unreachable" }
        : { exitCode: 0, stdout: JSON.stringify({ PLUGINS: "warbandeer" }), stderr: "" };
    const res = await handleRequest(authed("/api/plugins"), branchCfg({ runBotOps: failingStatus, listPluginIndex: async () => sampleIndex }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as PluginsView).stateError).toBeTruthy();
  });

  test("/api/plugins leaves stateError unset when both reads succeed", async () => {
    const res = await handleRequest(
      authed("/api/plugins"),
      branchCfg({ runBotOps: pluginsBotOps(JSON.stringify({ plugins: [] }), JSON.stringify({ PLUGINS: "" })), listPluginIndex: async () => sampleIndex }),
    );
    expect(((await res.json()) as PluginsView).stateError).toBeUndefined();
  });

  test("/api/plugins requires auth (no token -> 401, never shells out or fetches the index)", async () => {
    let botOpsCalled = false;
    let indexCalled = false;
    const res = await handleRequest(new Request("http://x/api/plugins"), branchCfg({
      runBotOps: async () => { botOpsCalled = true; return { exitCode: 0, stdout: "{}", stderr: "" }; },
      listPluginIndex: async () => { indexCalled = true; return sampleIndex; },
    }));
    expect(res.status).toBe(401);
    expect(botOpsCalled).toBe(false);
    expect(indexCalled).toBe(false);
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
    const stdout = '{"ok":false,"changed":["REPORT_ROLE_ID"],"backup":"/opt/x/.env.bak.1","log":"compose: image not found"}';
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
          body: "REPORT_ROLE_ID=stormrage",
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
        "[admin] env-set (changed: REPORT_ROLE_ID) — recreate FAILED by the ADMIN_TOKEN bearer token",
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
    const loaded = { DISCORD_SERVER_ID: "", ANNOUNCE_CHANNEL_ID: "111", ADMIN_USER_IDS: "123456, 234567", REPORT_ROLE_ID: "stormrage" };
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
    const same = { ANNOUNCE_CHANNEL_ID: "111", WATCHED_REPOS: "us" };
    const page = await runSaveEnv(same, { ...same });
    expect(page.posts).toEqual([]);
    expect(page.confirms).toEqual([]);
    expect(page.msg.textContent).toBe("No changes.");
  });

  test("a declined confirm posts nothing", async () => {
    const page = await runSaveEnv({ WATCHED_REPOS: "us" }, { WATCHED_REPOS: "eu" }, { confirm: false });
    expect(page.confirms).toHaveLength(1);
    expect(page.posts).toEqual([]);
    expect(page.reloads).toBe(0);
  });

  test("a rejected save surfaces bot-ops.sh's own message and re-baselines (issue #47)", async () => {
    const page = await runSaveEnv(
      { WATCHED_REPOS: "us" },
      { WATCHED_REPOS: "eu" },
      { response: { ok: false, text: "bot-ops: env-set: value for 'WATCHED_REPOS' is invalid" } },
    );
    expect(page.msg).toEqual({ textContent: "Failed: bot-ops: env-set: value for 'WATCHED_REPOS' is invalid", className: "msg error" });
    // .env may already have been rewritten even though this particular response is plain text
    // (a die() before any rewrite, in this case) — saveEnv can't tell the difference from the
    // response shape alone, so it re-baselines unconditionally on any failure.
    expect(page.reloads).toBe(1);
  });

  test("a failed recreate shows the compose error and backup path, not the raw JSON, and re-baselines (issue #47)", async () => {
    const page = await runSaveEnv(
      { REPORT_ROLE_ID: "stormrage" },
      { REPORT_ROLE_ID: "orgrimmar" },
      {
        response: {
          ok: false,
          text: '{"ok":false,"changed":["REPORT_ROLE_ID"],"backup":"/opt/x/.env.bak.1","log":"compose: image not found"}',
        },
      },
    );
    expect(page.msg.className).toBe("msg error");
    expect(page.msg.textContent).toBe("Failed: compose: image not found\nBackup: /opt/x/.env.bak.1");
    expect(page.reloads).toBe(1);
  });

  test("the body carries only the keys whose value differs, in field order (not alphabetical)", () => {
    // WATCHED_REPOS first though it sorts AFTER ANNOUNCE_CHANNEL_ID: the body must preserve the loaded
    // field order (env-get emits keys in bot-ops.sh's ALLOWED_ORDER, and the panel keeps that order),
    // never re-sort — an Object.keys(...).sort() mutant would put ANNOUNCE_CHANNEL_ID first and fail here.
    const loaded = { WATCHED_REPOS: "acme/one", ANNOUNCE_CHANNEL_ID: "111", DISCORD_SERVER_ID: "" };
    const current = { WATCHED_REPOS: "acme/two", ANNOUNCE_CHANNEL_ID: "222", DISCORD_SERVER_ID: "" };
    const plan = planEnvSave(loaded, current);
    expect(plan.body).toBe("WATCHED_REPOS=acme/two\nANNOUNCE_CHANNEL_ID=222");
    expect(plan.changes).toEqual([
      { key: "WATCHED_REPOS", before: "acme/one", now: "acme/two" },
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
    expect(planEnvSave({}, { WATCHED_REPOS: "" }).changes).toEqual([]);
    expect(planEnvSave({}, { WATCHED_REPOS: "eu" }).changes).toEqual([{ key: "WATCHED_REPOS", before: "", now: "eu" }]);
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
    const page = await runSaveEnv({ ANNOUNCE_CHANNEL_ID: "111", WATCHED_REPOS: "us" }, { ANNOUNCE_CHANNEL_ID: "", WATCHED_REPOS: "us" });
    expect(page.confirms).toEqual([]);
    expect(page.posts).toEqual([]);
    expect(page.msg).toEqual({ textContent: "ANNOUNCE_CHANNEL_ID is required and cannot be blank.", className: "msg error" });
    expect(page.reloads).toBe(0);
  });

  test("blanking a required field alongside an unrelated valid change blocks the WHOLE save", async () => {
    const page = await runSaveEnv({ ANNOUNCE_CHANNEL_ID: "111", WATCHED_REPOS: "us" }, { ANNOUNCE_CHANNEL_ID: "", WATCHED_REPOS: "eu" });
    expect(page.posts).toEqual([]); // the WATCHED_REPOS change is not posted either
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

// Which keys may never be blanked is a bot-ops.sh ↔ panel mirror like the others above: the
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

// BOT_BRANCH and AUTO_UPDATE are two more bot-ops.sh ↔ panel mirrors like REQUIRED_KEYS above:
// bot-ops.sh's ALLOWED regex is the authority (env-set's format check), and the panel hardcodes
// its own copy for client-side validation/options — nothing pins the two together, so either side
// can drift silently.
describe("BOT_BRANCH / AUTO_UPDATE (panel ↔ bot-ops.sh mirrors)", () => {
  const botOpsSrc = readFileSync(new URL("../bot-ops.sh", import.meta.url), "utf8");
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

  test("BOT_BRANCH: panel's BRANCH_NAME_RE matches bot-ops.sh's ALLOWED regex", () => {
    const botOpsBranchRe = botOpsSrc.match(/\[BOT_BRANCH\]='([^']*)'/)?.[1];
    // Greedy: defensive against a future BRANCH_NAME_RE whose character class embeds a literal
    // "/;" — today's `/` is followed by `-`, so lazy would happen to land here too.
    const panelBranchRe = indexSrc.match(/const BRANCH_NAME_RE = \/(.+)\/;/)?.[1];
    expect(botOpsBranchRe).toBeTruthy();
    expect(panelBranchRe).toBe(botOpsBranchRe);
  });

  test("AUTO_UPDATE: panel's select options match bot-ops.sh's ALLOWED alternation", () => {
    const botOpsAlternation = botOpsSrc.match(/\[AUTO_UPDATE\]='\^\(([^)]+)\)\$'/)?.[1];
    const botOpsOptions = (botOpsAlternation ?? "").split("|").sort();
    const panelOptionsSrc = indexSrc.match(/AUTO_UPDATE:\s*\{[^}]*options:\s*(\[[^\]]*\])/)?.[1];
    const panelOptions = (JSON.parse(panelOptionsSrc ?? "[]") as string[]).sort();
    expect(botOpsOptions.length).toBeGreaterThan(0);
    expect(panelOptions).toEqual(botOpsOptions);
  });
});

describe("parsePluginIndex (#102)", () => {
  test("parses a valid raw index (top-level .plugins)", () => {
    const idx = parsePluginIndex(JSON.stringify({ schemaVersion: 1, plugins: [{ name: "a", version: "1.0.0" }] }));
    expect(idx?.plugins[0]?.name).toBe("a");
  });
  test("null on bad JSON", () => {
    expect(parsePluginIndex("not json")).toBeNull();
  });
  test("null on a wrong schemaVersion", () => {
    expect(parsePluginIndex(JSON.stringify({ schemaVersion: 2, plugins: [] }))).toBeNull();
  });
  test("null when plugins isn't an array", () => {
    expect(parsePluginIndex(JSON.stringify({ schemaVersion: 1, plugins: {} }))).toBeNull();
  });
  test("null when an entry is missing name or version", () => {
    expect(parsePluginIndex(JSON.stringify({ schemaVersion: 1, plugins: [{ name: "a" }] }))).toBeNull();
  });
});

// The panel duck-types its way around importing src/ (config.ts type-imports discord.js), so its
// default index URL is a hand copy of config.ts's `pluginIndexUrl` default. This pins the two
// together mechanically — the same "stale hardcoded default behind a redirect" class as #113/#115,
// caught here instead of on a user's box: if config.ts's default changes, this test fails.
describe("DEFAULT_PLUGIN_INDEX_URL mirrors src/config.ts (#102, can't drift like #113/#115)", () => {
  test("matches the bot's compiled pluginIndexUrl default", () => {
    const configSrc = readFileSync(new URL("../../src/config.ts", import.meta.url), "utf8");
    const botDefault = configSrc.match(/optional\("PLUGIN_INDEX_URL"\)\s*\?\?\s*"([^"]+)"/)?.[1];
    expect(botDefault).toBeTruthy();
    expect(DEFAULT_PLUGIN_INDEX_URL).toBe(botDefault!);
  });
});

// The panel's HOST_API_VERSION is a hand copy of contract.ts's, used only to decide which updates to
// flag as "needs a newer bot" — the bot itself is the real compatibility enforcer. Pin the two
// together mechanically (the same drift class as the index-URL mirror): if the bot bumps its host
// API, this fails here rather than the panel silently mislabelling a compatible update.
describe("HOST_API_VERSION mirrors src/plugins/contract.ts (#105, can't drift)", () => {
  test("matches the bot's HOST_API_VERSION", () => {
    const contractSrc = readFileSync(new URL("../../src/plugins/contract.ts", import.meta.url), "utf8");
    const botVersion = contractSrc.match(/export const HOST_API_VERSION = (\d+)/)?.[1];
    expect(botVersion).toBeTruthy();
    expect(HOST_API_VERSION).toBe(Number(botVersion));
  });
});

describe("createPluginIndexLister (#102)", () => {
  const validText = JSON.stringify({ schemaVersion: 1, plugins: [{ name: "warbandeer", version: "1.0.0" }] });
  const otherText = JSON.stringify({ schemaVersion: 1, plugins: [{ name: "raidhelper", version: "2.0.0" }] });

  test("reads PLUGIN_INDEX_URL from .env on demand, fetches, and parses", async () => {
    const fetched: string[] = [];
    const lister = createPluginIndexLister({
      readEnvText: async () => "PLUGIN_INDEX_URL=https://a/index.json\n",
      fetchIndexText: async (url) => { fetched.push(url); return validText; },
      defaultUrl: "https://default/index.json",
    });
    const idx = await lister();
    expect(idx?.plugins[0]?.name).toBe("warbandeer");
    expect(fetched).toEqual(["https://a/index.json"]);
  });

  test("falls back to the default URL when .env leaves PLUGIN_INDEX_URL unset", async () => {
    const fetched: string[] = [];
    const lister = createPluginIndexLister({
      readEnvText: async () => "OTHER=1\n",
      fetchIndexText: async (url) => { fetched.push(url); return validText; },
      defaultUrl: "https://default/index.json",
    });
    await lister();
    expect(fetched).toEqual(["https://default/index.json"]);
  });

  test("serves the cache within the TTL (no second fetch), then refetches after it expires", async () => {
    let clock = 1000;
    const fetched: string[] = [];
    const lister = createPluginIndexLister({
      readEnvText: async () => "PLUGIN_INDEX_URL=https://a/index.json\n",
      fetchIndexText: async (url) => { fetched.push(url); return validText; },
      defaultUrl: "https://default/index.json",
      now: () => clock,
      ttlMs: 1000,
    });
    await lister();
    clock = 1500; // within TTL
    await lister();
    expect(fetched).toHaveLength(1); // cache hit, no refetch
    clock = 2600; // past TTL
    await lister();
    expect(fetched).toHaveLength(2); // refetched
  });

  test("a changed PLUGIN_INDEX_URL is picked up immediately (cache is keyed on the URL, not just time)", async () => {
    let envUrl = "https://a/index.json";
    const fetched: string[] = [];
    const lister = createPluginIndexLister({
      readEnvText: async () => `PLUGIN_INDEX_URL=${envUrl}\n`,
      fetchIndexText: async (url) => { fetched.push(url); return url.includes("/a/") ? validText : otherText; },
      defaultUrl: "https://default/index.json",
      now: () => 1000, // time frozen: only a URL change can bust the cache
      ttlMs: 60000,
    });
    expect((await lister())?.plugins[0]?.name).toBe("warbandeer");
    envUrl = "https://b/index.json"; // operator edited .env
    const second = await lister();
    expect(second?.plugins[0]?.name).toBe("raidhelper");
    expect(fetched).toEqual(["https://a/index.json", "https://b/index.json"]);
  });

  test("a fetch failure resolves null (route then reports indexError)", async () => {
    const lister = createPluginIndexLister({
      readEnvText: async () => "PLUGIN_INDEX_URL=https://a/index.json\n",
      fetchIndexText: async () => { throw new Error("timed out"); },
      defaultUrl: "https://default/index.json",
    });
    expect(await lister()).toBeNull();
  });

  test("a bad-shape index resolves null (never a partial/garbage index)", async () => {
    const lister = createPluginIndexLister({
      readEnvText: async () => "PLUGIN_INDEX_URL=https://a/index.json\n",
      fetchIndexText: async () => JSON.stringify({ schemaVersion: 2, plugins: [] }),
      defaultUrl: "https://default/index.json",
    });
    expect(await lister()).toBeNull();
  });
});

describe("mergePluginsView (#102)", () => {
  const index: PluginIndex = {
    schemaVersion: 1,
    plugins: [
      {
        name: "warbandeer",
        version: "1.1.0",
        description: "d",
        releases: [
          { version: "1.1.0", publishedAt: "2026-02-01", url: "u", notes: "n2" },
          { version: "1.0.0", publishedAt: "2026-01-01", url: "u", notes: "n1" },
        ],
      },
      { name: "raidhelper", version: "2.0.0", description: "r" },
    ],
  };
  const status: PluginStatusEntry[] = [
    { name: "warbandeer", enabled: true, installedVersion: "1.0.0", configured: true, missingEnv: [], active: true },
  ];

  test("merges index + status + PLUGINS; enabled comes from PLUGINS, pin ignored for matching", () => {
    const view = mergePluginsView(index, status, "warbandeer@1.0.0");
    expect(view.pluginsValue).toBe("warbandeer@1.0.0");
    expect(view.indexError).toBeUndefined();
    const wb = view.plugins.find((p) => p.name === "warbandeer")!;
    expect(wb).toMatchObject({ enabled: true, installedVersion: "1.0.0", latestVersion: "1.1.0", active: true, inIndex: true, configured: true });
    const rh = view.plugins.find((p) => p.name === "raidhelper")!;
    expect(rh).toMatchObject({ enabled: false, inIndex: true, latestVersion: "2.0.0" });
    expect(rh.installedVersion).toBeUndefined();
  });

  test("passes through configured / missingEnv / error from status (the state-badge inputs)", () => {
    const st: PluginStatusEntry[] = [
      { name: "warbandeer", enabled: true, installedVersion: "1.0.0", configured: false, missingEnv: ["WB_TOKEN", "WB_CHANNEL"], active: false, error: "boot failed: bad token" },
    ];
    const wb = mergePluginsView(index, st, "warbandeer").plugins.find((p) => p.name === "warbandeer")!;
    expect(wb.configured).toBe(false);
    expect(wb.missingEnv).toEqual(["WB_TOKEN", "WB_CHANNEL"]);
    expect(wb.error).toBe("boot failed: bad token");
    // and the defaults when status omits them (raidhelper has no status entry)
    const rh = mergePluginsView(index, st, "warbandeer").plugins.find((p) => p.name === "raidhelper")!;
    expect(rh.configured).toBe(false);
    expect(rh.missingEnv).toEqual([]);
    expect(rh.error).toBeUndefined();
  });

  test("de-duplicates a repeated name (malformed manifest) into a single row", () => {
    const dupIndex: PluginIndex = {
      schemaVersion: 1,
      plugins: [
        { name: "warbandeer", version: "1.0.0" },
        { name: "warbandeer", version: "9.9.9" },
      ],
    };
    const names = mergePluginsView(dupIndex, [], "").plugins.map((p) => p.name);
    expect(names).toEqual(["warbandeer"]);
  });

  test("releases are only those newer than the installed version (latest-first prefix)", () => {
    const wb = mergePluginsView(index, status, "warbandeer").plugins.find((p) => p.name === "warbandeer")!;
    expect(wb.releases.map((r) => r.version)).toEqual(["1.1.0"]);
  });

  test("an installed plugin absent from the index is still listed, inIndex:false", () => {
    const view = mergePluginsView(index, [{ name: "legacy", installedVersion: "0.9.0", active: false }], "");
    const legacy = view.plugins.find((p) => p.name === "legacy")!;
    expect(legacy.inIndex).toBe(false);
    expect(legacy.installedVersion).toBe("0.9.0");
    expect(legacy.enabled).toBe(false);
  });

  test("a PLUGINS-only plugin (unknown to index and status) still appears, enabled", () => {
    const ghost = mergePluginsView(index, [], "warbandeer,ghost").plugins.find((p) => p.name === "ghost")!;
    expect(ghost).toMatchObject({ enabled: true, inIndex: false });
  });

  test("index === null yields indexError plus state-only entries", () => {
    const view = mergePluginsView(null, status, "warbandeer");
    expect(view.indexError).toBeTruthy();
    expect(view.plugins.map((p) => p.name)).toEqual(["warbandeer"]);
    expect(view.plugins[0]!.inIndex).toBe(false);
    expect(view.pluginsValue).toBe("warbandeer");
  });
});

// #124 — the admin-tab delivery surface: the merge's admin passthrough, the pure URL resolvers
// (allowlist + traversal gate), and the two delivery routes over a fake fetcher.
describe("mergePluginsView surfaces #124 admin fields", () => {
  const idx = (over: Partial<PluginIndex["plugins"][number]> = {}): PluginIndex => ({
    schemaVersion: 1,
    plugins: [{ name: "warbandeer", version: "1.1.0", description: "d", ...over }],
  });

  test("top-level adminApiVersion is the panel's ADMIN_API_VERSION (index present OR null)", () => {
    expect(mergePluginsView(idx(), [], "warbandeer").adminApiVersion).toBe(ADMIN_API_VERSION);
    expect(mergePluginsView(null, [], "").adminApiVersion).toBe(ADMIN_API_VERSION);
  });

  test("carries adminUrl + adminApiVersion + envKeys from the manifest entry", () => {
    const wb = mergePluginsView(
      idx({
        adminUrl: "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js",
        adminApiVersion: 1,
        env: [{ key: "WARBANDEER_INGEST_PORT", secret: false }, { key: "WB_SECRET", secret: true }],
      }),
      [],
      "warbandeer",
    ).plugins[0]!;
    // Dropping any of these passthroughs (the mutation) means the panel can't render/mount the tab.
    expect(wb.adminUrl).toBe("https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js");
    expect(wb.adminApiVersion).toBe(1);
    expect(wb.envKeys).toEqual(["WARBANDEER_INGEST_PORT", "WB_SECRET"]);
  });

  test("a plugin with no admin bundle omits adminUrl/adminApiVersion and has empty envKeys", () => {
    const wb = mergePluginsView(idx(), [], "warbandeer").plugins[0]!;
    expect("adminUrl" in wb).toBe(false);
    expect("adminApiVersion" in wb).toBe(false);
    expect(wb.envKeys).toEqual([]);
  });

  test("a malformed env array element is dropped rather than crashing the merge", () => {
    const malformed = {
      schemaVersion: 1,
      plugins: [{ name: "warbandeer", version: "1.1.0", env: [{ key: "OK" }, null, { notKey: "x" }, { key: 5 }] }],
    } as unknown as PluginIndex;
    expect(mergePluginsView(malformed, [], "warbandeer").plugins[0]!.envKeys).toEqual(["OK"]);
  });
});

describe("resolveAdminBundleUrl (#124 allowlist + https + version gate)", () => {
  const entry = (over: Partial<PluginIndex["plugins"][number]> = {}): PluginIndex => ({
    schemaVersion: 1,
    plugins: [{ name: "warbandeer", version: "1.0.0", adminApiVersion: ADMIN_API_VERSION, ...over }],
  });
  const withAdmin = (adminUrl: string) => entry({ adminUrl });

  test("returns the URL for an allowlisted https host + matching adminApiVersion", () => {
    const u = "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.0.0/dist/admin.js";
    expect(resolveAdminBundleUrl(withAdmin(u), "warbandeer")).toBe(u);
  });
  test("null when the host is not allowlisted — incl. @-userinfo and subdomain-suffix tricks", () => {
    // Mutation: dropping the host check lets the panel fetch an attacker-chosen origin.
    expect(resolveAdminBundleUrl(withAdmin("https://evil.example.com/admin.js"), "warbandeer")).toBeNull();
    expect(resolveAdminBundleUrl(withAdmin("https://cdn.jsdelivr.net@evil.example.com/x.js"), "warbandeer")).toBeNull();
    expect(resolveAdminBundleUrl(withAdmin("https://cdn.jsdelivr.net.evil.example.com/x.js"), "warbandeer")).toBeNull();
  });
  test("null for a non-https scheme even on the allowlisted host", () => {
    // Mutation: dropping the https pin serves plugin code over http.
    expect(resolveAdminBundleUrl(withAdmin("http://cdn.jsdelivr.net/x.js"), "warbandeer")).toBeNull();
  });
  test("null when adminApiVersion doesn't match the panel's (server-side version gate)", () => {
    const u = "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.0.0/dist/admin.js";
    // Mutation: dropping the version gate serves/mounts an incompatible bundle.
    expect(resolveAdminBundleUrl(entry({ adminUrl: u, adminApiVersion: ADMIN_API_VERSION + 1 }), "warbandeer")).toBeNull();
    expect(resolveAdminBundleUrl(entry({ adminUrl: u }), "warbandeer")).toBe(u); // matching version → served
  });
  test("null when the plugin has no adminUrl, isn't in the index, or the index is null", () => {
    expect(resolveAdminBundleUrl(entry(), "warbandeer")).toBeNull();
    expect(resolveAdminBundleUrl(withAdmin("https://cdn.jsdelivr.net/x.js"), "nope")).toBeNull();
    expect(resolveAdminBundleUrl(null, "warbandeer")).toBeNull();
  });
  test("the host allowlist + size cap are the expected constants", () => {
    expect(ADMIN_ASSET_HOST).toBe("cdn.jsdelivr.net");
    expect(ADMIN_ASSET_MAX_BYTES).toBe(512 * 1024);
  });
});

describe("resolvePluginProxyUrl (#124 traversal/SSRF gate)", () => {
  const idx: PluginIndex = {
    schemaVersion: 1,
    plugins: [{ name: "wow", version: "1.2.3", package: "@rackbops/plugin-wow" }],
  };
  test("resolves a safe relative path inside the plugin's own package", () => {
    expect(resolvePluginProxyUrl(idx, "wow", "dist/realms.json")).toBe(
      "https://cdn.jsdelivr.net/npm/@rackbops/plugin-wow@1.2.3/dist/realms.json",
    );
  });
  test.each([
    ["a scheme", "https://evil.example.com/x"],
    ["a data URL", "data:text/js,alert(1)"],
    ["a leading slash", "/etc/passwd"],
    ["a backslash", "dist\\..\\secret"],
    ["a .. segment", "dist/../../secret"],
    ["a . segment", "dist/./x"],
    ["an empty path", ""],
    ["a trailing-slash empty segment", "dist/"],
    // Percent-encoded traversal: the URL parser inside fetch normalizes %2e%2e -> .. and escapes the
    // package prefix (even into jsDelivr's /gh/ endpoint). The `%` reject + prefix assertion catch it.
    ["a percent-encoded .. (lowercase)", "%2e%2e/secret"],
    ["a percent-encoded .. (uppercase)", "%2E%2E/secret"],
    ["a mixed encoded dot", ".%2e/secret"],
    ["a percent-encoded slash", "dist%2f..%2fsecret"],
    ["a deep encoded escape to /gh/", "%2e%2e/%2e%2e/%2e%2e/gh/o/r@main/e.js"],
    // Control chars (tab/newline) are STRIPPED by the URL parser, so `..\t`/`..\n` become `..` AFTER the
    // literal-segment check and escape the package prefix. ONLY the resolved-URL prefix assertion
    // catches these — so they pin that backstop line (a mutant that drops it stays green without them).
    ["a tab-stripped ..", "..\t/secret"],
    ["a newline-stripped ..", "..\n/secret"],
    ["a carriage-return-stripped ..", "..\r/secret"],
  ])("null for %s (mutation: dropping the sanitizer/prefix-assert lets it through)", (_label, path) => {
    expect(resolvePluginProxyUrl(idx, "wow", path)).toBeNull();
  });
  test("null for a missing plugin or one with no package", () => {
    expect(resolvePluginProxyUrl(idx, "nope", "dist/x")).toBeNull();
    expect(
      resolvePluginProxyUrl({ schemaVersion: 1, plugins: [{ name: "np", version: "1.0.0" }] }, "np", "dist/x"),
    ).toBeNull();
  });
});

describe("serveAdminBundle / servePluginProxy delivery routes (#124)", () => {
  const TOKEN = "the-real-token";
  const bundleUrl = "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.0.0/dist/admin.js";
  const index: PluginIndex = {
    schemaVersion: 1,
    plugins: [{ name: "warbandeer", version: "1.0.0", package: "@rackbops/plugin-warbandeer", adminUrl: bundleUrl, adminApiVersion: 1 }],
  };
  const okAsset = (body: string, contentType = "text/javascript"): AdminAssetResult => ({ ok: true, status: 200, contentType, body });
  const failAsset: AdminAssetResult = { ok: false, status: 502, contentType: "", body: "", error: "boom" };
  function cfg(over: Partial<HandlerConfig> = {}): HandlerConfig {
    return {
      adminToken: TOKEN,
      indexHtml: "<html></html>",
      runBotOps: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      listPluginIndex: async () => index,
      fetchAdminAsset: async (url) =>
        url === bundleUrl ? okAsset("export const adminApiVersion=1;export function mountAdmin(){return()=>{}}") : failAsset,
      ...over,
    };
  }

  test("GET /plugin-admin/<name>.js serves the bundle same-origin as JS", async () => {
    const res = await serveAdminBundle("/plugin-admin/warbandeer.js", cfg());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(await res.text()).toContain("mountAdmin");
  });
  test("404 when the plugin ships no admin bundle", async () => {
    expect((await serveAdminBundle("/plugin-admin/ghost.js", cfg())).status).toBe(404);
  });
  test("404 when the index/fetcher deps are absent", async () => {
    expect((await serveAdminBundle("/plugin-admin/warbandeer.js", cfg({ fetchAdminAsset: undefined }))).status).toBe(404);
    expect((await serveAdminBundle("/plugin-admin/warbandeer.js", cfg({ listPluginIndex: undefined }))).status).toBe(404);
  });
  test("502 when the upstream fetch fails", async () => {
    expect((await serveAdminBundle("/plugin-admin/warbandeer.js", cfg({ fetchAdminAsset: async () => failAsset }))).status).toBe(502);
  });
  test("an off-host adminUrl is refused (404), never proxied", async () => {
    const offHost: PluginIndex = { schemaVersion: 1, plugins: [{ name: "warbandeer", version: "1.0.0", adminApiVersion: 1, adminUrl: "https://evil.example.com/admin.js" }] };
    expect((await serveAdminBundle("/plugin-admin/warbandeer.js", cfg({ listPluginIndex: async () => offHost }))).status).toBe(404);
  });
  test("a version-incompatible bundle is refused (404) — not fetched or served", async () => {
    const incompat: PluginIndex = { schemaVersion: 1, plugins: [{ name: "warbandeer", version: "1.0.0", adminApiVersion: 99, adminUrl: bundleUrl }] };
    expect((await serveAdminBundle("/plugin-admin/warbandeer.js", cfg({ listPluginIndex: async () => incompat }))).status).toBe(404);
  });

  test("GET /api/plugin-proxy/<name>?path= serves a scoped asset with its content-type", async () => {
    const proxied = "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.0.0/dist/realms.json";
    const c = cfg({ fetchAdminAsset: async (url) => (url === proxied ? okAsset('{"ok":true}', "application/json") : failAsset) });
    const res = await servePluginProxy(new URL("http://x/api/plugin-proxy/warbandeer?path=dist/realms.json"), c);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
  test("400 for a traversal path — refused before any fetch", async () => {
    let fetched = false;
    const c = cfg({ fetchAdminAsset: async () => { fetched = true; return okAsset("x"); } });
    const res = await servePluginProxy(new URL("http://x/api/plugin-proxy/warbandeer?path=../secret"), c);
    expect(res.status).toBe(400);
    expect(fetched).toBe(false);
  });

  test("handleRequest serves the bundle route BEFORE the /api/ gate (no token needed)", async () => {
    const res = await handleRequest(new Request("http://x/plugin-admin/warbandeer.js"), cfg());
    expect(res.status).toBe(200); // same public layer as / — served before the /api/ auth gate
  });
  test("handleRequest gates the proxy route behind auth (401 without a token)", async () => {
    const res = await handleRequest(new Request("http://x/api/plugin-proxy/warbandeer?path=dist/realms.json"), cfg());
    expect(res.status).toBe(401);
  });
});

describe("makeAdminAssetFetcher (#124 size cap)", () => {
  const res = (o: { ok?: boolean; status?: number; contentLength?: string | null; contentType?: string | null; bytes?: number }) => ({
    ok: o.ok ?? true,
    status: o.status ?? 200,
    headers: { get: (h: string) => (h === "content-length" ? o.contentLength ?? null : h === "content-type" ? o.contentType ?? null : null) },
    arrayBuffer: async () => new ArrayBuffer(o.bytes ?? 0),
  });

  test("rejects early on an oversized Content-Length — WITHOUT buffering the body", async () => {
    let bodyRead = false;
    const fetcher = makeAdminAssetFetcher(async () => ({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === "content-length" ? "999999999" : null) },
      arrayBuffer: async () => {
        bodyRead = true;
        return new ArrayBuffer(0);
      },
    }), 100);
    const r = await fetcher("https://cdn.jsdelivr.net/x");
    expect(r.ok).toBe(false);
    // Mutation: dropping the Content-Length pre-check reads the (huge) body first.
    expect(bodyRead).toBe(false);
  });

  test("rejects an oversized body when no Content-Length is declared (the byteLength backstop)", async () => {
    const fetcher = makeAdminAssetFetcher(async () => res({ bytes: 200 }), 100);
    // Mutation: dropping the byteLength check serves an unbounded body.
    expect((await fetcher("https://cdn.jsdelivr.net/x")).ok).toBe(false);
  });

  test("returns the body + content-type when within the cap", async () => {
    const fetcher = makeAdminAssetFetcher(async () => res({ bytes: 10, contentType: "application/json" }), 100);
    const out = await fetcher("https://cdn.jsdelivr.net/x");
    expect(out.ok).toBe(true);
    expect(out.contentType).toBe("application/json");
  });

  test("a non-ok upstream is an error", async () => {
    const fetcher = makeAdminAssetFetcher(async () => res({ ok: false, status: 404 }), 100);
    expect((await fetcher("https://cdn.jsdelivr.net/x")).ok).toBe(false);
  });
});

// The admin-tab pure helpers (scopeToPluginKeys, adminTabState) are lifted from index.html between
// their PLUGIN_ADMIN_HELPERS markers and evaluated here, so the panel's own client logic is pinned in
// the same suite (the pattern the ENV_SAVE lift already uses).
describe("plugin admin helpers (lifted from index.html)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const src = indexSrc.match(/\/\/ PLUGIN_ADMIN_HELPERS:begin\n([\s\S]*?)\n\s*\/\/ PLUGIN_ADMIN_HELPERS:end/)?.[1];

  test("the marked block is present", () => {
    expect(src).toBeTruthy();
  });

  const scopeToPluginKeys = new Function(`"use strict";\n${src ?? ""}\nreturn scopeToPluginKeys;`)() as (
    obj: Record<string, unknown>,
    keys: string[],
  ) => Record<string, unknown>;
  const adminTabState = new Function(`"use strict";\n${src ?? ""}\nreturn adminTabState;`)() as (
    plugin: unknown,
    panelVer: number,
  ) => { kind: string; declared?: number; panel?: number };
  const buildSetEnvBody = new Function(`"use strict";\n${src ?? ""}\nreturn buildSetEnvBody;`)() as (
    changes: Record<string, unknown>,
    keys: string[],
  ) => { body?: string; error?: string };
  const viewToState = new Function(`"use strict";\n${src ?? ""}\nreturn viewToState;`)() as (
    p: unknown,
  ) => Record<string, unknown> | null;

  test("scopeToPluginKeys keeps ONLY the plugin's declared keys (the getEnv/setEnv scope)", () => {
    // Mutation: dropping the filter lets a tab read/write a core or another plugin's key.
    expect(
      scopeToPluginKeys({ WARBANDEER_INGEST_PORT: "8082", DISCORD_TOKEN: "x", ANNOUNCE_CHANNEL_ID: "1" }, ["WARBANDEER_INGEST_PORT"]),
    ).toEqual({ WARBANDEER_INGEST_PORT: "8082" });
    expect(scopeToPluginKeys({ A: "1" }, [])).toEqual({});
    expect(scopeToPluginKeys({}, ["A"])).toEqual({});
  });

  test("adminTabState: none without a bundle or when disabled; mismatch on a version gap; mount on a match", () => {
    expect(adminTabState({ enabled: true, adminUrl: "u", adminApiVersion: 1 }, 1)).toEqual({ kind: "mount" });
    expect(adminTabState({ enabled: false, adminUrl: "u", adminApiVersion: 1 }, 1).kind).toBe("none"); // not enabled
    expect(adminTabState({ enabled: true, adminApiVersion: 1 }, 1).kind).toBe("none"); // no adminUrl
    // A version gap in EITHER direction is a mismatch, never a mount — a `!==`→`===` mutant would run a
    // bundle built against a different contract.
    expect(adminTabState({ enabled: true, adminUrl: "u", adminApiVersion: 2 }, 1)).toEqual({ kind: "mismatch", declared: 2, panel: 1 });
    expect(adminTabState({ enabled: true, adminUrl: "u", adminApiVersion: 1 }, 2).kind).toBe("mismatch");
  });

  test("buildSetEnvBody scopes to the plugin's keys AND refuses a newline value (no env-set injection)", () => {
    // The scope is APPLIED here (not just in scopeToPluginKeys) — mutation: dropping it includes the
    // core key in the body.
    expect(buildSetEnvBody({ WARBANDEER_INGEST_PORT: "8082", ANNOUNCE_CHANNEL_ID: "1" }, ["WARBANDEER_INGEST_PORT"]))
      .toEqual({ body: "WARBANDEER_INGEST_PORT=8082" });
    expect(buildSetEnvBody({}, ["A"])).toEqual({ body: "" });
    // A \n or \r in a value would smuggle a second env-set line past the key scope — refused.
    expect(buildSetEnvBody({ WARBANDEER_INGEST_PORT: "8080\nANNOUNCE_CHANNEL_ID=1" }, ["WARBANDEER_INGEST_PORT"]).error).toBeTruthy();
    expect(buildSetEnvBody({ WARBANDEER_INGEST_PORT: "8080\rX=1" }, ["WARBANDEER_INGEST_PORT"]).error).toBeTruthy();
  });

  test("viewToState maps a /api/plugins row to the PluginStateEntry shape (availableVersion when newer)", () => {
    expect(viewToState(null)).toBeNull();
    const s = viewToState({ name: "wb", enabled: true, installedVersion: "1.0.0", latestVersion: "1.1.0", active: true, configured: true, missingEnv: [] })!;
    expect(s.installedVersion).toBe("1.0.0");
    expect(s.availableVersion).toBe("1.1.0"); // the view's latestVersion, since it's newer than installed
    expect(s.active).toBe(true);
    // No newer version → availableVersion undefined (mutation: always-copying latestVersion leaks it).
    expect(viewToState({ name: "wb", installedVersion: "1.1.0", latestVersion: "1.1.0" })!.availableVersion).toBeUndefined();
  });
});

// #105 adds the update-lifecycle passthrough (scheduled/skippedVersion/remindAt — the Cancel-button
// and marker inputs) and the compat flag the card uses to suppress Update now. The #102 merge tests
// above deliberately don't set hostApiVersion, so these use entries that do.
describe("mergePluginsView surfaces #105 schedule state + compat", () => {
  const withApi = (hostApiVersion: number): PluginIndex => ({
    schemaVersion: 1,
    plugins: [
      {
        name: "warbandeer",
        version: "1.1.0",
        description: "d",
        hostApiVersion,
        releases: [{ version: "1.1.0", publishedAt: "2026-02-01", url: "u", notes: "n" }],
      },
    ],
  });

  test("carries scheduled / skippedVersion / remindAt through from the bot's status", () => {
    const status: PluginStatusEntry[] = [
      {
        name: "warbandeer",
        enabled: true,
        installedVersion: "1.0.0",
        active: true,
        scheduled: { version: "1.1.0", at: "2026-09-06T18:30:00.000Z", requestedBy: "email:me@x.com" },
        skippedVersion: "1.0.5",
        remindAt: "2026-09-10T00:00:00.000Z",
      },
    ];
    const wb = mergePluginsView(withApi(1), status, "warbandeer").plugins.find((p) => p.name === "warbandeer")!;
    // A dropped `scheduled` passthrough (the mutation) means the panel never offers Cancel.
    expect(wb.scheduled).toEqual({ version: "1.1.0", at: "2026-09-06T18:30:00.000Z", requestedBy: "email:me@x.com" });
    expect(wb.skippedVersion).toBe("1.0.5");
    expect(wb.remindAt).toBe("2026-09-10T00:00:00.000Z");
  });

  test("status omitting the fields leaves them undefined (never a spurious Cancel/marker)", () => {
    const wb = mergePluginsView(withApi(1), [{ name: "warbandeer", installedVersion: "1.0.0" }], "warbandeer").plugins[0]!;
    expect(wb.scheduled).toBeUndefined();
    expect(wb.skippedVersion).toBeUndefined();
    expect(wb.remindAt).toBeUndefined();
  });

  test("compatible is true (no neededHostApi) when the entry's hostApiVersion equals the bot's", () => {
    const wb = mergePluginsView(withApi(HOST_API_VERSION), [], "warbandeer").plugins[0]!;
    expect(wb.compatible).toBe(true);
    expect(wb.neededHostApi).toBeUndefined();
  });

  test("compatible is false — with neededHostApi — when the entry needs a newer host API (bot would reject Update now)", () => {
    const wb = mergePluginsView(withApi(HOST_API_VERSION + 1), [], "warbandeer").plugins[0]!;
    // A `!==`→`===`-flipped compat mutant marks this compatible and lets the card offer an Update now
    // the bot will reject. (This case alone can't kill a `<=`/`<` mutant — the older-API case below does.)
    expect(wb.compatible).toBe(false);
    expect(wb.neededHostApi).toBe(HOST_API_VERSION + 1);
  });

  test("compatible is false for an OLDER-host-API entry too (the bot rejects `!==`, so === is the mirror, not <=)", () => {
    // The bot's validate rejects an update to the index's current version whenever
    // entry.hostApiVersion !== HOST_API_VERSION — BOTH newer and older. This is the one input that
    // distinguishes the correct `===` from a `<=`/`<` mutant (which would call an older-API build
    // compatible and offer an Update now the bot then quarantines). Realistic once HOST_API_VERSION
    // bumps and an un-updated plugin still declares the prior version.
    const wb = mergePluginsView(withApi(HOST_API_VERSION - 1), [], "warbandeer").plugins[0]!;
    expect(wb.compatible).toBe(false);
    expect(wb.neededHostApi).toBe(HOST_API_VERSION - 1);
  });

  test("a plugin not in the index is compatible (nothing to install → the flag is moot, never blocks)", () => {
    const legacy = mergePluginsView(withApi(1), [{ name: "legacy", installedVersion: "0.9.0" }], "").plugins.find(
      (p) => p.name === "legacy",
    )!;
    expect(legacy.compatible).toBe(true);
    expect(legacy.neededHostApi).toBeUndefined();
  });
});

// The panel-side request schema — the FIRST of three validation layers (panel → bot-ops.sh → the bot's
// requests.ts validate). It mirrors requests.ts's regexes so a hostile/malformed body is 400'd before
// it reaches bot-ops.sh at all; the anchored version regex (no `/`) is the traversal gate.
describe("parsePluginRequestInput (#105 request trust boundary)", () => {
  test("accepts each well-formed action and never carries requestedBy (the server sets it)", () => {
    expect(parsePluginRequestInput({ action: "update-now", plugin: "warbandeer", version: "1.1.0" })).toEqual({
      ok: true,
      request: { action: "update-now", plugin: "warbandeer", version: "1.1.0" },
    });
    expect(parsePluginRequestInput({ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "2026-09-06T18:30:00.000Z" }).ok).toBe(true);
    expect(parsePluginRequestInput({ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 7 }).ok).toBe(true);
    expect(parsePluginRequestInput({ action: "skip", plugin: "warbandeer", version: "1.1.0" }).ok).toBe(true);
    expect(parsePluginRequestInput({ action: "cancel", plugin: "warbandeer" })).toEqual({
      ok: true,
      request: { action: "cancel", plugin: "warbandeer" },
    });
  });

  test("a client-supplied requestedBy is dropped, not passed through (never trusted from the body)", () => {
    const r = parsePluginRequestInput({ action: "skip", plugin: "warbandeer", version: "1.1.0", requestedBy: "email:admin@evil" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request).not.toHaveProperty("requestedBy");
  });

  test("rejects a non-object, an unknown action, and a bad plugin name", () => {
    expect(parsePluginRequestInput(null).ok).toBe(false);
    expect(parsePluginRequestInput("nope").ok).toBe(false);
    expect(parsePluginRequestInput({ action: "delete-everything", plugin: "warbandeer", version: "1.1.0" }).ok).toBe(false);
    expect(parsePluginRequestInput({ action: "skip", plugin: "Warbandeer", version: "1.1.0" }).ok).toBe(false); // uppercase
  });

  test("rejects a version with a slash or path traversal (the security gate)", () => {
    for (const version of ["1.0.0/../../etc", "../../evil", "1.0.0/x", "latest"]) {
      expect(parsePluginRequestInput({ action: "update-now", plugin: "warbandeer", version }).ok).toBe(false);
    }
  });

  test("cancel needs no version; every other action requires a valid one", () => {
    expect(parsePluginRequestInput({ action: "cancel", plugin: "warbandeer" }).ok).toBe(true);
    expect(parsePluginRequestInput({ action: "skip", plugin: "warbandeer" }).ok).toBe(false); // missing version
  });

  test("rejects a bad schedule time and out-of-range days", () => {
    expect(parsePluginRequestInput({ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "tomorrow" }).ok).toBe(false);
    expect(parsePluginRequestInput({ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "2026-09-06T18:30" }).ok).toBe(false); // no offset
    expect(parsePluginRequestInput({ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 0 }).ok).toBe(false);
    expect(parsePluginRequestInput({ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 1000 }).ok).toBe(false);
  });
});

// The #105 producer route: a panel action button → a request file the bot consumes. Server-native
// (like /api/admins) specifically so `requestedBy` is set from the verified identity, never the body.
describe("POST /api/plugins/request (#105 panel producer)", () => {
  const TOKEN = "test-token";
  const INDEX_HTML = "<html></html>";
  const okStdout = '{"ok":true,"queued":"1757000000000-skip-42.json"}';

  // Captures the invocation so a test can assert args + stdin (the requestedBy injection).
  function capturingBotOps(result: BotOpsResult = { exitCode: 0, stdout: okStdout, stderr: "" }) {
    const calls: BotOpsInvocation[] = [];
    return { calls, run: async (inv: BotOpsInvocation): Promise<BotOpsResult> => (calls.push(inv), result) };
  }
  const cfg = (run: HandlerConfig["runBotOps"]): HandlerConfig => ({ adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: run });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://panel.example/api/plugins/request", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("queues a valid request: runs `plugin-request` with the JSON on stdin, returns bot-ops' output", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(post({ action: "skip", plugin: "warbandeer", version: "1.1.0" }), cfg(bot.run));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(okStdout);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0]!.args).toEqual(["plugin-request"]);
    expect(JSON.parse(bot.calls[0]!.stdin!)).toEqual({ action: "skip", plugin: "warbandeer", version: "1.1.0", requestedBy: "token" });
  });

  test("requestedBy is set from the verified Access email, NEVER the client body", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(
      new Request("http://panel.example/api/plugins/request", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": "jwt", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update-now", plugin: "warbandeer", version: "1.1.0", requestedBy: "email:attacker@evil" }),
      }),
      { adminToken: TOKEN, indexHtml: INDEX_HTML, runBotOps: bot.run, verifyAccessJwt: async () => ({ sub: "real@example.com", email: "real@example.com" }) },
    );
    expect(res.status).toBe(200);
    const sent = JSON.parse(bot.calls[0]!.stdin!);
    // The identity wins — a mutant that reads requestedBy from the body would send "email:attacker@evil".
    expect(sent.requestedBy).toBe("email:real@example.com");
  });

  test("the bearer path records requestedBy: token (no email identity)", async () => {
    const bot = capturingBotOps();
    await handleRequest(post({ action: "cancel", plugin: "warbandeer" }), cfg(bot.run));
    expect(JSON.parse(bot.calls[0]!.stdin!).requestedBy).toBe("token");
  });

  test("no token -> 401 and bot-ops is never called", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(
      new Request("http://panel.example/api/plugins/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", plugin: "warbandeer" }),
      }),
      cfg(bot.run),
    );
    expect(res.status).toBe(401);
    expect(bot.calls).toHaveLength(0);
  });

  test("a cross-site Origin -> 403 before auth, bot-ops never called", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(post({ action: "cancel", plugin: "warbandeer" }, { Origin: "http://evil.com" }), cfg(bot.run));
    expect(res.status).toBe(403);
    expect(bot.calls).toHaveLength(0);
  });

  test("a schema-invalid body -> 400, bot-ops never called", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(post({ action: "delete-everything", plugin: "warbandeer", version: "1.1.0" }), cfg(bot.run));
    expect(res.status).toBe(400);
    expect(bot.calls).toHaveLength(0);
  });

  test("a version with a slash -> 400 (the traversal gate), bot-ops never called", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(post({ action: "update-now", plugin: "warbandeer", version: "1.0.0/../etc" }), cfg(bot.run));
    expect(res.status).toBe(400);
    expect(bot.calls).toHaveLength(0);
  });

  test("invalid JSON -> 400, bot-ops never called", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(post("{ not json", {}), cfg(bot.run));
    expect(res.status).toBe(400);
    expect(bot.calls).toHaveLength(0);
  });

  test("a bot-ops failure surfaces its stderr with a 502", async () => {
    const bot = capturingBotOps({ exitCode: 1, stdout: "", stderr: "bot-ops: plugin-request: invalid action" });
    const res = await handleRequest(post({ action: "skip", plugin: "warbandeer", version: "1.1.0" }), cfg(bot.run));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("bot-ops: plugin-request: invalid action");
  });

  test("a timed-out bot-ops returns a distinct 504", async () => {
    const bot = capturingBotOps({ exitCode: 1, stdout: "", stderr: "", timedOut: true });
    const res = await handleRequest(post({ action: "skip", plugin: "warbandeer", version: "1.1.0" }), cfg(bot.run));
    expect(res.status).toBe(504);
  });
});

// The plugin Save path, pinned against the page's OWN source — mirrors the saveEnv lift above. The
// pure planPluginsSave and savePlugins are lifted from index.html (between their PLUGINS_SAVE_PLAN /
// PLUGINS_SAVE markers) and evaluated here, so the consumer boundary (savePlugins POSTs PLUGINS=<value>
// and ONLY that) is proven on the real function, not a re-implementation.
describe("admin panel plugin Save (#102)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const planSrc = indexSrc.match(/\/\/ PLUGINS_SAVE_PLAN:begin\n([\s\S]*?)\n\s*\/\/ PLUGINS_SAVE_PLAN:end/)?.[1];
  const saveSrc = indexSrc.match(/\/\/ PLUGINS_SAVE:begin\n([\s\S]*?)\n\s*\/\/ PLUGINS_SAVE:end/)?.[1];

  type Plan = { value: string; changed: boolean };
  const planPluginsSave = (checked: string[], current: string, order: string[]): Plan =>
    (new Function(`"use strict";\n${planSrc ?? ""}\nreturn planPluginsSave;`)() as (
      c: string[],
      v: string,
      o: string[],
    ) => Plan)(checked, current, order);

  test("both marked functions are present in the served page", () => {
    expect(planSrc).toContain("function planPluginsSave(");
    expect(saveSrc).toContain("async function savePlugins(");
  });

  describe("planPluginsSave (pure)", () => {
    test("keeps a name@version pin for a still-ticked plugin, no-op when unchanged", () => {
      expect(planPluginsSave(["warbandeer"], "warbandeer@1.0.0", ["warbandeer", "raidhelper"])).toEqual({
        value: "warbandeer@1.0.0",
        changed: false,
      });
    });
    test("orders ticked plugins by the manifest", () => {
      expect(planPluginsSave(["raidhelper", "warbandeer"], "raidhelper", ["warbandeer", "raidhelper"])).toEqual({
        value: "warbandeer,raidhelper",
        changed: true,
      });
    });
    test("a newly-ticked plugin is added bare (no pin), keeping an existing pin", () => {
      expect(planPluginsSave(["warbandeer", "raidhelper"], "warbandeer@1.0.0", ["warbandeer", "raidhelper"])).toEqual({
        value: "warbandeer@1.0.0,raidhelper",
        changed: true,
      });
    });
    test("unticking a plugin drops it entirely", () => {
      expect(planPluginsSave([], "warbandeer@1.0.0", ["warbandeer"])).toEqual({ value: "", changed: true });
    });
    test("a whitespace-only difference is not a change (no spurious restart)", () => {
      expect(planPluginsSave(["warbandeer", "raidhelper"], "warbandeer, raidhelper", ["warbandeer", "raidhelper"]).changed).toBe(false);
    });
    test("a ticked plugin the manifest doesn't list is appended in its own order", () => {
      expect(planPluginsSave(["warbandeer", "legacy"], "warbandeer,legacy", ["warbandeer"]).value).toBe("warbandeer,legacy");
    });
  });

  interface FakePage {
    posts: { path: string; opts: { method?: string; body?: string; signal?: AbortSignal } }[];
    confirms: string[];
    msg: { textContent: string; className: string };
    reloads: { plugins: number; env: number; status: number };
  }
  async function runSavePlugins(
    pluginsData: { plugins: { name: string }[]; pluginsValue: string; stateError?: string },
    checked: string[],
    opts: { confirm?: boolean; response?: { ok: boolean; text: string } } = {},
  ): Promise<FakePage> {
    const page: FakePage = { posts: [], confirms: [], msg: { textContent: "", className: "" }, reloads: { plugins: 0, env: 0, status: 0 } };
    const checkedSet = new Set(checked);
    const boxes = pluginsData.plugins.map((p) => ({ checked: checkedSet.has(p.name), dataset: { plugin: p.name }, type: "checkbox" }));
    const document = {
      getElementById: (id: string) => (id === "plugins-msg" ? page.msg : null),
      querySelectorAll: (selector: string) => (selector === "#plugins-list input[type=checkbox]" ? boxes : []),
    };
    const confirm = (text: string): boolean => {
      page.confirms.push(text);
      return opts.confirm ?? true;
    };
    const api = async (path: string, o: { method?: string; body?: string; signal?: AbortSignal }) => {
      page.posts.push({ path, opts: o });
      const r = opts.response ?? { ok: true, text: '{"ok":true,"changed":["PLUGINS"]}' };
      return { ok: r.ok, text: async () => r.text };
    };
    const timeoutSignal = (_ms: number) => ({ signal: new AbortController().signal, cancel: () => {} });
    const savePlugins = new Function(
      "document",
      "confirm",
      "api",
      "timeoutSignal",
      "MUTATION_TIMEOUT_MS",
      "loadPlugins",
      "loadEnv",
      "loadStatus",
      "pluginsData",
      `${planSrc ?? ""}\n${saveSrc ?? ""}\nreturn savePlugins;`,
    )(
      document,
      confirm,
      api,
      timeoutSignal,
      110000,
      () => page.reloads.plugins++,
      () => page.reloads.env++,
      () => page.reloads.status++,
      pluginsData,
    ) as () => Promise<void>;
    await savePlugins();
    return page;
  }

  test("savePlugins POSTs only PLUGINS with the planned value, then re-baselines all three views", async () => {
    const page = await runSavePlugins(
      { plugins: [{ name: "warbandeer" }, { name: "raidhelper" }], pluginsValue: "warbandeer" },
      ["warbandeer", "raidhelper"],
    );
    expect(page.posts).toHaveLength(1);
    const [post] = page.posts;
    expect(post?.path).toBe("/api/env");
    expect(post?.opts.method).toBe("POST");
    expect(post?.opts.body).toBe("PLUGINS=warbandeer,raidhelper");
    expect(post?.opts.signal).toBeInstanceOf(AbortSignal);
    expect(page.confirms).toHaveLength(1);
    expect(page.confirms[0]).toContain("warbandeer,raidhelper");
    expect(page.msg.className).toBe("msg ok");
    expect(page.reloads).toEqual({ plugins: 1, env: 1, status: 1 });
  });

  test("savePlugins with no change posts nothing and says so", async () => {
    const page = await runSavePlugins({ plugins: [{ name: "warbandeer" }], pluginsValue: "warbandeer@1.0.0" }, ["warbandeer"]);
    expect(page.posts).toEqual([]);
    expect(page.confirms).toEqual([]);
    expect(page.msg.textContent).toBe("No changes.");
  });

  test("a declined confirm posts nothing", async () => {
    const page = await runSavePlugins(
      { plugins: [{ name: "warbandeer" }, { name: "raidhelper" }], pluginsValue: "warbandeer" },
      ["warbandeer", "raidhelper"],
      { confirm: false },
    );
    expect(page.confirms).toHaveLength(1);
    expect(page.posts).toEqual([]);
    expect(page.reloads).toEqual({ plugins: 0, env: 0, status: 0 });
  });

  test("a rejected save surfaces bot-ops.sh's own message", async () => {
    const page = await runSavePlugins(
      { plugins: [{ name: "warbandeer" }, { name: "raidhelper" }], pluginsValue: "warbandeer" },
      ["warbandeer", "raidhelper"],
      { response: { ok: false, text: "bot-ops: env-set: value for 'PLUGINS' is invalid" } },
    );
    expect(page.msg.className).toBe("msg error");
    expect(page.msg.textContent).toContain("bot-ops");
  });

  test("savePlugins refuses to post when stateError is set (no wipe against a false-empty baseline)", async () => {
    // The dangerous case: state read failed so pluginsValue came back "", the operator ticks a
    // subset — without the guard this would POST PLUGINS=<subset> and drop the rest.
    const page = await runSavePlugins(
      { plugins: [{ name: "warbandeer" }, { name: "raidhelper" }], pluginsValue: "", stateError: "the bot's current state couldn't be read" },
      ["warbandeer"],
    );
    expect(page.posts).toEqual([]);
    expect(page.confirms).toEqual([]);
  });
});

// The badge DECISIONS are pure {text, kind} functions lifted from index.html's PLUGIN_BADGES markers
// and pinned here — the render (makeBadge → createElement) stays browser-only, but the two review-fix
// conditions (index-outage suppression = MODERATE-2, newer-release guard = MINOR-2) are guarded.
describe("admin panel plugin badge decisions (#102, lifted from index.html)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const badgesSrc = indexSrc.match(/\/\/ PLUGIN_BADGES:begin\n([\s\S]*?)\n\s*\/\/ PLUGIN_BADGES:end/)?.[1];
  type Badge = { text: string; kind: string | null } | null;
  const fns = new Function(`"use strict";\n${badgesSrc ?? ""}\nreturn { pluginStateBadge, pluginUpdateBadge };`)() as {
    pluginStateBadge: (p: Record<string, unknown>, indexAvailable: boolean) => Badge;
    pluginUpdateBadge: (p: Record<string, unknown>) => Badge;
  };

  test("both marked functions are present in the served page", () => {
    expect(badgesSrc).toContain("function pluginStateBadge(");
    expect(badgesSrc).toContain("function pluginUpdateBadge(");
  });

  describe("pluginStateBadge", () => {
    test("MODERATE-2: labels 'not in index' only when the index is available", () => {
      // During an outage every row is inIndex:false — it must NOT be labelled 'not in index'.
      expect(fns.pluginStateBadge({ inIndex: false, active: true }, false)).toEqual({ text: "active", kind: "active" });
      // But a genuinely-unknown plugin (index loaded, absent) still is.
      expect(fns.pluginStateBadge({ inIndex: false, active: true }, true)).toEqual({ text: "not in index", kind: "warn" });
    });
    test("precedence: error > needs-config > active > enabled > disabled", () => {
      expect(fns.pluginStateBadge({ inIndex: true, error: "boom" }, true)).toEqual({ text: "failed: boom", kind: "warn" });
      expect(fns.pluginStateBadge({ inIndex: true, enabled: true, missingEnv: ["A"] }, true)).toEqual({ text: "needs config: A", kind: "warn" });
      expect(fns.pluginStateBadge({ inIndex: true, active: true }, true)).toEqual({ text: "active", kind: "active" });
      expect(fns.pluginStateBadge({ inIndex: true, enabled: true, missingEnv: [] }, true)).toEqual({ text: "enabled, not active", kind: null });
      expect(fns.pluginStateBadge({ inIndex: true, enabled: false }, true)).toEqual({ text: "disabled", kind: null });
    });
  });

  describe("pluginUpdateBadge", () => {
    test("shows 'update to X' when a newer release exists", () => {
      expect(fns.pluginUpdateBadge({ installedVersion: "1.0.0", latestVersion: "1.1.0", releases: [{ version: "1.1.0" }] })).toEqual({ text: "update to 1.1.0", kind: "update" });
    });
    test("MINOR-2: no badge when latest === installed (even if releasesNewerThan returned entries)", () => {
      expect(fns.pluginUpdateBadge({ installedVersion: "1.0.0", latestVersion: "1.0.0", releases: [{ version: "1.0.0" }] })).toBeNull();
    });
    test("no badge when not installed, or no releases", () => {
      expect(fns.pluginUpdateBadge({ latestVersion: "2.0.0", releases: [{ version: "2.0.0" }] })).toBeNull();
      expect(fns.pluginUpdateBadge({ installedVersion: "1.0.0", latestVersion: "1.1.0", releases: [] })).toBeNull();
    });
  });
});

// The #105 action-button helpers, lifted from index.html and pinned here: the datetime-local→ISO
// conversion (must satisfy the bot's ISO_OFFSET_RE) and the payload builder (must never carry
// requestedBy — the server owns that). The DOM render (buildPluginUpdateBlock) stays browser-only,
// exactly like buildPluginRow; its pure inputs (pluginUpdateBadge, compatible, scheduled) are the
// tested seams.
describe("admin panel plugin request helpers (#105, lifted from index.html)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const helpersSrc = indexSrc.match(/\/\/ PLUGIN_REQUEST_HELPERS:begin\n([\s\S]*?)\n\s*\/\/ PLUGIN_REQUEST_HELPERS:end/)?.[1];
  const fns = new Function(
    `"use strict";\n${helpersSrc ?? ""}\nreturn { scheduleAtToIso, toDatetimeLocalValue, pluginRequestPayload };`,
  )() as {
    scheduleAtToIso: (v: string) => string | null;
    toDatetimeLocalValue: (d: Date) => string;
    pluginRequestPayload: (action: string, plugin: string, version?: string, extra?: { at?: string; days?: number }) => Record<string, unknown>;
  };

  test("the marked helpers are present in the served page", () => {
    expect(helpersSrc).toContain("function scheduleAtToIso(");
    expect(helpersSrc).toContain("function pluginRequestPayload(");
  });

  describe("scheduleAtToIso", () => {
    test("a datetime-local value becomes an offset-bearing ISO the bot's regex accepts, same instant", () => {
      const iso = fns.scheduleAtToIso("2026-09-06T18:30");
      expect(iso).not.toBeNull();
      // The bot's ISO_OFFSET_RE (requests.ts) — Z counts as an offset, so toISOString()'s output passes.
      expect(iso!).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/);
      expect(new Date(iso!).getTime()).toBe(new Date("2026-09-06T18:30").getTime());
    });
    test("null on a blank or unparseable value (the Schedule button then refuses to send)", () => {
      expect(fns.scheduleAtToIso("")).toBeNull();
      expect(fns.scheduleAtToIso("not a date")).toBeNull();
    });
  });

  test("toDatetimeLocalValue's output round-trips back to the same instant through scheduleAtToIso", () => {
    const d = new Date("2026-09-06T18:30");
    const localValue = fns.toDatetimeLocalValue(d);
    expect(localValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(fns.scheduleAtToIso(localValue)!).getTime()).toBe(d.getTime());
  });

  describe("pluginRequestPayload", () => {
    test("builds each action's body and NEVER includes requestedBy (the server injects it)", () => {
      expect(fns.pluginRequestPayload("update-now", "warbandeer", "1.1.0")).toEqual({ action: "update-now", plugin: "warbandeer", version: "1.1.0" });
      expect(fns.pluginRequestPayload("schedule", "warbandeer", "1.1.0", { at: "2026-09-06T18:30:00.000Z" })).toEqual({ action: "schedule", plugin: "warbandeer", version: "1.1.0", at: "2026-09-06T18:30:00.000Z" });
      expect(fns.pluginRequestPayload("remind", "warbandeer", "1.1.0", { days: 7 })).toEqual({ action: "remind", plugin: "warbandeer", version: "1.1.0", days: 7 });
      expect(fns.pluginRequestPayload("cancel", "warbandeer")).toEqual({ action: "cancel", plugin: "warbandeer" });
    });
    test("omits version for cancel even when one is passed", () => {
      expect(fns.pluginRequestPayload("cancel", "warbandeer", "1.1.0")).not.toHaveProperty("version");
    });
  });
});

// The send consumer, pinned against the page's OWN source — mirrors the savePlugins lift. Proves the
// boundary (POSTs to /api/plugins/request, re-loads on success, never adds requestedBy), not just the
// pure payload — the "break lives between changed and unchanged code" lesson.
describe("admin panel sendPluginRequest (#105, lifted from index.html)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const sendSrc = indexSrc.match(/\/\/ PLUGIN_REQUEST_SEND:begin\n([\s\S]*?)\n\s*\/\/ PLUGIN_REQUEST_SEND:end/)?.[1];

  test("the marked consumer is present in the served page", () => {
    expect(sendSrc).toContain("async function sendPluginRequest(");
  });

  interface Sent {
    path: string;
    opts: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal };
  }
  async function runSend(
    payload: Record<string, unknown>,
    response: { ok: boolean; text: string } = { ok: true, text: '{"ok":true,"queued":"x.json"}' },
  ) {
    const posts: Sent[] = [];
    const reloads = { plugins: 0, status: 0 };
    const msg = { textContent: "", className: "" };
    const api = async (path: string, opts: Sent["opts"]) => {
      posts.push({ path, opts });
      return { ok: response.ok, status: response.ok ? 200 : 502, text: async () => response.text };
    };
    const timeoutSignal = (_ms: number) => ({ signal: new AbortController().signal, cancel: () => {} });
    const sendPluginRequest = new Function(
      "api",
      "timeoutSignal",
      "MUTATION_TIMEOUT_MS",
      "loadPlugins",
      "loadStatus",
      `${sendSrc ?? ""}\nreturn sendPluginRequest;`,
    )(api, timeoutSignal, 110000, () => reloads.plugins++, () => reloads.status++) as (
      p: unknown,
      m: unknown,
    ) => Promise<void>;
    await sendPluginRequest(payload, msg);
    return { posts, reloads, msg };
  }

  test("POSTs the payload to /api/plugins/request as JSON with a signal, then re-loads on success", async () => {
    const { posts, reloads, msg } = await runSend({ action: "skip", plugin: "warbandeer", version: "1.1.0" });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe("/api/plugins/request");
    expect(posts[0]!.opts.method).toBe("POST");
    expect(posts[0]!.opts.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(posts[0]!.opts.body!)).toEqual({ action: "skip", plugin: "warbandeer", version: "1.1.0" });
    expect(posts[0]!.opts.signal).toBeInstanceOf(AbortSignal);
    expect(msg.className).toBe("plugin-actions-msg ok");
    expect(reloads).toEqual({ plugins: 1, status: 1 });
  });

  test("never adds requestedBy to the posted body (the server injects it from identity)", async () => {
    const { posts } = await runSend({ action: "skip", plugin: "warbandeer", version: "1.1.0" });
    expect(posts[0]!.opts.body).not.toContain("requestedBy");
  });

  test("a failed request shows the server's message and does NOT re-load", async () => {
    const { reloads, msg } = await runSend({ action: "cancel", plugin: "warbandeer" }, { ok: false, text: "bad action" });
    expect(msg.className).toBe("plugin-actions-msg error");
    expect(msg.textContent).toContain("bad action");
    expect(reloads).toEqual({ plugins: 0, status: 0 });
  });
});
