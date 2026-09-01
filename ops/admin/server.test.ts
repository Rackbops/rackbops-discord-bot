import { describe, expect, test } from "bun:test";
import {
  buildInvocation,
  extractBearerToken,
  handleRequest,
  isAuthorized,
  tokensMatch,
  type BotOpsResult,
} from "./server";

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
