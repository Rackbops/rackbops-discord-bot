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
  REQUIRED_BOT_OPS_SCHEMA,
  REQUIRED_COMPOSE_SCHEMA,
  decideBotOpsSchema,
  decideComposeSchema,
  checkBotOpsSchemaStartup,
  mergeStatusOutdated,
  IDLE_TIMEOUT_SECONDS,
  isAuthorized,
  isCrossSiteWrite,
  isEmailAllowed,
  describeBotOpsStartup,
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
  resolveAdminStorePathsOrExit,
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
// #238 (panel shell): kept as separate import statements so this change adds lines and removes none.
import { existsSync } from "node:fs";
import { loadStaticAssets, STATIC_ASSET_FILES, type StaticAsset } from "./server";
import { composeThemeCss } from "./theme/build-theme";
// #242 (panel routing API): its own import statement, like the one above, so it adds lines and removes none.
import { parseRoutingSetInput, parseWebhookAddInput, redactWebhookUrls } from "./server";

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

// The refusal itself, which used to be an inline try/catch under `import.meta.main` where
// `process.exit(1)` was unpinnable — swapping it for "log and carry on" left the whole suite green
// while producing exactly what the guard exists to prevent: a panel that starts and authorizes
// every Access identity. Injected logError/exit make it an ordinary unit test.
describe("resolveAdminStorePathsOrExit refuses to start rather than degrading", () => {
  /** Stands in for process.exit's `never` by actually not returning. */
  const throwingExit = ((code: number) => {
    throw new Error(`EXIT:${code}`);
  }) as (code: number) => never;

  test("a relative value logs the [admin]-prefixed reason and exits 1", () => {
    const errors: string[] = [];
    expect(() =>
      resolveAdminStorePathsOrExit({ BOT_OPS_CONFIG_DIR: "./config" }, (m) => errors.push(m), throwingExit),
    ).toThrow("EXIT:1");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(
      '[admin] BOT_OPS_CONFIG_DIR must be an absolute path, got "./config" — it holds .env, backups/ and admins.json, and a relative path resolves against the panel\'s cwd — refusing to start',
    );
  });

  test("an absolute value returns the pair and never exits or logs", () => {
    const errors: string[] = [];
    const paths = resolveAdminStorePathsOrExit({ BOT_OPS_CONFIG_DIR: "/opt/bot" }, (m) => errors.push(m), throwingExit);
    expect(paths).toEqual({ configDir: "/opt/bot", adminsFile: "/opt/bot/admins.json" });
    expect(errors).toEqual([]);
  });

  test("unset returns the degraded pair and never exits — bootstrap-only must still start", () => {
    const errors: string[] = [];
    expect(resolveAdminStorePathsOrExit({}, (m) => errors.push(m), throwingExit)).toEqual({
      configDir: undefined,
      adminsFile: undefined,
    });
    expect(errors).toEqual([]);
  });
});

test("the panel entry point resolves its paths through the guard, not from raw env", () => {
  const serverSrc = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const marker = "if (import.meta.main) {";
  const entry = serverSrc.slice(serverSrc.indexOf(marker));
  expect(entry).toContain(marker); // the block still exists; guards against a silent no-op scan
  expect(entry).toContain("resolveAdminStorePathsOrExit(process.env)");
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

// #60 item 2 / #168: the panel's other operator-precious path fact, alongside the config dir above.
describe("describeBotOpsStartup (issue #60 item 2 / #168)", () => {
  test("names the bot-ops script unconditionally", () => {
    // Mutation: dropping this line would leave the script path invisible at startup.
    expect(describeBotOpsStartup("/opt/rackbops-discord-bot/bin/bot-ops.sh", undefined)).toEqual([
      "[admin] bot-ops: /opt/rackbops-discord-bot/bin/bot-ops.sh",
    ]);
  });

  test("also names the compose file when BOT_OPS_COMPOSE_FILE is set", () => {
    const lines = describeBotOpsStartup(
      "/opt/rackbops-discord-bot/bin/bot-ops.sh",
      "/opt/stacks/rackbops-discord-bot-debug/docker-compose.yml",
    );
    expect(lines).toEqual([
      "[admin] bot-ops: /opt/rackbops-discord-bot/bin/bot-ops.sh",
      "[admin] compose file: /opt/stacks/rackbops-discord-bot-debug/docker-compose.yml",
    ]);
  });

  test("omits the compose-file line when it's unset or empty — never prints it as undefined/blank", () => {
    // Mutation: always pushing the second line would print a bare "[admin] compose file: " or
    // "...undefined" when the env var genuinely isn't configured for this instance.
    expect(describeBotOpsStartup("x", undefined)).toHaveLength(1);
    expect(describeBotOpsStartup("x", "")).toHaveLength(1);
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
  test("a key that is a suffix of another key doesn't match", () => expect(parseEnvValue("MY_GITHUB_REPO=x", "GITHUB_REPO")).toBeUndefined());

  // #195: parity with ops/bot-ops.sh's load_env_values / compose's env_file: loader.
  test("the LAST occurrence of a duplicated key wins, not the first", () => {
    expect(parseEnvValue("GITHUB_TOKEN=old-value\nGITHUB_TOKEN=new-value", "GITHUB_TOKEN")).toBe("new-value");
  });
  test("a later duplicate that is empty still wins", () => {
    expect(parseEnvValue("GITHUB_TOKEN=x\nGITHUB_TOKEN=", "GITHUB_TOKEN")).toBe("");
  });
  test("an `export KEY=` line defines the key", () => {
    expect(parseEnvValue("export GITHUB_REPO=owner/name", "GITHUB_REPO")).toBe("owner/name");
  });
  test("an indented line, tab or spaces, defines the key", () => {
    expect(parseEnvValue("  GITHUB_REPO=a\n\texport GITHUB_TOKEN=b", "GITHUB_REPO")).toBe("a");
    expect(parseEnvValue("  GITHUB_REPO=a\n\texport GITHUB_TOKEN=b", "GITHUB_TOKEN")).toBe("b");
  });
  test("a key that appears only as a later export wins over an earlier plain line", () => {
    expect(parseEnvValue("GITHUB_REPO=first\nexport GITHUB_REPO=second", "GITHUB_REPO")).toBe("second");
  });
  test("CRLF duplicate: last wins and the CR is trimmed", () => {
    expect(parseEnvValue("GITHUB_TOKEN=a\r\nGITHUB_TOKEN=b\r\n", "GITHUB_TOKEN")).toBe("b");
  });
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

  test("GET /api/env-schema -> env-schema, json (#205)", () => {
    expect(buildInvocation("GET", "/api/env-schema", new URLSearchParams(), noBody)).toEqual({
      args: ["env-schema"],
      contentType: "application/json",
    });
  });

  test("POST /api/env-schema is not routed (read-only) (#205)", () => {
    expect(buildInvocation("POST", "/api/env-schema", new URLSearchParams(), noBody)).toBeUndefined();
  });

  test("GET /api/routing maps to routing-get, json (#242)", () => {
    expect(buildInvocation("GET", "/api/routing", new URLSearchParams(), noBody)).toEqual({
      args: ["routing-get"],
      contentType: "application/json",
    });
  });

  test("POST /api/routing is not a buildInvocation route: the routing writes are server-native (#242)", () => {
    for (const [method, path] of [
      ["POST", "/api/routing"],
      ["POST", "/api/webhooks"],
      ["DELETE", "/api/webhooks/333333333333333331"],
      ["POST", "/api/discovery/refresh"],
    ] as const) {
      expect(buildInvocation(method, path, new URLSearchParams(), '{"url":"x"}'), `${method} ${path}`).toBeUndefined();
    }
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

  // The child here must be ONE process: no `sleep`, no subshell, nothing to orphan. On Windows the timeout
  // kill reaches only the direct child (createRunBotOps's disclosed gap: there is no process-group kill
  // there), so a grandchild keeps the stdout/stderr pipes open for its own full duration and `runBotOps`
  // settles whenever THAT ends, not when the kill lands. This test used to run `sleep 5`, and measured
  // (bash 5.3 in Git for Windows): 0.2-0.8s when the kill beat bash's spawn of `sleep`, 5.1-5.8s when it
  // did not (`exec sleep 5` measured the same on msys), and past this test's own 10s
  // limit under CPU load (5 of 12 runs with 12 busy loops running: the "flaky" failure, ~10.0s). With the
  // builtin loop below: 0.1-0.7s idle, 0 failures in 24 runs under the same load. A bash builtin loop has
  // no child to orphan and cannot end on its own before the kill (its 30s bound is longer than this
  // test's 20s limit), so the only way this promise settles is that the kill landed, on every platform,
  // and a kill that never lands fails at the limit. The grandchild case has its own POSIX-only test below.
  test("a process that outlives its timeout is killed and reported as timed out", async () => {
    const script = slowScript("SECONDS=0\nwhile (( SECONDS < 30 )); do :; done\necho should-not-print");
    const runBotOps = createRunBotOps(script, { timeoutMs: 100, killSignal: "SIGKILL" });
    const result = await runBotOps({ args: [], contentType: "text/plain" });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("should-not-print");
  }, 20000);

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

  // #173/#178: GET /api/status merges botOpsOutdated+outdatedFiles into cmd_status's own JSON — the
  // one route this panel augments server-side. Also proves the whole point of the design: outdated
  // file(s) never stop the panel from serving day-2 ops (status here, restart below), only make
  // the drift visible.
  test("GET /api/status merges botOpsOutdated:true + outdatedFiles when the startup check found drift", async () => {
    const res = await handleRequest(
      authed("/api/status"),
      branchCfg({ runBotOps: fakeRunBotOps({ exitCode: 0, stdout: '{"running":true,"realmStatus":"UP"}', stderr: "" }), outdatedFiles: ["bot-ops.sh"] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ running: true, realmStatus: "UP", botOpsOutdated: true, outdatedFiles: ["bot-ops.sh"] });
  });

  test("GET /api/status names BOTH files when both are behind — never conflates them into one flag", async () => {
    const res = await handleRequest(
      authed("/api/status"),
      branchCfg({ runBotOps: fakeRunBotOps({ exitCode: 0, stdout: '{"running":true}', stderr: "" }), outdatedFiles: ["bot-ops.sh", "docker-compose.yml"] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ running: true, botOpsOutdated: true, outdatedFiles: ["bot-ops.sh", "docker-compose.yml"] });
  });

  test("GET /api/status carries no botOpsOutdated/outdatedFiles fields when both files are up to date", async () => {
    const res = await handleRequest(
      authed("/api/status"),
      branchCfg({ runBotOps: fakeRunBotOps({ exitCode: 0, stdout: '{"running":true}', stderr: "" }), outdatedFiles: [] }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ running: true });
  });

  test("POST /api/restart still succeeds with an outdated script/compose — the panel degrades, never refuses to start or serve (#173/#178)", async () => {
    const res = await handleRequest(
      new Request("http://x/api/restart", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } }),
      branchCfg({ runBotOps: fakeRunBotOps({ exitCode: 0, stdout: "restarted probe\n", stderr: "" }), outdatedFiles: ["bot-ops.sh", "docker-compose.yml"] }),
    );
    // Mutation: a stray "refuse when outdated" guard anywhere on the request path turns this red.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("restarted probe\n");
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

// The pure config diff, pinned against the page's OWN source: planEnvSave is lifted from index.html
// (between its ENV_SAVE_PLAN markers) and evaluated here, so what issue #44 hinged on — the body carries
// ONLY the keys whose value changed, never an untouched field echoed back — is asserted on the real
// function, not a re-implementation. (#257: the saveEnv that used to wrap it is gone; the consumer
// boundary — the POST body applyPending actually hands to api() — is pinned in the `applyPending (#257)`
// describe below, where every one of saveEnv's tests was carried over by name.)
describe("admin panel planEnvSave: only the changed keys (issue #44)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const planSrc = indexSrc.match(/\/\/ ENV_SAVE_PLAN:begin\n([\s\S]*?)\n\s*\/\/ ENV_SAVE_PLAN:end/)?.[1];
  type Plan = { changes: { key: string; before: string; now: string }[]; body: string };
  // "use strict" up front, matching the page's own IIFE (index.html:226): without it, a `Function`
  // body silently creates a global on an assignment to an un-injected or misspelled identifier
  // instead of throwing — the real (strict-mode) page would ReferenceError there instead.
  const planEnvSave = (loaded: Record<string, string>, current: Record<string, string>): Plan =>
    (new Function(`"use strict";\n${planSrc ?? ""}\nreturn planEnvSave;`)() as (
      l: typeof loaded,
      c: typeof current,
    ) => Plan)(loaded, current);

  test("the marked function is present in the served page", () => {
    expect(planSrc).toContain("function planEnvSave(");
  });

  test("the body carries only the keys whose value differs, in field order (not alphabetical)", () => {
    // WATCHED_REPOS first though it sorts AFTER ANNOUNCE_CHANNEL_ID: the body must preserve the loaded
    // field order (env-get emits keys in bot-ops.sh's own whitelist order, and the panel keeps that order),
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

// AUTO_UPDATE is a UI-shape mirror only (select options), not validation — REQUIRED/BOT_BRANCH's
// format validation moved to GET /api/env-schema (#207), read live by the panel instead of a
// hardcoded copy, so there's nothing left here for those two to drift out of sync on.
describe("AUTO_UPDATE (panel ↔ bot-ops.sh UI-shape mirror)", () => {
  const botOpsSrc = readFileSync(new URL("../bot-ops.sh", import.meta.url), "utf8");
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

  test("AUTO_UPDATE: panel's select options match bot-ops.sh's ALLOWED alternation", () => {
    const botOpsAlternation = botOpsSrc.match(/'AUTO_UPDATE\|\^\(([^)]+)\)\$'/)?.[1];
    const botOpsOptions = (botOpsAlternation ?? "").split("|").sort();
    const panelOptionsSrc = indexSrc.match(/AUTO_UPDATE:\s*\{[^}]*options:\s*(\[[^\]]*\])/)?.[1];
    const panelOptions = (JSON.parse(panelOptionsSrc ?? "[]") as string[]).sort();
    expect(botOpsOptions.length).toBeGreaterThan(0);
    expect(panelOptions).toEqual(botOpsOptions);
  });
});

// #207: the panel's client-side env validation (required-ness, format) reads GET /api/env-schema
// live instead of hardcoding a copy of bot-ops.sh's ALLOWED_SPEC regexes — compilePattern/
// validateEnvChanges are pinned against the page's OWN source (lifted from index.html between
// their ENV_SCHEMA markers), same discipline as planEnvSave above (applyPending reaches
// validateEnvChanges through the same lift).
describe("env schema drives client-side validation (#207)", () => {
  const botOpsSrc = readFileSync(new URL("../bot-ops.sh", import.meta.url), "utf8");
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const schemaSrc = indexSrc.match(/\/\/ ENV_SCHEMA:begin\n([\s\S]*?)\n\s*\/\/ ENV_SCHEMA:end/)?.[1];
  const lifted = new Function(`"use strict";\n${schemaSrc ?? ""}\nreturn { compilePattern, validateEnvChanges };`)() as {
    compilePattern: (ere: unknown) => RegExp | null;
    validateEnvChanges: (
      schema: Record<string, { pattern?: string; required?: boolean }>,
      changes: { key: string; before: string; now: string }[],
    ) => { key: string; message: string } | null;
  };
  const { compilePattern, validateEnvChanges } = lifted;
  // Every 'KEY|regex' row in ALLOWED_SPEC — scraped the same way the deleted BOT_BRANCH mirror test
  // did, generalized to all of them. Split on the FIRST "|" only, matching build_allowed_from_spec's
  // own `${spec%%|*}` / `${spec#*|}` split (AUTO_UPDATE's and PLUGIN_INDEX_URL's regex values both
  // contain a later "|" as alternation).
  const allowedSpec = [...botOpsSrc.matchAll(/^\s*'([A-Z_][A-Z0-9_]*)\|(.*)'$/gm)].map((m) => ({ key: m[1]!, regex: m[2]! }));

  test("both marked functions are present in the served page", () => {
    expect(schemaSrc).toContain("function compilePattern(");
    expect(schemaSrc).toContain("function validateEnvChanges(");
  });

  test("compilePattern translates every ALLOWED_SPEC pattern into a RegExp", () => {
    expect(allowedSpec.length).toBeGreaterThan(0);
    for (const { key, regex } of allowedSpec) expect(compilePattern(regex), key).not.toBeNull();
  });

  test('the compiled PLUGIN_INDEX_URL pattern agrees with bash on a space (proves the "[:space:]" translation, not just that it compiles)', async () => {
    const ere = allowedSpec.find((e) => e.key === "PLUGIN_INDEX_URL")?.regex;
    expect(ere).toBeTruthy();
    const re = compilePattern(ere);
    const cases: [string, boolean][] = [
      ["https://a b", false],
      ["https://a/b", true],
      ["/abs/path", true],
    ];
    for (const [value, expected] of cases) expect(re!.test(value), value).toBe(expected);
    // Parity with the real bash ERE these values will actually be checked against by env-set
    // (ops/bot-ops.sh) — only runs where a real POSIX bash is available (CI's Linux runner).
    if (process.platform !== "win32" && BASH) {
      for (const [value, expected] of cases) {
        const proc = Bun.spawn([BASH, "-c", '[[ "$1" =~ $2 ]] && echo true || echo false', "_", value, ere!], {
          stdout: "pipe",
        });
        const out = (await new Response(proc.stdout).text()).trim();
        await proc.exited;
        expect(out, value).toBe(String(expected));
      }
    }
  });

  test("an uncompilable pattern means no client check, not a thrown error", () => {
    expect(compilePattern("(")).toBeNull();
    expect(validateEnvChanges({ K: { pattern: "(", required: false } }, [{ key: "K", before: "", now: "x" }])).toBeNull();
  });

  // A POSIX class outside the six POSIX_CLASSES maps (blank/punct/cntrl/print/graph/xdigit, or any
  // future one no current ALLOWED_SPEC/plugin manifest happens to use yet) must fail SAFE, not
  // silently compile a wrong-but-valid JS RegExp. `[^[:blank:]]` is syntactically fine JS: the class
  // closes at its first literal "]", so the compiled pattern ends up requiring the value to
  // literally END in "]" — rejecting almost everything (including values bash's real ERE would
  // accept), the opposite of "no check". Caught in review (correctness lens) before this shipped.
  test("an unmapped POSIX class means no client check, not a silently-wrong regex", () => {
    const re = compilePattern("^[^[:blank:]]+$");
    expect(re).toBeNull();
    expect(validateEnvChanges({ K: { pattern: "^[^[:blank:]]+$", required: false } }, [{ key: "K", before: "", now: "no-blank-here" }])).toBeNull();
  });

  test.each([
    ["blank + required -> names the key", { K: { required: true } }, [{ key: "K", before: "1", now: "" }], { key: "K", message: "K is required and cannot be blank." }],
    ["blank + optional -> null", { K: { required: false } }, [{ key: "K", before: "1", now: "" }], null],
    [
      "bad format -> message carries the value and the pattern",
      { K: { pattern: "^[0-9]+$", required: false } },
      [{ key: "K", before: "1", now: "abc" }],
      { key: "K", message: 'K: "abc" doesn\'t match the expected format (^[0-9]+$).' },
    ],
    ["good format -> null", { K: { pattern: "^[0-9]+$", required: false } }, [{ key: "K", before: "1", now: "42" }], null],
    ["a key absent from the schema -> null (unchecked, not refused)", {}, [{ key: "K", before: "1", now: "anything" }], null],
    [
      "the FIRST violation in change order wins",
      { A: { required: true }, B: { required: true } },
      [
        { key: "A", before: "1", now: "" },
        { key: "B", before: "1", now: "" },
      ],
      { key: "A", message: "A is required and cannot be blank." },
    ],
  ])("validateEnvChanges: %s", (_name, schema, changes, expected) => {
    expect(validateEnvChanges(schema as Record<string, { pattern?: string; required?: boolean }>, changes)).toEqual(expected);
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

// #173: REQUIRED_BOT_OPS_SCHEMA is a hand copy of ops/bot-ops.sh's own BOT_OPS_SCHEMA — the same
// drift class as HOST_API_VERSION above, but NOT cosmetic here: an outdated deployed script is
// missing real subcommands/whitelist rows the panel image already assumes exist.
describe("REQUIRED_BOT_OPS_SCHEMA mirrors ops/bot-ops.sh's BOT_OPS_SCHEMA (#173, can't drift)", () => {
  test("matches the script's readonly BOT_OPS_SCHEMA", () => {
    const botOpsSrc = readFileSync(new URL("../bot-ops.sh", import.meta.url), "utf8");
    const scriptSchema = botOpsSrc.match(/readonly BOT_OPS_SCHEMA=(\d+)/)?.[1];
    // Mutation: bumping either side without the other turns this red.
    expect(scriptSchema).toBeTruthy();
    expect(REQUIRED_BOT_OPS_SCHEMA).toBe(Number(scriptSchema));
  });
});

// #178: same mirror class, for the deployed docker-compose.yml's x-rackbops-schema: key.
describe("REQUIRED_COMPOSE_SCHEMA mirrors docker-compose.yml's x-rackbops-schema (#178, can't drift)", () => {
  test("matches the repo compose file's x-rackbops-schema", () => {
    const composeSrc = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
    const composeSchema = composeSrc.match(/^x-rackbops-schema:\s*(\d+)\s*$/m)?.[1];
    // Mutation: bumping either side without the other turns this red.
    expect(composeSchema).toBeTruthy();
    expect(REQUIRED_COMPOSE_SCHEMA).toBe(Number(composeSchema));
  });
});

describe("decideBotOpsSchema (#173)", () => {
  test("matching schema -> not outdated, got the real number", () => {
    expect(decideBotOpsSchema({ exitCode: 0, stdout: '{"schema":1}' }, 1)).toEqual({ outdated: false, got: 1 });
  });
  test("a real mismatch -> outdated, got the wrong number (not the required one)", () => {
    // Mutation: dropping the !== comparison (always false) would call a genuine mismatch up to date.
    expect(decideBotOpsSchema({ exitCode: 0, stdout: '{"schema":2}' }, 1)).toEqual({ outdated: true, got: 2 });
  });
  test("a pre-#173 script's usage error (nonzero exit, no JSON) -> outdated, got null", () => {
    // The issue's own design: "a usage error from a pre-stamp script counts as outdated" — not a
    // separate/unknown state. Mutation: only checking stdout shape (ignoring exitCode) would treat
    // a coincidentally-JSON-shaped stderr-adjacent stdout as a real schema.
    expect(decideBotOpsSchema({ exitCode: 1, stdout: "" }, 1)).toEqual({ outdated: true, got: null });
  });
  test("exit 0 but an unexpected shape (no numeric schema field) -> outdated, got null", () => {
    expect(decideBotOpsSchema({ exitCode: 0, stdout: "{}" }, 1)).toEqual({ outdated: true, got: null });
    expect(decideBotOpsSchema({ exitCode: 0, stdout: "not json" }, 1)).toEqual({ outdated: true, got: null });
    expect(decideBotOpsSchema({ exitCode: 0, stdout: '{"schema":"one"}' }, 1)).toEqual({ outdated: true, got: null });
  });
  // #178: composeSchema being present/absent/malformed must never affect the SCRIPT's own decision —
  // proves the two files' drift can't be conflated at the decision layer.
  test("an unrelated composeSchema field never affects the schema decision", () => {
    expect(decideBotOpsSchema({ exitCode: 0, stdout: '{"schema":1,"composeSchema":99}' }, 1)).toEqual({ outdated: false, got: 1 });
    expect(decideBotOpsSchema({ exitCode: 0, stdout: '{"schema":2,"composeSchema":1}' }, 1)).toEqual({ outdated: true, got: 2 });
  });
});

// #178: the same shape as decideBotOpsSchema, reading composeSchema instead — kept as a genuinely
// separate function/describe block so the two are never accidentally merged into one that could
// conflate the two files' drift.
describe("decideComposeSchema (#178)", () => {
  test("matching composeSchema -> not outdated, got the real number", () => {
    expect(decideComposeSchema({ exitCode: 0, stdout: '{"schema":1,"composeSchema":1}' }, 1)).toEqual({ outdated: false, got: 1 });
  });
  test("a real mismatch -> outdated, got the wrong number", () => {
    expect(decideComposeSchema({ exitCode: 0, stdout: '{"schema":1,"composeSchema":2}' }, 1)).toEqual({ outdated: true, got: 2 });
  });
  test("composeSchema: null (a pre-#178 compose file) -> outdated, got null", () => {
    expect(decideComposeSchema({ exitCode: 0, stdout: '{"schema":1,"composeSchema":null}' }, 1)).toEqual({ outdated: true, got: null });
  });
  test("the version call itself failed (nonzero exit) -> outdated, got null — same as decideBotOpsSchema", () => {
    expect(decideComposeSchema({ exitCode: 1, stdout: "" }, 1)).toEqual({ outdated: true, got: null });
  });
  test("exit 0 but an unexpected shape (no composeSchema field at all) -> outdated, got null", () => {
    expect(decideComposeSchema({ exitCode: 0, stdout: '{"schema":1}' }, 1)).toEqual({ outdated: true, got: null });
    expect(decideComposeSchema({ exitCode: 0, stdout: "not json" }, 1)).toEqual({ outdated: true, got: null });
  });
  // Mirrors decideBotOpsSchema's own "unrelated field" test, the other direction.
  test("an unrelated schema field never affects the compose decision", () => {
    expect(decideComposeSchema({ exitCode: 0, stdout: '{"schema":99,"composeSchema":1}' }, 1)).toEqual({ outdated: false, got: 1 });
    expect(decideComposeSchema({ exitCode: 0, stdout: '{"schema":1,"composeSchema":2}' }, 1)).toEqual({ outdated: true, got: 2 });
  });
});

describe("checkBotOpsSchemaStartup (#173/#178)", () => {
  function capture() {
    const logs: string[] = [];
    const errors: string[] = [];
    return { logs, errors, log: (m: string) => logs.push(m), logError: (m: string) => errors.push(m) };
  }

  test("both match -> two info lines, no logError, returns []", async () => {
    const { logs, errors, log, logError } = capture();
    const runBotOps = async () => ({ exitCode: 0, stdout: '{"schema":1,"composeSchema":1}', stderr: "" });
    const outdatedFiles = await checkBotOpsSchemaStartup(runBotOps, 1, 1, log, logError);
    expect(outdatedFiles).toEqual([]);
    expect(errors.length).toBe(0);
    // Mutation: dropping either logSchemaLine call turns this red (only one line would appear).
    expect(logs.length).toBe(2);
    expect(logs[0]).toBe("[admin] bot-ops.sh schema 1 (panel needs 1)");
    expect(logs[1]).toBe("[admin] docker-compose.yml schema 1 (panel needs 1)");
  });

  test("bot-ops.sh mismatch only -> its OUT OF DATE line + compose's own info line, returns ['bot-ops.sh']", async () => {
    const { logs, errors, log, logError } = capture();
    const runBotOps = async () => ({ exitCode: 0, stdout: '{"schema":2,"composeSchema":1}', stderr: "" });
    const outdatedFiles = await checkBotOpsSchemaStartup(runBotOps, 1, 1, log, logError);
    // Mutation: conflating the two decisions (e.g. one shared "outdated" flag) would either miss
    // this or wrongly also flag docker-compose.yml.
    expect(outdatedFiles).toEqual(["bot-ops.sh"]);
    expect(logs).toEqual(["[admin] docker-compose.yml schema 1 (panel needs 1)"]);
    expect(errors).toEqual(["[admin] bot-ops.sh is OUT OF DATE — re-run ops/install.sh on this instance; panel features may fail (schema 2, panel needs 1)"]);
  });

  test("docker-compose.yml mismatch only -> its OUT OF DATE line + bot-ops.sh's own info line, returns ['docker-compose.yml']", async () => {
    const { logs, errors, log, logError } = capture();
    const runBotOps = async () => ({ exitCode: 0, stdout: '{"schema":1,"composeSchema":null}', stderr: "" });
    const outdatedFiles = await checkBotOpsSchemaStartup(runBotOps, 1, 1, log, logError);
    expect(outdatedFiles).toEqual(["docker-compose.yml"]);
    expect(logs).toEqual(["[admin] bot-ops.sh schema 1 (panel needs 1)"]);
    // got===null even though the version call itself succeeded (a real, valid "composeSchema: null"
    // response — the pre-#178-compose case) still gets the "no schema reported" detail clause,
    // since decideComposeSchema genuinely couldn't determine a real number either way.
    expect(errors).toEqual(["[admin] docker-compose.yml is OUT OF DATE — re-run ops/install.sh on this instance; panel features may fail (schema unknown, panel needs 1; no schema reported)"]);
  });

  test("both mismatch -> two OUT OF DATE lines, returns both names in order", async () => {
    const { logs, errors, log, logError } = capture();
    const runBotOps = async () => ({ exitCode: 0, stdout: '{"schema":2,"composeSchema":2}', stderr: "" });
    const outdatedFiles = await checkBotOpsSchemaStartup(runBotOps, 1, 1, log, logError);
    expect(outdatedFiles).toEqual(["bot-ops.sh", "docker-compose.yml"]);
    expect(logs.length).toBe(0);
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain("bot-ops.sh is OUT OF DATE");
    expect(errors[1]).toContain("docker-compose.yml is OUT OF DATE");
  });

  test("a pre-#173 script's usage error -> BOTH lines OUT OF DATE, both name 'unknown' AND the same real stderr detail", async () => {
    // Round-1 review fix, reused for both files: the version call itself never produced JSON at
    // all, so NEITHER file's real schema is known — both lines must say so, with the same detail.
    const { errors, log, logError } = capture();
    const runBotOps = async () => ({ exitCode: 1, stdout: "", stderr: "bot-ops: usage: bot-ops.sh {status|logs [N]|restart|env-get|env-set}" });
    const outdatedFiles = await checkBotOpsSchemaStartup(runBotOps, 1, 1, log, logError);
    expect(outdatedFiles).toEqual(["bot-ops.sh", "docker-compose.yml"]);
    expect(errors.length).toBe(2);
    for (const line of errors) {
      expect(line).toContain("OUT OF DATE");
      expect(line).toContain("schema unknown");
      // Mutation: discarding result.stderr here would make this the SAME message as any other
      // unrelated failure, sending an operator to re-run install.sh for the wrong reason.
      expect(line).toContain("bot-ops: usage: bot-ops.sh {status|logs [N]|restart|env-get|env-set}");
    }
  });

  test("an UNRELATED precondition failure (e.g. missing jq, no stderr text) -> distinguishable from a real usage error", async () => {
    const { errors, log, logError } = capture();
    const runBotOps = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    await checkBotOpsSchemaStartup(runBotOps, 1, 1, log, logError);
    expect(errors[0]).toContain("no schema reported");
    expect(errors[1]).toContain("no schema reported");
  });

  test("a timed-out version call is named as a timeout on BOTH lines, not conflated with a schema mismatch", async () => {
    const { errors, log, logError } = capture();
    const runBotOps = async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: true });
    await checkBotOpsSchemaStartup(runBotOps, 1, 1, log, logError);
    // Mutation: ignoring result.timedOut (the MINOR gap the round-1 correctness reviewer named)
    // would fall through to "no schema reported" instead of naming the real cause.
    expect(errors[0]).toContain("version timed out");
    expect(errors[0]).not.toContain("no schema reported");
    expect(errors[1]).toContain("version timed out");
  });

  test("passes args:['version'] to runBotOps, contentType application/json", async () => {
    let seen: unknown;
    const runBotOps = async (invocation: unknown) => {
      seen = invocation;
      return { exitCode: 0, stdout: '{"schema":1,"composeSchema":1}', stderr: "" };
    };
    await checkBotOpsSchemaStartup(runBotOps, 1, 1);
    expect(seen).toEqual({ args: ["version"], contentType: "application/json" });
  });
});

describe("mergeStatusOutdated (#173/#178)", () => {
  test("empty outdatedFiles -> stdout passed through byte-for-byte, unchanged", () => {
    const stdout = '{"running":true,"realmStatus":"UP"}';
    // Mutation: always merging (dropping the length check) would add fields even when fine.
    expect(mergeStatusOutdated(stdout, [])).toBe(stdout);
  });
  test("one outdated file -> botOpsOutdated:true + outdatedFiles merged into the existing status fields", () => {
    const merged = JSON.parse(mergeStatusOutdated('{"running":true,"realmStatus":"UP"}', ["bot-ops.sh"]));
    expect(merged).toEqual({ running: true, realmStatus: "UP", botOpsOutdated: true, outdatedFiles: ["bot-ops.sh"] });
  });
  test("both outdated files -> outdatedFiles carries both names, never collapsed to one", () => {
    const merged = JSON.parse(mergeStatusOutdated('{"running":true}', ["bot-ops.sh", "docker-compose.yml"]));
    expect(merged).toEqual({ running: true, botOpsOutdated: true, outdatedFiles: ["bot-ops.sh", "docker-compose.yml"] });
  });
  test("a genuinely broken stdout stays as-is rather than throwing", () => {
    expect(mergeStatusOutdated("not json", ["bot-ops.sh"])).toBe("not json");
    expect(mergeStatusOutdated("[]", ["bot-ops.sh"])).toBe("[]"); // an array, not an object — left alone
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

  // #165: the admin tab follows the INSTALLED version, not the index's current one.
  describe("#165 installedVersion pinning", () => {
    const pinnedIdx = (): PluginIndex => ({
      schemaVersion: 1,
      plugins: [{
        name: "warbandeer",
        version: "1.1.0",
        package: "@rackbops/plugin-warbandeer",
        adminUrl: "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js",
        adminApiVersion: ADMIN_API_VERSION,
      }],
    });

    test("a pinned version that differs from the manifest's derives that version's own bundle URL", () => {
      // Mutation: ignoring installedVersion serves the manifest's (wrong) version.
      expect(resolveAdminBundleUrl(pinnedIdx(), "warbandeer", "1.0.0")).toBe(
        "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.0.0/dist/admin.js",
      );
    });
    test("a pinned version equal to the manifest's uses today's path (manifest URL + its gate)", () => {
      expect(resolveAdminBundleUrl(pinnedIdx(), "warbandeer", "1.1.0")).toBe(
        "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js",
      );
    });
    test("no installedVersion behaves exactly as before (manifest URL + its gate)", () => {
      expect(resolveAdminBundleUrl(pinnedIdx(), "warbandeer")).toBe(
        "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js",
      );
    });
    test.each([
      ["a non-semver string", "not-a-version"],
      ["a .. traversal segment", "1.0.0/../../secret"],
      ["a percent-encoded traversal", "1.0.0/%2e%2e/secret"],
      ["an npm scope injection", "1.0.0@other"],
      ["a path with a slash", "1.0.0/extra"],
      ["whitespace", " 1.0.0"],
    ])("a malformed installedVersion (%s) is treated as absent, not trusted", (_label, bad) => {
      // Mutation: dropping the semver regex would let this flow into the URL template untested.
      // Falls back to the manifest's own (safe) URL — never derives a URL from the bad string.
      expect(resolveAdminBundleUrl(pinnedIdx(), "warbandeer", bad)).toBe(
        "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js",
      );
    });
    test("a pinned version with no `package` on the manifest entry can't be derived", () => {
      const noPkg: PluginIndex = {
        schemaVersion: 1,
        plugins: [{ name: "warbandeer", version: "1.1.0", adminUrl: "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js", adminApiVersion: ADMIN_API_VERSION }],
      };
      expect(resolveAdminBundleUrl(noPkg, "warbandeer", "1.0.0")).toBeNull();
    });
    test("the manifest's own adminApiVersion gate is SKIPPED for a genuinely pinned (differing) version", () => {
      const mismatched: PluginIndex = {
        schemaVersion: 1,
        plugins: [{
          name: "warbandeer", version: "1.1.0", package: "@rackbops/plugin-warbandeer",
          adminUrl: "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js",
          adminApiVersion: ADMIN_API_VERSION + 99, // the CURRENT bundle is incompatible
        }],
      };
      // Mutation: keeping the manifest gate here would 404 a perfectly-servable pinned bundle.
      expect(resolveAdminBundleUrl(mismatched, "warbandeer", "1.0.0")).toBe(
        "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.0.0/dist/admin.js",
      );
      // But the SAME manifest, pinned to the version THAT gate describes, still refuses it.
      // Mutation: inverting the !== to === (or dropping the branch) would serve this too.
      expect(resolveAdminBundleUrl(mismatched, "warbandeer", "1.1.0")).toBeNull();
      expect(resolveAdminBundleUrl(mismatched, "warbandeer")).toBeNull();
    });
    test("the post-new URL prefix re-assert catches a traversal-shaped `package` field on the manifest", () => {
      // The strict semver regex fully sanitizes `pinned` itself, so THIS defense-in-depth line is only
      // reachable via a hostile `package` field (a pre-existing, not #165-introduced, manifest-trust
      // assumption also present in resolvePluginProxyUrl below).
      const hostilePackage: PluginIndex = {
        schemaVersion: 1,
        plugins: [{
          name: "warbandeer", version: "1.1.0", package: "../../evil",
          adminUrl: "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js",
          adminApiVersion: ADMIN_API_VERSION,
        }],
      };
      // Mutation: dropping the re-assert would return the un-verified candidate URL instead of null.
      expect(resolveAdminBundleUrl(hostilePackage, "warbandeer", "1.0.0")).toBeNull();
    });
    test("the manifest's own URL must still pass https+allowlist even when pinning a different version", () => {
      const offHost: PluginIndex = {
        schemaVersion: 1,
        plugins: [{ name: "warbandeer", version: "1.1.0", package: "@rackbops/plugin-warbandeer", adminUrl: "https://evil.example.com/admin.js", adminApiVersion: ADMIN_API_VERSION }],
      };
      // Mutation: skipping the manifest sanity gate when a pin is present lets an unlisted manifest
      // URL through as long as SOME installedVersion is supplied.
      expect(resolveAdminBundleUrl(offHost, "warbandeer", "1.0.0")).toBeNull();
    });
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

  // #165: the asset must come from the SAME published version as the bundle asking for it.
  describe("#165 installedVersion pinning", () => {
    test("a valid installedVersion overrides the manifest's entry.version in the package prefix", () => {
      // Mutation: ignoring installedVersion serves the (wrong) manifest-current asset instead.
      expect(resolvePluginProxyUrl(idx, "wow", "dist/realms.json", "1.0.0")).toBe(
        "https://cdn.jsdelivr.net/npm/@rackbops/plugin-wow@1.0.0/dist/realms.json",
      );
    });
    test("no installedVersion behaves exactly as before (entry.version)", () => {
      expect(resolvePluginProxyUrl(idx, "wow", "dist/realms.json")).toBe(
        "https://cdn.jsdelivr.net/npm/@rackbops/plugin-wow@1.2.3/dist/realms.json",
      );
    });
    test.each([
      ["a non-semver string", "not-a-version"],
      ["a .. traversal segment", "1.0.0/../../secret"],
      ["a percent-encoded traversal", "1.0.0/%2e%2e/secret"],
      ["an npm scope injection", "1.0.0@other"],
    ])("a malformed installedVersion (%s) falls back to entry.version, never trusted raw", (_label, bad) => {
      // Mutation: dropping the semver validation on installedVersion here would let it flow straight
      // into the prefix template UNTESTED by the path-traversal cases above (which target `path`, not
      // this parameter).
      expect(resolvePluginProxyUrl(idx, "wow", "dist/realms.json", bad)).toBe(
        "https://cdn.jsdelivr.net/npm/@rackbops/plugin-wow@1.2.3/dist/realms.json",
      );
    });
    test("existing traversal/SSRF gate on `path` is unaffected by a valid installedVersion", () => {
      expect(resolvePluginProxyUrl(idx, "wow", "../secret", "1.0.0")).toBeNull();
    });
  });
});

describe("serveAdminBundle / servePluginProxy delivery routes (#124, #165)", () => {
  const TOKEN = "the-real-token";
  const bundleUrl = "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/admin.js";
  const pinnedBundleUrl = "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.0.0/dist/admin.js";
  const index: PluginIndex = {
    schemaVersion: 1,
    plugins: [{ name: "warbandeer", version: "1.1.0", package: "@rackbops/plugin-warbandeer", adminUrl: bundleUrl, adminApiVersion: 1 }],
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
        url === bundleUrl || url === pinnedBundleUrl
          ? okAsset("export const adminApiVersion=1;export function mountAdmin(){return()=>{}}")
          : failAsset,
      ...over,
    };
  }
  // A route call always needs a URL (for the ?v= query param) — a small helper to build one for the
  // bundle route, matching how the proxy route below is already called.
  const bundleReq = (path: string) => new URL("http://x" + path);

  test("GET /plugin-admin/<name>.js serves the bundle same-origin as JS", async () => {
    const res = await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js"), cfg());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/javascript");
    expect(await res.text()).toContain("mountAdmin");
  });
  test("404 when the plugin ships no admin bundle", async () => {
    expect((await serveAdminBundle(bundleReq("/plugin-admin/ghost.js"), cfg())).status).toBe(404);
  });
  test("404 when the index/fetcher deps are absent", async () => {
    expect((await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js"), cfg({ fetchAdminAsset: undefined }))).status).toBe(404);
    expect((await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js"), cfg({ listPluginIndex: undefined }))).status).toBe(404);
  });
  test("502 when the upstream fetch fails", async () => {
    expect((await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js"), cfg({ fetchAdminAsset: async () => failAsset }))).status).toBe(502);
  });
  // #165: a real upstream 404 (a candidate URL that resolves but jsDelivr doesn't have — exactly a
  // pinned older version that predates the plugin's first admin bundle) must surface as 404, not a
  // flat 502, so the client's describeBundleFailure renders its "no settings tab at this version"
  // note instead of the generic "couldn't load" one.
  test("a genuine upstream 404 (asset.status===404) propagates as 404, distinct from a 502 error", async () => {
    const upstream404: AdminAssetResult = { ok: false, status: 404, contentType: "", body: "", error: "upstream 404" };
    const res = await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js"), cfg({ fetchAdminAsset: async () => upstream404 }));
    // Mutation: collapsing every !asset.ok to 502 (the pre-fix bug) would return 502 here instead.
    expect(res.status).toBe(404);
  });
  test("an off-host adminUrl is refused (404), never proxied", async () => {
    const offHost: PluginIndex = { schemaVersion: 1, plugins: [{ name: "warbandeer", version: "1.1.0", adminApiVersion: 1, adminUrl: "https://evil.example.com/admin.js" }] };
    expect((await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js"), cfg({ listPluginIndex: async () => offHost }))).status).toBe(404);
  });
  test("a version-incompatible bundle is refused (404) — not fetched or served", async () => {
    const incompat: PluginIndex = { schemaVersion: 1, plugins: [{ name: "warbandeer", version: "1.1.0", adminApiVersion: 99, adminUrl: bundleUrl }] };
    expect((await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js"), cfg({ listPluginIndex: async () => incompat }))).status).toBe(404);
  });

  // #165
  test("?v=<installedVersion> serves that version's own bundle, not the manifest's current one", async () => {
    const res = await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js?v=1.0.0"), cfg());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mountAdmin");
  });
  test("?v= equal to the manifest's current version behaves exactly like no ?v=", async () => {
    const res = await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js?v=1.1.0"), cfg());
    expect(res.status).toBe(200);
  });
  test("a malformed ?v= is 400, never a silent fallback to the manifest's version", async () => {
    let fetched = false;
    const c = cfg({ fetchAdminAsset: async () => { fetched = true; return okAsset("x"); } });
    const res = await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js?v=not-a-version"), c);
    // Mutation: falling back to resolveAdminBundleUrl(index, name) on a malformed v would serve 200
    // here instead of refusing — re-creating exactly the installed/current split #165 exists to fix.
    expect(res.status).toBe(400);
    expect(fetched).toBe(false);
  });
  test("a pinned version whose manifest current-bundle is version-incompatible is still served", async () => {
    // The CURRENT bundle (1.1.0) is incompatible with this panel, but the pinned 1.0.0 bundle isn't
    // gated by that — its own export (checked client-side) is the authority.
    const incompatCurrent: PluginIndex = { schemaVersion: 1, plugins: [{ name: "warbandeer", version: "1.1.0", package: "@rackbops/plugin-warbandeer", adminUrl: bundleUrl, adminApiVersion: 99 }] };
    const res = await serveAdminBundle(bundleReq("/plugin-admin/warbandeer.js?v=1.0.0"), cfg({ listPluginIndex: async () => incompatCurrent }));
    expect(res.status).toBe(200);
  });

  test("GET /api/plugin-proxy/<name>?path= serves a scoped asset with its content-type", async () => {
    const proxied = "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.1.0/dist/realms.json";
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
  // #165: same status-propagation fix as serveAdminBundle — a genuine upstream 404 for a data asset
  // (e.g. missing at this pinned version) surfaces as 404, not a flat 502.
  test("a genuine upstream 404 (asset.status===404) propagates as 404, distinct from a 502 error", async () => {
    const upstream404: AdminAssetResult = { ok: false, status: 404, contentType: "", body: "", error: "upstream 404" };
    const res = await servePluginProxy(new URL("http://x/api/plugin-proxy/warbandeer?path=dist/realms.json"), cfg({ fetchAdminAsset: async () => upstream404 }));
    // Mutation: collapsing every !asset.ok to 502 (the pre-fix bug) would return 502 here instead.
    expect(res.status).toBe(404);
  });
  // #165
  test("?v=<installedVersion> scopes the proxied asset to that version's package prefix", async () => {
    const pinnedAsset = "https://cdn.jsdelivr.net/npm/@rackbops/plugin-warbandeer@1.0.0/dist/realms.json";
    const c = cfg({ fetchAdminAsset: async (url) => (url === pinnedAsset ? okAsset('{"ok":true}', "application/json") : failAsset) });
    const res = await servePluginProxy(new URL("http://x/api/plugin-proxy/warbandeer?path=dist/realms.json&v=1.0.0"), c);
    expect(res.status).toBe(200);
  });
  test("a malformed ?v= on the proxy route is 400, never a silent fallback", async () => {
    let fetched = false;
    const c = cfg({ fetchAdminAsset: async () => { fetched = true; return okAsset("x"); } });
    const res = await servePluginProxy(new URL("http://x/api/plugin-proxy/warbandeer?path=dist/realms.json&v=not-a-version"), c);
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

// #173/#178: the drift-banner text composition is lifted from index.html between its own
// OUTDATED_BANNER_HELPERS markers, same lift pattern as PLUGIN_ADMIN_HELPERS below — the panel's
// exact banner wording (which file(s), singular vs plural) is pinned here, not just eyeballed.
describe("describeOutdatedBanner (lifted from index.html, #173/#178)", () => {
  const bannerIndexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const bannerSrc = bannerIndexSrc.match(/\/\/ OUTDATED_BANNER_HELPERS:begin\n([\s\S]*?)\n\s*\/\/ OUTDATED_BANNER_HELPERS:end/)?.[1];

  test("the marked block is present", () => {
    expect(bannerSrc).toBeTruthy();
  });

  const describeOutdatedBanner = new Function(`"use strict";\n${bannerSrc ?? ""}\nreturn describeOutdatedBanner;`)() as (
    outdatedFiles: string[] | undefined,
  ) => string | null;

  test("no outdated files (absent or empty) -> null, so the caller hides the banner", () => {
    // Mutation: returning a non-null value here for an empty/absent list would show a banner when
    // both files are current.
    expect(describeOutdatedBanner(undefined)).toBeNull();
    expect(describeOutdatedBanner([])).toBeNull();
  });

  test("one file -> names it, singular 'is'", () => {
    expect(describeOutdatedBanner(["bot-ops.sh"])).toBe(
      "bot-ops.sh is out of date on this instance — re-run ops/install.sh; panel features may fail.",
    );
    expect(describeOutdatedBanner(["docker-compose.yml"])).toBe(
      "docker-compose.yml is out of date on this instance — re-run ops/install.sh; panel features may fail.",
    );
  });

  test("both files -> names both, plural 'are' — never conflated into a single generic sentence", () => {
    // Mutation: hardcoding "bot-ops.sh" regardless of the list, or always using singular "is", both
    // turn this red.
    expect(describeOutdatedBanner(["bot-ops.sh", "docker-compose.yml"])).toBe(
      "bot-ops.sh and docker-compose.yml are out of date on this instance — re-run ops/install.sh; panel features may fail.",
    );
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
  const bundleMountDecision = new Function(`"use strict";\n${src ?? ""}\nreturn bundleMountDecision;`)() as (
    mod: unknown,
    panelVer: number,
  ) => { kind: string; declared?: number };
  const describeBundleFailure = new Function(`"use strict";\n${src ?? ""}\nreturn describeBundleFailure;`)() as (
    status: number,
    installedVersion: string,
    latestVersion: string | undefined,
  ) => string;
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

  test("adminTabState (#165): none without a bundle/when disabled; pending with no installedVersion", () => {
    expect(adminTabState({ enabled: false, adminUrl: "u", adminApiVersion: 1, installedVersion: "1.0.0", latestVersion: "1.0.0" }, 1).kind).toBe("none"); // not enabled
    expect(adminTabState({ enabled: true, adminApiVersion: 1, installedVersion: "1.0.0", latestVersion: "1.0.0" }, 1).kind).toBe("none"); // no adminUrl
    // Mutation: dropping this check would mount the manifest's version over code that isn't running.
    expect(adminTabState({ enabled: true, adminUrl: "u", adminApiVersion: 1, latestVersion: "1.0.0" }, 1)).toEqual({ kind: "pending" });
  });
  test("adminTabState (#165): the manifest gate applies ONLY when installed === latest", () => {
    // installed === latest (running the index's current bundle) → the manifest's adminApiVersion IS
    // describing what will actually be fetched, so a gap there is a real mismatch.
    // Mutation: inverting !== to === (or dropping the branch) would mount an incompatible bundle.
    expect(adminTabState({ enabled: true, adminUrl: "u", adminApiVersion: 2, installedVersion: "1.0.0", latestVersion: "1.0.0" }, 1))
      .toEqual({ kind: "mismatch", declared: 2, panel: 1 });
    expect(adminTabState({ enabled: true, adminUrl: "u", adminApiVersion: 1, installedVersion: "1.0.0", latestVersion: "1.0.0" }, 1))
      .toEqual({ kind: "mount" });
    // installed !== latest (pinned to an older/different version) → the manifest's gate describes a
    // DIFFERENT bundle, so it must NOT block the mount here even though it's numerically a "mismatch";
    // the client checks the fetched bundle's own declared version instead (bundleMountDecision).
    // Mutation: dropping the installed===latest condition would refuse this legitimate pinned mount.
    expect(adminTabState({ enabled: true, adminUrl: "u", adminApiVersion: 99, installedVersion: "1.0.0", latestVersion: "1.1.0" }, 1))
      .toEqual({ kind: "mount" });
  });

  test("bundleMountDecision (#165): mounts only when the bundle's OWN declared version matches", () => {
    // Mutation: mounting regardless of the declared version runs code built against a different
    // contract.
    expect(bundleMountDecision({ adminApiVersion: 1 }, 1)).toEqual({ kind: "mount" });
    expect(bundleMountDecision({ adminApiVersion: 2 }, 1)).toEqual({ kind: "mismatch", declared: 2 });
    // A bundle missing the export entirely is treated as a mismatch, not mounted — every published
    // admin bundle must declare it.
    expect(bundleMountDecision({}, 1)).toEqual({ kind: "mismatch", declared: undefined });
    expect(bundleMountDecision(null, 1)).toEqual({ kind: "mismatch", declared: undefined });
  });

  test("describeBundleFailure (#165): names both versions on 404; a generic note otherwise", () => {
    // Mutation: swapping the branches would put version numbers in a plain fetch-error note, or a
    // generic note where the "no settings tab yet" one belongs.
    expect(describeBundleFailure(404, "1.0.0", "1.1.0")).toContain("v1.0.0");
    expect(describeBundleFailure(404, "1.0.0", "1.1.0")).toContain("v1.1.0");
    expect(describeBundleFailure(404, "1.0.0", "1.1.0")).not.toContain("v404");
    const other = describeBundleFailure(502, "1.0.0", "1.1.0");
    expect(other).not.toContain("1.0.0");
    expect(other).not.toContain("1.1.0");
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

// ---------------------------------------------------------------------------------------------------
// #242: the panel's routing API. Five routes (GET /api/routing, POST /api/routing, POST /api/webhooks,
// DELETE /api/webhooks/<channel id>, POST /api/discovery/refresh); the four writes are `plugin-request`
// actions queued through bot-ops.sh, with `requestedBy` from the verified identity and an `id` the SERVER
// mints. The webhook URL is a secret: body -> parsed value -> stdin, and nowhere else.
// ---------------------------------------------------------------------------------------------------
const RT_GUILD_A = "111111111111111111";
const RT_GUILD_B = "222222222222222222";
const RT_CHAN_1 = "333333333333333331";
const RT_CHAN_2 = "333333333333333332";
const RT_HOOK_ID = "444444444444444444";
// A distinctive token in a webhook URL: found anywhere it must not be, it is a leak. Like a real token it
// holds `-` and `_` (a class that forgot either would let the tail of a real token through), and it is
// long enough that a PARTIAL leak (a run of it) is as visible as the whole.
const RT_HOOK_TOKEN = "TOKENzq9f3k2m8-v1w7p4r6t5_y0uabcdefghij-XYZ_5aB7cD9eF3-kLmNoPqRs_TuVw";
const RT_HOOK_URL = `https://discord.com/api/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`;
/** Every 8-character run of `secret`: if any of them is in a text, a piece of the secret is in it. */
const rtWindows = (secret: string, n = 8): string[] => Array.from({ length: secret.length - n + 1 }, (_, i) => secret.slice(i, i + n));
/** The first 8-character run of `secret` found in `text`, or undefined. */
const rtLeakedRun = (text: string, secret: string = RT_HOOK_TOKEN): string | undefined => rtWindows(secret).find((run) => text.includes(run));

describe("parseRoutingSetInput (#242)", () => {
  const body = (servers: unknown, over: Record<string, unknown> = {}) => ({ plugin: "music", servers, ...over });

  test('accepts "all", a channel list, a postTo, and an empty servers object', () => {
    expect(
      parseRoutingSetInput(
        body({ [RT_GUILD_A]: { commands: "all" }, [RT_GUILD_B]: { commands: [RT_CHAN_1, RT_CHAN_2], postTo: RT_CHAN_1 } }),
      ),
    ).toEqual({
      ok: true,
      input: {
        plugin: "music",
        servers: { [RT_GUILD_A]: { commands: "all" }, [RT_GUILD_B]: { commands: [RT_CHAN_1, RT_CHAN_2], postTo: RT_CHAN_1 } },
      },
    });
    // An empty servers object is valid: it places the plugin nowhere.
    expect(parseRoutingSetInput(body({}))).toEqual({ ok: true, input: { plugin: "music", servers: {} } });
  });

  test("the shortest (5 digits) and longest (25 digits) ids are accepted for a server, a channel and a postTo", () => {
    for (const id of ["12345", "1".repeat(25)]) {
      expect(parseRoutingSetInput(body({ [id]: { commands: [id], postTo: id } })), id).toEqual({
        ok: true,
        input: { plugin: "music", servers: { [id]: { commands: [id], postTo: id } } },
      });
    }
  });

  test("body is not a JSON object", () => {
    for (const raw of [null, undefined, "x", 5, true, [], [body({})]]) {
      expect(parseRoutingSetInput(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: "body is not a JSON object" });
    }
  });

  test("bad plugin name", () => {
    for (const plugin of [undefined, null, 5, "", "Music", "a_b", "1music", "music/../x", ["music"]]) {
      expect(parseRoutingSetInput({ plugin, servers: {} }), JSON.stringify(plugin)).toEqual({ ok: false, reason: "bad plugin name" });
    }
  });

  test("servers must be an object", () => {
    for (const servers of [undefined, null, [], "all", 5, [{ commands: "all" }]]) {
      expect(parseRoutingSetInput(body(servers)), JSON.stringify(servers)).toEqual({ ok: false, reason: "servers must be an object" });
    }
  });

  test("bad server id", () => {
    for (const id of ["main", "1234", "1".repeat(26), "-1", "12 345", ""]) {
      expect(parseRoutingSetInput(body({ [id]: { commands: "all" } })), id).toEqual({ ok: false, reason: "bad server id" });
    }
  });

  test('commands must be "all" or a non-empty list of channel ids', () => {
    const reason = 'commands must be "all" or a non-empty list of channel ids';
    for (const entry of [{}, { commands: "none" }, { commands: [] }, { commands: [7] }, { commands: ["abc"] }, { commands: [RT_CHAN_1, 7] }, { commands: ["1234"] }, { commands: null }, { commands: {} }, "all", 7, null, []]) {
      expect(parseRoutingSetInput(body({ [RT_GUILD_A]: entry })), JSON.stringify(entry)).toEqual({ ok: false, reason });
    }
  });

  test("bad postTo", () => {
    for (const postTo of [7, "x", "1234", null, {}, [], "", [RT_CHAN_1]]) {
      expect(parseRoutingSetInput(body({ [RT_GUILD_A]: { commands: "all", postTo } })), JSON.stringify(postTo)).toEqual({ ok: false, reason: "bad postTo" });
    }
    // An absent postTo is not a bad one.
    expect(parseRoutingSetInput(body({ [RT_GUILD_A]: { commands: "all" } })).ok).toBe(true);
  });

  test("a reason never contains the value it refused", () => {
    const secret = "SECRET-VALUE-xyz";
    for (const raw of [
      { plugin: secret, servers: {} },
      { plugin: "music", servers: { [secret]: { commands: "all" } } },
      { plugin: "music", servers: { [RT_GUILD_A]: { commands: secret } } },
      { plugin: "music", servers: { [RT_GUILD_A]: { commands: [secret] } } },
      { plugin: "music", servers: { [RT_GUILD_A]: { commands: "all", postTo: secret } } },
      { plugin: "music", servers: secret },
    ]) {
      const result = parseRoutingSetInput(raw);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  test("unknown keys at every level are dropped: the input is rebuilt, not passed on", () => {
    const raw = {
      plugin: "music",
      servers: { [RT_GUILD_A]: { commands: [RT_CHAN_1], postTo: RT_CHAN_2, extra: 1, url: RT_HOOK_URL } },
      extra: { nested: true },
      requestedBy: "email:attacker@evil",
      id: "attacker-chosen-id",
    };
    const result = parseRoutingSetInput(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.input)).toEqual(["plugin", "servers"]);
    expect(result.input.servers).toEqual({ [RT_GUILD_A]: { commands: [RT_CHAN_1], postTo: RT_CHAN_2 } });
    expect(Object.keys(result.input.servers[RT_GUILD_A]!)).toEqual(["commands", "postTo"]);
    // A copy, not the caller's arrays or objects.
    expect(result.input.servers).not.toBe(raw.servers);
    expect(result.input.servers[RT_GUILD_A]!.commands).not.toBe(raw.servers[RT_GUILD_A]!.commands);
    expect(JSON.stringify(result)).not.toContain(RT_HOOK_TOKEN);
  });

  test("a __proto__ server key is refused, not assigned", () => {
    for (const key of ["__proto__", "constructor", "prototype", "toString"]) {
      const raw = JSON.parse(`{"plugin":"music","servers":{"${key}":{"commands":"all"}}}`);
      expect(parseRoutingSetInput(raw), key).toEqual({ ok: false, reason: "bad server id" });
    }
    // Beside a good one, so it is not just the only key that fails; and nothing leaked onto Object.prototype.
    const mixed = JSON.parse(`{"plugin":"music","servers":{"${RT_GUILD_A}":{"commands":"all"},"__proto__":{"commands":"all","polluted":true}}}`);
    expect(parseRoutingSetInput(mixed)).toEqual({ ok: false, reason: "bad server id" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).commands).toBeUndefined();
  });

  test("a requestedBy or id in the body is dropped", () => {
    const result = parseRoutingSetInput(body({}, { requestedBy: "email:attacker@evil", id: "attacker-chosen-id" }));
    expect(result).toEqual({ ok: true, input: { plugin: "music", servers: {} } });
  });
});

describe("parseWebhookAddInput (#242)", () => {
  test("accepts discord.com, discordapp.com, canary, ptb and a versioned path", () => {
    const token = "abcdefghij0123456789-_ABCDE";
    for (const url of [
      `https://discord.com/api/webhooks/${RT_HOOK_ID}/${token}`,
      `https://discordapp.com/api/webhooks/${RT_HOOK_ID}/${token}`,
      `https://canary.discord.com/api/webhooks/${RT_HOOK_ID}/${token}`,
      `https://ptb.discord.com/api/webhooks/${RT_HOOK_ID}/${token}`,
      `https://discord.com/api/v10/webhooks/${RT_HOOK_ID}/${token}`,
      `https://discordapp.com/api/v9/webhooks/12345/${"a".repeat(20)}`,
      `https://discord.com/api/webhooks/${"1".repeat(25)}/${token}`,
    ]) {
      expect(parseWebhookAddInput({ url }), url).toEqual({ ok: true, url });
    }
  });

  test("a real-sized url is accepted and a url over 512 characters is refused, whatever it looks like", () => {
    // The longest a real one gets: canary, versioned, a 25-digit id, a 68-character token.
    const longest = `https://canary.discord.com/api/v10/webhooks/${"1".repeat(25)}/${"aZ-_".repeat(17)}`;
    expect(longest.length).toBeLessThan(200);
    expect(parseWebhookAddInput({ url: longest })).toEqual({ ok: true, url: longest });
    // Exactly at the cap, and one over: the cap is on the trimmed url.
    const prefix = `https://discord.com/api/webhooks/${RT_HOOK_ID}/`;
    const atCap = `${prefix}${"a".repeat(512 - prefix.length)}`;
    expect(atCap).toHaveLength(512);
    expect(parseWebhookAddInput({ url: atCap })).toEqual({ ok: true, url: atCap });
    expect(parseWebhookAddInput({ url: `${atCap}a` })).toEqual({ ok: false, reason: "bad webhook url" });
    expect(parseWebhookAddInput({ url: `  ${atCap}\n` })).toEqual({ ok: true, url: atCap });
    // A multi-megabyte "token" never gets as far as a pattern match, or bot-ops.sh.
    const huge = `${prefix}${"a".repeat(5_000_000)}`;
    const started = performance.now();
    expect(parseWebhookAddInput({ url: huge })).toEqual({ ok: false, reason: "bad webhook url" });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("trims whitespace, and the trimmed string is what comes back", () => {
    expect(parseWebhookAddInput({ url: `  ${RT_HOOK_URL}\n` })).toEqual({ ok: true, url: RT_HOOK_URL });
    expect(parseWebhookAddInput({ url: `\t${RT_HOOK_URL}\r\n` })).toEqual({ ok: true, url: RT_HOOK_URL });
  });

  test("refuses http, another host, a missing token, a query string, a non-string", () => {
    const bad = [
      RT_HOOK_URL.replace("https://", "http://"),
      `https://example.com/api/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://discord.com.evil.example/api/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://evil.example/https://discord.com/api/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://discord.com/api/webhooks/${RT_HOOK_ID}`,
      `https://discord.com/api/webhooks/${RT_HOOK_ID}/`,
      `https://discord.com/api/webhooks/${RT_HOOK_ID}/${"a".repeat(19)}`,
      `https://discord.com/api/webhooks/1234/${RT_HOOK_TOKEN}`,
      `${RT_HOOK_URL}?wait=true`,
      `${RT_HOOK_URL}/`,
      `${RT_HOOK_URL}#x`,
      `${RT_HOOK_URL} extra`,
      `${RT_HOOK_URL.slice(0, 40)}\n${RT_HOOK_URL.slice(40)}`,
      `https://user@discord.com/api/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      // Every dot in the host is a dot, not "any character"; the version segment is `v` and digits.
      `https://discordXcom/api/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://canaryXdiscord.com/api/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://ptbXdiscord.com/api/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://discord.com/apiX/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://discord.com/api/vX/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://discord.com/api/v/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://discord.com/api/v1x0/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://discord.com/api/webhooksX/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://discordapp.org/api/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      `https://canary.ptb.discord.com/api/webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`,
      "",
      "   ",
    ];
    for (const url of bad) expect(parseWebhookAddInput({ url }), url).toEqual({ ok: false, reason: "bad webhook url" });
    for (const url of [undefined, null, 5, true, [RT_HOOK_URL], { url: RT_HOOK_URL }]) {
      expect(parseWebhookAddInput({ url }), JSON.stringify(url)).toEqual({ ok: false, reason: "bad webhook url" });
    }
    expect(parseWebhookAddInput({})).toEqual({ ok: false, reason: "bad webhook url" });
  });

  test("body is not a JSON object", () => {
    for (const raw of [null, undefined, "x", 5, [], [{ url: RT_HOOK_URL }]]) {
      expect(parseWebhookAddInput(raw), JSON.stringify(raw)).toEqual({ ok: false, reason: "body is not a JSON object" });
    }
  });

  test("the reason never contains the value, whatever is wrong with it", () => {
    for (const url of [RT_HOOK_URL.replace("https://", "http://"), `${RT_HOOK_URL}?wait=true`, `${RT_HOOK_URL}x y`, RT_HOOK_TOKEN]) {
      const result = parseWebhookAddInput({ url });
      expect(result).toEqual({ ok: false, reason: "bad webhook url" });
      expect(JSON.stringify(result)).not.toContain(RT_HOOK_TOKEN);
    }
  });

  test("only the url is read: other keys never come back", () => {
    const result = parseWebhookAddInput({ url: RT_HOOK_URL, requestedBy: "email:attacker@evil", id: "attacker-chosen-id", channelId: RT_CHAN_1 });
    expect(result).toEqual({ ok: true, url: RT_HOOK_URL });
  });
});

describe("redactWebhookUrls (#242)", () => {
  // Built from character codes: a `backslash u 0 0 2 f` typed into an editor or a tool can be turned into
  // the character it stands for, and then a case would only be testing a plain slash.
  const bs = String.fromCharCode(92);
  const u = (hex: string) => `${bs}u${hex}`;
  const ODD = "aaaaaaaaaa.bbbbbbbbbb"; // a token with a character no token has, so the path pattern cannot help
  const T = RT_HOOK_TOKEN;
  const ID = RT_HOOK_ID;
  // [name, the url as it might appear, the secret that must not survive]
  const forms: [string, string, string][] = [
    ["http", `http://discord.com/api/webhooks/${ID}/${T}`, T],
    ["https", `https://discord.com/api/webhooks/${ID}/${T}`, T],
    ["upper case", `HTTPS://DISCORD.COM/API/WEBHOOKS/${ID}/${T}`, T],
    ["mixed case", `Https://Discord.Com/Api/Webhooks/${ID}/${T}`, T],
    ["versioned", `https://discord.com/api/v10/webhooks/${ID}/${T}`, T],
    ["discordapp", `https://discordapp.com/api/webhooks/${ID}/${T}`, T],
    ["canary", `https://canary.discord.com/api/webhooks/${ID}/${T}`, T],
    ["ptb", `https://ptb.discord.com/api/webhooks/${ID}/${T}`, T],
    ["a port", `https://discord.com:443/api/webhooks/${ID}/${T}`, T],
    ["a doubled slash", `https://discord.com//api/webhooks/${ID}/${T}`, T],
    ["a trailing dot", `https://discord.com./api/webhooks/${ID}/${T}`, T],
    ["no host", `/api/webhooks/${ID}/${T}`, T],
    ["just the path", `webhooks/${ID}/${T}`, T],
    ["percent-encoded slashes", `https:%2F%2Fdiscord.com%2Fapi%2Fwebhooks%2F${ID}%2F${T}`, T],
    ["json-escaped slashes", `https:${bs}/${bs}/discord.com${bs}/api${bs}/webhooks${bs}/${ID}${bs}/${T}`, T],
    ["a unicode-escaped letter in the host", `https://${u("0064")}iscord.com/api/webhooks/${ID}/${T}`, T],
    ["a unicode-escaped dot", `https://discord${u("002e")}com/api/webhooks/${ID}/${T}`, T],
    ["unicode-escaped slashes", `https:${u("002f")}${u("002f")}discord.com${u("002f")}api${u("002f")}webhooks${u("002f")}${ID}${u("002f")}${T}`, T],
    ["unicode-escaped slashes in upper-case hex", `https:${u("002F")}${u("002F")}discord.com${u("002F")}api${u("002F")}webhooks${u("002F")}${ID}${u("002F")}${T}`, T],
    ["a unicode-escaped letter in webhooks", `https://discord.com/api/${u("0077")}ebhooks/${ID}/${T}`, T],
    ["a percent-encoded letter in webhooks", `https://discord.com/api/%77ebhooks/${ID}/${T}`, T],
    ["a percent-encoded letter, lower-case hex", `https://discord.com/api/webhoo%6bs/${ID}/${T}`, T],
    ["a percent-encoded letter, upper-case hex", `https://discord.com/api/webhoo%6Bs/${ID}/${T}`, T],
    ["a percent-encoded letter in the host, with an odd token", `https://%64iscord.com/api/webhooks/${ID}/${ODD}`, ODD],
    ["the host, with an odd token", `https://discord.com/api/webhooks/${ID}/${ODD}`, ODD],
    ["the host in upper case, with an odd token", `HTTPS://DISCORD.COM/API/WEBHOOKS/${ID}/${ODD}`, ODD],
    ["the host with a version, with an odd token", `https://discord.com/api/v10/webhooks/${ID}/${ODD}`, ODD],
    ["upper case, no host", `/API/WEBHOOKS/${ID}/${T}`, T],
    ["no host, a token with a hyphen", `webhooks/${ID}/aaaaaaaaaa-bbbbbbbbbb`, "aaaaaaaaaa-bbbbbbbbbb"],
    ["no host, a token with an underscore", `webhooks/${ID}/aaaaaaaaaa_bbbbbbbbbb`, "aaaaaaaaaa_bbbbbbbbbb"],
    // Not a spelling anything here produces, but the path pattern's own `%2f` catches it once the `%25` is read.
    ["a doubly percent-encoded slash", `webhooks%252f${ID}%252f${T}`, T],
    ["no host, a long token that starts with a hyphen and an underscore", `webhooks/${ID}/-_${T}`, T],
    ["a token of 68 characters that is all hyphens and underscores", `https://discord.com/api/webhooks/${ID}/${"-_".repeat(34)}`, "-_".repeat(34)],
  ];

  test("redacts http, https, mixed case, versioned and discordapp forms, and every spelling of the slashes and letters", () => {
    for (const [name, url, secret] of forms) {
      const out = redactWebhookUrls(`bot-ops: bad payload ${url} (from the writer)`);
      // No run of eight characters of the token survives, not only "the whole token is gone".
      expect(rtLeakedRun(out, secret), name).toBeUndefined();
      expect(out, name).toContain("[webhook url]");
      // The text around it is kept.
      expect(out.startsWith("bot-ops: bad payload "), name).toBe(true);
      expect(out.endsWith(" (from the writer)"), name).toBe(true);
    }
  });

  test("a url wrapped in quotes, in JSON or with more text around it is cut to the url", () => {
    expect(redactWebhookUrls(`bad url '${RT_HOOK_URL}' in payload`)).toBe("bad url '[webhook url]' in payload");
    expect(redactWebhookUrls(`{"url":"${RT_HOOK_URL}","action":"webhook-add"}`)).toBe('{"url":"[webhook url]","action":"webhook-add"}');
    expect(redactWebhookUrls(`first ${RT_HOOK_URL} and second ${RT_HOOK_URL.replace("discord.com", "discordapp.com")}`)).toBe("first [webhook url] and second [webhook url]");
  });

  test("leaves other text alone", () => {
    for (const text of [
      "",
      "bot-ops: plugin-request: invalid action",
      "100%25 done",
      `an escape ${u("00e9")} that is not a url`,
      "https://example.com/api/webhooks-are-nice",
      "discord.com/api/webhooks",
      "webhooks/1234/short",
      `webhooks/${ID}/${"a".repeat(19)}`,
      "https://discord.com/channels/1/2",
      "docker: Error response from daemon: no such container",
    ]) {
      expect(redactWebhookUrls(text), text).toBe(text);
    }
  });

  test("stays fast on a hostile megabyte-ish of text", () => {
    const started = performance.now();
    for (const text of ["a.".repeat(100_000), "discord".repeat(30_000), "https://".repeat(30_000), "webhooks/".repeat(30_000), "%2f".repeat(60_000), `${bs}/`.repeat(60_000)]) {
      redactWebhookUrls(text);
    }
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe("routing routes (#242)", () => {
  const TOKEN = "test-token";
  const REQ_ID = "req-0123456789";
  const okStdout = '{"ok":true,"queued":"1757000000000-webhook-add-42.json"}';

  // Captures the invocation so a test can assert args + stdin (the payload).
  function capturingBotOps(result: BotOpsResult = { exitCode: 0, stdout: okStdout, stderr: "" }) {
    const calls: BotOpsInvocation[] = [];
    return { calls, run: async (inv: BotOpsInvocation): Promise<BotOpsResult> => (calls.push(inv), result) };
  }
  const cfg = (run: HandlerConfig["runBotOps"], over: Partial<HandlerConfig> = {}): HandlerConfig => ({
    adminToken: TOKEN,
    indexHtml: "<html></html>",
    runBotOps: run,
    newRequestId: () => REQ_ID,
    ...over,
  });
  function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, bearer = true): Request {
    return new Request(`http://panel.example${path}`, {
      method,
      headers: { ...(bearer ? { Authorization: `Bearer ${TOKEN}` } : {}), "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  }
  const jwtCfg = (run: HandlerConfig["runBotOps"], over: Partial<HandlerConfig> = {}) =>
    cfg(run, { verifyAccessJwt: async () => ({ sub: "real@example.com", email: "real@example.com" }), ...over });
  const jwtHeaders = { "Cf-Access-Jwt-Assertion": "jwt" };

  // The handler logs an audit line per queued request: recorded here (and kept off the test output).
  let out: { log: string[]; error: string[] };
  let restoreConsole: () => void;
  beforeEach(() => {
    out = { log: [], error: [] };
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.log.push(a.map(String).join(" ")));
    const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void out.error.push(a.map(String).join(" ")));
    restoreConsole = () => {
      log.mockRestore();
      error.mockRestore();
    };
  });
  afterEach(() => restoreConsole());
  const jsonOf = async (res: Response) => (await res.json()) as { ok?: boolean; id: string; queued?: string };

  interface Route {
    name: string;
    method: string;
    path: string;
    body?: unknown;
    /** A body the parser refuses, for the routes that have one. */
    badBody?: unknown;
    describe: string;
    payload: Record<string, unknown>;
  }
  const routes: Route[] = [
    {
      name: "POST /api/routing",
      method: "POST",
      path: "/api/routing",
      body: { plugin: "music", servers: { [RT_GUILD_A]: { commands: "all", postTo: RT_CHAN_1 }, [RT_GUILD_B]: { commands: [RT_CHAN_2] } } },
      badBody: { plugin: "Music", servers: {} },
      describe: "routing-set music",
      payload: { action: "routing-set", plugin: "music", servers: { [RT_GUILD_A]: { commands: "all", postTo: RT_CHAN_1 }, [RT_GUILD_B]: { commands: [RT_CHAN_2] } } },
    },
    {
      name: "POST /api/webhooks",
      method: "POST",
      path: "/api/webhooks",
      body: { url: RT_HOOK_URL },
      badBody: { url: "http://nope" },
      describe: "webhook-add",
      payload: { action: "webhook-add", url: RT_HOOK_URL },
    },
    {
      name: "DELETE /api/webhooks/<channel id>",
      method: "DELETE",
      path: `/api/webhooks/${RT_CHAN_1}`,
      describe: `webhook-remove ${RT_CHAN_1}`,
      payload: { action: "webhook-remove", channelId: RT_CHAN_1 },
    },
    {
      name: "POST /api/discovery/refresh",
      method: "POST",
      path: "/api/discovery/refresh",
      describe: "discovery-refresh",
      payload: { action: "discovery-refresh" },
    },
  ];

  for (const r of routes) {
    describe(r.name, () => {
      test("401 without auth, bot-ops never called (even before a bad body is looked at)", async () => {
        for (const body of r.badBody === undefined ? [r.body] : [r.body, r.badBody]) {
          const bot = capturingBotOps();
          const res = await handleRequest(req(r.method, r.path, body, {}, false), cfg(bot.run));
          expect(res.status).toBe(401);
          expect(bot.calls).toHaveLength(0);
        }
      });

      test("403 cross-site, bot-ops never called (even with a bad body)", async () => {
        for (const body of r.badBody === undefined ? [r.body] : [r.body, r.badBody]) {
          const bot = capturingBotOps();
          const res = await handleRequest(req(r.method, r.path, body, { Origin: "http://evil.com" }), cfg(bot.run));
          expect(res.status).toBe(403);
          expect(bot.calls).toHaveLength(0);
        }
      });

      test("runs plugin-request with the expected payload on stdin", async () => {
        const bot = capturingBotOps();
        const res = await handleRequest(req(r.method, r.path, r.body), cfg(bot.run));
        expect(res.status).toBe(200);
        expect(bot.calls).toHaveLength(1);
        expect(bot.calls[0]!.args).toEqual(["plugin-request"]);
        expect(bot.calls[0]!.contentType).toBe("application/json");
        expect(JSON.parse(bot.calls[0]!.stdin!)).toEqual({ ...r.payload, requestedBy: "token", id: REQ_ID });
      });

      test("answers { ok, id, queued }", async () => {
        const bot = capturingBotOps();
        const res = await handleRequest(req(r.method, r.path, r.body), cfg(bot.run));
        expect(res.headers.get("Content-Type")).toBe("application/json");
        expect(await res.json()).toEqual({ ok: true, id: REQ_ID, queued: "1757000000000-webhook-add-42.json" });
      });

      test("logs one audit line naming the action and the actor", async () => {
        const bot = capturingBotOps();
        await handleRequest(req(r.method, r.path, r.body), cfg(bot.run));
        expect(out.log).toEqual([`[admin] plugin-request queued (${r.describe}) — requested by the ADMIN_TOKEN bearer token`]);
        expect(out.error).toEqual([]);
      });

      test("a bot-ops failure is a 502 with its stderr", async () => {
        const bot = capturingBotOps({ exitCode: 1, stdout: "", stderr: "bot-ops: plugin-request: invalid action\n" });
        const res = await handleRequest(req(r.method, r.path, r.body), cfg(bot.run));
        expect(res.status).toBe(502);
        expect(await res.text()).toBe("bot-ops: plugin-request: invalid action");
        expect(out.error).toEqual([
          "[admin] plugin-request failed (exit 1) — requested by the ADMIN_TOKEN bearer token: bot-ops: plugin-request: invalid action",
        ]);
        expect(out.log).toEqual([]);
      });

      test("a bot-ops failure with no stderr is a 502 saying so", async () => {
        const bot = capturingBotOps({ exitCode: 1, stdout: "", stderr: "" });
        const res = await handleRequest(req(r.method, r.path, r.body), cfg(bot.run));
        expect(res.status).toBe(502);
        expect(await res.text()).toBe("plugin-request failed");
      });

      test("a timed-out bot-ops is a 504", async () => {
        const bot = capturingBotOps({ exitCode: 1, stdout: "", stderr: "", timedOut: true });
        const res = await handleRequest(req(r.method, r.path, r.body), cfg(bot.run));
        expect(res.status).toBe(504);
        expect(await res.text()).toBe("bot-ops.sh timed out");
      });

      test("requestedBy is the verified email even when the body supplies another, and an id in the body is ignored", async () => {
        const bot = capturingBotOps();
        // EVERY route gets a body that tries: the two without a body of their own (DELETE, discovery refresh)
        // are sent one anyway, since a client can, and it must change nothing. The route's own fields win.
        const hostile = { requestedBy: "email:attacker@evil", id: "attacker-chosen-id", action: "webhook-add", url: RT_HOOK_URL };
        const body = { ...hostile, ...(isRecordBody(r.body) ? r.body : {}) };
        const res = await handleRequest(req(r.method, r.path, body, jwtHeaders, false), jwtCfg(bot.run));
        expect(res.status).toBe(200);
        expect(JSON.parse(bot.calls[0]!.stdin!)).toEqual({ ...r.payload, requestedBy: "email:real@example.com", id: REQ_ID });
        expect((await jsonOf(res)).id).toBe(REQ_ID);
        // The bearer path, too: `token`, and the server's id.
        const viaToken = capturingBotOps();
        await handleRequest(req(r.method, r.path, body), cfg(viaToken.run));
        expect(JSON.parse(viaToken.calls[0]!.stdin!)).toEqual({ ...r.payload, requestedBy: "token", id: REQ_ID });
      });

      test("without newRequestId the id is a UUID the bot accepts, and a different one each time", async () => {
        const bot = capturingBotOps();
        const noSeam = cfg(bot.run, { newRequestId: undefined });
        const ids: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const res = await handleRequest(req(r.method, r.path, r.body), noSeam);
          ids.push((await jsonOf(res)).id);
        }
        for (const id of ids) {
          expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
          expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/); // the bot's REQUEST_ID_RE
          expect(JSON.parse(bot.calls[ids.indexOf(id)]!.stdin!).id).toBe(id);
        }
        expect(new Set(ids).size).toBe(3);
      });

      test("the answer omits `queued` when bot-ops' output is not JSON", async () => {
        const bot = capturingBotOps({ exitCode: 0, stdout: "queued\n", stderr: "" });
        const res = await handleRequest(req(r.method, r.path, r.body), cfg(bot.run));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, id: REQ_ID });
      });
    });
  }

  function isRecordBody(body: unknown): body is Record<string, unknown> {
    return typeof body === "object" && body !== null && !Array.isArray(body);
  }

  test("POST /api/routing: invalid JSON is 400, and a refused body is 400 naming the field", async () => {
    const cases: [unknown, string][] = [
      ["{ not json", "invalid JSON"],
      ["", "invalid JSON"],
      [[], "body is not a JSON object"],
      ["null", "body is not a JSON object"],
      [{ servers: {} }, "bad plugin name"],
      [{ plugin: "music" }, "servers must be an object"],
      [{ plugin: "music", servers: { main: { commands: "all" } } }, "bad server id"],
      [{ plugin: "music", servers: { [RT_GUILD_A]: { commands: "some" } } }, 'commands must be "all" or a non-empty list of channel ids'],
      [{ plugin: "music", servers: { [RT_GUILD_A]: { commands: "all", postTo: "x" } } }, "bad postTo"],
    ];
    for (const [body, reason] of cases) {
      const bot = capturingBotOps();
      const res = await handleRequest(req("POST", "/api/routing", body), cfg(bot.run));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.text()).toBe(reason);
      expect(bot.calls).toHaveLength(0);
    }
  });

  test("POST /api/routing: a __proto__ server key sent as JSON text is 400, never queued", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(req("POST", "/api/routing", `{"plugin":"music","servers":{"__proto__":{"commands":"all"}}}`), cfg(bot.run));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("bad server id");
    expect(bot.calls).toHaveLength(0);
  });

  test("POST /api/routing: unknown keys at every level never reach stdin", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(
      req("POST", "/api/routing", {
        plugin: "music",
        servers: { [RT_GUILD_A]: { commands: [RT_CHAN_1], postTo: RT_CHAN_2, extra: "x", url: RT_HOOK_URL } },
        extra: "y",
        action: "webhook-remove",
      }),
      cfg(bot.run),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(bot.calls[0]!.stdin!)).toEqual({
      action: "routing-set",
      plugin: "music",
      servers: { [RT_GUILD_A]: { commands: [RT_CHAN_1], postTo: RT_CHAN_2 } },
      requestedBy: "token",
      id: REQ_ID,
    });
    expect(bot.calls[0]!.stdin).not.toContain(RT_HOOK_TOKEN);
  });

  test("POST /api/routing: an empty servers object is queued (it places the plugin nowhere)", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(req("POST", "/api/routing", { plugin: "wow", servers: {} }), cfg(bot.run));
    expect(res.status).toBe(200);
    expect(JSON.parse(bot.calls[0]!.stdin!)).toEqual({ action: "routing-set", plugin: "wow", servers: {}, requestedBy: "token", id: REQ_ID });
  });

  test("POST /api/webhooks: invalid JSON is 400, and a refused body is 400 naming the field", async () => {
    const cases: [unknown, string][] = [
      ["{ not json", "invalid JSON"],
      [[], "body is not a JSON object"],
      [{}, "bad webhook url"],
      [{ url: 5 }, "bad webhook url"],
      [{ url: RT_HOOK_URL.replace("https://", "http://") }, "bad webhook url"],
      [{ url: `${RT_HOOK_URL}?wait=true` }, "bad webhook url"],
    ];
    for (const [body, reason] of cases) {
      const bot = capturingBotOps();
      const res = await handleRequest(req("POST", "/api/webhooks", body), cfg(bot.run));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await res.text()).toBe(reason);
      expect(bot.calls).toHaveLength(0);
    }
  });

  test("POST /api/webhooks: the url is trimmed, and only the url is read from the body", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(req("POST", "/api/webhooks", { url: `  ${RT_HOOK_URL}\n`, channelId: RT_CHAN_1, action: "webhook-remove" }), cfg(bot.run));
    expect(res.status).toBe(200);
    expect(JSON.parse(bot.calls[0]!.stdin!)).toEqual({ action: "webhook-add", url: RT_HOOK_URL, requestedBy: "token", id: REQ_ID });
  });

  test("DELETE /api/webhooks/<id>: anything that is not a channel id is 400, a percent-encoded one included", async () => {
    const encoded = [...RT_CHAN_1].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("");
    for (const id of ["abc", "", "1234", "1".repeat(26), `${RT_CHAN_1}/extra`, `${RT_CHAN_1}/`, `x/${RT_CHAN_1}`, `${RT_CHAN_2}/${RT_CHAN_1}`, encoded, `${RT_CHAN_1}%2fx`, "..%2f..%2fx", "12 345", "-12345", "12345.5"]) {
      const bot = capturingBotOps();
      const res = await handleRequest(req("DELETE", `/api/webhooks/${id}`), cfg(bot.run));
      expect(res.status, id).toBe(400);
      expect(await res.text()).toBe("bad channel id");
      expect(bot.calls, id).toHaveLength(0);
    }
  });

  test("DELETE /api/webhooks/<id>: a query string is not part of the id, and never supplies one", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(req("DELETE", `/api/webhooks/${RT_CHAN_1}?x=1`), cfg(bot.run));
    expect(res.status).toBe(200);
    expect(JSON.parse(bot.calls[0]!.stdin!).channelId).toBe(RT_CHAN_1);
    // A query parameter named like the id is ignored: the path's id wins, and a bad path id is not rescued by it.
    for (const query of [`?id=${RT_CHAN_2}`, `?channelId=${RT_CHAN_2}`, `?id=${RT_CHAN_2}&channelId=${RT_CHAN_2}`]) {
      const other = capturingBotOps();
      const ok = await handleRequest(req("DELETE", `/api/webhooks/${RT_CHAN_1}${query}`), cfg(other.run));
      expect(ok.status, query).toBe(200);
      expect(JSON.parse(other.calls[0]!.stdin!).channelId, query).toBe(RT_CHAN_1);
      const bad = capturingBotOps();
      const refused = await handleRequest(req("DELETE", `/api/webhooks/abc${query}`), cfg(bad.run));
      expect(refused.status, query).toBe(400);
      expect(bad.calls, query).toHaveLength(0);
    }
  });

  test("DELETE /api/webhooks/<id>: the shortest and longest channel ids are accepted", async () => {
    for (const id of ["12345", "1".repeat(25)]) {
      const bot = capturingBotOps();
      const res = await handleRequest(req("DELETE", `/api/webhooks/${id}`), cfg(bot.run));
      expect(res.status, id).toBe(200);
      expect(JSON.parse(bot.calls[0]!.stdin!).channelId, id).toBe(id);
    }
  });

  test("POST /api/discovery/refresh: the body is ignored, even garbage", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(req("POST", "/api/discovery/refresh", "{ not json at all", { "Content-Type": "text/plain" }), cfg(bot.run));
    expect(res.status).toBe(200);
    expect(JSON.parse(bot.calls[0]!.stdin!)).toEqual({ action: "discovery-refresh", requestedBy: "token", id: REQ_ID });
  });

  test("any other method on these paths is the existing 404, bot-ops never called", async () => {
    for (const [method, path] of [
      ["GET", "/api/webhooks"],
      ["GET", `/api/webhooks/${RT_CHAN_1}`],
      ["GET", "/api/discovery/refresh"],
      ["PUT", "/api/routing"],
      ["DELETE", "/api/routing"],
      ["PUT", "/api/webhooks"],
      ["POST", `/api/webhooks/${RT_CHAN_1}`],
      ["DELETE", "/api/webhooks"],
      ["DELETE", "/api/discovery/refresh"],
      ["GET", "/api/discovery"],
    ] as const) {
      const bot = capturingBotOps();
      const res = await handleRequest(req(method, path, method === "GET" ? undefined : {}), cfg(bot.run));
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(bot.calls, `${method} ${path}`).toHaveLength(0);
    }
  });

  test("GET /api/routing runs routing-get and passes its JSON through", async () => {
    const stdout = JSON.stringify({ routing: { v: 1, plugins: {}, webhooks: {}, results: [] }, discovery: { v: 1, guilds: [] } });
    const bot = capturingBotOps({ exitCode: 0, stdout, stderr: "" });
    const res = await handleRequest(req("GET", "/api/routing"), cfg(bot.run));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.text()).toBe(stdout);
    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0]!.args).toEqual(["routing-get"]);
    expect(bot.calls[0]!.stdin).toBeUndefined();
  });

  test("GET /api/routing: 401 without auth, and a failing routing-get is a 502 with its stderr", async () => {
    const denied = capturingBotOps();
    expect((await handleRequest(req("GET", "/api/routing", undefined, {}, false), cfg(denied.run))).status).toBe(401);
    expect(denied.calls).toHaveLength(0);

    const failing = capturingBotOps({ exitCode: 1, stdout: "", stderr: "bot-ops: routing-get: no data dir" });
    const res = await handleRequest(req("GET", "/api/routing"), cfg(failing.run));
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("bot-ops: routing-get: no data dir");
    expect(out.error).toEqual(["[admin] routing-get failed (exit 1) — requested by the ADMIN_TOKEN bearer token: bot-ops: routing-get: no data dir"]);
  });
});

describe("a webhook url never leaves the stdin payload (#242)", () => {
  const TOKEN = "test-token";
  const REQ_ID = "req-0123456789";
  const bs = String.fromCharCode(92);

  function capturingBotOps(result: BotOpsResult = { exitCode: 0, stdout: '{"ok":true,"queued":"1757000000000-webhook-add-42.json"}', stderr: "" }) {
    const calls: BotOpsInvocation[] = [];
    return { calls, run: async (inv: BotOpsInvocation): Promise<BotOpsResult> => (calls.push(inv), result) };
  }
  const cfg = (run: HandlerConfig["runBotOps"]): HandlerConfig => ({ adminToken: TOKEN, indexHtml: "<html></html>", runBotOps: run, newRequestId: () => REQ_ID });
  const post = (path: string, body: unknown) =>
    new Request(`http://panel.example${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  // Every console method the handler could reach, and both process streams, with the arguments rendered
  // the way a log line would be. (`console.trace`, `dir` and `table` and a direct `process.stderr.write`
  // are ways to write a line that a spy on `log` and `error` alone would not see.)
  let lines: string[];
  let spies: { mockRestore: () => void }[];
  beforeEach(() => {
    lines = [];
    const render = (a: unknown) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a));
    const record = (...args: unknown[]) => void lines.push(args.map(render).join(" "));
    spies = (["log", "error", "warn", "info", "debug", "trace", "dir", "dirxml", "table"] as const).map((level) =>
      spyOn(console, level).mockImplementation(record),
    );
    for (const stream of [process.stdout, process.stderr]) {
      spies.push(
        spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
          lines.push(`[stream] ${render(typeof chunk === "string" ? chunk : String(chunk))}`);
          return true;
        }) as never),
      );
    }
  });
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  /** No piece of the token (no run of eight of its characters) is in any response body or header, any
   *  console line or stream write, or `args`; and the response carries at most a Content-Type. */
  async function expectNoLeak(where: string, res: Response, bot: ReturnType<typeof capturingBotOps>): Promise<void> {
    expect(rtLeakedRun(await res.clone().text()), `${where}: the response body`).toBeUndefined();
    expect(rtLeakedRun(JSON.stringify([...res.headers])), `${where}: the response headers`).toBeUndefined();
    // (A plain-string Response carries no header object at all until it is sent, so "at most" a Content-Type.)
    expect([...res.headers.keys()].filter((name) => name !== "content-type"), `${where}: the response's header names`).toEqual([]);
    expect(rtLeakedRun(lines.join("\n")), `${where}: the console`).toBeUndefined();
    for (const call of bot.calls) expect(rtLeakedRun(JSON.stringify(call.args)), `${where}: argv`).toBeUndefined();
  }

  test("an accepted url: on stdin, and nowhere else", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(post("/api/webhooks", { url: RT_HOOK_URL }), cfg(bot.run));
    expect(res.status).toBe(200);
    // It DID reach bot-ops, so this cannot pass by the route doing nothing.
    expect(bot.calls).toHaveLength(1);
    expect(bot.calls[0]!.stdin).toContain(RT_HOOK_TOKEN);
    expect(JSON.parse(bot.calls[0]!.stdin!).url).toBe(RT_HOOK_URL);
    expect(bot.calls[0]!.args).toEqual(["plugin-request"]);
    await expectNoLeak("accepted", res, bot);
    // And something WAS logged, so the console check is not vacuous.
    expect(lines).toEqual(["[admin] plugin-request queued (webhook-add) — requested by the ADMIN_TOKEN bearer token"]);
  });

  test("a malformed url (the same token behind http://): a bare 400, nothing echoed", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(post("/api/webhooks", { url: RT_HOOK_URL.replace("https://", "http://") }), cfg(bot.run));
    expect(res.status).toBe(400);
    expect(await res.clone().text()).toBe("bad webhook url");
    expect(bot.calls).toHaveLength(0);
    await expectNoLeak("malformed", res, bot);
  });

  test("an accepted url whose bot-ops fails with a stderr that holds it: redacted in the answer and the log", async () => {
    const stderr = `bot-ops: plugin-request: bad url '${RT_HOOK_URL}' in payload\n`;
    const bot = capturingBotOps({ exitCode: 1, stdout: "", stderr });
    const res = await handleRequest(post("/api/webhooks", { url: RT_HOOK_URL }), cfg(bot.run));
    expect(res.status).toBe(502);
    expect(await res.clone().text()).toBe("bot-ops: plugin-request: bad url '[webhook url]' in payload");
    expect(bot.calls[0]!.stdin).toContain(RT_HOOK_TOKEN); // it was sent, on stdin
    await expectNoLeak("failed", res, bot);
    expect(lines).toEqual([
      "[admin] plugin-request failed (exit 1) — requested by the ADMIN_TOKEN bearer token: bot-ops: plugin-request: bad url '[webhook url]' in payload",
    ]);
  });

  test("the same failure with the url spelled with escapes: still redacted", async () => {
    const spellings = [
      RT_HOOK_URL.split("/").join(`${bs}/`), // json-escaped slashes
      RT_HOOK_URL.split("/").join("%2F"), // percent-encoded slashes
      RT_HOOK_URL.split("/").join(`${bs}u002f`), // unicode-escaped slashes
      RT_HOOK_URL.replace("webhooks", "%77ebhooks"), // a percent-encoded letter
      RT_HOOK_URL.replace("https://discord.com", "https://discord.com:443"), // a port
      `webhooks/${RT_HOOK_ID}/${RT_HOOK_TOKEN}`, // no host
    ];
    for (const spelling of spellings) {
      lines.length = 0;
      const bot = capturingBotOps({ exitCode: 1, stdout: "", stderr: `jq: error: bad input near ${spelling}` });
      const res = await handleRequest(post("/api/webhooks", { url: RT_HOOK_URL }), cfg(bot.run));
      expect(res.status, spelling).toBe(502);
      expect(await res.clone().text(), spelling).toContain("[webhook url]");
      await expectNoLeak(spelling, res, bot);
    }
  });

  test("a timed-out bot-ops whose stderr holds the url: a fixed 504 body, and a redacted log line", async () => {
    const bot = capturingBotOps({ exitCode: 1, stdout: "", stderr: `killed while reading ${RT_HOOK_URL}`, timedOut: true });
    const res = await handleRequest(post("/api/webhooks", { url: RT_HOOK_URL }), cfg(bot.run));
    expect(res.status).toBe(504);
    expect(await res.clone().text()).toBe("bot-ops.sh timed out");
    await expectNoLeak("timed out", res, bot);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[webhook url]");
  });

  test("a success whose stdout `queued` holds the url: redacted", async () => {
    const bot = capturingBotOps({ exitCode: 0, stdout: JSON.stringify({ ok: true, queued: RT_HOOK_URL }), stderr: "" });
    const res = await handleRequest(post("/api/webhooks", { url: RT_HOOK_URL }), cfg(bot.run));
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual({ ok: true, id: REQ_ID, queued: "[webhook url]" });
    await expectNoLeak("queued", res, bot);
  });

  test("a success whose `queued` is not a string is left out, whatever it holds", async () => {
    for (const queued of [{ url: RT_HOOK_URL }, [RT_HOOK_URL], 5, null, true]) {
      const bot = capturingBotOps({ exitCode: 0, stdout: JSON.stringify({ ok: true, queued }), stderr: "" });
      const res = await handleRequest(post("/api/webhooks", { url: RT_HOOK_URL }), cfg(bot.run));
      expect(res.status).toBe(200);
      expect(await res.clone().json()).toEqual({ ok: true, id: REQ_ID });
      await expectNoLeak(JSON.stringify(queued).slice(0, 30), res, bot);
    }
  });

  test("a runBotOps that throws, with the payload in its message: a fixed 502, and the log line redacted", async () => {
    const payloadText = `spawn failed for stdin {"action":"webhook-add","url":"${RT_HOOK_URL}"}`;
    for (const [thrown, marked] of [
      [new Error(payloadText), true],
      [new Error(`${"x".repeat(250)} ${RT_HOOK_URL}`), true],
      // The url sits past the clip: the line is cut, and there is nothing of the url in what is left.
      [new Error(`${"x".repeat(5000)} ${RT_HOOK_URL}`), false],
    ] as const) {
      lines.length = 0;
      const calls: BotOpsInvocation[] = [];
      const run = async (inv: BotOpsInvocation): Promise<BotOpsResult> => {
        calls.push(inv);
        throw thrown;
      };
      const res = await handleRequest(post("/api/webhooks", { url: RT_HOOK_URL }), cfg(run));
      expect(res.status).toBe(502);
      expect(await res.clone().text()).toBe("bot-ops.sh could not be run");
      await expectNoLeak("thrown", res, { calls } as ReturnType<typeof capturingBotOps>);
      expect(calls[0]!.stdin).toContain(RT_HOOK_TOKEN); // it was on the payload it threw about
      expect(lines).toHaveLength(1);
      expect(lines[0]!.startsWith("[admin] plugin-request could not run bot-ops.sh — requested by the ADMIN_TOKEN bearer token: ")).toBe(true);
      expect(lines[0]!.includes("[webhook url]")).toBe(marked);
      // Clipped: the message is 5 KB of x in one of the cases.
      expect(lines[0]!.length).toBeLessThan(500);
    }
  });

  test("a runBotOps that throws something that is not an Error, or an Error whose message cannot be read: still a fixed 502", async () => {
    const unreadable = Object.defineProperty(new Error("x"), "message", {
      get(): never {
        throw new Error(`nested ${RT_HOOK_URL}`);
      },
    });
    for (const [thrown, why] of [
      [RT_HOOK_URL, "not an Error"],
      [null, "not an Error"],
      [{ message: RT_HOOK_URL }, "not an Error"],
      [unreadable, "unreadable error"],
    ] as const) {
      lines.length = 0;
      const calls: BotOpsInvocation[] = [];
      const res = await handleRequest(
        post("/api/webhooks", { url: RT_HOOK_URL }),
        cfg(async (inv) => {
          calls.push(inv);
          throw thrown;
        }),
      );
      expect(res.status).toBe(502);
      expect(await res.clone().text()).toBe("bot-ops.sh could not be run");
      await expectNoLeak(why, res, { calls } as ReturnType<typeof capturingBotOps>);
      expect(lines).toEqual([`[admin] plugin-request could not run bot-ops.sh — requested by the ADMIN_TOKEN bearer token: ${why}`]);
    }
  });

  test("a thrown message is redacted BEFORE it is clipped: a clip through a url must not leave a piece of its token", async () => {
    // The port makes the host pattern miss, so only the path pattern (which needs 20 token characters) can
    // catch this url. Clipped FIRST, at 300, it would be cut ten characters into the token and nothing would
    // catch it: those ten would be in the log line.
    const portPrefix = `https://discord.com:443/api/webhooks/${RT_HOOK_ID}/`;
    const message = `${"x".repeat(300 - 1 - portPrefix.length - 10)} ${portPrefix}${RT_HOOK_TOKEN}`;
    const calls: BotOpsInvocation[] = [];
    const res = await handleRequest(
      post("/api/webhooks", { url: RT_HOOK_URL }),
      cfg(async (inv) => {
        calls.push(inv);
        throw new Error(message);
      }),
    );
    expect(res.status).toBe(502);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[webhook url]");
    await expectNoLeak("clip", res, { calls } as ReturnType<typeof capturingBotOps>);
  });

  test("a thrown message clipped through a surrogate pair does not leave half of it in the log line", async () => {
    const emoji = String.fromCodePoint(0x1f600); // two UTF-16 units: the cut at 300 lands between them
    const res = await handleRequest(
      post("/api/webhooks", { url: RT_HOOK_URL }),
      cfg(async () => {
        throw new Error(`${"x".repeat(299)}${emoji}${"y".repeat(50)}`);
      }),
    );
    expect(res.status).toBe(502);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.isWellFormed()).toBe(true);
    expect(lines[0]!.endsWith("x".repeat(299))).toBe(true);
  });

  test("the routing writes speak only through console.log and console.error (source pin)", () => {
    // The spies above cover the console methods and streams a test can reach; this covers the ones it cannot
    // (group, count, assert, Bun.write(Bun.stderr, ...)) by pinning what the code that handles a webhook url
    // is allowed to call at all.
    const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const helper = src.slice(src.indexOf("async function queueRoutingRequest("), src.indexOf("/** The whole request lifecycle"));
    const routes = src.slice(src.indexOf("// #242: the four routing writes."), src.indexOf('if (url.pathname === "/api/admins"'));
    expect(helper.length).toBeGreaterThan(500);
    expect(routes.length).toBeGreaterThan(500);
    expect([...helper.matchAll(/console\.(\w+)/g)].map((m) => m[1])).toEqual(["error", "error", "log"]);
    expect([...routes.matchAll(/console\./g)]).toHaveLength(0);
    for (const [name, text] of [["queueRoutingRequest", helper], ["the routing routes", routes]] as const) {
      expect(text, name).not.toMatch(/process\.(stdout|stderr)|Bun\.(write|stdout|stderr)|\bfetch\(|\bBun\.spawn/);
    }
  });

  test("a url in the wrong place of a routing-set body is refused with a fixed reason, never echoed", async () => {
    const bodies = [
      { plugin: RT_HOOK_URL, servers: {} },
      { plugin: "music", servers: { [RT_HOOK_URL]: { commands: "all" } } },
      { plugin: "music", servers: { [RT_GUILD_A]: { commands: RT_HOOK_URL } } },
      { plugin: "music", servers: { [RT_GUILD_A]: { commands: [RT_HOOK_URL] } } },
      { plugin: "music", servers: { [RT_GUILD_A]: { commands: "all", postTo: RT_HOOK_URL } } },
      { plugin: "music", servers: RT_HOOK_URL },
    ];
    for (const body of bodies) {
      const bot = capturingBotOps();
      const res = await handleRequest(post("/api/routing", body), cfg(bot.run));
      expect(res.status).toBe(400);
      expect(bot.calls).toHaveLength(0);
      await expectNoLeak(JSON.stringify(body).slice(0, 60), res, bot);
    }
  });

  test("a url in the body of the other routes is never read, so never echoed either", async () => {
    for (const [path, body] of [
      ["/api/discovery/refresh", { url: RT_HOOK_URL, note: RT_HOOK_URL }],
      ["/api/routing", { plugin: "music", servers: {}, url: RT_HOOK_URL }],
    ] as const) {
      const bot = capturingBotOps();
      const res = await handleRequest(post(path, body), cfg(bot.run));
      expect(res.status, path).toBe(200);
      expect(bot.calls[0]!.stdin, path).not.toContain(RT_HOOK_TOKEN);
      await expectNoLeak(path, res, bot);
    }
  });

  test("a url with invalid JSON around it: a bare 400", async () => {
    const bot = capturingBotOps();
    const res = await handleRequest(post("/api/webhooks", `{"url":"${RT_HOOK_URL}"`), cfg(bot.run));
    expect(res.status).toBe(400);
    expect(await res.clone().text()).toBe("invalid JSON");
    await expectNoLeak("invalid JSON", res, bot);
  });

  test("the audit line for webhook-add and webhook-remove never carries the url or the token", async () => {
    const bot = capturingBotOps();
    await handleRequest(post("/api/webhooks", { url: RT_HOOK_URL }), cfg(bot.run));
    await handleRequest(new Request(`http://panel.example/api/webhooks/${RT_CHAN_1}`, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } }), cfg(bot.run));
    expect(lines).toEqual([
      "[admin] plugin-request queued (webhook-add) — requested by the ADMIN_TOKEN bearer token",
      `[admin] plugin-request queued (webhook-remove ${RT_CHAN_1}) — requested by the ADMIN_TOKEN bearer token`,
    ]);
  });
});

// The pure PLUGINS plan, pinned against the page's OWN source: planPluginsSave is lifted from index.html
// (between its PLUGINS_SAVE_PLAN markers) and evaluated here. (#257: the savePlugins that used to wrap
// it is gone; the consumer boundary — PLUGINS first in the ONE POST applyPending sends, only when it
// changed, never planned against an unreadable state — is pinned in `applyPending (#257)` below.)
describe("admin panel planPluginsSave (#102)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const planSrc = indexSrc.match(/\/\/ PLUGINS_SAVE_PLAN:begin\n([\s\S]*?)\n\s*\/\/ PLUGINS_SAVE_PLAN:end/)?.[1];

  type Plan = { value: string; changed: boolean };
  const planPluginsSave = (checked: string[], current: string, order: string[]): Plan =>
    (new Function(`"use strict";\n${planSrc ?? ""}\nreturn planPluginsSave;`)() as (
      c: string[],
      v: string,
      o: string[],
    ) => Plan)(checked, current, order);

  test("the marked function is present in the served page", () => {
    expect(planSrc).toContain("function planPluginsSave(");
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

// The send consumer, pinned against the page's OWN source, the same lift-and-stub way as applyPending.
// Proves the boundary (POSTs to /api/plugins/request, re-loads on success, never adds requestedBy), not just the
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

// #124's server.ts gained a local import (./admin-contract) that the Dockerfile's `COPY server.ts
// admin-contract.ts ./` had to name explicitly; #128 was a missed one — the container crash-looped
// at boot with "Cannot find module './admin-contract'" because nothing but the real image build
// caught it. This ratchets that: every relative local import server.ts has must appear among the
// Dockerfile's COPY sources, so a future added import that isn't COPYed fails here instead of at boot.
describe("Dockerfile COPY ratchet: every server.ts local import is copied into the image (#128, #163)", () => {
  const serverSrc = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const dockerfileSrc = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");

  // Static `from "./x"` / `from "./x.js"` and dynamic `import("./x")` relative specifiers, mapped
  // to their on-disk filename (Bun resolves a `.js` specifier to the sibling `.ts` file).
  function extractLocalImportFilenames(src: string): string[] {
    const specifiers: string[] = [];
    for (const m of src.matchAll(/from\s+["'](\.\/[^"']+)["']/g)) specifiers.push(m[1]!);
    for (const m of src.matchAll(/import\(\s*["'](\.\/[^"']+)["']\s*\)/g)) specifiers.push(m[1]!);
    return specifiers.map((spec) => {
      const base = spec.slice(2).replace(/\.js$/, "");
      return base.endsWith(".ts") ? base : `${base}.ts`;
    });
  }

  // Every COPY instruction's source tokens (all but the last, which is the destination);
  // `--chown=`/`--from=` flags are ignored, not treated as sources.
  function extractDockerfileCopySources(src: string): string[] {
    const sources: string[] = [];
    for (const line of src.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("COPY ")) continue;
      const tokens = trimmed
        .slice("COPY ".length)
        .split(/\s+/)
        .filter((t) => t.length > 0 && !t.startsWith("--"));
      sources.push(...tokens.slice(0, -1));
    }
    return sources;
  }

  test("the extractor finds at least one local import (can't pass vacuously)", () => {
    expect(extractLocalImportFilenames(serverSrc).length).toBeGreaterThanOrEqual(1);
  });

  test("every server.ts local import filename is among the Dockerfile's COPY sources", () => {
    const imports = extractLocalImportFilenames(serverSrc);
    const copied = extractDockerfileCopySources(dockerfileSrc);
    for (const filename of imports) {
      expect(copied).toContain(filename);
    }
  });
});

// ---- #238: the panel shell (Rackbops theme, static assets, three tabs) --------------------------

// The page's stylesheets are served from an exact-match Map (HandlerConfig.assets), built at startup
// from STATIC_ASSET_FILES -- the request path is only ever a key, never a filesystem path.
describe("static assets", () => {
  const TOKEN = "test-token";
  const THEME: StaticAsset = { body: "/* theme */", contentType: "text/css; charset=utf-8" };
  const ADMIN: StaticAsset = { body: "/* admin */", contentType: "text/css; charset=utf-8" };
  const assets = new Map<string, StaticAsset>([
    ["/rb-theme.css", THEME],
    ["/admin.css", ADMIN],
  ]);
  const cfg = (overrides: Partial<HandlerConfig> = {}): HandlerConfig => ({
    adminToken: TOKEN,
    indexHtml: "<html>admin panel</html>",
    assets,
    runBotOps: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ...overrides,
  });

  test("serves /rb-theme.css as text/css", async () => {
    const res = await handleRequest(new Request("http://x/rb-theme.css"), cfg());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await res.text()).toBe(THEME.body);
  });

  test("serves /admin.css as text/css", async () => {
    const res = await handleRequest(new Request("http://x/admin.css"), cfg());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/css");
    expect(await res.text()).toBe(ADMIN.body);
  });

  test("serves them without authentication, like the page", async () => {
    // No Authorization header anywhere: the page has to load its own stylesheets before it can even
    // show the token gate.
    for (const path of ["/rb-theme.css", "/admin.css"]) {
      expect((await handleRequest(new Request("http://x" + path), cfg())).status).toBe(200);
    }
  });

  test("answers a non-GET with 404", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/rb-theme.css", "/admin.css"]) {
        const res = await handleRequest(new Request("http://x" + path, { method, body: "x" }), cfg());
        expect(res.status).toBe(404);
      }
    }
  });

  test("answers a percent-encoded spelling with 404", async () => {
    // /%72b-theme.css is /rb-theme.css to anything that decodes before it looks up. It must miss: the
    // lookup is an exact match on url.pathname, which the URL parser leaves percent-encoded (the same
    // reason the admin-asset routes never decode a path they then trust; see CONTEXT.md's %-encoding
    // gotcha). A percent-encoded dot SEGMENT, /%2e%2e/admin.css, is not listed: the URL parser itself
    // resolves that to exactly /admin.css before the handler sees it, so it is the key itself.
    for (const path of ["/%72b-theme.css", "/rb-theme%2ecss", "/%61dmin.css", "/admin%2Ecss", "/admin.css%00", "/admin.css%2f"]) {
      const res = await handleRequest(new Request("http://x" + path), cfg());
      expect(res.status).toBe(404);
    }
  });

  test("answers a near-miss spelling (case, trailing slash, ;param, double slash) with 404", async () => {
    // Exact means exact: nothing here folds case, strips a slash or a ;parameter, or collapses `//`.
    for (const path of ["/ADMIN.CSS", "/Admin.css", "/RB-THEME.CSS", "/admin.css/", "/admin.css;x=1", "//admin.css", "/admin.css%20", "/%20admin.css", "/admin.css.map", "/admin.cs", "/rb-theme.css/x"]) {
      const res = await handleRequest(new Request("http://x" + path), cfg());
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    // ... while a query string is not part of the path, so it still names the asset.
    expect((await handleRequest(new Request("http://x/admin.css?v=2"), cfg())).status).toBe(200);
  });

  test("answers /constructor with 404", async () => {
    // Object.prototype names: a lookup on a plain object (with the slash stripped) would find these
    // and answer 200 with a function as the body.
    for (const path of ["/constructor", "/__proto__", "/toString", "/hasOwnProperty", "/valueOf"]) {
      const res = await handleRequest(new Request("http://x" + path), cfg());
      expect(res.status).toBe(404);
    }
  });

  test("leaves every existing route untouched", async () => {
    const page = await handleRequest(new Request("http://x/"), cfg());
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<html>admin panel</html>");
    expect((await handleRequest(new Request("http://x/index.html"), cfg())).status).toBe(200);
    // Auth still gates the API, and an unknown path is still a plain 404.
    expect((await handleRequest(new Request("http://x/api/status"), cfg())).status).toBe(401);
    expect((await handleRequest(new Request("http://x/nope.css"), cfg())).status).toBe(404);
    // No assets configured (an older HandlerConfig) -> the routes simply don't exist.
    expect((await handleRequest(new Request("http://x/admin.css"), cfg({ assets: undefined }))).status).toBe(404);
  });
});

// The boot-time half of the asset route. The import.meta.main block (which no test runs) only calls
// loadStaticAssets and puts the result in the HandlerConfig, so the route -> file mapping and the
// content type are pinned here against the real files, and the two call sites by source.
describe("loadStaticAssets (the boot-time wiring of the static assets)", () => {
  const readReal = async (file: string) => readFileSync(new URL(`./public/${file}`, import.meta.url), "utf8");

  test("maps each route to its own file, as text/css", async () => {
    const assets = await loadStaticAssets(readReal);
    expect([...assets.keys()].sort()).toEqual(Object.keys(STATIC_ASSET_FILES).sort());
    // Each route carries ITS file's bytes: a swapped STATIC_ASSET_FILES entry would put the theme
    // under /admin.css and the panel's own CSS under /rb-theme.css.
    const theme = assets.get("/rb-theme.css")!.body;
    const admin = assets.get("/admin.css")!.body;
    expect(theme).toContain("GENERATED by ops/admin/theme/build-theme.ts");
    expect(theme).not.toContain(".adm {");
    expect(admin).toContain(".adm {");
    expect(admin).not.toContain("GENERATED by ops/admin/theme/build-theme.ts");
    for (const asset of assets.values()) expect(asset.contentType).toBe("text/css; charset=utf-8");
  });

  test("reads each STATIC_ASSET_FILES entry by its file name under public/, once", async () => {
    const read: string[] = [];
    await loadStaticAssets(async (file) => (read.push(file), `body of ${file}`));
    expect(read).toEqual(Object.values(STATIC_ASSET_FILES));
  });

  test("a stylesheet that can't be read rejects, so the boot fails instead of a live 404", async () => {
    await expect(
      loadStaticAssets(async (file) => {
        if (file === "admin.css") throw new Error("ENOENT: admin.css");
        return "";
      }),
    ).rejects.toThrow("ENOENT: admin.css");
  });

  test("the entry point calls it and puts the result in the HandlerConfig", () => {
    const serverSrc = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(serverSrc).toContain("const assets = await loadStaticAssets((file) => Bun.file(new URL(`./public/${file}`, import.meta.url)).text());");
    const config = (/const config: HandlerConfig = \{([^}]*)\};/.exec(serverSrc)?.[1] ?? "")
      .replace(/\/\*[\s\S]*?\*\//g, "") // a commented-out `assets,` must not satisfy the pin
      .replace(/\/\/[^\n]*/g, "");
    // the bare shorthand `assets`, the variable the line above built -- not `assets: new Map()` or any
    // other value that merely mentions the word
    expect(config).toMatch(/(^|[\s,])assets\s*(,|$)/);
  });
});

// The page is a template (index.html) plus two stylesheets. These read the real files: the page must
// not link anything the server won't serve, and must not carry the styling that moved out of it.
describe("the page's stylesheets", () => {
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

  test("every stylesheet the page links is served", () => {
    const hrefs = [...html.matchAll(/<link\b[^>]*>/gi)]
      .map((m) => m[0])
      .filter((tag) => /\brel=["']?stylesheet\b/i.test(tag))
      .map((tag) => /\bhref=["']([^"']+)["']/i.exec(tag)?.[1]);
    expect(hrefs.length).toBeGreaterThanOrEqual(2); // can't pass vacuously
    for (const href of hrefs) {
      expect(href).toBeTruthy();
      expect(Object.hasOwn(STATIC_ASSET_FILES, href!)).toBe(true);
      expect(existsSync(new URL(`./public/${STATIC_ASSET_FILES[href!]}`, import.meta.url))).toBe(true);
    }
  });

  test("the page has no inline style block", () => {
    expect(/<style[\s>]/i.test(html)).toBe(false);
  });

  test("the page carries no legacy custom property", () => {
    // The hand-rolled token block is gone; a straggling var(--muted) would render as nothing.
    for (const name of ["bg", "panel", "border", "text", "muted", "accent", "danger", "ok", "inset", "chip", "btn2"]) {
      expect(new RegExp(`var\\(\\s*--${name}\\s*[,)]`).test(html)).toBe(false); // var(--x)
      expect(new RegExp(`(^|[\\s;{"'])--${name}\\s*:`).test(html)).toBe(false); // a declaration of --x
    }
  });

  test("every class the page uses is styled by admin.css or the theme", () => {
    // A typo'd or renamed class (rb-btn--dnager) would silently render unstyled. Collect every class
    // token the markup, the script's className assignments, classList.toggle calls and the rb-*
    // string literals name, and require each to appear as a `.class` selector in one of the sheets.
    const sheets = (readFileSync(new URL("./public/admin.css", import.meta.url), "utf8") + readFileSync(new URL("./public/rb-theme.css", import.meta.url), "utf8")).replace(/\/\*[\s\S]*?\*\//g, ""); // a class named only in a comment is not styled
    const styled = new Set([...sheets.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!));
    const used = new Set<string>();
    const add = (list: string | undefined) => {
      for (const token of (list ?? "").split(/\s+/)) if (/^[A-Za-z][\w-]*$/.test(token)) used.add(token);
    };
    for (const m of html.matchAll(/\bclass="([^"]*)"/g)) add(m[1]);
    for (const m of html.matchAll(/\bclassName = "([^"]*)"/g)) add(m[1]);
    for (const m of html.matchAll(/classList\.toggle\("([^"]+)"/g)) add(m[1]);
    for (const m of html.matchAll(/"(rb-[\w-]+)"/g)) add(m[1]);
    expect(used.size).toBeGreaterThan(40); // can't pass vacuously
    expect(used.has("rb-btn--danger") && used.has("rb-badge--success") && used.has("nowrap")).toBe(true);
    const unstyled = [...used].filter((c) => !styled.has(c));
    expect(unstyled).toEqual([]);
  });
});

// rb-theme.css is GENERATED by ops/admin/theme/build-theme.ts from the pinned @rackbops/styles and
// committed. Its first line names the version it came from; this fails when the pin moves without a
// rebuild (or the file is hand-edited), with no need for node_modules (CI does not install the theme
// package).
describe("rb-theme.css", () => {
  const themePkg = JSON.parse(readFileSync(new URL("./theme/package.json", import.meta.url), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const pin = themePkg.devDependencies?.["@rackbops/styles"] ?? "";
  const css = readFileSync(new URL("./public/rb-theme.css", import.meta.url), "utf8");

  test("is stamped with the version pinned in ops/admin/theme/package.json", () => {
    const expectedBanner = composeThemeCss(pin, "", "").split("\n")[0];
    expect(css.split("\n")[0]).toBe(expectedBanner);
  });

  test("the pin is an exact version", () => {
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("carries both themes", () => {
    expect(css).toContain('[data-rb-style="arcane-obsidian"]');
    expect(css).toContain('[data-rb-style="arcane-parchment"]');
  });
});

// admin.css is the panel's own CSS and the theme is the only source of colour, type and shape: it is
// written with --rb-* tokens, so a re-theme (or a light/dark switch) can never leave a stray literal.
describe("admin.css uses tokens only", () => {
  const css = readFileSync(new URL("./public/admin.css", import.meta.url), "utf8");
  const themeCss = readFileSync(new URL("./public/rb-theme.css", import.meta.url), "utf8");

  // A small CSS scanner: every `prop: value` declaration at ANY nesting depth (@media, native nesting),
  // and every selector / at-rule prelude, with comments stripped and `;` `{` `}` inside parentheses
  // or strings ignored. Selectors are never mistaken for declarations, so `#logs-filter` is not a hex
  // colour.
  function parseCss(source: string): { decls: { prop: string; value: string }[]; selectors: string[] } {
    const decls: { prop: string; value: string }[] = [];
    const selectors: string[] = [];
    let buf = "";
    let parens = 0;
    let quote = "";
    const flush = () => {
      const i = buf.indexOf(":");
      if (buf.trim() !== "" && i !== -1) decls.push({ prop: buf.slice(0, i).trim().toLowerCase(), value: buf.slice(i + 1).trim() });
      buf = "";
    };
    for (const ch of source.replace(/\/\*[\s\S]*?\*\//g, "")) {
      if (quote) {
        buf += ch;
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") parens++;
      else if (ch === ")") parens--;
      else if (parens === 0 && ch === "{") {
        selectors.push(buf.trim());
        buf = "";
        continue;
      } else if (parens === 0 && (ch === ";" || ch === "}")) {
        flush();
        continue;
      }
      buf += ch;
    }
    return { decls, selectors };
  }
  const { decls, selectors } = parseCss(css);

  // What a colour-bearing declaration may contain besides var(...) tokens and numbers: line styles,
  // the non-colour keywords, and color-mix()'s own words. Anything else -- a named colour (red,
  // white, Canvas ...), a colour function, a hex value -- is a literal.
  const COLOUR_PROPS = /^(color|background(-color|-image)?|border(-[a-z]+)*|outline(-color)?|box-shadow|text-shadow|fill|stroke|[a-z-]*-color|-webkit-text-fill-color|text-decoration(-color)?|column-rule(-color)?)$/;
  const ALLOWED_WORDS = new Set(["solid", "dashed", "dotted", "none", "transparent", "currentcolor", "inherit", "initial", "unset", "important", "in", "srgb", "color-mix(", "calc("]);
  // Every CSS named colour, and every system colour including the deprecated CSS2 ones -- except
  // `background`, which doubles as a property name in `transition: background ...`. Checked in EVERY
  // value of EVERY property (custom property names are stripped first, a var() fallback is not), so
  // `filter: drop-shadow(0 0 1px red)` and `color: var(--rb-text, red)` are caught as well as
  // `color: red`. (`tan(` etc. are functions: the scan keeps a trailing "(" on a word, so they never
  // match a colour name.) A backslash anywhere in a value is rejected too, since a CSS escape can
  // spell a colour word (`r\65 d`) past the word scan.
  const NAMED_COLOURS = new Set(
    ("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen " +
      "canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext highlight highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext " +
      "activeborder activecaption appworkspace buttonhighlight buttonshadow captiontext inactiveborder inactivecaption inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow threedface threedhighlight threedlightshadow threedshadow window windowframe windowtext").split(" "),
  );
  function colourViolation(prop: string, value: string): string | null {
    if (value.includes("\\")) return "escape sequence";
    if (/#[0-9a-f]{3,8}\b/i.test(value)) return "hex colour";
    if (/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|light-dark)\(/i.test(value)) return "colour function";
    for (const m of value.replace(/--[\w-]+/g, " ").toLowerCase().matchAll(/[a-z-]+\(?/g)) {
      if (NAMED_COLOURS.has(m[0])) return `named colour "${m[0]}"`;
    }
    if (!COLOUR_PROPS.test(prop)) return null;
    const rest = value.replace(/var\([^)]*\)/g, " ").replace(/-?\d*\.?\d+(px|rem|em|%)?/g, " ");
    for (const m of rest.toLowerCase().matchAll(/[a-z-]+\(?/g)) {
      if (!ALLOWED_WORDS.has(m[0])) return `unexpected word "${m[0]}"`;
    }
    return null;
  }

  test("the declaration parser finds the sheet's declarations (can't pass vacuously)", () => {
    expect(decls.length).toBeGreaterThan(100);
    // ... including declarations inside a nested rule and an @media block, next to a parent's own.
    const sample = parseCss(".a { color: #f00; & b { margin: 0 } border-radius: 6px } @media (max-width: 640px) { .c { font-family: Arial } }");
    expect(sample.decls).toEqual([
      { prop: "color", value: "#f00" },
      { prop: "margin", value: "0" },
      { prop: "border-radius", value: "6px" },
      { prop: "font-family", value: "Arial" },
    ]);
  });

  test("the colour check accepts tokens and rejects every literal spelling", () => {
    for (const [prop, value] of [
      ["color", "var(--rb-text)"],
      ["border", "1px solid var(--rb-border)"],
      ["border-left", "3px solid var(--rb-danger)"],
      ["box-shadow", "0 0 0 3px var(--rb-accent-wash)"],
      ["background", "color-mix(in srgb, var(--rb-danger) 16%, transparent)"],
      ["border-color", "color-mix(in srgb, var(--rb-accent) 40%, var(--rb-border))"],
      ["background", "none"],
      ["outline", "none"],
      ["display", "flex"],
      ["text-transform", "none"],
      ["grid-template-columns", "auto 1fr"],
    ] as const) {
      expect({ prop, value, violation: colourViolation(prop, value) }).toEqual({ prop, value, violation: null });
    }
    for (const [prop, value] of [
      ["color", "red"],
      ["background", "white"],
      ["color", "Canvas"],
      ["border", "1px solid black"],
      ["background", "color-mix(in srgb, red, blue)"],
      ["color", "color(display-p3 1 0 0)"],
      ["color", "#fff"],
      ["fill", "rgb(0 0 0)"],
      ["filter", "drop-shadow(0 0 1px #000)"],
      // named colours on properties outside the usual colour set, and inside a var() fallback
      ["background-image", "linear-gradient(red, blue)"],
      ["filter", "drop-shadow(0 0 1px red)"],
      ["scrollbar-color", "red blue"],
      ["-webkit-text-fill-color", "red"],
      ["text-emphasis-color", "red"],
      ["stop-color", "red"],
      ["mask-image", "linear-gradient(red, blue)"],
      ["-webkit-tap-highlight-color", "red"],
      ["color", "var(--rb-text, red)"],
      ["border-top-color", "hotpink"],
      // deprecated system colours on non-colour properties, and a colour spelled with a CSS escape
      ["filter", "drop-shadow(0 0 1px WindowText)"],
      ["mask-image", "linear-gradient(ThreeDFace, ThreeDShadow)"],
      ["color", "var(--rb-text, r\\65 d)"],
    ] as const) {
      expect({ prop, value, rejected: colourViolation(prop, value) !== null }).toEqual({ prop, value, rejected: true });
    }
  });

  test("has no colour literal", () => {
    for (const { prop, value } of decls) {
      expect({ prop, value, violation: colourViolation(prop, value) }).toEqual({ prop, value, violation: null });
    }
  });

  test("every font-family is a token", () => {
    const families = decls.filter((d) => d.prop === "font-family");
    expect(families.length).toBeGreaterThan(0);
    for (const { value } of families) {
      expect(value).toMatch(/^(var\(--rb-font-(body|mono|display)\)|inherit)$/);
    }
    // The `font` shorthand can smuggle a family in past the check above.
    expect(decls.filter((d) => d.prop === "font")).toEqual([]);
  });

  test("every border-radius is a token, 50% or 0", () => {
    const radii = decls.filter((d) => /^border(-[a-z]+)*-radius$/.test(d.prop));
    expect(radii.length).toBeGreaterThan(0);
    for (const { prop, value } of radii) {
      for (const part of value.split(/\s+/)) {
        expect({ prop, part, ok: /^(var\(--rb-radius(-lg|-pill)?\)|50%|0)$/.test(part) }).toEqual({ prop, part, ok: true });
      }
    }
  });

  test("restates the [hidden] rule, which an author display rule would otherwise beat", () => {
    // .adm / .adm-panel / .rb-alert all set `display`, and an author `display` beats the browser's own
    // [hidden] { display: none } -- without this the hidden app (behind the token gate), the hidden
    // tab panels and the drift banner would all show at once. (The gate itself has no display rule.)
    const hidden = /(^|\})\s*\[hidden\]\s*\{([^{}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""));
    expect(hidden?.[2]).toMatch(/display:\s*none\s*!important/);
  });

  test("the small state text and the touch targets keep the accessible choices (WCAG AA text, 24px / 44px targets)", () => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`).exec(bare)?.[2] ?? "";
    // The light theme's success / warning / info text on their own 16% tint is 2.9 / 2.85 / 4.0 : 1, so
    // a badge's words are body text; the semantic modifier only tints the pill.
    expect(rule(".plugin-badge")).toMatch(/color:\s*var\(--rb-text\);/);
    // The instance badge (the wrong-instance guard) does the same: accent text on its accent wash is 4.4 : 1.
    expect(rule(".instance-badge")).toMatch(/color:\s*var\(--rb-text\);/);
    // The small danger button sits in this box, and danger red on the sunken well is 4.24 : 1.
    expect(rule(".plugin-update")).toMatch(/background:\s*var\(--rb-surface\);/);
    // A chip's remove button is never smaller than 24 x 24 CSS px, and on a phone a plugin bundle's own
    // buttons and the panel's are 44px tall.
    expect(rule(".tag-field .tag button")).toMatch(/min-width:\s*1\.5rem;[\s\S]*min-height:\s*1\.5rem;/);
    const phone = /@media \(max-width: 640px\) \{([\s\S]*)\}\s*$/.exec(bare)?.[1] ?? "";
    expect(phone).toMatch(/:where\(\.plugin-admin-tab button\)\s*\{\s*min-height:\s*44px;/);
    expect(phone).toMatch(/\.adm \.rb-btn[\s\S]*min-height:\s*44px;/);
  });

  test("the Apply bar (#257): sticky at the bottom, stacks on a phone, pads focus scrolling, bounds its text, marks a refused control", () => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`).exec(bare)?.[2] ?? "";
    expect(rule(".adm-apply")).toMatch(/position:\s*sticky;[\s\S]*bottom:\s*0;/);
    // The tone rides on the left edge, in tokens: a colour, never small text.
    expect(rule(".adm-apply--danger")).toMatch(/border-left-color:\s*var\(--rb-danger\);/);
    expect(rule(".adm-apply--ok")).toMatch(/border-left-color:\s*var\(--rb-success\);/);
    // On a phone it stacks, and in a column the text's flex-basis would be a HEIGHT (a 260px-tall bar), so the
    // text goes back to its content's size.
    const phone = /@media \(max-width: 640px\) \{([\s\S]*)\}\s*$/.exec(bare)?.[1] ?? "";
    expect(phone).toMatch(/\.adm-apply\s*\{\s*flex-direction:\s*column;/);
    expect(phone).toMatch(/\.adm-apply__text\s*\{\s*flex:\s*0 0 auto;/);
    // A sticky bar covers the bottom of the viewport, so focus scrolling is padded while it shows (the phone
    // bar, stacked, is taller) -- or a Tab stop lands underneath it. And its text is bounded, so a compose log
    // of hundreds of lines cannot push the buttons off the screen.
    expect(rule(":root:has(.adm-apply:not([hidden]))")).toMatch(/scroll-padding-bottom:\s*6rem;/);
    expect(phone).toMatch(/:root:has\(\.adm-apply:not\(\[hidden\]\)\)\s*\{\s*scroll-padding-bottom:\s*10rem;/);
    // A failed bar (a compose log in its title) and a refused one (the offending value in its hint) can be
    // taller, both bounded at 30vh below, so the --danger padding is that bound plus the rest of the bar
    // (unclamped, on purpose: see admin.css). Equal specificity: each danger rule must FOLLOW its base rule.
    expect(rule(":root:has(.adm-apply--danger:not([hidden]))")).toMatch(/scroll-padding-bottom:\s*calc\(30vh \+ 5rem\);/);
    expect(phone).toMatch(/:root:has\(\.adm-apply--danger:not\(\[hidden\]\)\)\s*\{\s*scroll-padding-bottom:\s*calc\(30vh \+ 10rem\);/);
    expect(bare.indexOf(":root:has(.adm-apply--danger")).toBeGreaterThan(bare.indexOf(":root:has(.adm-apply:not([hidden]))"));
    expect(phone.indexOf(":root:has(.adm-apply--danger")).toBeGreaterThan(phone.indexOf(":root:has(.adm-apply:not([hidden]))"));
    // The title and the hint are two SEPARATE scrollers, each bounded at 30vh, and the wrapper around them is
    // neither: the hint holds the backup path (#47), which must never be inside the title's scroller (a
    // 300-line log would push it out of view), while a pasted 3000-character value in a refusal cannot make
    // the bar taller than the bound either.
    expect(rule(".adm-apply__text > strong")).toMatch(/max-height:\s*30vh;[\s\S]*overflow-y:\s*auto;/);
    expect(rule(".adm-apply__text .field-hint")).toMatch(/max-height:\s*30vh;[\s\S]*overflow-y:\s*auto;/);
    expect(rule(".adm-apply__text")).not.toMatch(/max-height|overflow-y/);
    // The bar takes focus while a request is in flight and shows no ring of its own: the theme's covers it.
    expect(themeCss).toMatch(/:where\(:focus-visible\)\s*\{\s*outline:\s*var\(--rb-focus-ring\);/);
    // A control the bar refused (the page sets aria-invalid on it) and a chip field around one.
    expect(rule('.adm [aria-invalid="true"]')).toMatch(/border-color:\s*var\(--rb-danger\);/);
    expect(rule('.tag-field:has([aria-invalid="true"])')).toMatch(/border-color:\s*var\(--rb-danger\);/);
  });

  test("the rules for a plugin's own bare controls sit wholly inside :where(), so a bundle's styling wins", () => {
    // A published plugin bundle builds bare label / input / select / textarea / button elements, so
    // admin.css styles them by tag name under .plugin-admin-tab. Every such selector must be ONE
    // :where(...) group -- zero specificity -- or it would beat a rule the bundle brings itself.
    const topLevelParts = (sel: string) => {
      const parts: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < sel.length; i++) {
        if (sel[i] === "(") depth++;
        else if (sel[i] === ")") depth--;
        else if (sel[i] === "," && depth === 0) {
          parts.push(sel.slice(start, i).trim());
          start = i + 1;
        }
      }
      parts.push(sel.slice(start).trim());
      return parts;
    };
    const wholly = (part: string) => {
      if (!part.startsWith(":where(")) return false;
      let depth = 0;
      for (let i = 0; i < part.length; i++) {
        if (part[i] === "(") depth++;
        else if (part[i] === ")" && --depth === 0) return i === part.length - 1;
      }
      return false;
    };
    const bare = selectors.flatMap(topLevelParts).filter((p) => p.includes(".plugin-admin-tab") && /\b(label|input|select|textarea|button)\b/.test(p));
    expect(bare.length).toBeGreaterThanOrEqual(5);
    for (const part of bare) expect({ part, wholly: wholly(part) }).toEqual({ part, wholly: true });
    // the checker itself can tell the difference
    expect(wholly(".plugin-admin-tab :where(label)")).toBe(false);
    expect(wholly(":where(.plugin-admin-tab label):focus-visible")).toBe(false);
    expect(wholly(":where(.plugin-admin-tab label)")).toBe(true);
  });

  test("only references --rb-* tokens the theme defines, and defines none of its own", () => {
    const defined = new Set([...themeCss.matchAll(/(--rb-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(20);
    for (const name of used) expect({ name, defined: defined.has(name) }).toEqual({ name, defined: true });
    expect(decls.filter((d) => d.prop.startsWith("--"))).toEqual([]);
  });
});

// The page follows the viewer's colour scheme with no toggle: an inline script in <head>, ahead of the
// stylesheets, sets data-rb-style on <html>. Evaluated here against a stubbed window/document.
describe("colour scheme (the inline head script)", () => {
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const src = /<script>\n([\s\S]*?)\n<\/script>/.exec(head)?.[1] ?? "";

  test("the page is dark by default for a viewer with no script", () => {
    expect(html).toContain('<html lang="en" data-rb-style="arcane-obsidian">');
  });

  test("the script sits ahead of the stylesheets, so first paint is already the right scheme", () => {
    expect(src).not.toBe("");
    expect(head.indexOf("<script>")).toBeGreaterThan(-1);
    expect(head.indexOf("<script>")).toBeLessThan(head.indexOf('rel="stylesheet"'));
  });

  function run(dark: boolean) {
    const listeners: [string, () => void][] = [];
    const queries: string[] = [];
    const mq = { matches: dark, addEventListener: (type: string, fn: () => void) => void listeners.push([type, fn]) };
    const root = { dataset: {} as Record<string, string> };
    new Function("window", "document", `"use strict";\n${src}`)(
      { matchMedia: (q: string) => (queries.push(q), mq) },
      { documentElement: root },
    );
    return { root, mq, listeners, queries };
  }

  test("dark preference -> arcane-obsidian, light -> arcane-parchment", () => {
    const d = run(true);
    expect(d.queries).toEqual(["(prefers-color-scheme: dark)"]);
    expect(d.root.dataset.rbStyle).toBe("arcane-obsidian");
    expect(run(false).root.dataset.rbStyle).toBe("arcane-parchment");
  });

  test("follows a later change of the OS setting", () => {
    const p = run(true);
    const change = p.listeners.find(([type]) => type === "change")?.[1];
    expect(change).toBeTruthy();
    p.mq.matches = false;
    change!();
    expect(p.root.dataset.rbStyle).toBe("arcane-parchment");
    p.mq.matches = true;
    change!();
    expect(p.root.dataset.rbStyle).toBe("arcane-obsidian");
  });
});

// The tab decisions are lifted from index.html between their TABS markers (the same lift the other
// pure page helpers use), so the page's own source is what's pinned -- not a copy of it.
describe("tabs (lifted from index.html)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const tabsSrc = indexSrc.match(/\/\/ TABS:begin\n([\s\S]*?)\n\s*\/\/ TABS:end/)?.[1];

  test("the marked block is present", () => {
    expect(tabsSrc).toBeTruthy();
  });

  const { tabFromHash, nextTabId } = new Function(`"use strict";\n${tabsSrc ?? ""}\nreturn { tabFromHash, nextTabId };`)() as {
    tabFromHash: (hash: unknown) => string;
    nextTabId: (current: string, key: string) => string;
  };

  test("an unknown or empty hash opens Overview", () => {
    // Mutation: returning the raw hash makes "#nope" open a tab that doesn't exist.
    for (const hash of ["", "#", "#nope", "#PLUGINS", "#constructor", "#__proto__", "#toString", undefined, null]) {
      expect(tabFromHash(hash)).toBe("overview");
    }
  });

  test("a known hash opens its tab", () => {
    expect(tabFromHash("#overview")).toBe("overview");
    expect(tabFromHash("#plugins")).toBe("plugins");
    expect(tabFromHash("#settings")).toBe("settings");
    expect(tabFromHash("plugins")).toBe("plugins"); // location.hash always has the '#', but the parse shouldn't need it
  });

  test("arrow keys wrap in both directions", () => {
    expect(nextTabId("overview", "ArrowRight")).toBe("plugins");
    expect(nextTabId("plugins", "ArrowRight")).toBe("settings");
    expect(nextTabId("settings", "ArrowRight")).toBe("overview");
    expect(nextTabId("settings", "ArrowLeft")).toBe("plugins");
    expect(nextTabId("plugins", "ArrowLeft")).toBe("overview");
    expect(nextTabId("overview", "ArrowLeft")).toBe("settings");
  });

  test("Home and End jump to the ends", () => {
    for (const from of ["overview", "plugins", "settings"]) {
      expect(nextTabId(from, "Home")).toBe("overview");
      expect(nextTabId(from, "End")).toBe("settings");
    }
  });

  test("any other key stays put", () => {
    for (const key of ["Enter", " ", "Tab", "ArrowUp", "ArrowDown", "a", "PageDown", "Escape"]) {
      expect(nextTabId("plugins", key)).toBe("plugins");
    }
  });
});

// The markup half of the tabs, and the guarantee that moving seven stacked sections under three tabs
// lost nothing. Parsed from the real index.html (the page markup only -- not the script below it).
describe("page skeleton", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const bodyStart = indexSrc.indexOf("<body>");
  const markup = indexSrc
    .slice(bodyStart, indexSrc.indexOf("<script>", bodyStart))
    .replace(/<!--[\s\S]*?-->/g, "");

  function attrs(tagSource: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of tagSource.matchAll(/([\w-]+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
    return out;
  }
  const tabs = [...markup.matchAll(/<button\b[^>]*\brole="tab"[^>]*>/g)].map((m) => attrs(m[0]));
  const panels = [...markup.matchAll(/<div\b[^>]*\brole="tabpanel"[^>]*>/g)].map((m) => attrs(m[0]));

  test("every tab controls an existing tabpanel", () => {
    expect(tabs.length).toBe(3);
    expect(panels.length).toBe(3);
    for (const tab of tabs) {
      const panel = panels.find((p) => p.id === tab["aria-controls"]);
      expect({ tab: tab.id, panel: panel?.id }).toEqual({ tab: tab.id, panel: tab["aria-controls"] });
      expect(panel!["aria-labelledby"]).toBe(tab.id);
    }
  });

  // Container tags only, walked with a stack, so "inside a tabpanel" means genuinely nested in one.
  // Maps every id found inside a tabpanel to the id of the panel that holds it.
  function panelOfIds(): Map<string, string> {
    const out = new Map<string, string>();
    const stack: { tag: string; panel: string | null }[] = [];
    for (const m of markup.matchAll(/<(\/?)(div|section|main|nav)\b([^>]*)>/g)) {
      if (m[1] === "/") {
        stack.pop();
        continue;
      }
      const a = attrs(m[3]!);
      const panel = a.role === "tabpanel" ? (a.id ?? null) : (stack.findLast((s) => s.panel !== null)?.panel ?? null);
      stack.push({ tag: m[2]!, panel });
      if (a.id && panel && !out.has(a.id)) out.set(a.id, panel);
    }
    return out;
  }

  test("every original section id still exists exactly once, inside a tabpanel", () => {
    const inPanels = panelOfIds();
    for (const id of ["status-section", "plugins-section", "plugin-admin-section", "admins-section", "identity-section"]) {
      expect({ id, total: markup.split(`id="${id}"`).length - 1 }).toEqual({ id, total: 1 });
      expect({ id, inPanel: Boolean(inPanels.get(id)) }).toEqual({ id, inPanel: true });
    }
  });

  test("each section sits under the tab the issue names", () => {
    // Overview: status, restart, logs. Plugins: the plugin list and plugin settings. Settings:
    // config, admins, identity. (Logs and Config had no id before #238; they got one so this can say so.)
    const inPanels = panelOfIds();
    const expected: Record<string, string> = {
      "status-section": "panel-overview",
      "logs-section": "panel-overview",
      "plugins-section": "panel-plugins",
      "plugin-admin-section": "panel-plugins",
      "config-section": "panel-settings",
      "admins-section": "panel-settings",
      "identity-section": "panel-settings",
    };
    for (const [id, panel] of Object.entries(expected)) {
      expect({ id, total: markup.split(`id="${id}"`).length - 1 }).toEqual({ id, total: 1 });
      expect({ id, panel: inPanels.get(id) }).toEqual({ id, panel });
    }
  });

  test("the token gate and the out-of-date banner stay outside every tabpanel, and the banner above the tabs", () => {
    const inPanels = panelOfIds();
    expect(markup).toContain('id="gate"');
    expect(markup).toContain('id="bot-ops-outdated-banner"');
    expect(inPanels.has("gate")).toBe(false);
    expect(inPanels.has("bot-ops-outdated-banner")).toBe(false);
    expect(markup.indexOf('id="bot-ops-outdated-banner"')).toBeLessThan(markup.indexOf('role="tablist"'));
  });

  test("the decorative wordmark spark is hidden from the accessibility tree", () => {
    // Otherwise the page's <h1> is announced as "◆bot admin".
    const sparks = markup.split('class="rb-wordmark__spark"').length - 1;
    expect(sparks).toBe(2); // the gate's and the app's
    expect(markup.split('class="rb-wordmark__spark" aria-hidden="true"').length - 1).toBe(sparks);
  });

  test("the page has exactly one tablist, holding the three tabs, and the script's lookup of it matches", () => {
    expect(markup.split('role="tablist"').length - 1).toBe(1);
    const list = markup.slice(markup.indexOf('role="tablist"'));
    const listEnd = list.indexOf("</nav>");
    const inside = [...list.slice(0, listEnd).matchAll(/\brole="tab"/g)].length;
    expect(inside).toBe(3);
    expect(indexSrc).toContain(`document.querySelector('[role="tablist"]')`);
  });

  test("every element id the page script looks up by literal exists in the markup", () => {
    // A control the script wires (Lock, Restart, Save ...) or a section it fills that lost its id in
    // a re-organisation would otherwise throw at load (or silently do nothing) while every test of a
    // lifted block stays green.
    const script = indexSrc.slice(indexSrc.indexOf("<script>", bodyStart));
    const looked = new Set([...script.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]!));
    expect(looked.size).toBeGreaterThan(25); // can't pass vacuously
    for (const id of ["lock", "restart", "unlock", "apply-bar", "apply-title", "apply-hint", "apply-go", "apply-discard", "apply-ok", "logs-out", "status-grid"]) {
      expect(looked.has(id)).toBe(true);
    }
    const missing = [...looked].filter((id) => markup.split(`id="${id}"`).length - 1 !== 1);
    expect(missing).toEqual([]);
  });

  test("the controls carry the design-system classes the restyle gave them", () => {
    // Presentation only (no behaviour rides on these), but a control that silently loses `rb-btn` or
    // gets the wrong variant renders unstyled or with the wrong emphasis while every other test stays
    // green. Each entry is a fragment of the page and how many times it must appear.
    const expected: [string, number][] = [
      // static markup
      ['<button id="unlock" class="rb-btn rb-btn--primary">', 1],
      ['<input id="token-input" class="rb-input"', 1],
      ['<button id="lock" class="rb-btn rb-btn--ghost">', 1],
      ['<button id="restart" class="rb-btn rb-btn--danger">', 1],
      ['<button id="refresh-status" class="rb-btn">', 1],
      ['<button id="load-logs" class="rb-btn">', 1],
      ['<input id="logs-n" class="rb-input"', 1],
      ['<input id="logs-filter" class="rb-input"', 1],
      ['id="logs-wrap" class="rb-checkbox"', 1],
      ['<pre id="logs-out" class="rb-pre rb-log"', 1],
      ['<button id="apply-go" type="button" class="rb-btn rb-btn--primary">', 1], // #257: the ONE apply button
      ['<button id="apply-discard" type="button" class="rb-btn rb-btn--ghost">', 1],
      ['<button id="apply-ok" type="button" class="rb-btn rb-btn--ghost" hidden>', 1],
      ['<div id="apply-bar" class="adm-apply" tabindex="-1" hidden>', 1],
      ['<div class="adm-apply__text" role="status">', 1], // the announced text
      ['<button id="add-admin" class="rb-btn rb-btn--primary">', 1],
      ['<input id="admin-email" class="rb-input"', 1],
      ['<div id="env-fields" class="adm-fields">', 1],
      ['class="banner-warn rb-alert rb-alert--danger"', 1],
      ['class="rb-tabstrip" role="tablist"', 1],
      ['class="rb-tabpanel adm-panel"', 3],
      ['class="rb-card"', 7], // seven sections (five carry their old id, Logs and Config their new one)
      ['class="rb-tabstrip__tab', 3], // the three tab buttons
      ['<main id="app" class="adm" hidden>', 1],
      ['class="adm-gate"', 1],
      ['class="rb-wordmark"', 2], // the gate's h1 and the app's
      ['class="instance-badge rb-badge rb-badge--md"', 2],
      ['<label class="inline-check rb-label">', 1], // the Wrap toggle
      ['class="status-grid"', 2], // status and identity
      ['class="msg"', 2], // restart, admins (#257: the config and plugins message lines went with the Save buttons)
      // built by the page script
      ['btn.className = "rb-btn rb-btn--danger rb-btn--sm";', 1], // Remove admin
      ['check.className = "rb-checkbox";', 1], // a plugin's tick box
      ['now.className = "rb-btn rb-btn--primary rb-btn--sm";', 1], // Update now
      ['when.className = "rb-input";', 1], // the schedule picker
      ['schedBtn.className = "rb-btn rb-btn--sm";', 1],
      ['remind.className = "rb-btn rb-btn--sm";', 1],
      ['skip.className = "rb-btn rb-btn--sm";', 1],
      ['cancel.className = "rb-btn rb-btn--danger rb-btn--sm";', 1],
      ['add.className = "tag-add rb-input";', 1], // the chip editor's typing field
      ['label.className = "rb-label";', 1], // a config field's label
      ['control.className = "rb-select";', 2], // an enum select and the branch chooser
      ['control.className = "rb-input";', 1], // a plain config field
      ['notice.className = "field-hint field-hint--danger";', 1],
      ['row.className = "plugin-row";', 1],
      ['row.className = "admin-row";', 1],
      ['wrapper.className = "tag-field";', 1],
      ['sched.className = "sched";', 1],
      ['actions.className = "plugin-actions";', 1],
      ['wrap.className = "plugin-update";', 1],
      ['wrap.className = "plugin-admin-tab";', 1],
    ];
    for (const [fragment, count] of expected) {
      expect({ fragment, found: indexSrc.split(fragment).length - 1 }).toEqual({ fragment, found: count });
    }
  });

  test("every lifted block is still present", () => {
    // The thirteen blocks server.test.ts lifted out of the page before #238, plus the four it added
    // (TABS, TABS_DOM, LOGS_SCROLL, PLUGIN_BADGE_CLASSES), minus the two save blocks #257 deleted
    // (PLUGINS_SAVE, ENV_SAVE) and plus the four it added (APPLY_PLAN, APPLY_VIEW, APPLY, TAG_SYNC). A
    // rename or a deleted marker would otherwise leave a lifted `new Function` evaluating an empty string.
    const names = [
      "TIMEOUT_SIGNAL", "PLUGIN_ADMIN_HELPERS", "PLUGIN_BADGES", "PLUGIN_REQUEST_HELPERS", "PLUGINS_SAVE_PLAN",
      "PLUGIN_REQUEST_SEND", "OUTDATED_BANNER_HELPERS", "RESTART", "ENV_SCHEMA", "ENV_SAVE_PLAN",
      "HAS_ACCESS_SESSION", "TABS", "TABS_DOM", "LOGS_SCROLL", "PLUGIN_BADGE_CLASSES",
      "APPLY_PLAN", "APPLY_VIEW", "APPLY", "TAG_SYNC",
    ];
    expect(names.length).toBe(19);
    // ... and the two that were deleted are really gone, with the buttons, message lines and functions.
    for (const gone of ["PLUGINS_SAVE", "ENV_SAVE"]) {
      expect({ gone, begin: indexSrc.split(`// ${gone}:begin\n`).length - 1 }).toEqual({ gone, begin: 0 });
    }
    for (const name of names) {
      expect({ name, begin: indexSrc.split(`// ${name}:begin\n`).length - 1 }).toEqual({ name, begin: 1 });
      expect({ name, end: indexSrc.split(`// ${name}:end\n`).length - 1 }).toEqual({ name, end: 1 });
    }
  });

  // ---- #257: the Apply bar's place in the page ----
  test("the apply bar is the last child of #app, outside every tabpanel", () => {
    const inPanels = panelOfIds();
    expect(markup).toContain('id="apply-bar"');
    expect(inPanels.has("apply-bar")).toBe(false);
    const start = markup.indexOf('id="apply-bar"');
    // After the last tabpanel opens ...
    expect(start).toBeGreaterThan(markup.lastIndexOf('role="tabpanel"'));
    // ... and closes before </main>, with nothing between that and the end of <main>.
    const end = markup.indexOf("</main>", start);
    expect(end).toBeGreaterThan(start);
    // The bar's own element: from its opening tag to the </div> that closes it (nested divs counted) ...
    const open = markup.lastIndexOf("<div", start);
    let depth = 0;
    let close = -1;
    for (const m of markup.slice(open).matchAll(/<div\b|<\/div>/g)) {
      depth += m[0] === "</div>" ? -1 : 1;
      if (depth === 0) {
        close = open + m.index! + m[0].length;
        break;
      }
    }
    expect(close).toBeGreaterThan(open);
    // ... and after that, up to </main>, only whitespace and comments: nothing follows it, so it is the LAST
    // child of <main> (sticky at the bottom of the page) and a sibling of the tabpanels, not inside one.
    expect(markup.slice(close, end).replace(/<!--[\s\S]*?-->/g, "").trim()).toBe("");
    expect(markup.slice(end + "</main>".length).trim()).toBe("");
  });

  test("neither Save button nor its message line remains, and applying asks for no confirm(", () => {
    for (const gone of ["save-plugins", "save-env", "plugins-msg", "env-msg", "savePlugins", "saveEnv"]) {
      expect({ gone, found: indexSrc.includes(gone) }).toEqual({ gone, found: false });
    }
    // The confirm() dialogs that stay: removing an admin, an update action, Restart. None is in the bar.
    expect((indexSrc.match(/\bconfirm\(/g) ?? []).length).toBe(3);
    expect(applyBlock("APPLY")).not.toContain("confirm(");
    expect(applyBlock("APPLY_PLAN")).not.toContain("confirm(");
  });

  test("the Config editor does not render a PLUGINS field (loadEnv skips that key)", () => {
    // loadEnv is far too DOM-heavy to lift; the wiring is pinned in source, the file's idiom for it.
    const loadEnv = indexSrc.slice(indexSrc.indexOf("async function loadEnv()"), indexSrc.indexOf("// ENV_SCHEMA:begin"));
    expect(loadEnv.length).toBeGreaterThan(500);
    expect(loadEnv).toContain('if (key === "PLUGINS") continue;');
    expect(loadEnv.indexOf('if (key === "PLUGINS") continue;')).toBeLessThan(loadEnv.indexOf("buildEnvControl(key, value)"));
  });

  test("the bar is wired: the buttons through withBusy, and ONE delegated input and change listener on #app", () => {
    expect(indexSrc).toContain('document.getElementById("apply-go").addEventListener("click", (e) => withBusy(e.currentTarget, applyPending));');
    expect(indexSrc).toContain('document.getElementById("apply-discard").addEventListener("click", (e) => withBusy(e.currentTarget, discardPending));');
    expect(indexSrc).toContain('document.getElementById("apply-ok").addEventListener("click", dismissApplyResult);');
    expect(indexSrc.split('app.addEventListener("input", onControlEdited);').length - 1).toBe(1);
    expect(indexSrc.split('app.addEventListener("change", onControlEdited);').length - 1).toBe(1);
  });

  test("the bar re-reads what is pending whenever a baseline moves: loadEnv and loadPlugins end in refreshApplyBar", () => {
    const loadEnv = indexSrc.slice(indexSrc.indexOf("async function loadEnv()"), indexSrc.indexOf("// ENV_SCHEMA:begin"));
    const loadPlugins = indexSrc.slice(indexSrc.indexOf("async function loadPlugins()"), indexSrc.indexOf("// ---- #124: per-plugin admin tabs"));
    for (const [name, src] of [["loadEnv", loadEnv], ["loadPlugins", loadPlugins]] as const) {
      const finallyBlock = src.slice(src.lastIndexOf("} finally {"));
      expect({ name, refreshes: finallyBlock.includes("refreshApplyBar();") }).toEqual({ name, refreshes: true });
    }
  });

  test("while the bot's state is unreadable every plugin box is rendered disabled", () => {
    expect(indexSrc).toContain("container.appendChild(buildPluginRow(p, indexAvailable, !!data.stateError))");
    expect(indexSrc).toContain("if (stateError || (!p.inIndex && !p.enabled)) check.disabled = true;");
  });

  test("config is POSTed from ONE place: applyPending (a plugin bundle's own setEnv is separate, and unchanged)", () => {
    const post = 'api("/api/env", { method: "POST", body: plan.body, signal })';
    expect(applyBlock("APPLY").split(post).length - 1).toBe(1);
    expect(indexSrc.split(post).length - 1).toBe(1);
  });

  test("the chip editor writes its value carrier only through syncTagValue, so the bar hears every chip change", () => {
    const tagControl = indexSrc.slice(indexSrc.indexOf("function buildTagControl("), indexSrc.indexOf("function buildEnvControl("));
    expect(tagControl).toContain("const sync = () => syncTagValue(hidden, tokens);");
    // The one direct write is the initial seeding with the RAW loaded value (before the bar could care).
    expect(tagControl.split("hidden.value =").length - 1).toBe(1);
    expect(tagControl).toContain("hidden.value = value;");
  });
});

// ---------------------------------------------------------------------------------------------------
// #257: the Apply bar. Every change that needs a restart -- the plugin on/off choices and every edited
// config field -- collects in ONE bar and costs ONE POST /api/env and one restart. It replaces the two
// save paths (savePlugins, saveEnv); every guarantee their tests pinned is carried over BY NAME below:
//   saveEnv  "POSTs only the changed fields ... (#44)"        -> `an untouched field is never posted ...` +
//                                                                 `ticking one plugin and editing two fields is ONE POST ...`
//   saveEnv  "with nothing changed posts nothing"             -> `nothing changed: nothing is posted`
//   saveEnv  "a declined confirm posts nothing"               -> `no confirm is asked` (there is none to decline)
//   saveEnv  "a rejected save surfaces bot-ops.sh's own message and re-baselines (#47)" -> `a plain-text failure is shown verbatim ...`
//   saveEnv  "a failed recreate shows the compose error and backup path ... (#47)"      -> `a failed recreate shows the compose error ...`
//   saveEnv  "blanking a required field is refused ... nothing is posted (#45)"         -> `a blank required field blocks the whole apply ...`
//   saveEnv  "... alongside an unrelated valid change blocks the WHOLE save"            -> the same test (a plugin tick and a field change ride along)
//   saveEnv  "a bad-format value (BOT_BRANCH) is refused ... (#207)"                    -> `a bad format blocks the whole apply the same way`
//   saveEnv  "with no schema loaded ({}) ... the degraded path (#207)"                  -> `with no schema the apply still goes`
//   saveEnv  "the POST now carries a real AbortSignal (#53)"  -> `the POST carries an AbortSignal ...`
//   savePlugins "POSTs only PLUGINS ... then re-baselines all three views"              -> `ticking a plugin alone posts PLUGINS alone` + `success re-loads plugins, env and status ...`
//   savePlugins "with no change posts nothing"                -> `nothing changed: nothing is posted` + planApply `a formatting-only PLUGINS difference plans nothing`
//   savePlugins "a rejected save surfaces bot-ops.sh's own message"                     -> `a plain-text failure is shown verbatim ...`
//   savePlugins "refuses to post when stateError is set (no wipe ...)"                  -> `an unreadable bot state cannot produce a PLUGINS change` + planApply `with plugins null ...`
// planPluginsSave / planEnvSave / validateEnvChanges are unchanged and their own tests are untouched.
// #272 supersedes the two "... and re-baselines" carry-overs above for a PLAIN-TEXT failure only: that answer now
// KEEPS the user's edits (`a plain-text failure is shown verbatim, and the user's edits are kept`); the #47
// re-baseline is pinned by `a failed recreate ...` (JSON 502), `a 504 re-baselines ...` and `any other status
// re-baselines too ...`, and by `failureWroteNothing (#272)`.
// ---------------------------------------------------------------------------------------------------
const applyIndexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const applyBlock = (name: string): string =>
  applyIndexSrc.match(new RegExp(`// ${name}:begin\\n([\\s\\S]*?)\\n\\s*// ${name}:end`))?.[1] ?? "";

interface ApplyChange {
  key: string;
  before: string;
  now: string;
}
interface ApplyPlanInput {
  loadedEnv: Record<string, string>;
  fields: Record<string, string>;
  plugins: { checkedNames: string[]; currentValue: string; manifestOrder: string[] } | null;
}
interface ApplyPlan {
  changes: ApplyChange[];
  body: string;
  count: number;
  error?: string;
}
interface BarView {
  hidden: boolean;
  tone: string;
  title: string;
  hint: string;
  showDiscard: boolean;
  showGo: boolean;
  showOk: boolean;
  busy: boolean;
}
// "use strict" up front, like the page's own IIFE: without it a lifted `Function` body silently creates
// a global on an assignment to an un-injected identifier instead of throwing.
const planApply = new Function(
  `"use strict";\n${applyBlock("PLUGINS_SAVE_PLAN")}\n${applyBlock("ENV_SAVE_PLAN")}\n${applyBlock("APPLY_PLAN")}\nreturn planApply;`,
)() as (input: ApplyPlanInput) => ApplyPlan;
const { applyBarView, describeApplyFailure, failureWroteNothing } = new Function(
  `"use strict";\n${applyBlock("APPLY_VIEW")}\nreturn { applyBarView, describeApplyFailure, failureWroteNothing };`,
)() as {
  applyBarView: (state: { count: number; phase: string; error?: string; detail?: string; noop?: boolean }) => BarView;
  describeApplyFailure: (text: string, result: { log?: string; backup?: string } | null) => { error: string; detail: string };
  failureWroteNothing: (status: number, result: unknown, text: string) => boolean;
};

describe("planApply (#257)", () => {
  const W = { checkedNames: ["warbandeer", "raidhelper"], currentValue: "warbandeer", manifestOrder: ["warbandeer", "raidhelper"] };

  test("PLUGINS comes first, then the changed fields in field order", () => {
    const plan = planApply({
      loadedEnv: { WATCHED_REPOS: "acme/one", ANNOUNCE_CHANNEL_ID: "111", DISCORD_SERVER_ID: "" },
      fields: { WATCHED_REPOS: "acme/two", ANNOUNCE_CHANNEL_ID: "222", DISCORD_SERVER_ID: "" },
      plugins: W,
    });
    // WATCHED_REPOS before ANNOUNCE_CHANNEL_ID though it sorts after it: the loaded field order, never re-sorted.
    expect(plan.changes).toEqual([
      { key: "PLUGINS", before: "warbandeer", now: "warbandeer,raidhelper" },
      { key: "WATCHED_REPOS", before: "acme/one", now: "acme/two" },
      { key: "ANNOUNCE_CHANNEL_ID", before: "111", now: "222" },
    ]);
    expect(plan.body).toBe("PLUGINS=warbandeer,raidhelper\nWATCHED_REPOS=acme/two\nANNOUNCE_CHANNEL_ID=222");
    expect(plan.count).toBe(3);
    expect(plan.error).toBeUndefined();
  });

  test("PLUGINS is ordered by the manifest, not by the order the boxes were ticked in", () => {
    const plan = planApply({
      loadedEnv: {},
      fields: {},
      plugins: { checkedNames: ["warbandeer", "raidhelper"], currentValue: "", manifestOrder: ["raidhelper", "warbandeer"] },
    });
    expect(plan.changes).toEqual([{ key: "PLUGINS", before: "", now: "raidhelper,warbandeer" }]);
    expect(plan.body).toBe("PLUGINS=raidhelper,warbandeer");
  });

  test("an unchanged page plans nothing", () => {
    const plan = planApply({ loadedEnv: { A: "1", B: "" }, fields: { A: "1", B: "" }, plugins: { ...W, checkedNames: ["warbandeer"] } });
    expect(plan).toEqual({ changes: [], body: "", count: 0 });
  });

  test("a formatting-only PLUGINS difference plans nothing", () => {
    const plan = planApply({ loadedEnv: {}, fields: {}, plugins: { checkedNames: ["warbandeer", "raidhelper"], currentValue: "warbandeer, raidhelper", manifestOrder: ["warbandeer", "raidhelper"] } });
    expect(plan.count).toBe(0);
  });

  test("an existing name@version pin survives", () => {
    const plan = planApply({ loadedEnv: {}, fields: {}, plugins: { ...W, currentValue: "warbandeer@1.0.0" } });
    expect(plan.changes).toEqual([{ key: "PLUGINS", before: "warbandeer@1.0.0", now: "warbandeer@1.0.0,raidhelper" }]);
    expect(plan.body).toBe("PLUGINS=warbandeer@1.0.0,raidhelper");
  });

  test("unticking every plugin is a change to an empty PLUGINS", () => {
    const plan = planApply({ loadedEnv: {}, fields: {}, plugins: { ...W, checkedNames: [] } });
    expect(plan.changes).toEqual([{ key: "PLUGINS", before: "warbandeer", now: "" }]);
    expect(plan.body).toBe("PLUGINS=");
  });

  test("with plugins null, a ticked box plans nothing", () => {
    // `plugins` is null when the bot's state could not be read: nothing may be planned against it, whatever
    // is ticked, while the config fields still plan normally.
    const plan = planApply({ loadedEnv: { PLUGINS: "warbandeer", A: "1" }, fields: { A: "2" }, plugins: null });
    expect(plan.changes).toEqual([{ key: "A", before: "1", now: "2" }]);
    expect(plan.body).toBe("A=2");
  });

  test("a PLUGINS field among the env fields is ignored", () => {
    const plan = planApply({ loadedEnv: { PLUGINS: "warbandeer", A: "1" }, fields: { PLUGINS: "raidhelper", A: "2" }, plugins: { ...W, checkedNames: ["warbandeer"] } });
    expect(plan.changes).toEqual([{ key: "A", before: "1", now: "2" }]);
    expect(plan.body).not.toContain("PLUGINS");
  });

  test("a line break in a value is an error and the body is empty", () => {
    for (const bad of ["8080\nANNOUNCE_CHANNEL_ID=1", "8080\rX=1", "8080\r\nX=1", "\n"]) {
      const plan = planApply({ loadedEnv: { OK: "1", PORT: "" }, fields: { OK: "2", PORT: bad }, plugins: null });
      expect(plan.error, JSON.stringify(bad)).toBe("PORT must not contain a line break.");
      expect(plan.body, JSON.stringify(bad)).toBe("");
      expect(plan.count).toBe(2); // the bar still says how many changes are pending
    }
    // The FIRST offending key is named.
    expect(planApply({ loadedEnv: {}, fields: { A: "x\ny", B: "x\ny" }, plugins: null }).error).toBe("A must not contain a line break.");
  });
});

describe("applyBarView (#257)", () => {
  const hiddenView: BarView = { hidden: true, tone: "", title: "", hint: "", showDiscard: false, showGo: false, showOk: false, busy: false };
  const HINT = "The bot goes offline for about 20 seconds while it restarts.";

  test("idle with nothing pending: the bar is hidden", () => {
    expect(applyBarView({ count: 0, phase: "idle" })).toEqual(hiddenView);
  });

  test("idle with changes pending: the count, the consequence, Discard and Apply and restart", () => {
    expect(applyBarView({ count: 3, phase: "idle" })).toEqual({
      hidden: false, tone: "", title: "3 changes need a restart", hint: HINT, showDiscard: true, showGo: true, showOk: false, busy: false,
    });
  });

  test("the count is singular for one", () => {
    expect(applyBarView({ count: 1, phase: "idle" }).title).toBe("1 change needs a restart");
    expect(applyBarView({ count: 2, phase: "idle" }).title).toBe("2 changes need a restart");
  });

  test("idle with a validation error: the same title, the error as the hint, danger, both buttons", () => {
    expect(applyBarView({ count: 2, phase: "idle", error: "ANNOUNCE_CHANNEL_ID is required and cannot be blank." })).toEqual({
      hidden: false, tone: "danger", title: "2 changes need a restart", hint: "ANNOUNCE_CHANNEL_ID is required and cannot be blank.",
      showDiscard: true, showGo: true, showOk: false, busy: false,
    });
  });

  test("applying: Restarting the bot..., both buttons shown and busy", () => {
    expect(applyBarView({ count: 3, phase: "applying" })).toEqual({
      hidden: false, tone: "", title: "Restarting the bot…", hint: "This takes about 20 seconds.", showDiscard: true, showGo: true, showOk: false, busy: true,
    });
    // ... whatever else is in the state: an in-flight request has one message.
    expect(applyBarView({ count: 0, phase: "applying", error: "x", detail: "y" }).title).toBe("Restarting the bot…");
  });

  test("done: it says the change is running, ok tone, only OK", () => {
    expect(applyBarView({ count: 3, phase: "done" })).toEqual({
      hidden: false, tone: "ok", title: "Applied. The bot restarted with your changes.", hint: "", showDiscard: false, showGo: false, showOk: true, busy: false,
    });
    expect(applyBarView({ count: 0, phase: "done" }).hidden).toBe(false); // shown even though nothing is pending any more
  });

  test("done with nothing restarted (bot-ops.sh's \"no changes\" answer): it does not claim a restart", () => {
    const view = applyBarView({ count: 1, phase: "done", noop: true });
    // #272: THE wording under change. The hint used to say "The bot already had these values", which is false after
    // an apply that wrote .env and was killed before its recreate finished: the running bot does not have them.
    // It now says what the answer proves, that the SAVED settings hold them.
    expect(view).toEqual({
      hidden: false, tone: "ok", title: "Nothing needed applying.", hint: "The saved settings already held these values, so the bot was not restarted.",
      showDiscard: false, showGo: false, showOk: true, busy: false,
    });
    expect(`${view.title} ${view.hint}`).not.toMatch(/restarted with|The bot already had/);
    // noop only means something once an apply has finished: pending changes never read as "nothing needed".
    expect(applyBarView({ count: 1, phase: "idle", noop: true }).title).toBe("1 change needs a restart");
    expect(applyBarView({ count: 1, phase: "failed", error: "boom", noop: true }).title).toBe("Couldn't apply: boom");
    expect(applyBarView({ count: 1, phase: "applying", noop: true }).title).toBe("Restarting the bot…");
  });

  test("failed: the error in the title, the detail as the hint, danger, OK -- plus Discard and Apply while changes are pending", () => {
    expect(applyBarView({ count: 0, phase: "failed", error: "compose: image not found", detail: "Backup: /opt/x/.env.bak.1" })).toEqual({
      hidden: false, tone: "danger", title: "Couldn't apply: compose: image not found", hint: "Backup: /opt/x/.env.bak.1",
      showDiscard: false, showGo: false, showOk: true, busy: false,
    });
    const again = applyBarView({ count: 2, phase: "failed", error: "boom" });
    expect([again.showOk, again.showDiscard, again.showGo]).toEqual([true, true, true]);
    expect(again.hint).toBe("");
  });

  test("failed with no error text still says something", () => {
    expect(applyBarView({ count: 1, phase: "failed", error: "" }).title).toBe("Couldn't apply: bot-ops.sh error");
  });
});

describe("describeApplyFailure (#257, the failText logic saveEnv had, split in two lines)", () => {
  test("a failed recreate: the compose error, and the backup path as the detail -- never the raw JSON (#47)", () => {
    const text = '{"ok":false,"changed":["REPORT_ROLE_ID"],"backup":"/opt/x/.env.bak.1","log":"compose: image not found"}';
    expect(describeApplyFailure(text, JSON.parse(text))).toEqual({ error: "compose: image not found", detail: "Backup: /opt/x/.env.bak.1" });
  });
  test("a log with no backup, and a backup with no log", () => {
    expect(describeApplyFailure("{}", { log: "compose: boom" })).toEqual({ error: "compose: boom", detail: "" });
    expect(describeApplyFailure("{}", { backup: "/x/.env.bak" })).toEqual({ error: "bot-ops.sh error", detail: "Backup: /x/.env.bak" });
  });
  test("anything else is shown verbatim: plain text, an empty body, JSON without a log or a backup", () => {
    expect(describeApplyFailure("bot-ops: env-set: value for 'WATCHED_REPOS' is invalid", null)).toEqual({ error: "bot-ops: env-set: value for 'WATCHED_REPOS' is invalid", detail: "" });
    expect(describeApplyFailure("", null)).toEqual({ error: "bot-ops.sh error", detail: "" });
    expect(describeApplyFailure('{"ok":false}', {})).toEqual({ error: '{"ok":false}', detail: "" });
  });
});

// #272: after a failed POST /api/env, may the page keep what the user typed? Only when the failure IS one of
// env-set's own refusals, identified POSITIVELY: a 502, a body that is not JSON, and a line that starts
// `bot-ops: env-set: ` (bot-ops.sh's die() prints `bot-ops: ` + its message and every `die "env-set: ..."` sits
// before the write). server.ts answers a failed bot-ops.sh with 502 (a JSON body when env-set got as far as the
// write and the recreate failed; the plain stderr text otherwise) or 504 (we killed it: outcome unknown). The
// plain stderr text can ALSO come from a failure after the write that printed no JSON -- a `set -e` abort (a
// tool's own error text), a kill during the recreate (at most the `bot-ops: env file` line), a kill between the
// mv and that line (an empty body), a proxy's own 502 (HTML) -- and none of those carries an env-set line.
describe("failureWroteNothing (#272)", () => {
  const REFUSAL = "bot-ops: env-set: value for 'WATCHED_REPOS' is invalid";

  test("an env-set refusal (a 502, not JSON, a line starting `bot-ops: env-set: `) is a failure that wrote nothing", () => {
    expect(failureWroteNothing(502, null, REFUSAL)).toBe(true);
    expect(failureWroteNothing(502, null, "bot-ops: env-set: 'FOO' is not an editable key")).toBe(true);
    // the line need not be the first one: the anchor is a line start, not the start of the body
    expect(failureWroteNothing(502, null, `a warning first\n${REFUSAL}\ntrailing text`)).toBe(true);
  });

  test("everything that is not one of those re-baselines", () => {
    // a failed recreate: .env was rewritten first (#47), and the body parsed as JSON
    expect(failureWroteNothing(502, { ok: false, changed: ["X"], backup: "/b", log: "compose: boom" }, REFUSAL)).toBe(false);
    expect(failureWroteNothing(502, { ok: false }, REFUSAL)).toBe(false);
    expect(failureWroteNothing(502, {}, REFUSAL)).toBe(false);
    // a `set -e` abort after the mv: a tool's own error text, or the env-file line the script prints before the recreate
    expect(failureWroteNothing(502, null, "jq: error (at <stdin>:0): Cannot iterate over null")).toBe(false);
    expect(failureWroteNothing(502, null, "bot-ops: env file /x/.env")).toBe(false);
    // a kill between the mv and that line: an empty body (and server.ts's own fallback text for it)
    expect(failureWroteNothing(502, null, "")).toBe(false);
    expect(failureWroteNothing(502, null, "bot-ops.sh failed")).toBe(false);
    // a proxy's own 502
    expect(failureWroteNothing(502, null, "<html><head><title>502 Bad Gateway</title></head><body>cloudflared</body></html>")).toBe(false);
    // `env-set:` in the middle of a line is not an env-set line
    expect(failureWroteNothing(502, null, `note: ${REFUSAL}`)).toBe(false);
    expect(failureWroteNothing(502, null, "bot-ops: env-set:no space after the colon")).toBe(false);
    // a failed backup or mktemp BEFORE the write has no env-set line either: it re-baselines, the safe side
    expect(failureWroteNothing(502, null, "install: cannot create regular file '/opt/x/backups/.env.bak': Permission denied")).toBe(false);
    // a timeout: the recreate may still finish, whatever the body looks like
    expect(failureWroteNothing(504, null, REFUSAL)).toBe(false);
    expect(failureWroteNothing(504, null, "bot-ops.sh timed out")).toBe(false);
    // a status this page cannot reason about says nothing, even with a refusal-looking body
    for (const status of [200, 400, 401, 403, 404, 500, 503]) {
      expect({ status, wroteNothing: failureWroteNothing(status, null, REFUSAL) }).toEqual({ status, wroteNothing: false });
    }
  });
});

// What makes the page's reliance on a message the script owns safe: inside `cmd_env_set`, EVERY `die "env-set: ..."`
// sits before the write (`mv "$tmp" "$ENV_FILE"`), nothing after the write prints an `env-set:` line, no such die
// lives outside `cmd_env_set` (a post-write helper could reach it), and `die` prints with the `bot-ops: ` prefix the
// page's pattern starts with. Whoever adds a die after the write breaks this test, and the messages say why. A pure
// function over the script text, so its own mutants (a die moved below the mv, ...) are tested too.
function envSetRefusalOrderProblems(script: string): string[] {
  const problems: string[] = [];
  if (!/^die\(\) \{ echo "bot-ops: \$\*" >&2; exit 1; \}$/m.test(script)) {
    problems.push('die() must print "bot-ops: " + its message to stderr: the page keeps edits only for a line starting `bot-ops: env-set: `');
  }
  const start = script.indexOf("\ncmd_env_set() {");
  if (start === -1) return [...problems, "cmd_env_set() was not found"];
  const end = script.indexOf("\n}\n", start);
  const body = script.slice(start, end === -1 ? undefined : end);
  const writes = [...body.matchAll(/mv "\$tmp" "\$ENV_FILE"/g)];
  if (writes.length !== 1) return [...problems, `cmd_env_set must contain exactly one write (mv "$tmp" "$ENV_FILE"), found ${writes.length}`];
  const writeAt = writes[0]!.index!;
  const dies = [...body.matchAll(/die "env-set:/g)];
  if (dies.length === 0) problems.push('cmd_env_set has no die "env-set: ..." at all (the page would never keep an edit)');
  for (const d of dies) if (d.index! > writeAt) problems.push(`a die "env-set: ..." comes AFTER the write, at cmd_env_set offset ${d.index}`);
  const afterWrite = body.slice(writeAt);
  for (const line of afterWrite.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    if (/(?:die|echo|printf)\b.*env-set:/.test(line)) problems.push(`a line after the write prints an env-set: message: ${line.trim()}`);
  }
  const allDies = [...script.matchAll(/die "env-set:/g)].length;
  if (allDies !== dies.length) problems.push(`${allDies - dies.length} die "env-set: ..." live outside cmd_env_set`);
  return problems;
}

describe("bot-ops.sh's env-set refusals all precede the write (#272: what keeps failureWroteNothing true)", () => {
  const script = readFileSync(new URL("../bot-ops.sh", import.meta.url), "utf8");
  const WRITE = '  mv "$tmp" "$ENV_FILE"\n';

  test("in the real script", () => {
    expect(envSetRefusalOrderProblems(script)).toEqual([]);
    // not vacuous: the pin looked at real refusals (the script has nine today)
    expect([...script.matchAll(/die "env-set:/g)].length).toBeGreaterThanOrEqual(5);
    expect(script.split(WRITE).length - 1).toBe(1);
  });

  test("it catches a die moved below the write", () => {
    const first = 'die "env-set: $ENV_FILE not found"';
    expect(script.split(first).length - 1).toBe(1);
    // (function replacers throughout: the script text is full of `$` sequences a string replacement would expand)
    const moved = script.replace(first, () => "true").replace(WRITE, () => `${WRITE}  die "env-set: moved below the write"\n`);
    expect(envSetRefusalOrderProblems(moved).join("\n")).toContain("AFTER the write");
  });

  test("it catches a message printed after the write, a die outside the function, and a die that loses its prefix", () => {
    expect(envSetRefusalOrderProblems(script.replace(WRITE, () => `${WRITE}  echo "bot-ops: env-set: late" >&2\n`)).join("\n")).toContain("after the write prints an env-set:");
    expect(envSetRefusalOrderProblems(`${script}\nother() { die "env-set: elsewhere"; }\n`).join("\n")).toContain("outside cmd_env_set");
    expect(envSetRefusalOrderProblems(script.replace('die() { echo "bot-ops: $*" >&2; exit 1; }', () => 'die() { echo "$*" >&2; exit 1; }')).join("\n")).toContain('die() must print "bot-ops: "');
  });

  test("it catches a second write and a missing function (so it cannot pass vacuously)", () => {
    expect(envSetRefusalOrderProblems(script.replace(WRITE, () => `${WRITE}${WRITE}`)).join("\n")).toContain("exactly one write");
    expect(envSetRefusalOrderProblems(script.replace("cmd_env_set() {", () => "cmd_renamed() {")).join("\n")).toContain("cmd_env_set() was not found");
  });
});

// The DOM half, lifted with every page global injected and run against a stub page. The stub THROWS on any
// element id it was not given and on any selector the collector is not allowed: a plugin's own settings
// bundle renders arbitrary DOM inside this page, so a page-wide [data-key] would be a bug, not a convenience.
interface StubEl {
  id: string;
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  value: string;
  checked: boolean;
  dataset: Record<string, string>;
  classes: Set<string>;
  attrs: Map<string, string>;
  classList: { toggle: (name: string, force?: boolean) => boolean };
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  getAttribute: (name: string) => string | null;
  focus: (options?: { preventScroll?: boolean }) => void;
  contains: (other: unknown) => boolean;
  closest: (selector: string) => unknown;
}
interface ApplySpec {
  loadedEnv: Record<string, string>;
  /** The config controls' current values, in field order (default: loadedEnv, nothing edited). */
  fields?: Record<string, string>;
  /** Field keys whose control is a chip editor: the [data-key] carrier is a hidden input, the control is a typing input. */
  tags?: string[];
  pluginsData?: { plugins: { name: string }[]; pluginsValue: string; stateError?: string } | null;
  /** The ticked plugin names (default: the names in pluginsValue). */
  checked?: string[];
  schema?: Record<string, unknown>;
  /** What api() answers; an Error is thrown by it (a timeout, the 401 "unauthorized"). `status` defaults to
   *  200 for `ok: true` and 502 for `ok: false` (what bot-ops.sh's failures come back as, server.ts ~1683). */
  response?: { ok: boolean; text: string; status?: number } | Error;
  /** api() waits for this before answering: an in-flight request. */
  hold?: Promise<void>;
  /** The loaders put the controls back to `loadedEnv` and the server's ticks (a re-render from the baseline). */
  resetOnReload?: boolean;
  /** The plugin list is not rendered (a failed /api/plugins reload swaps the boxes for an error line) while
   *  `pluginsData` still holds the previous answer. */
  noBoxes?: boolean;
}
type ApplyPost = { path: string; opts: { method?: string; body?: string; signal?: AbortSignal } };

const APPLY_SCHEMA = { ANNOUNCE_CHANNEL_ID: { pattern: "^[0-9]{5,25}$", required: true, source: "core" } };
const APPLY_PLUGINS = { plugins: [{ name: "warbandeer" }, { name: "raidhelper" }], pluginsValue: "warbandeer" };
const APPLY_ENV = { DISCORD_SERVER_ID: "", ANNOUNCE_CHANNEL_ID: "11111", ADMIN_USER_IDS: "123456, 234567", REPORT_ROLE_ID: "stormrage", WATCHED_REPOS: "us" };

function runApply(spec: ApplySpec) {
  const log = {
    posts: [] as ApplyPost[],
    reloads: { plugins: 0, env: 0, status: 0 },
    tabs: [] as [string, boolean][],
    focused: [] as string[],
    /** The ids focused with { preventScroll: true }. */
    preventScroll: [] as string[],
    /** Every write to any stub's textContent, as `id=text` (the bar's words are a live region). */
    textWrites: [] as string[],
    cancels: 0,
    timeouts: [] as number[],
    selectors: [] as string[],
  };
  const state: { active: StubEl | null } = { active: null };
  const makeEl = (id: string, over: Partial<StubEl> = {}): StubEl => {
    let hidden = false;
    let disabled = false;
    const el: StubEl = {
      id, hidden, disabled, textContent: "", value: "", checked: false, dataset: {}, classes: new Set(), attrs: new Map(),
      classList: { toggle: (name, force) => { const want = force ?? !el.classes.has(name); if (want) el.classes.add(name); else el.classes.delete(name); return want; } },
      setAttribute: (name, value) => void el.attrs.set(name, value),
      removeAttribute: (name) => void el.attrs.delete(name),
      getAttribute: (name) => el.attrs.get(name) ?? null,
      focus: (options) => {
        log.focused.push(el.id);
        if (options?.preventScroll) log.preventScroll.push(el.id);
        state.active = el;
      },
      contains: (other) => other === el,
      closest: () => null,
      ...over,
    };
    // The browser drops focus to <body> when the focused element (or one inside it) is hidden -- and, in
    // Firefox, when it is disabled. The stub does both, so a page that forgot focus shows up as a lost one.
    const dropsFocus = () => {
      if (state.active && (state.active === el || el.contains(state.active))) state.active = null;
    };
    Object.defineProperty(el, "hidden", { get: () => hidden, set: (v: boolean) => { hidden = v; if (v) dropsFocus(); }, configurable: true });
    Object.defineProperty(el, "disabled", { get: () => disabled, set: (v: boolean) => { disabled = v; if (v) dropsFocus(); }, configurable: true });
    let text = "";
    Object.defineProperty(el, "textContent", { get: () => text, set: (v: string) => { text = v; log.textWrites.push(`${el.id}=${v}`); }, configurable: true });
    if (over.hidden) hidden = true;
    return el;
  };

  const bar = makeEl("apply-bar", { hidden: true });
  const title = makeEl("apply-title");
  const hint = makeEl("apply-hint");
  const ok = makeEl("apply-ok", { hidden: true });
  const discard = makeEl("apply-discard");
  const go = makeEl("apply-go");
  const inBar: unknown[] = [bar, title, hint, ok, discard, go];
  bar.contains = (other) => inBar.includes(other);
  const tab = makeEl("tab-settings");
  const body = makeEl("body");

  const baseline = { ...spec.loadedEnv }; // what the server holds: what a re-render restores
  const fieldEntries = Object.entries(spec.fields ?? spec.loadedEnv);
  const byId = new Map<string, StubEl>([bar, title, hint, ok, discard, go].map((e) => [e.id, e]));
  const controls = fieldEntries.map(([key, value]) => {
    const carrier = makeEl(`carrier-${key}`, { value, dataset: { key } });
    // A plain control is its own [data-key] element and carries the id its label points at; a chip
    // editor's carrier is a hidden input, and the id belongs to the typing input beside it.
    const control = (spec.tags ?? []).includes(key) ? makeEl(`env-${key}`) : carrier;
    if (control === carrier) carrier.id = `env-${key}`;
    byId.set(`env-${key}`, control);
    return carrier;
  });
  const pluginsData = spec.pluginsData === undefined ? APPLY_PLUGINS : spec.pluginsData;
  const tickedOnServer = pluginsData ? pluginsData.pluginsValue.split(",").map((t) => t.split("@")[0]!.trim()).filter(Boolean) : [];
  const tickedNow = spec.checked ?? tickedOnServer;
  const boxes = spec.noBoxes ? [] : (pluginsData?.plugins ?? []).map((p) => makeEl(`plugin-${p.name}`, { dataset: { plugin: p.name }, checked: tickedNow.includes(p.name) }));
  const boxBaseline = (pluginsData?.plugins ?? []).map((p) => tickedOnServer.includes(p.name));

  const document = {
    body,
    get activeElement() { return state.active ?? body; },
    getElementById: (id: string): StubEl => {
      const el = byId.get(id);
      if (!el) throw new Error(`harness: the page asked for an element it was not given: #${id}`);
      return el;
    },
    querySelectorAll: (selector: string): StubEl[] => {
      log.selectors.push(selector);
      if (selector === "#env-fields [data-key]") return controls;
      if (selector === "#plugins-list input[type=checkbox][data-plugin]") return boxes;
      throw new Error(`harness: the collector may read only its two selectors, not ${JSON.stringify(selector)}`);
    },
    querySelector: (selector: string): StubEl | null => {
      if (selector === '[role="tab"][aria-selected="true"]') return tab;
      throw new Error(`harness: unexpected querySelector(${JSON.stringify(selector)})`);
    },
  };
  // The real loaders re-render every control from the persisted state. With `resetOnReload` the stubs do
  // the same to the stub controls (back to the baseline they started from), so Discard is observable end
  // to end; without it they only count (after a real apply the new baseline IS what was typed).
  const loadEnv = async () => {
    log.reloads.env++;
    if (spec.resetOnReload) controls.forEach((c) => { c.value = baseline[c.dataset.key!] ?? ""; });
  };
  const loadPlugins = async () => {
    log.reloads.plugins++;
    if (spec.resetOnReload) boxes.forEach((b, i) => { b.checked = boxBaseline[i]!; });
  };
  const loadStatus = async () => void log.reloads.status++;
  const api = async (path: string, opts: ApplyPost["opts"]) => {
    log.posts.push({ path, opts });
    if (spec.hold) await spec.hold;
    if (spec.response instanceof Error) throw spec.response;
    const r = spec.response ?? { ok: true, text: '{"ok":true,"changed":["X"]}' };
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 502), text: async () => r.text };
  };
  const timeoutSignal = (ms: number) => {
    log.timeouts.push(ms);
    return { signal: new AbortController().signal, cancel: () => void log.cancels++ };
  };
  const confirm = () => {
    throw new Error("confirm() must not be asked: the bar is the confirmation");
  };
  const showTab = (id: string, moveFocus: boolean) => void log.tabs.push([id, moveFocus]);

  const run = new Function(
    "document", "confirm", "api", "loadEnv", "loadPlugins", "loadStatus", "showTab", "loadedEnv", "loadedSchema", "pluginsData", "MUTATION_TIMEOUT_MS", "timeoutSignal",
    `"use strict";\n${["ENV_SCHEMA", "PLUGINS_SAVE_PLAN", "ENV_SAVE_PLAN", "APPLY_PLAN", "APPLY_VIEW", "APPLY"].map(applyBlock).join("\n")}\n` +
      "return { applyPending, discardPending, refreshApplyBar, onControlEdited, dismissApplyResult, collectPending };",
  )(document, confirm, api, loadEnv, loadPlugins, loadStatus, showTab, spec.loadedEnv, spec.schema ?? APPLY_SCHEMA, pluginsData, 110000, timeoutSignal) as {
    applyPending: () => Promise<void>;
    discardPending: () => Promise<void>;
    refreshApplyBar: () => void;
    onControlEdited: (e: unknown) => void;
    dismissApplyResult: () => void;
    collectPending: () => ApplyPlanInput;
  };

  return {
    run,
    log,
    els: { bar, title, hint, ok, discard, go, tab, body },
    controls,
    boxes,
    /** The control the page marks / focuses for `key` (a chip editor's typing input, else the field itself). */
    control: (key: string) => byId.get(`env-${key}`)!,
    edit(key: string, value: string) {
      const c = controls.find((x) => x.dataset.key === key)!;
      c.value = value;
      return c;
    },
    tick(name: string, on: boolean) {
      const b = boxes.find((x) => x.dataset.plugin === name)!;
      b.checked = on;
      return b;
    },
    activate(el: StubEl | null) { state.active = el; },
    /** What the bar is showing right now. */
    view() {
      return {
        hidden: bar.hidden,
        tone: bar.classes.has("adm-apply--danger") ? "danger" : bar.classes.has("adm-apply--ok") ? "ok" : "",
        title: title.textContent,
        hint: hint.textContent,
        ok: !ok.hidden,
        discard: !discard.hidden,
        go: !go.hidden,
        disabled: go.disabled && discard.disabled,
      };
    },
  };
}

describe("applyPending (#257)", () => {
  const ticked = ["warbandeer", "raidhelper"];
  const returnsSoon = (call: Promise<void>) => Promise.race([call.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))]);

  test("ticking one plugin and editing two fields is ONE POST: PLUGINS first, only those three keys", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, ANNOUNCE_CHANNEL_ID: "22222", WATCHED_REPOS: "eu" }, checked: ticked });
    await page.run.applyPending();
    expect(page.log.posts).toHaveLength(1);
    const [post] = page.log.posts;
    expect(post?.path).toBe("/api/env");
    expect(post?.opts.method).toBe("POST");
    expect(post?.opts.body).toBe("PLUGINS=warbandeer,raidhelper\nANNOUNCE_CHANNEL_ID=22222\nWATCHED_REPOS=eu");
  });

  test("ticking a plugin alone posts PLUGINS alone", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, checked: ticked });
    await page.run.applyPending();
    expect(page.log.posts.map((p) => p.opts.body)).toEqual(["PLUGINS=warbandeer,raidhelper"]);
  });

  test("an untouched field is never posted, even when its stored value would fail its format (#44)", async () => {
    // The issue's exact setup: two stored values the whitelist would reject, both untouched. The schema is
    // strict about the very field that holds one, so posting it would be refused: it must not be sent at all.
    const loaded = { DISCORD_SERVER_ID: "", ANNOUNCE_CHANNEL_ID: "11111", ADMIN_USER_IDS: "123456, 234567", REPORT_ROLE_ID: "stormrage" };
    const schema = { ...APPLY_SCHEMA, ADMIN_USER_IDS: { pattern: "^[0-9]+(,[0-9]+)*$", required: false, source: "core" } };
    const page = runApply({ loadedEnv: loaded, fields: { ...loaded, ANNOUNCE_CHANNEL_ID: "22222" }, schema });
    await page.run.applyPending();
    expect(page.log.posts).toHaveLength(1);
    expect(page.log.posts[0]?.opts.body).toBe("ANNOUNCE_CHANNEL_ID=22222");
  });

  test("nothing changed: nothing is posted, and the bar stays hidden", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV });
    await page.run.applyPending();
    page.run.refreshApplyBar();
    expect(page.log.posts).toEqual([]);
    expect(page.log.reloads).toEqual({ plugins: 0, env: 0, status: 0 });
    expect(page.view().hidden).toBe(true);
  });

  test("a blank required field blocks the whole apply, names the key, marks the control invalid, shows its tab, and posts nothing (#45)", async () => {
    // A plugin tick and an unrelated valid change ride along: they are not posted either.
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, ANNOUNCE_CHANNEL_ID: "", WATCHED_REPOS: "eu" }, checked: ticked });
    await page.run.applyPending();
    expect(page.log.posts).toEqual([]);
    expect(page.view()).toMatchObject({
      hidden: false,
      tone: "danger",
      title: "3 changes need a restart",
      hint: "ANNOUNCE_CHANNEL_ID is required and cannot be blank.",
      go: true,
      discard: true,
    });
    const control = page.control("ANNOUNCE_CHANNEL_ID");
    expect(control.attrs.get("aria-invalid")).toBe("true");
    expect(page.log.tabs).toEqual([["settings", false]]);
    expect(page.log.focused).toEqual(["env-ANNOUNCE_CHANNEL_ID"]);
    expect(page.log.reloads).toEqual({ plugins: 0, env: 0, status: 0 });
  });

  test("a refusal on a chip field marks and focuses its typing input, not the hidden carrier", async () => {
    const schema = { ADMIN_USER_IDS: { pattern: "^[0-9,]+$", required: true, source: "core" } };
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, ADMIN_USER_IDS: "" }, tags: ["ADMIN_USER_IDS"], schema });
    await page.run.applyPending();
    expect(page.log.posts).toEqual([]);
    expect(page.log.focused).toEqual(["env-ADMIN_USER_IDS"]);
    expect(page.control("ADMIN_USER_IDS").attrs.get("aria-invalid")).toBe("true");
    expect(page.controls.find((c) => c.dataset.key === "ADMIN_USER_IDS")!.attrs.has("aria-invalid")).toBe(false);
  });

  test("a bad format blocks the whole apply the same way (#207)", async () => {
    const schema = { BOT_BRANCH: { pattern: "^[A-Za-z0-9._/-]{1,100}$", required: false, source: "core" } };
    const page = runApply({ loadedEnv: { BOT_BRANCH: "main", A: "1" }, fields: { BOT_BRANCH: "bad branch!", A: "2" }, schema, pluginsData: null });
    await page.run.applyPending();
    expect(page.log.posts).toEqual([]);
    expect(page.view().hint).toBe('BOT_BRANCH: "bad branch!" doesn\'t match the expected format (^[A-Za-z0-9._/-]{1,100}$).');
    expect(page.view().tone).toBe("danger");
    expect(page.control("BOT_BRANCH").attrs.get("aria-invalid")).toBe("true");
    expect(page.log.reloads).toEqual({ plugins: 0, env: 0, status: 0 }); // nothing was sent, so nothing is re-read
  });

  test("a refusal on PLUGINS itself shows the plugins tab, marks no control, and posts nothing", async () => {
    // A ticked name the PLUGINS pattern rejects (the schema carries bot-ops.sh's own pattern for the key).
    const schema = { ...APPLY_SCHEMA, PLUGINS: { pattern: "^[a-z][a-z0-9-]*(@[A-Za-z0-9._-]+)?(,[a-z][a-z0-9-]*(@[A-Za-z0-9._-]+)?)*$", required: false, source: "core" } };
    const pluginsData = { plugins: [{ name: "warbandeer" }, { name: "Bad_Name" }], pluginsValue: "warbandeer" };
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, pluginsData, checked: ["warbandeer", "Bad_Name"], schema });
    await page.run.applyPending();
    expect(page.log.posts).toEqual([]);
    expect(page.log.tabs).toEqual([["plugins", false]]);
    expect(page.log.focused).toEqual([]); // there is no single control to send the user to: the tab is the place
    expect(page.view()).toMatchObject({ hidden: false, tone: "danger", title: "2 changes need a restart" });
    expect(page.view().hint).toMatch(/^PLUGINS: "warbandeer,Bad_Name" doesn't match the expected format/);
    for (const el of [...page.controls, ...page.boxes]) expect(el.attrs.has("aria-invalid")).toBe(false);
  });

  test("with no plugin box rendered (a failed reload of the list) no PLUGINS change is planned, so it cannot wipe them", async () => {
    // pluginsData is the PREVIOUS answer (PLUGINS=warbandeer); the list on the page is now an error line.
    // Reading "nothing ticked" against it would post PLUGINS= and switch every plugin off.
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, noBoxes: true });
    expect(page.run.collectPending().plugins).toBeNull();
    await page.run.applyPending();
    expect(page.log.posts.map((p) => p.opts.body)).toEqual(["WATCHED_REPOS=eu"]);
    // With nothing else changed, there is nothing to apply at all: the bar stays hidden and nothing is posted.
    const alone = runApply({ loadedEnv: APPLY_ENV, noBoxes: true });
    alone.run.refreshApplyBar();
    await alone.run.applyPending();
    expect(alone.view().hidden).toBe(true);
    expect(alone.log.posts).toEqual([]);
  });

  test("with the list rendered, unticking every plugin is still a real change (the guard is 'no box', not 'nothing ticked')", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, checked: [] });
    await page.run.applyPending();
    expect(page.log.posts.map((p) => p.opts.body)).toEqual(["PLUGINS="]);
  });

  test("with no schema the apply still goes (the degraded path, #207)", async () => {
    const page = runApply({ loadedEnv: { BOT_BRANCH: "main" }, fields: { BOT_BRANCH: "bad branch!" }, schema: {}, pluginsData: null });
    await page.run.applyPending();
    expect(page.log.posts.map((p) => p.opts.body)).toEqual(["BOT_BRANCH=bad branch!"]);
  });

  test("a line break in a value is refused before anything is sent", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu\nANNOUNCE_CHANNEL_ID=1" } });
    await page.run.applyPending();
    expect(page.log.posts).toEqual([]);
    expect(page.view()).toMatchObject({ hidden: false, tone: "danger", hint: "WATCHED_REPOS must not contain a line break." });
  });

  test("the POST carries an AbortSignal, and the timer is cancelled when the request settles (#53)", async () => {
    for (const response of [undefined, { ok: false, text: "nope" }, new Error("boom")]) {
      const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, response });
      await page.run.applyPending();
      expect(page.log.posts[0]?.opts.signal).toBeInstanceOf(AbortSignal);
      expect(page.log.timeouts).toEqual([110000]);
      expect(page.log.cancels).toBe(1);
    }
  });

  test("success re-loads plugins, env and status, and the bar says applied", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, checked: ticked });
    await page.run.applyPending();
    expect(page.log.reloads).toEqual({ plugins: 1, env: 1, status: 1 });
    expect(page.view()).toEqual({
      hidden: false, tone: "ok", title: "Applied. The bot restarted with your changes.", hint: "", ok: true, discard: false, go: false, disabled: false,
    });
  });

  test("bot-ops.sh's \"no changes\" answer says nothing was restarted (it never claims a restart it did not do)", async () => {
    // env-set found .env already holding every value (another operator applied them, or the tab was stale).
    const text = '{"ok":true,"changed":[],"recreated":false,"note":"no changes"}';
    const spec: ApplySpec = { loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, response: { ok: true, text } };
    const page = runApply(spec);
    await page.run.applyPending();
    expect(page.view()).toEqual({
      hidden: false, tone: "ok", title: "Nothing needed applying.", hint: "The saved settings already held these values, so the bot was not restarted.",
      ok: true, discard: false, go: false, disabled: false,
    });
    expect(page.log.reloads).toEqual({ plugins: 1, env: 1, status: 1 }); // still re-baselined
    // Only an explicit recreated:false counts; a real restart (recreated:true), or any other success body, still says applied.
    for (const body of ['{"ok":true,"changed":["WATCHED_REPOS"],"recreated":true,"backup":"/x","log":""}', '{"ok":true,"changed":["X"]}', "OK", ""]) {
      const real = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, response: { ok: true, text: body } });
      await real.run.applyPending();
      expect({ body, title: real.view().title }).toEqual({ body, title: "Applied. The bot restarted with your changes." });
    }
    // ... and a later apply on the same page (the edit is still pending) is not stuck on the earlier answer.
    page.run.onControlEdited({ target: { closest: () => ({}) } });
    expect(page.view().title).toBe("1 change needs a restart");
    spec.response = { ok: true, text: '{"ok":true,"changed":["WATCHED_REPOS"],"recreated":true,"backup":"/x","log":""}' };
    await page.run.applyPending();
    expect(page.view().title).toBe("Applied. The bot restarted with your changes.");
  });

  test("a failed recreate shows the compose error and the backup path, and re-baselines (#47)", async () => {
    const text = '{"ok":false,"changed":["REPORT_ROLE_ID"],"backup":"/opt/x/.env.bak.1","log":"compose: image not found"}';
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, REPORT_ROLE_ID: "orgrimmar" }, response: { ok: false, text } });
    await page.run.applyPending();
    const view = page.view();
    expect(view).toMatchObject({ hidden: false, tone: "danger", title: "Couldn't apply: compose: image not found", hint: "Backup: /opt/x/.env.bak.1", ok: true });
    expect(`${view.title}${view.hint}`).not.toContain('"ok"'); // never the raw JSON blob
    // .env may already have been rewritten: the plugins and the config are re-read; nothing "restarted".
    expect(page.log.reloads).toEqual({ plugins: 1, env: 1, status: 0 });
  });

  // #272: THE expectation under change. A plain-text 502 is, in every case bot-ops.sh's own checks produce, an
  // early die() (a refused value, a key that is not editable, a backup that could not be written) that never
  // reached the write, so the page has nothing to re-baseline against and must not throw away what the user
  // typed (the rare plain-text 502 that follows the write is described at failureWroteNothing). Until #272 this test said
  // `reloads` was { plugins: 1, env: 1, status: 0 } "unconditionally" (#47 parity with the retired saveEnv).
  test("a plain-text failure is shown verbatim, and the user's edits are kept (#272)", async () => {
    const page = runApply({
      loadedEnv: APPLY_ENV,
      fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" },
      checked: ["warbandeer", "raidhelper"],
      response: { ok: false, text: "bot-ops: env-set: value for 'WATCHED_REPOS' is invalid" },
      resetOnReload: true, // a reload WOULD put the controls back to the server's values: the asserts below prove none ran
    });
    await page.run.applyPending();
    expect(page.view()).toEqual({
      hidden: false, tone: "danger", title: "Couldn't apply: bot-ops: env-set: value for 'WATCHED_REPOS' is invalid", hint: "",
      ok: true, discard: true, go: true, disabled: false,
    });
    expect(page.log.reloads).toEqual({ plugins: 0, env: 0, status: 0 });
    expect(page.controls.find((c) => c.dataset.key === "WATCHED_REPOS")!.value).toBe("eu");
    expect(page.boxes.find((b) => b.dataset.plugin === "raidhelper")!.checked).toBe(true);
  });

  test("a 504 re-baselines, because the outcome is unknown", async () => {
    const page = runApply({
      loadedEnv: APPLY_ENV,
      fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" },
      checked: ["warbandeer", "raidhelper"],
      response: { ok: false, status: 504, text: "bot-ops.sh timed out" },
      resetOnReload: true,
    });
    await page.run.applyPending();
    expect(page.view()).toMatchObject({ tone: "danger", title: "Couldn't apply: bot-ops.sh timed out", hint: "", ok: true });
    // the recreate may still finish and .env may already hold the new values: the page re-reads both
    expect(page.log.reloads).toEqual({ plugins: 1, env: 1, status: 0 });
    expect(page.controls.find((c) => c.dataset.key === "WATCHED_REPOS")!.value).toBe(APPLY_ENV.WATCHED_REPOS);
    // and whatever the body looks like: a 504 whose body reads like a refusal is still a timeout
    const lookalike = runApply({
      loadedEnv: APPLY_ENV,
      fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" },
      response: { ok: false, status: 504, text: "bot-ops: env-set: value for 'WATCHED_REPOS' is invalid" },
    });
    await lookalike.run.applyPending();
    expect(lookalike.log.reloads).toEqual({ plugins: 1, env: 1, status: 0 });
  });

  test("any other status re-baselines too: a status this page does not know says nothing, even with a refusal-looking body", async () => {
    for (const status of [400, 403, 500, 503]) {
      const page = runApply({
        loadedEnv: APPLY_ENV,
        fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" },
        response: { ok: false, status, text: "bot-ops: env-set: value for 'WATCHED_REPOS' is invalid" },
      });
      await page.run.applyPending();
      expect({ status, reloads: page.log.reloads }).toEqual({ status, reloads: { plugins: 1, env: 1, status: 0 } });
    }
  });

  // #272: the rule identifies an env-set refusal POSITIVELY. The plain-text 502s below can all follow the write (or
  // precede it for a reason that is not a refusal), and none carries an `env-set:` line, so the page re-reads
  // instead of keeping edits that may already be the stored values.
  test("a plain-text 502 that is not an env-set refusal re-baselines", async () => {
    const bodies = [
      "jq: error (at <stdin>:0): Cannot iterate over null", // a `set -e` abort after the mv: a tool's own error text
      "bot-ops: env file /opt/rackbops/.env", // the line env-set prints just before the recreate: the write already happened
      "", // a kill between the mv and that line
      "bot-ops.sh failed", // server.ts's fallback for an empty stderr
      "<html><body>502 Bad Gateway</body></html>", // a proxy's own 502
      "install: cannot create regular file '/opt/x/backups/.env.bak': Permission denied", // before the write, but no refusal
    ];
    for (const text of bodies) {
      const page = runApply({
        loadedEnv: APPLY_ENV,
        fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" },
        checked: ["warbandeer", "raidhelper"],
        response: { ok: false, text },
        resetOnReload: true,
      });
      await page.run.applyPending();
      expect({ text, reloads: page.log.reloads }).toEqual({ text, reloads: { plugins: 1, env: 1, status: 0 } });
      expect(page.controls.find((c) => c.dataset.key === "WATCHED_REPOS")!.value).toBe(APPLY_ENV.WATCHED_REPOS);
    }
  });

  test("retrying after a kept-edits failure posts the same body again, and a no-changes answer says nothing needed applying", async () => {
    const spec: ApplySpec = {
      loadedEnv: APPLY_ENV,
      fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" },
      checked: ["warbandeer", "raidhelper"],
      response: { ok: false, text: "bot-ops: env-set: value for 'WATCHED_REPOS' is invalid" },
    };
    const page = runApply(spec);
    await page.run.applyPending();
    expect(page.view().title).toMatch(/^Couldn't apply/);
    // The user presses Apply and restart again with nothing edited (the narrow window after the write: .env
    // already holds the values, so env-set answers recreated:false).
    spec.response = { ok: true, text: '{"ok":true,"changed":[],"recreated":false,"note":"no changes"}' };
    await page.run.applyPending();
    expect(page.log.posts).toHaveLength(2);
    expect(page.log.posts[1]?.opts.body).toBe(page.log.posts[0]?.opts.body);
    expect(page.log.posts[0]?.opts.body).toBe("PLUGINS=warbandeer,raidhelper\nWATCHED_REPOS=eu");
    expect(page.view()).toMatchObject({ tone: "ok", title: "Nothing needed applying.", ok: true });
  });

  test("a timeout is shown", async () => {
    const aborted = Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, response: aborted });
    await page.run.applyPending();
    expect(page.view()).toMatchObject({ tone: "danger", title: "Couldn't apply: The operation was aborted.", ok: true });
    expect(page.log.cancels).toBe(1);
  });

  // #272 leaves this branch as it was: a network error or the page's own timeout is not an answer from the
  // server, so nothing is re-read (a reload from a server that cannot be reached would replace the user's
  // input with two error lines) and the controls keep what the user typed.
  test("a request that throws (a network error, the page's own timeout) leaves the controls as they are", async () => {
    for (const error of [new TypeError("Failed to fetch"), Object.assign(new Error("The operation was aborted."), { name: "AbortError" })]) {
      const page = runApply({
        loadedEnv: APPLY_ENV,
        fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" },
        checked: ["warbandeer", "raidhelper"],
        response: error,
        resetOnReload: true,
      });
      await page.run.applyPending();
      expect(page.log.reloads).toEqual({ plugins: 0, env: 0, status: 0 });
      expect(page.controls.find((c) => c.dataset.key === "WATCHED_REPOS")!.value).toBe("eu");
      expect(page.boxes.find((b) => b.dataset.plugin === "raidhelper")!.checked).toBe(true);
      expect(page.view()).toMatchObject({ tone: "danger", ok: true, discard: true, go: true });
    }
  });

  test("unauthorized is swallowed: the bar does not stay on Restarting the bot...", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, response: new Error("unauthorized") });
    await page.run.applyPending();
    // Back to what is pending (the gate is what the user sees); no error is shown for it.
    expect(page.view()).toMatchObject({ hidden: false, tone: "", title: "1 change needs a restart", ok: false, go: true });
    expect(page.log.reloads).toEqual({ plugins: 0, env: 0, status: 0 });
  });

  test("an unreadable bot state cannot produce a PLUGINS change", async () => {
    // The dangerous case: the state read failed, so pluginsValue came back "" -- ticking a subset would post
    // PLUGINS=<subset> and drop the rest. With the state unreadable (or not loaded yet) it is never planned.
    for (const pluginsData of [{ ...APPLY_PLUGINS, pluginsValue: "", stateError: "the bot's current state couldn't be read" }, null]) {
      const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, pluginsData, checked: ["warbandeer"] });
      await page.run.applyPending();
      expect(page.log.posts.map((p) => p.opts.body)).toEqual(["WATCHED_REPOS=eu"]);
      // ... and it does not so much as look at the boxes.
      expect(page.log.selectors).not.toContain("#plugins-list input[type=checkbox][data-plugin]");
    }
    // Nothing else changed: nothing at all is posted.
    const alone = runApply({ loadedEnv: APPLY_ENV, pluginsData: { ...APPLY_PLUGINS, pluginsValue: "", stateError: "x" }, checked: ["warbandeer"] });
    await alone.run.applyPending();
    expect(alone.log.posts).toEqual([]);
  });

  test("no confirm is asked", async () => {
    // The injected confirm() throws: any call would fail this apply (and its failure paths).
    for (const response of [undefined, { ok: false, text: "nope" }]) {
      const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, checked: ticked, response });
      await page.run.applyPending();
      expect(page.log.posts).toHaveLength(1);
    }
  });

  test("the collector reads exactly two selectors, so a plugin bundle's DOM cannot feed the bar", () => {
    const page = runApply({ loadedEnv: APPLY_ENV });
    const input = page.run.collectPending();
    expect(page.log.selectors).toEqual(["#env-fields [data-key]", "#plugins-list input[type=checkbox][data-plugin]"]);
    expect(Object.keys(input.fields)).toEqual(Object.keys(APPLY_ENV));
    expect(input.plugins).toEqual({ checkedNames: ["warbandeer"], currentValue: "warbandeer", manifestOrder: ["warbandeer", "raidhelper"] });
    expect(input.loadedEnv).toBe(APPLY_ENV);
  });

  test("while the request is in flight the bar says Restarting the bot..., both buttons are disabled, and a second apply is ignored", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, hold });
    const first = page.run.applyPending();
    await Promise.resolve();
    expect(page.view()).toEqual({
      hidden: false, tone: "", title: "Restarting the bot…", hint: "This takes about 20 seconds.", ok: false, discard: true, go: true, disabled: true,
    });
    try {
      // A second click while one is in flight, and a Discard: each must return at once. Raced against a
      // deadline, because a page that DID start a second request would wait on the held one forever (Bun on
      // this box neither times such a test out nor exits): the failure has to be an assertion, not a hang.
      expect(await returnsSoon(page.run.applyPending())).toBe(true);
      expect(await returnsSoon(page.run.discardPending())).toBe(true);
      expect(page.log.posts).toHaveLength(1);
      expect(page.log.reloads).toEqual({ plugins: 0, env: 0, status: 0 });
    } finally {
      release();
    }
    await first;
    expect(page.view().title).toBe("Applied. The bot restarted with your changes.");
    expect(page.view().disabled).toBe(false);
  });

  test("focus rests on the bar while a request is in flight and lands on OK when it ends", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, hold });
    page.activate(page.els.go); // the Apply button was focused (and is about to be disabled)
    const pending = page.run.applyPending();
    await Promise.resolve();
    expect(page.log.focused).toEqual(["apply-bar"]);
    release();
    await pending;
    expect(page.log.focused).toEqual(["apply-bar", "apply-ok"]);
  });

  test("focus lost to the page (Firefox drops a disabled button's focus) is recovered too, but focus the user moved elsewhere is not pulled back", async () => {
    const lost = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" } });
    await lost.run.applyPending(); // nothing is focused
    expect(lost.log.focused).toEqual(["apply-bar", "apply-ok"]);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const moved = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, hold });
    moved.activate(moved.els.go);
    const pending = moved.run.applyPending();
    await Promise.resolve();
    moved.activate(moved.control("WATCHED_REPOS")); // the user tabbed into a field during the restart
    release();
    await pending;
    expect(moved.log.focused).toEqual(["apply-bar"]); // not pulled to OK
  });

  test("a request that throws (a timeout, the network) also lands focus on OK", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, response: new Error("The operation was aborted.") });
    page.activate(page.els.go);
    await page.run.applyPending();
    expect(page.view()).toMatchObject({ tone: "danger", ok: true });
    expect(page.log.focused).toEqual(["apply-bar", "apply-ok"]);
  });

  test("a refusal is over once an apply goes: its message and its aria-invalid mark do not outlive it", async () => {
    // Refused (blank required field), then the field is filled by something that fires no `input` event
    // (a reload of the config does), then Apply goes and fails. The refusal is not true any more and must
    // not come back when the failure is dismissed.
    const page = runApply({
      loadedEnv: APPLY_ENV,
      fields: { ...APPLY_ENV, ANNOUNCE_CHANNEL_ID: "", WATCHED_REPOS: "eu" },
      response: { ok: false, text: "nope" },
    });
    await page.run.applyPending();
    expect(page.view().hint).toBe("ANNOUNCE_CHANNEL_ID is required and cannot be blank.");
    const control = page.control("ANNOUNCE_CHANNEL_ID");
    expect(control.attrs.has("aria-invalid")).toBe(true);
    page.edit("ANNOUNCE_CHANNEL_ID", "22222");
    await page.run.applyPending();
    expect(page.view().title).toBe("Couldn't apply: nope");
    expect(control.attrs.has("aria-invalid")).toBe(false);
    page.run.dismissApplyResult();
    expect(page.view()).toMatchObject({ tone: "", title: "2 changes need a restart", hint: "The bot goes offline for about 20 seconds while it restarts." });
  });

  test("a keystroke that leaves the bar's words as they were does not rewrite them (the words are a live region)", () => {
    const page = runApply({ loadedEnv: APPLY_ENV });
    const writes = (id: string) => page.log.textWrites.filter((w) => w.startsWith(`${id}=`));
    for (const value of ["e", "eu", "eu,", "eu,ap", "eu,ap,tw"]) {
      page.edit("WATCHED_REPOS", value);
      page.run.refreshApplyBar();
    }
    expect(page.view().title).toBe("1 change needs a restart");
    expect(writes("apply-title")).toEqual(["apply-title=1 change needs a restart"]);
    expect(writes("apply-hint")).toEqual(["apply-hint=The bot goes offline for about 20 seconds while it restarts."]);
    // A real change of words is written.
    page.edit("ANNOUNCE_CHANNEL_ID", "22222");
    page.run.refreshApplyBar();
    expect(writes("apply-title")).toEqual(["apply-title=1 change needs a restart", "apply-title=2 changes need a restart"]);
  });
});

describe("Apply bar events (#257)", () => {
  const inside = { closest: (sel: string) => (sel === "#env-fields, #plugins-list" ? {} : null), getAttribute: () => null, removeAttribute: () => {} };
  const outside = { closest: () => null, getAttribute: () => null, removeAttribute: () => {} };

  test("an edit inside the config fields or the plugin list shows the bar; an event from anywhere else does nothing", () => {
    const page = runApply({ loadedEnv: APPLY_ENV });
    page.run.onControlEdited({ target: outside });
    expect(page.view().hidden).toBe(true);
    page.edit("WATCHED_REPOS", "eu");
    page.run.onControlEdited({ target: outside }); // the logs filter, the admin e-mail box, a plugin's own bundle ...
    expect(page.view().hidden).toBe(true); // ... never reach the bar, even with a real change pending
    page.run.onControlEdited({ target: inside });
    expect(page.view()).toMatchObject({ hidden: false, title: "1 change needs a restart", go: true, discard: true });
    page.tick("raidhelper", true);
    page.run.onControlEdited({ target: inside });
    expect(page.view().title).toBe("2 changes need a restart");
    page.edit("WATCHED_REPOS", "us");
    page.tick("raidhelper", false);
    page.run.onControlEdited({ target: inside });
    expect(page.view().hidden).toBe(true); // putting it back leaves nothing pending: derived, never stored
  });

  test("an event with no usable target is ignored, not thrown on", () => {
    const page = runApply({ loadedEnv: APPLY_ENV });
    for (const e of [undefined, null, {}, { target: null }, { target: {} }]) expect(() => page.run.onControlEdited(e)).not.toThrow();
  });

  test("an edit dismisses a finished message and a refusal, and clears aria-invalid", async () => {
    const refused = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, ANNOUNCE_CHANNEL_ID: "" } });
    await refused.run.applyPending();
    const control = refused.control("ANNOUNCE_CHANNEL_ID");
    expect(control.attrs.has("aria-invalid")).toBe(true);
    refused.edit("ANNOUNCE_CHANNEL_ID", "22222");
    refused.run.onControlEdited({ target: inside });
    expect(control.attrs.has("aria-invalid")).toBe(false);
    expect(refused.view()).toMatchObject({ tone: "", hint: "The bot goes offline for about 20 seconds while it restarts." });

    for (const response of [undefined, { ok: false, text: "nope" }]) {
      const done = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, response });
      await done.run.applyPending();
      expect(done.view().ok).toBe(true);
      done.run.onControlEdited({ target: inside }); // any edit: back to what is pending
      expect(done.view()).toMatchObject({ ok: false, go: true, tone: "" });
    }
  });

  test("an edit while a request is in flight does not clear the Restarting message", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, hold });
    const pending = page.run.applyPending();
    await Promise.resolve();
    page.run.onControlEdited({ target: inside });
    expect(page.view().title).toBe("Restarting the bot…");
    release();
    await pending;
  });
});

describe("discardPending (#257)", () => {
  test("Discard after a kept-edits failure restores the server's values and posts nothing more (#272)", async () => {
    const page = runApply({
      loadedEnv: APPLY_ENV,
      fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" },
      checked: ["warbandeer", "raidhelper"],
      response: { ok: false, text: "bot-ops: env-set: value for 'WATCHED_REPOS' is invalid" },
      resetOnReload: true,
    });
    await page.run.applyPending();
    expect(page.log.reloads).toEqual({ plugins: 0, env: 0, status: 0 }); // the edits were kept ...
    expect(page.view()).toMatchObject({ tone: "danger", discard: true, go: true });
    await page.run.discardPending(); // ... and Discard still puts every control back
    expect(page.log.posts).toHaveLength(1); // only the failed apply: Discard sends nothing
    expect(page.log.reloads).toEqual({ plugins: 1, env: 1, status: 0 });
    expect(page.controls.find((c) => c.dataset.key === "WATCHED_REPOS")!.value).toBe(APPLY_ENV.WATCHED_REPOS);
    expect(page.boxes.find((b) => b.dataset.plugin === "raidhelper")!.checked).toBe(false);
    expect(page.view().hidden).toBe(true); // nothing pending, and the failure message is gone with the phase
  });

  test("posts nothing and re-renders plugins and env", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu", ANNOUNCE_CHANNEL_ID: "" }, checked: ["warbandeer", "raidhelper"], resetOnReload: true });
    await page.run.applyPending(); // a refusal: the control is marked invalid
    await page.run.discardPending();
    expect(page.log.posts).toEqual([]);
    expect(page.log.reloads).toEqual({ plugins: 1, env: 1, status: 0 });
    // Every control is back at the baseline, so nothing is pending and the bar is gone.
    const restored = page.run.collectPending();
    expect(restored.fields).toEqual(APPLY_ENV);
    expect(restored.plugins?.checkedNames).toEqual(["warbandeer"]);
    expect(page.view().hidden).toBe(true);
    expect(page.control("ANNOUNCE_CHANNEL_ID").attrs.has("aria-invalid")).toBe(false);
  });

  test("Discard on a failed apply also clears the failure, and focus returns to the open tab when the bar goes", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, response: { ok: false, text: "nope" }, resetOnReload: true });
    page.activate(page.els.go);
    await page.run.applyPending();
    expect(page.view()).toMatchObject({ tone: "danger", ok: true, discard: true, go: true }); // changes are still pending
    page.activate(page.els.discard); // Discard is the one clicked ...
    await page.run.discardPending();
    expect(page.view().hidden).toBe(true); // ... and the bar hides with it (the stub drops its focus, as a browser does)
    expect(page.log.focused.at(-1)).toBe("tab-settings");
    // The tab strip is at the top of a long page and Discard was pressed at the bottom of it: never scroll there.
    expect(page.log.preventScroll).toEqual(["tab-settings"]);
  });

  test("focus that is somewhere real is left alone when the bar goes", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, resetOnReload: true });
    await page.run.applyPending();
    page.activate(page.control("WATCHED_REPOS")); // the user is already typing elsewhere
    const before = page.log.focused.length;
    await page.run.discardPending();
    expect(page.log.focused).toHaveLength(before);
  });
});

describe("dismissApplyResult (#257)", () => {
  test("OK on a finished message hides the bar and puts focus back on the open tab", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" } });
    page.activate(page.els.go);
    await page.run.applyPending();
    expect(page.log.focused.at(-1)).toBe("apply-ok");
    // The real loaders have re-rendered the controls from the new state: nothing is pending.
    page.controls.forEach((c) => { c.value = APPLY_ENV[c.dataset.key as keyof typeof APPLY_ENV] ?? ""; });
    page.run.dismissApplyResult();
    expect(page.view().hidden).toBe(true);
    expect(page.log.focused.at(-1)).toBe("tab-settings");
    expect(page.log.preventScroll).toEqual(["tab-settings"]);
  });

  test("OK while changes are still pending keeps the bar and puts focus on it, not on Apply", async () => {
    const page = runApply({ loadedEnv: APPLY_ENV, fields: { ...APPLY_ENV, WATCHED_REPOS: "eu" }, response: { ok: false, text: "nope" } });
    page.activate(page.els.go);
    await page.run.applyPending();
    expect(page.log.focused.at(-1)).toBe("apply-ok");
    page.run.dismissApplyResult(); // OK hides, and takes focus with it
    expect(page.view()).toMatchObject({ hidden: false, title: "1 change needs a restart" });
    expect(page.log.focused.at(-1)).toBe("apply-bar"); // an Enter pressed twice must not restart the bot
    expect(page.log.preventScroll).toEqual(["apply-bar"]);
  });
});

describe("syncTagValue (#257)", () => {
  const syncTagValue = new Function(`"use strict";\n${applyBlock("TAG_SYNC")}\nreturn syncTagValue;`)() as (
    hidden: { value: string; dispatchEvent: (e: Event) => boolean },
    tokens: string[],
  ) => void;

  test("writes the joined value and dispatches a bubbling input event", () => {
    const events: Event[] = [];
    const hidden = { value: "stale", dispatchEvent: (e: Event) => (events.push(e), true) };
    syncTagValue(hidden, ["123456", "234567"]);
    expect(hidden.value).toBe("123456,234567");
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("input");
    expect(events[0]!.bubbles).toBe(true);
  });

  test("an empty list writes an empty value, and still says so", () => {
    const events: Event[] = [];
    const hidden = { value: "a", dispatchEvent: (e: Event) => (events.push(e), true) };
    syncTagValue(hidden, []);
    expect(hidden.value).toBe("");
    expect(events).toHaveLength(1);
  });

});

// The DOM half of the tabs (showTab + the click / keydown / hashchange wiring), lifted from index.html
// between TABS_DOM markers together with the pure TABS block, and run against a hand-made page:
// three tab buttons, three panels, and spies for history.replaceState and the listeners.
describe("tabs DOM wiring (lifted from index.html)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const tabsSrc = indexSrc.match(/\/\/ TABS:begin\n([\s\S]*?)\n\s*\/\/ TABS:end/)?.[1];
  const domSrc = indexSrc.match(/\/\/ TABS_DOM:begin\n([\s\S]*?)\n\s*\/\/ TABS_DOM:end/)?.[1];

  test("the marked blocks are present", () => {
    expect(tabsSrc).toBeTruthy();
    expect(domSrc).toBeTruthy();
  });

  type Tab = {
    id: string;
    attrs: Record<string, string>;
    tabIndex: number;
    classes: Set<string>;
    focused: number;
    setAttribute(k: string, v: string): void;
    classList: { toggle(c: string, on: boolean): void };
    focus(): void;
    closest(sel: string): Tab | null;
  };
  type KeyEvent = { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; target: Tab; prevented: boolean; preventDefault(): void };

  function page(hash = "") {
    const ids = ["overview", "plugins", "settings"];
    const tabs: Tab[] = ids.map((id) => {
      const el: Tab = {
        id: `tab-${id}`,
        attrs: {},
        tabIndex: 0,
        classes: new Set(),
        focused: 0,
        setAttribute(k, v) {
          el.attrs[k] = v;
        },
        classList: {
          toggle(c, on) {
            if (on) el.classes.add(c);
            else el.classes.delete(c);
          },
        },
        focus() {
          el.focused += 1;
        },
        closest: (sel) => (sel === '[role="tab"]' ? el : null),
      };
      return el;
    });
    const panels = ids.map((id) => ({ id: `panel-${id}`, hidden: id !== "overview" }));
    const handlers: Record<string, (e?: unknown) => void> = {};
    const tablist = { addEventListener: (type: string, fn: (e?: unknown) => void) => void (handlers[type] = fn) };
    const win = { addEventListener: (type: string, fn: (e?: unknown) => void) => void (handlers[`window:${type}`] = fn) };
    const loc = { hash };
    const replaced: unknown[][] = [];
    // showTab must find the shell's tabs and panels by their own ids: a role query would also catch
    // ARIA tabs a plugin's settings bundle builds elsewhere in the page.
    const doc = {
      getElementById: (id: string) => tabs.find((t) => t.id === id) ?? panels.find((x) => x.id === id) ?? null,
      querySelectorAll: () => {
        throw new Error("showTab must look tabs and panels up by id, not by role");
      },
    };
    const hist = {
      replaceState: (...args: unknown[]) => {
        replaced.push(args);
        loc.hash = String(args[2]);
      },
    };
    const shownCalls: string[] = [];
    // Which panels were hidden at the moment afterTabShown ran: it must run AFTER the panels are
    // updated, or a deferred scroll would still see the old (hidden) layout.
    const hiddenAtCall: boolean[][] = [];
    const api = new Function(
      "document",
      "history",
      "window",
      "location",
      "afterTabShown",
      `"use strict";\n${tabsSrc ?? ""}\n${domSrc ?? ""}\nreturn { showTab, wireTabs };`,
    )(doc, hist, win, loc, (id: string) => {
      shownCalls.push(id);
      hiddenAtCall.push(panels.map((x) => x.hidden));
    }) as { showTab: (id: string, moveFocus: boolean) => void; wireTabs: (tablist: unknown) => void };
    api.wireTabs(tablist);
    const key = (tab: Tab, k: string, mods: Partial<Pick<KeyEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {}): KeyEvent => {
      const e: KeyEvent = {
        key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods, target: tab, prevented: false,
        preventDefault() {
          e.prevented = true;
        },
      };
      handlers.keydown!(e);
      return e;
    };
    const open = () => tabs.filter((t) => t.attrs["aria-selected"] === "true").map((t) => t.id);
    const shown = () => panels.filter((p) => !p.hidden).map((p) => p.id);
    return { api, tabs, panels, handlers, replaced, loc, key, open, shown, shownCalls, hiddenAtCall };
  }

  test("showTab opens exactly one tab and one panel, and writes the hash with replaceState", () => {
    const p = page();
    p.api.showTab("plugins", false);
    expect(p.tabs.map((t) => t.attrs["aria-selected"])).toEqual(["false", "true", "false"]);
    expect(p.tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]); // roving tabindex
    expect(p.tabs.map((t) => t.classes.has("rb-tabstrip__tab--active"))).toEqual([false, true, false]);
    expect(p.panels.map((x) => x.hidden)).toEqual([true, false, true]);
    // replaceState (no scroll, no history entry), with the bare hash as the URL.
    expect(p.replaced).toEqual([[null, "", "#plugins"]]);
  });

  test("showTab tells afterTabShown which tab just opened", () => {
    const p = page();
    p.api.showTab("plugins", false);
    p.api.showTab("overview", false);
    expect(p.shownCalls).toEqual(["plugins", "overview"]);
    // ... and only once the target panel is shown and the others hidden (overview, plugins, settings).
    expect(p.hiddenAtCall).toEqual([
      [true, false, true],
      [false, true, true],
    ]);
  });

  test("showTab moves focus only when asked", () => {
    const p = page();
    p.api.showTab("settings", true);
    expect(p.tabs.map((t) => t.focused)).toEqual([0, 0, 1]);
    p.api.showTab("plugins", false);
    expect(p.tabs.map((t) => t.focused)).toEqual([0, 0, 1]);
  });

  test("a click on a tab opens it, without moving focus", () => {
    const p = page();
    p.handlers.click!({ target: p.tabs[1] });
    expect(p.open()).toEqual(["tab-plugins"]);
    expect(p.shown()).toEqual(["panel-plugins"]);
    expect(p.tabs.map((t) => t.focused)).toEqual([0, 0, 0]);
    // A click that isn't on a tab (target.closest -> null) does nothing.
    p.handlers.click!({ target: { closest: () => null } });
    expect(p.open()).toEqual(["tab-plugins"]);
  });

  test("arrow keys, Home and End open the target tab, focus it, and prevent the default", () => {
    const p = page();
    expect(p.key(p.tabs[0]!, "ArrowRight").prevented).toBe(true);
    expect(p.open()).toEqual(["tab-plugins"]);
    expect(p.tabs.map((t) => t.focused)).toEqual([0, 1, 0]);
    p.key(p.tabs[1]!, "End");
    expect(p.open()).toEqual(["tab-settings"]);
    p.key(p.tabs[2]!, "ArrowRight"); // wraps
    expect(p.open()).toEqual(["tab-overview"]);
    p.key(p.tabs[0]!, "ArrowLeft"); // wraps back
    expect(p.open()).toEqual(["tab-settings"]);
    p.key(p.tabs[2]!, "Home");
    expect(p.open()).toEqual(["tab-overview"]);
    expect(p.replaced.map((r) => r[2])).toEqual(["#plugins", "#settings", "#overview", "#settings", "#overview"]);
  });

  test("Home on the first tab still prevents the page scroll", () => {
    const p = page();
    expect(p.key(p.tabs[0]!, "Home").prevented).toBe(true);
    expect(p.open()).toEqual(["tab-overview"]);
  });

  test("other keys and modified keys do nothing and are left to the browser", () => {
    const p = page();
    for (const k of ["Enter", " ", "Tab", "ArrowUp", "ArrowDown", "a"]) {
      expect(p.key(p.tabs[0]!, k).prevented).toBe(false);
    }
    // Alt+Left is the browser's Back; Ctrl/Meta/Shift + arrows are not ours either.
    for (const mods of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(p.key(p.tabs[0]!, "ArrowRight", mods).prevented).toBe(false);
    }
    expect(p.open()).toEqual([]); // nothing was ever opened
    expect(p.replaced).toEqual([]);
  });

  test("a hashchange opens the tab the hash names, or Overview for an unknown one", () => {
    const p = page();
    p.loc.hash = "#settings";
    p.handlers["window:hashchange"]!();
    expect(p.open()).toEqual(["tab-settings"]);
    p.loc.hash = "#bogus";
    p.handlers["window:hashchange"]!();
    expect(p.open()).toEqual(["tab-overview"]);
  });

  test("showApp opens the tab named by the hash once the loaders have started", () => {
    // showApp itself is not lifted (it starts every loader), so pin its source: the call is there,
    // last, and reads location.hash -- that is what makes a reload land on the open tab.
    const showApp = indexSrc.match(/function showApp\(\) \{\n([\s\S]*?)\n  \}\n/)?.[1] ?? "";
    expect(showApp).toContain("loadAdmins();");
    expect(showApp.trimEnd().endsWith("showTab(tabFromHash(location.hash), false);")).toBe(true);
  });

  test("the page script wires the tablist at load, and a missing tablist can only cost the tabs", () => {
    // wireTabs is lifted and exercised above, but nothing there calls it the way the page does. The
    // call runs before the boot code, so an unguarded null would blank the page including the token
    // gate: it is guarded, and the markup is pinned to carry exactly one tablist.
    expect(indexSrc).toContain(`const tablist = document.querySelector('[role="tablist"]');\n  if (tablist) wireTabs(tablist);`);
  });
});

// "Load" jumps the log block to its newest line, but the block lives in the Overview tab and scrollTop
// does nothing on an element that isn't laid out: a load that finishes while another tab is open must
// wait for Overview to be shown again (showTab -> afterTabShown), not be silently lost.
describe("log scroll deferral (lifted from index.html)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const src = indexSrc.match(/\/\/ LOGS_SCROLL:begin\n([\s\S]*?)\n\s*\/\/ LOGS_SCROLL:end/)?.[1];

  test("the marked block is present", () => {
    expect(src).toBeTruthy();
  });

  function page(laidOut: boolean) {
    // For a statically positioned element like #logs-out, offsetParent is null when the element or
    // an ancestor is display:none (a position:fixed element also has a null offsetParent, but the log
    // block never is one).
    const out = { offsetParent: laidOut ? {} : null, scrollTop: 0, scrollHeight: 500 };
    const api = new Function(
      "document",
      `"use strict";\n${src ?? ""}\nreturn { scrollLogsToBottom, afterTabShown };`,
    )({ getElementById: (id: string) => (id === "logs-out" ? out : null) }) as {
      scrollLogsToBottom: () => void;
      afterTabShown: (id: string) => void;
    };
    return { out, ...api };
  }

  test("a visible log block jumps straight to the newest line", () => {
    const p = page(true);
    p.scrollLogsToBottom();
    expect(p.out.scrollTop).toBe(500);
  });

  test("a load that finishes while Overview is hidden scrolls once Overview is shown", () => {
    const p = page(false);
    p.scrollLogsToBottom(); // the response arrived on another tab
    expect(p.out.scrollTop).toBe(0); // nothing to scroll: the block isn't laid out
    p.afterTabShown("plugins"); // still not Overview: keep waiting
    p.afterTabShown("settings");
    expect(p.out.scrollTop).toBe(0);
    p.out.offsetParent = {}; // Overview is now visible
    p.afterTabShown("overview");
    expect(p.out.scrollTop).toBe(500);
  });

  test("opening Overview with nothing pending leaves the log where the admin scrolled it", () => {
    const p = page(true);
    p.out.scrollTop = 42;
    p.afterTabShown("overview");
    expect(p.out.scrollTop).toBe(42);
    // ... and a pending jump is consumed once: a later Overview visit doesn't scroll again.
    const q = page(false);
    q.scrollLogsToBottom();
    q.out.offsetParent = {};
    q.afterTabShown("overview");
    q.out.scrollTop = 7;
    q.afterTabShown("overview");
    expect(q.out.scrollTop).toBe(7);
  });
});

// makeBadge maps a badge DECISION's kind onto the library's semantic modifier; the decisions
// themselves (pluginStateBadge / pluginUpdateBadge) are pinned elsewhere in this file.
describe("plugin badge classes (lifted from index.html)", () => {
  const indexSrc = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  const src = indexSrc.match(/\/\/ PLUGIN_BADGE_CLASSES:begin\n([\s\S]*?)\n\s*\/\/ PLUGIN_BADGE_CLASSES:end/)?.[1];

  test("the marked block is present", () => {
    expect(src).toBeTruthy();
  });

  const makeBadge = new Function(
    "document",
    `"use strict";\n${src ?? ""}\nreturn makeBadge;`,
  )({ createElement: () => ({ className: "", textContent: "" }) }) as (
    text: string,
    kind: string | null,
  ) => { className: string; textContent: string };

  test("each kind keeps its own class and gains the matching semantic modifier", () => {
    expect(makeBadge("active", "active")).toEqual({ className: "rb-badge plugin-badge active rb-badge--success", textContent: "active" });
    expect(makeBadge("needs config: X", "warn")).toEqual({ className: "rb-badge plugin-badge warn rb-badge--warning", textContent: "needs config: X" });
    expect(makeBadge("update to 1.1.0", "update")).toEqual({ className: "rb-badge plugin-badge update rb-badge--info", textContent: "update to 1.1.0" });
  });

  test("a badge with no kind (or one it doesn't know) is the plain badge", () => {
    expect(makeBadge("disabled", null).className).toBe("rb-badge plugin-badge");
    expect(makeBadge("x", "constructor").className).toBe("rb-badge plugin-badge constructor"); // a Map, not an object lookup
  });
});
