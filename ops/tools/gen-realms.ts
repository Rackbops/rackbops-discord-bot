// Regenerate ops/admin/public/realms.json — the static realm list the admin panel's WOW_REALM
// chooser reads. Run locally, by hand, about once a year (WoW realm lists change that rarely);
// the deployed panel never calls Blizzard itself.
//
// Deliberately lives OUTSIDE ops/admin/ so it's never in the admin image's build context, and it
// takes NO npm dependency on the battlenet-api-research client — it dynamic-imports that repo's
// working client by path at run time, the only place the two are coupled.
//
// Run (Bun, which resolves the client's TS + ".js"-specifier ESM imports natively):
//   bun run ops/tools/gen-realms.ts
//
// Inputs (both overridable by env, absolute paths only):
//   BNET_SECRETS     Blizzard client creds JSON: { "ID": "...", "SECRET": "..." }
//                    default R:/repos/secrets/BattleNetAPI-secrets.json
//   BNET_CLIENT_DIR  the roshne/battlenet-api-research client/ checkout
//                    default R:/repos/battlenet-api-research/client
//
// Writes ops/admin/public/realms.json: { generated, source, regions: { us:[{slug,name}], eu:[...] } }.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SECRETS = process.env.BNET_SECRETS ?? "R:/repos/secrets/BattleNetAPI-secrets.json";
const CLIENT_DIR = process.env.BNET_CLIENT_DIR ?? "R:/repos/battlenet-api-research/client";
const OUT = new URL("../admin/public/realms.json", import.meta.url);

// Only "us"/"eu" — the two values bot-ops.sh's WOW_REGION regex accepts, and the two the panel
// filters by. (kr/tw exist in the API but the bot doesn't offer them.)
const REGIONS = ["us", "eu"] as const;

type RealmIndex = {
  realms?: Array<{ slug?: string; name?: string | { en_US?: string } }>;
};

const creds = JSON.parse(readFileSync(SECRETS, "utf8")) as { ID?: string; SECRET?: string };
if (!creds.ID || !creds.SECRET) {
  throw new Error(`${SECRETS} must contain non-empty "ID" and "SECRET"`);
}

const clientEntry = pathToFileURL(join(CLIENT_DIR, "src/index.ts")).href;
const { createBlizzardClient } = (await import(clientEntry)) as {
  createBlizzardClient: (opts: {
    clientId: string;
    clientSecret: string;
    region: string;
  }) => { api: { GET: (path: string, init: unknown) => Promise<{ data?: unknown; error?: unknown; response: Response }> }; namespace: (c: string) => string };
};

const regions: Record<string, Array<{ slug: string; name: string }>> = {};
for (const region of REGIONS) {
  const bnet = createBlizzardClient({ clientId: creds.ID, clientSecret: creds.SECRET, region });
  const res = await bnet.api.GET("/data/wow/realm/index", {
    params: { query: { namespace: bnet.namespace("dynamic"), locale: "en_US" } },
  });
  if (res.error || !res.data) {
    throw new Error(`realm/index for ${region} failed: HTTP ${res.response.status}`);
  }
  const data = res.data as RealmIndex;
  const realms = (data.realms ?? [])
    .map((r) => ({
      slug: r.slug ?? "",
      // The index endpoint returns name as a plain string at locale=en_US, but tolerate a
      // localized object just in case; fall back to the slug so a row is never nameless.
      name: (typeof r.name === "string" ? r.name : r.name?.en_US) || r.slug || "",
    }))
    .filter((r) => r.slug)
    .sort((a, b) => a.name.localeCompare(b.name));
  // A 200 with an empty/missing realms array slips past the error guard above; refuse to write an
  // empty region rather than silently shipping a chooser with no options for it.
  if (realms.length === 0) {
    throw new Error(`realm/index for ${region} returned no usable realms — refusing to write an empty list`);
  }
  regions[region] = realms;
  console.log(`+ ${region}: ${realms.length} realms`);
}

const payload = {
  generated: new Date().toISOString().slice(0, 10),
  source: "/data/wow/realm/index (dynamic namespace, us + eu)",
  regions,
};
writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
console.log(`= wrote ${OUT.pathname.replace(/^\//, "")}`);
