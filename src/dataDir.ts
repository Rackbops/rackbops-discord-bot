// A leaf: imports `node:path` only, so `src/bootLog.ts` can import it without evaluating
// `src/storage.ts`'s body (which computes `DATA_DIR` at load and would throw first, #493).
// `src/storage.ts` re-exports it; import it from there everywhere else.
import { isAbsolute, join } from "node:path";

// Bun's test discovery names: *.test.*, *_test.*, *.spec.*, *_spec.* over js/jsx/ts/tsx (and the c/m variants).
const TEST_ENTRY = /[._](test|spec)\.[cm]?[jt]sx?$/;

/**
 * Resolve the one `data/` directory. Defaults to `<repo>/data` (`/app/data` in the image); a
 * `BOT_DATA_DIR` override relocates it wholesale.
 *
 * **The override exists for tests, not for operators** (#139). Every test that transitively imports
 * `commands`/`update`/`announce` pulls in `state.ts`, whose top-level `await` reads this directory
 * at import — and the suite then *writes* it, silently destroying a developer's real
 * `attemptedUpdateToSha` and `pendingUpdateReport`. Redirecting the whole directory is what
 * contains that, which is why the override lives here rather than on `state.ts` alone: `handoff.ts`
 * writes here too, and three separate spellings of "the data dir" is the underlying defect.
 *
 * Deliberately NOT documented in `.env.example` and NOT on `bot-ops.sh`'s editable whitelist. In a
 * deployment it is a footgun: `buildCreateSpec` copies the container's env onto the replacement but
 * derives `Binds` from the mounts, so a value pointing off the named volume means the original and
 * the replacement write *different* filesystems — the replacement's `handoff.json` is never seen,
 * every `/update` waits out `HANDOFF_DEADLINE_MS` and reports a replacement that "never reported
 * in", and self-update is broken with nothing naming the cause. That is why `src/bootLog.ts` logs the
 * resolved path on every boot, before `./config` can throw — it is the one thing that turns that into
 * a one-line diagnosis — and `bootLog.test.ts` runs the module in a subprocess to pin it (#458).
 * (Absolute-only is a *separate* guard, and not a mitigation for the above: `/srv/elsewhere` is
 * absolute and is exactly the failure case. It exists because a relative value resolves against
 * cwd, which can land back inside a checkout — the same reason `BOT_OPS_CONFIG_DIR` is
 * absolute-only.)
 *
 * Under `bun test` an unset override is a hard error rather than a silent fall back to the
 * checkout: without that, a preload that fails to run restores the corruption invisibly. `bun test`
 * is recognised by `NODE_ENV=test` — which Bun sets only when the shell exported no `NODE_ENV`
 * (measured on Bun 1.4.2: `NODE_ENV=production bun test` keeps `production`) — or by the entry file
 * (`process.argv[1]`, the test file under `bun test`) being a `*.test.*` file; the preload itself
 * cannot be the signal, since the case to catch is the preload not running (#510).
 */
export function resolveDataDir(
  env: Record<string, string | undefined> = process.env,
  entry: string | undefined = process.argv[1],
): string {
  const override = env.BOT_DATA_DIR;
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(`BOT_DATA_DIR must be an absolute path, got "${override}"`);
    }
    return override;
  }
  if (env.NODE_ENV === "test" || (entry !== undefined && TEST_ENTRY.test(entry))) {
    throw new Error(
      "BOT_DATA_DIR must be set under `bun test` — refusing to read or write the checkout's data/ " +
        "(#139). The bunfig.toml preload sets it; if you are seeing this, the preload did not run.",
    );
  }
  return join(import.meta.dir, "..", "data");
}
