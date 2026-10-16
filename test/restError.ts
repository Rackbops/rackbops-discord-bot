// A discord.js REST error as a failed reply to an interaction produces it (#545), with a random token in its
// `url` and a random reply in its `requestBody`, for the tests that pin what a log line may carry. Random, so
// neither value is in any source line Bun.inspect prints beside a stack frame.

import { expect } from "bun:test";
import { format } from "node:util";
import { DiscordAPIError } from "discord.js";

export interface ReplyFailure {
  /** What the interaction token is, as a string a log line must never contain. */
  token: string;
  /** What the reply was, as a string a log line must never contain. */
  marker: string;
  /** Discord's "Unknown interaction" (10062), 404, POST, from `url`, carrying `requestBody` with `marker`. */
  error: DiscordAPIError;
}

/**
 * `route` is where the failed call went, with the body discord.js sends there: an interaction's own
 * `callback` (`/interactions/<id>/<token>/callback`, body `{ type, data: { content } }`) or the follow-up
 * `webhook` (`/webhooks/<app>/<token>`, which `/update`'s report posts to, body `{ content }`). The callback
 * body nests the reply past `util.format`'s default depth, so only the token in `url` is printed whole for
 * it; the flat webhook body prints the reply too.
 */
export function replyFailure(route: "callback" | "webhook" = "callback"): ReplyFailure {
  const token = `token-${crypto.randomUUID()}`;
  const marker = `reply-${crypto.randomUUID()}`;
  const url =
    route === "callback"
      ? `https://discord.com/api/v10/interactions/1/${token}/callback`
      : `https://discord.com/api/v10/webhooks/2/${token}`;
  const body = route === "callback" ? { type: 4, data: { content: marker } } : { content: marker };
  const error = new DiscordAPIError({ message: "Unknown interaction", code: 10062 }, 10062, 404, "POST", url, {
    body,
    files: undefined,
  });
  return { token, marker, error };
}

/**
 * Every way a console call's arguments reach a log: `util.format` is the `LOG_FORMAT=json` path (src/logFormat.ts)
 * and prints a REST error's request in full; `Bun.inspect` is what the text console prints, per argument.
 */
export function printed(args: unknown[]): string[] {
  return [format(...args), ...args.map((a) => Bun.inspect(a))];
}

/**
 * What every #545 log-site test asserts about one logged call's `args` (the error is the last one): it is a
 * cleaned copy, not the original; it lost `url`, `requestBody` and `rawError` but kept Discord's code, the
 * status and the method; and neither the token nor the reply is printed, in either log format.
 */
export function expectCleanedLog(args: unknown[], failure: ReplyFailure): void {
  const logged = args.at(-1) as Record<string, unknown>;
  expect(logged).toBeInstanceOf(Error);
  expect(logged).not.toBe(failure.error);
  for (const key of ["url", "requestBody", "rawError"]) expect(key in logged, key).toBe(false);
  expect([logged.code, logged.status, logged.method]).toEqual([10062, 404, "POST"]);
  for (const text of printed(args)) {
    expect(text).not.toContain(failure.token);
    expect(text).not.toContain(failure.marker);
  }
}
