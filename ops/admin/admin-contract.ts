// The admin-UI contract, vendored for the panel — a copy of the plugins repo's
// packages/api/admin.ts (#123, child 1). ops/admin imports nothing from src/ or across repos, like
// the hand-vendored DEFAULT_PLUGIN_INDEX_URL. server.ts uses ADMIN_API_VERSION to gate which bundles
// it serves + mounts; the panel's client bridge (public/index.html `makeAdminApi`) implements
// AdminApi.
//
// Drift from the plugins-repo source is SAFE-FAIL — a version mismatch makes the panel refuse to
// mount (a "needs a newer panel" note), never a broken or unsafe mount — and a real mismatch is
// caught end-to-end by the deploy check (#125). So it is deliberately NOT pinned by a (cross-repo,
// network) drift test here, unlike the same-repo HOST_API_VERSION pin. Bump in lockstep when the
// admin contract's shape changes.

/** Mirror of the plugins repo's ADMIN_API_VERSION. The panel mounts a plugin's admin bundle only when
 *  the plugin's declared adminApiVersion equals this. */
export const ADMIN_API_VERSION = 1;

/** The outcome of an AdminApi.setEnv — mirrors what the panel's guarded env-set route returns. */
export interface SaveResult {
  ok: boolean;
  error?: string;
}

/** What the panel hands a plugin's admin bundle (the panel-side analog of the bot's HostApi). The
 *  concrete implementation is `makeAdminApi` in public/index.html; this is the vendored type. */
export interface AdminApi {
  readonly meta: { name: string; version: string; adminApiVersion: number };
  getEnv(): Promise<Record<string, string>>;
  setEnv(changes: Record<string, string>): Promise<SaveResult>;
  getState(): Promise<unknown>;
  proxyFetch(path: string): Promise<Response>;
}
