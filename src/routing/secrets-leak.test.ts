// The acceptance test for the secret (#241): a webhook URL is written to routing.secrets.json and to
// NOWHERE else -- not routing.json, not discovery.json, not a rejected/ folder, not a temp file, not a
// log line, not a reason, not a result -- whether the request is accepted or refused, and whichever way
// it is refused.
//
// Everything is real but Discord: a real temp data dir, the real routing store (`mutateRouting`,
// `mutateSecrets`, which log through `console`), the real mailbox drain over the real filesystem, and a
// capturing `log` AND a captured `console`. Every scenario has its own distinctive token, so a leak can
// be traced to the request it came from; afterwards every file under the data dir (recursively) and every
// captured line is searched for every token.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumePluginRequests, resetPluginRequestsForTest, type PluginRequestDeps } from "../plugins/requests";
import { discoveryPath, readDiscovery, writeDiscovery } from "./discovery";
import type { DiscoveryFile } from "./model";
import type { WebhookLookup } from "./requests";
import { mutateRouting, mutateSecrets, readRouting, readSecrets, routingPath, secretsPath } from "./store";

const HOME = "111111111111111111";
const STRANGER = "999999999999999999";
const CH = "333333333333333331";
const AT = "2026-09-21T12:00:00.000Z";

/** One token per scenario, so a leak names its own request. Each is 20+ characters of [A-Za-z0-9_-]. */
const TOKENS = {
  accepted: "ACCEPTED_Tk_0123456789abcdefgh",
  wrongServer: "WRONGSERVER_Tk_0123456789abcdef",
  unknown: "UNKNOWNTOKEN_Tk_0123456789abcde",
  malformed: "MALFORMED_Tk_0123456789abcdefgh",
  unparseable: "UNPARSEABLE_Tk_0123456789abcdef",
  escaped: "ESCAPEDSLASH_Tk_0123456789abcde",
  thrown: "THROWNBYDEP_Tk_0123456789abcdef",
  inRequestedBy: "INREQUESTEDBY_Tk_0123456789abcd",
  updateRequest: "UPDATEREQUEST_Tk_0123456789abcd",
  wrongChannel: "WRONGCHANNEL_Tk_0123456789abcde",
  bare: "BARETOKENQUOTED_Tk_0123456789abcd",
  port: "PORTFORMNOHOST_Tk_0123456789abcde",
  orphan: "ORPHANEDSECRET_Tk_0123456789abcdef",
} as const;

const urlFor = (id: string, token: string) => `https://discord.com/api/webhooks/${id}/${token}`;
const ID = (n: number) => `55555555555555555${n}`;

let dataDir: string;
let requestsDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "secrets-leak-test-"));
  requestsDir = join(dataDir, "plugins", "requests");
  mkdirSync(requestsDir, { recursive: true });
  resetPluginRequestsForTest();
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const discovery = (): DiscoveryFile => ({
  v: 1,
  generatedAt: AT,
  bot: { id: "900000000000000000", username: "Setlist Bot" },
  inviteUrl: "https://discord.com/oauth2/authorize?client_id=900000000000000000",
  homeGuildId: HOME,
  guilds: [{ id: HOME, name: "Home", channels: [{ id: CH, name: "general", canSend: true }], commands: null }],
  plugins: {},
});

/** Every file under `dir`, recursively, as path -> text. Directories are not files. */
function everyFile(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const full = join(dir, entry);
    if (statSync(full).isFile()) found.set(entry.replaceAll("\\", "/"), readFileSync(full, "utf8"));
  }
  return found;
}

describe("a webhook url is only ever in routing.secrets.json", () => {
  test("accepted, refused for its server, unknown to Discord, malformed, unparseable: the token is in the secrets file and nowhere else", async () => {
    await writeDiscovery(dataDir, discovery());

    // ---- what is captured -------------------------------------------------------------------------
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => spyOn(console, method).mockImplementation(capture));
    const results: unknown[] = [];

    try {
      // ---- the mailbox: real fs, real store, a fake Discord -----------------------------------------
      const lookup = async (id: string, token: string): Promise<WebhookLookup> => {
        if (token === TOKENS.accepted) return { ok: true, id, channelId: CH, guildId: HOME };
        if (token === TOKENS.wrongServer) return { ok: true, id, channelId: CH, guildId: STRANGER };
        if (token === TOKENS.wrongChannel) return { ok: true, id, channelId: "777777777777777777", guildId: HOME };
        if (token === TOKENS.thrown) throw new Error(`the lookup exploded for ${urlFor(id, token)}`);
        return { ok: false, reason: "Discord does not know that webhook" };
      };
      const deps: PluginRequestDeps = {
        requestsDir,
        readDir: (dir) => readdir(dir),
        readFile: (path) => readFile(path, "utf8"),
        unlink: (path) => unlink(path),
        rename: (from, to) => rename(from, to),
        mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
        // Only the one update request (scenario 10) needs these; no plugin is installed, so it is refused.
        loadIndex: async () => ({ schemaVersion: 1, generatedAt: "", plugins: [] }),
        readState: async () => ({ hostApiVersion: 1, writtenAt: "", plugins: [] }),
        mutateState: async () => {
          throw new Error("no update request was valid");
        },
        requestRestart: () => {},
        hostApiVersion: 1,
        now: () => new Date(AT),
        log: { info: capture, warn: capture, error: capture },
        // The second look at a file that will not parse waits no wall-clock time here.
        tornReadRetryMs: 0,
        routing: {
          readDiscovery: () => readDiscovery(dataDir),
          readRouting: () => readRouting(dataDir),
          readSecrets: () => readSecrets(dataDir),
          mutateRouting: (mutate) => mutateRouting(dataDir, mutate),
          mutateSecrets: (mutate) => mutateSecrets(dataDir, mutate),
          fetchWebhook: lookup,
          applyRouting: async () => {
            results.push("applied");
            return {};
          },
          refreshDiscovery: async () => {},
          now: () => new Date(AT),
          log: { warn: capture },
        },
      };

      const drop = (name: string, body: unknown) => writeFileSync(join(requestsDir, name), typeof body === "string" ? body : JSON.stringify(body));
      const add = (n: number, token: string, over: Record<string, unknown> = {}) => ({
        action: "webhook-add",
        url: urlFor(ID(n), token),
        requestedBy: "admin@example.com",
        id: `req-add-0${n}`,
        ...over,
      });

      // 1. Accepted: the one place the URL may end up.
      drop("100-webhook-add-1.json", add(1, TOKENS.accepted));
      // 2. Refused: it posts to a server the bot is not in.
      drop("200-webhook-add-2.json", add(2, TOKENS.wrongServer));
      // 3. Refused: Discord does not know it.
      drop("300-webhook-add-3.json", add(3, TOKENS.unknown));
      // 4. Refused: not a webhook url at all (wrong scheme), but the token is in it.
      drop("400-webhook-add-4.json", add(4, TOKENS.malformed, { url: `http://discord.com/api/webhooks/${ID(4)}/${TOKENS.malformed}` }));
      // 5. Unparseable, and named for what it carries.
      drop("500-webhook-add-5.json", `{"action":"webhook-add","url":"${urlFor(ID(5), TOKENS.unparseable)}", oops`);
      // 6. The same, with the writer naming it something else and the slashes JSON-escaped.
      drop(
        "600-x.json",
        String.raw`{"action":"webhook-add","url":"https:\/\/discord.com\/api\/webhooks\/${ID(6)}\/${TOKENS.escaped}" oops`,
      );
      // 7. The dependency itself throws the url in its message.
      drop("700-webhook-add-7.json", add(7, TOKENS.thrown));
      // 8. A url where only a name should be: requestedBy.
      drop("800-webhook-add-8.json", add(8, TOKENS.accepted, { url: urlFor(ID(1), TOKENS.accepted), requestedBy: urlFor(ID(8), TOKENS.inRequestedBy) }));
      // 9. A refusal for the channel, not the server.
      drop("900-webhook-add-9.json", add(9, TOKENS.wrongChannel));
      // 10. An update request that happens to carry a url: refused as an update request, and deleted.
      drop("950-skip-1.json", { action: "skip", plugin: "ghost", version: "1.0.0", requestedBy: urlFor(ID(0), TOKENS.updateRequest), note: urlFor(ID(0), TOKENS.updateRequest) });

      // 11. A parser that quotes a bare token (Bun says `Unexpected identifier "<text>"`), in a file that is
      // not named for a webhook: its reason keeps the shape of the message and loses the quoted text.
      drop("960-y.json", `{"note":${TOKENS.bare}}`);
      // 12. A url in a shape no url pattern knows (a port), in an update request: refused, deleted.
      drop("970-skip-2.json", { action: "skip", plugin: "ghost", version: "1.0.0", requestedBy: `https://discord.com:443/api/webhooks/${ID(0)}/${TOKENS.port}` });

      await consumePluginRequests(deps);

      // Every request file is gone: none was left queued, and the only one set aside is scenario 11 -- a
      // bare token with no url around it, which nothing can tell from any other unparseable text.
      expect(readdirSync(requestsDir)).toEqual(["rejected"]);
      expect(readdirSync(join(requestsDir, "rejected"))).toEqual(["960-y.json"]);
      expect(results).toEqual([]);

      // ---- what was written, and where ---------------------------------------------------------------
      const files = everyFile(dataDir);
      const secrets = JSON.parse(files.get("routing.secrets.json") ?? "{}");
      // The accepted webhook's URL, canonical, and nothing else in there.
      expect(secrets.webhooks).toEqual({ [CH]: urlFor(ID(1), TOKENS.accepted) });
      // Request 8 was a second webhook-add for the same channel with the same url: it replaced the first
      // (one webhook per channel), so the file still holds exactly one.
      expect(Object.keys(secrets.webhooks)).toHaveLength(1);
      // Metadata went to routing.json, without the URL; the panel reads that file.
      expect(JSON.parse(files.get("routing.json") ?? "{}").webhooks[CH]).toMatchObject({ id: ID(1), guildId: HOME });

      // A secret-bearing refusal is deleted, not set aside: nothing in rejected/ but scenario 11's file.
      expect([...files.keys()].filter((name) => name.includes("rejected"))).toEqual(["plugins/requests/rejected/960-y.json"]);

      // ---- the search: every token, every file, every line --------------------------------------------
      const everywhere: [string, string][] = [
        ...[...files].map(([name, text]) => [`file ${name}`, text] as [string, string]),
        ...lines.map((line, i) => [`log line ${i}`, line] as [string, string]),
      ];
      for (const [scenario, token] of Object.entries(TOKENS)) {
        const homes = everywhere.filter(([, text]) => text.includes(token)).map(([where]) => where);
        // The accepted one is in the secrets file; every other token is nowhere at all -- except a bare
        // token, whose unparseable file is set aside like any other (it is the LOG that must not quote it).
        const expected =
          scenario === "accepted" ? ["file routing.secrets.json"] : scenario === "bare" ? ["file plugins/requests/rejected/960-y.json"] : [];
        expect(homes, `token of the "${scenario}" request`).toEqual(expected);
      }
      // And no webhook URL of any kind outside that one file: no `api/webhooks` in a log line or in any
      // other file, whatever token it carried.
      for (const [where, text] of everywhere) {
        if (where === "file routing.secrets.json") continue;
        expect(text.toLowerCase(), where).not.toContain("api/webhooks");
        expect(text, where).not.toContain("api\\/webhooks");
      }

      // What the operator DID get to see: a reason for each refusal, in the result the panel reads.
      const routing = JSON.parse(files.get("routing.json") ?? "{}");
      const byId = new Map<string, { ok: boolean; reason?: string; channelId?: string }>(routing.results.map((r: { id: string }) => [r.id, r]));
      expect(byId.get("req-add-01")).toMatchObject({ ok: true, channelId: CH });
      expect(byId.get("req-add-02")).toMatchObject({ ok: false, reason: "that webhook posts to a server the bot is not in" });
      expect(byId.get("req-add-03")).toMatchObject({ ok: false, reason: "Discord does not know that webhook" });
      expect(byId.get("req-add-04")).toMatchObject({ ok: false, reason: "bad webhook url" });
      expect(byId.get("req-add-07")).toMatchObject({ ok: false, reason: "apply failed — the lookup exploded for [webhook url]" });
      expect(byId.get("req-add-09")).toMatchObject({ ok: false, reason: "that webhook posts to a channel the bot cannot see" });
      // Request 8 was accepted (it replaced the channel's webhook), and the url in its requestedBy was
      // redacted before it could land in `addedBy` / `updatedBy`, which the panel reads.
      expect(byId.get("req-add-08")).toMatchObject({ ok: true, channelId: CH });
      expect(routing.webhooks[CH].addedBy).toBe("[webhook url]");
      expect(routing.updatedBy).toBe("[webhook url]");
      // The unparseable files and the update request had no id to record under, and that is fine.
      expect(routing.results).toHaveLength(7);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("the secrets file is the only place the url is, and the write left no temp file behind", async () => {
    await writeDiscovery(dataDir, discovery());
    const deps = liveDeps();
    writeFileSync(
      join(requestsDir, "100-webhook-add-1.json"),
      JSON.stringify({ action: "webhook-add", url: urlFor(ID(1), TOKENS.accepted), requestedBy: "admin@example.com", id: "req-add-01" }),
    );
    await consumePluginRequests(deps.deps);
    const names = [...everyFile(dataDir).keys()].sort();
    expect(names).toEqual(["discovery.json", "routing.json", "routing.secrets.json"]);
    expect(everyFile(dataDir).get("routing.secrets.json")).toContain(TOKENS.accepted);
    expect(readFileSync(secretsPath(dataDir), "utf8")).toContain(TOKENS.accepted);
    expect(readFileSync(routingPath(dataDir), "utf8")).not.toContain(TOKENS.accepted);
    expect(readFileSync(discoveryPath(dataDir), "utf8")).not.toContain(TOKENS.accepted);
  });

  test("removing a webhook whose metadata is already gone still removes the url it left in the secrets file", async () => {
    await writeDiscovery(dataDir, discovery());
    const deps = liveDeps();
    // What a write that failed halfway leaves: a stored url that routing.json does not name.
    await mutateSecrets(dataDir, (current) => ({ ...current, webhooks: { [CH]: urlFor(ID(1), TOKENS.orphan) } }));
    writeFileSync(join(requestsDir, "100-webhook-remove-1.json"), JSON.stringify({ action: "webhook-remove", channelId: CH, requestedBy: "a", id: "req-rm-001" }));
    await consumePluginRequests(deps.deps);
    expect(JSON.parse(readFileSync(secretsPath(dataDir), "utf8")).webhooks).toEqual({});
    for (const [name, text] of everyFile(dataDir)) expect(text, name).not.toContain(TOKENS.orphan);
    expect(JSON.parse(readFileSync(routingPath(dataDir), "utf8")).results[0]).toMatchObject({ id: "req-rm-001", ok: true, channelId: CH });
  });

  test("removing the webhook removes the url from the secrets file, and nothing else remembers it", async () => {
    await writeDiscovery(dataDir, discovery());
    const deps = liveDeps();
    writeFileSync(join(requestsDir, "100-webhook-add-1.json"), JSON.stringify({ action: "webhook-add", url: urlFor(ID(1), TOKENS.accepted), requestedBy: "a" }));
    await consumePluginRequests(deps.deps);
    writeFileSync(join(requestsDir, "200-webhook-remove-1.json"), JSON.stringify({ action: "webhook-remove", channelId: CH, requestedBy: "a", id: "req-rm-001" }));
    await consumePluginRequests(deps.deps);
    for (const [name, text] of everyFile(dataDir)) expect(text, name).not.toContain(TOKENS.accepted);
    expect(JSON.parse(readFileSync(secretsPath(dataDir), "utf8")).webhooks).toEqual({});
    expect(JSON.parse(readFileSync(routingPath(dataDir), "utf8")).webhooks).toEqual({});
  });
});

/** Live-shaped deps over `dataDir` with an accepting Discord, for the tests that need no scenario detail. */
function liveDeps() {
  const deps: PluginRequestDeps = {
    requestsDir,
    readDir: (dir) => readdir(dir),
    readFile: (path) => readFile(path, "utf8"),
    unlink: (path) => unlink(path),
    rename: (from, to) => rename(from, to),
    mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
    loadIndex: async () => {
      throw new Error("not needed");
    },
    readState: async () => {
      throw new Error("not needed");
    },
    mutateState: async () => {},
    requestRestart: () => {},
    hostApiVersion: 1,
    now: () => new Date(AT),
    log: { info() {}, warn() {}, error() {} },
    tornReadRetryMs: 0,
    routing: {
      readDiscovery: () => readDiscovery(dataDir),
      readRouting: () => readRouting(dataDir),
      readSecrets: () => readSecrets(dataDir),
      mutateRouting: (mutate) => mutateRouting(dataDir, mutate),
      mutateSecrets: (mutate) => mutateSecrets(dataDir, mutate),
      fetchWebhook: async (id) => ({ ok: true, id, channelId: CH, guildId: HOME }),
      applyRouting: async () => ({}),
      refreshDiscovery: async () => {},
      now: () => new Date(AT),
      log: { warn() {} },
    },
  };
  return { deps };
}
