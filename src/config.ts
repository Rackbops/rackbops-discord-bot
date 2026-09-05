export type Region = "us" | "eu";

export interface Config {
  discordToken: string;
  announceChannelId: string;
  releaseAnnounceChannelId: string;
  guildId?: string;
  region: Region;
  realmSlug?: string;
  blizzardClientId?: string;
  blizzardClientSecret?: string;
  githubRepo: string;
  /** Repos whose releases get announced (`owner/repo`). Distinct from `githubRepo`, which
   * anchors self-update; defaults to `[githubRepo]`. */
  watchedRepos: string[];
  githubToken?: string;
  dmfTimezone: string;
  /** Commit this build was made from, baked in via the GIT_SHA build arg. Absent = self-update disabled. */
  gitSha?: string;
  /** Branch self-update measures staleness against. Must exist on `githubRepo`. */
  botBranch: string;
  autoUpdate: boolean;
  /** Discord user IDs allowed to run /update. Empty = nobody. */
  adminUserIds: string[];
  reportRoleId?: string;
  commandPrefix: string;
  /** Parsed `PLUGINS=` tokens — which plugins to install. Installing ≠ configured; a plugin's
   * own env keys are separate. See docs/adr/0004. */
  plugins: PluginSelector[];
  /** Where to fetch the Plugin Index (plugins.json) from — http(s), file://, or an absolute path. */
  pluginIndexUrl: string;
}

/** One `PLUGINS=` token: a bare name, or `name@version` to pin a version. */
export interface PluginSelector {
  name: string;
  version?: string;
}

/** `/report` project token → GitHub `owner/repo`. The slash-command choices are built from
 * these keys, so an unrecognized project token can't reach the handler. */
export const REPORT_PROJECTS: Record<string, string> = {
  wow: "nazumods/wow",
  abm: "roshne/ActionBarMaster",
};

/** The GitHub repo a `/report` project token maps to, or undefined if unknown. */
export function repoForProject(project: string): string | undefined {
  return REPORT_PROJECTS[project];
}

type Env = Record<string, string | undefined>;

export function resolveConfig(env: Env): Config {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
    return v;
  };

  const optional = (name: string): string | undefined => {
    const v = env[name];
    return v === "" ? undefined : v;
  };

  const list = (name: string): string[] => [
    ...new Set(
      (optional(name) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];

  const region = (optional("WOW_REGION") ?? "us") as Region;
  if (region !== "us" && region !== "eu") {
    throw new Error(`WOW_REGION must be "us" or "eu", got "${region}"`);
  }

  const announceChannelId = required("ANNOUNCE_CHANNEL_ID");

  const githubRepo = optional("GITHUB_REPO") ?? "roshne/rackbops-discord-bot";
  // Repos whose releases get announced. Distinct from githubRepo (self-update's anchor);
  // an empty/unset WATCHED_REPOS falls back to just githubRepo, i.e. the prior behavior.
  const watchedRepos = list("WATCHED_REPOS");

  // Optional prefix for slash-command names, so a second (debug/staging) bot can run in the
  // same server without command collisions. Discord requires lowercase command names.
  const commandPrefix = optional("COMMAND_PREFIX") ?? "";
  if (commandPrefix && !/^[a-z0-9_-]{1,20}$/.test(commandPrefix)) {
    throw new Error(
      `COMMAND_PREFIX must be 1-20 chars of lowercase letters, numbers, "-" or "_" ` +
        `(Discord slash-command name rules), got "${commandPrefix}"`,
    );
  }

  // Validated here, not left to fail wherever dmf.ts first calls Intl.DateTimeFormat with it —
  // an invalid zone would otherwise throw on every scheduler tick (checkDmf runs first, with no
  // per-check isolation before this fix) instead of refusing to boot at all (issue #43).
  const dmfTimezone =
    optional("DMF_TIMEZONE") ?? (region === "us" ? "America/Los_Angeles" : "Europe/Paris");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: dmfTimezone });
  } catch {
    throw new Error(`DMF_TIMEZONE is not a valid IANA time zone, got "${dmfTimezone}"`);
  }

  // name, or name@version to pin a version; duplicate names rejected separately from list()'s
  // own token-level dedup, which wouldn't catch "foo,foo@1.0.0" (different tokens, same name).
  const pluginTokens = list("PLUGINS");
  const plugins: PluginSelector[] = [];
  const seenPluginNames = new Set<string>();
  for (const token of pluginTokens) {
    const at = token.indexOf("@");
    const name = at === -1 ? token : token.slice(0, at);
    const version = at === -1 ? undefined : token.slice(at + 1);
    if (!/^[a-z][a-z0-9-]*$/.test(name) || (version !== undefined && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))) {
      throw new Error(
        `PLUGINS must be a comma-separated list of plugin names (optionally name@version), got "${token}"`,
      );
    }
    if (seenPluginNames.has(name)) {
      throw new Error(`PLUGINS lists "${name}" more than once`);
    }
    seenPluginNames.add(name);
    plugins.push(version === undefined ? { name } : { name, version });
  }

  const pluginIndexUrl =
    optional("PLUGIN_INDEX_URL") ?? "https://raw.githubusercontent.com/Rackbops/bot-plugins/main/plugins.json";
  if (!/^https?:\/\//.test(pluginIndexUrl) && !/^file:\/\//.test(pluginIndexUrl) && !pluginIndexUrl.startsWith("/")) {
    throw new Error(
      `PLUGIN_INDEX_URL must be an http(s) URL, a file:// URL or an absolute path, got "${pluginIndexUrl}"`,
    );
  }

  return {
    discordToken: required("DISCORD_TOKEN"),
    announceChannelId,
    releaseAnnounceChannelId: optional("RELEASE_ANNOUNCE_CHANNEL_ID") ?? announceChannelId,
    guildId: optional("DISCORD_SERVER_ID"),
    region,
    realmSlug: optional("WOW_REALM"),
    blizzardClientId: optional("BLIZZARD_CLIENT_ID"),
    blizzardClientSecret: optional("BLIZZARD_CLIENT_SECRET"),
    githubRepo,
    watchedRepos: watchedRepos.length ? watchedRepos : [githubRepo],
    githubToken: optional("GITHUB_TOKEN"),
    dmfTimezone,
    gitSha: optional("GIT_SHA"),
    botBranch: optional("BOT_BRANCH") ?? "main",
    autoUpdate: optional("AUTO_UPDATE") === "true",
    adminUserIds: list("ADMIN_USER_IDS"),
    reportRoleId: optional("REPORT_ROLE_ID"),
    commandPrefix,
    plugins,
    pluginIndexUrl,
  };
}

export const config: Config = resolveConfig(process.env);
