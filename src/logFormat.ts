// #324: JSON log lines, opt-in with LOG_FORMAT=json -- one JSON object per line on stdout/stderr, for
// an instance whose logs are read by a machine (the Rackbops Clerk instance, plan E3) rather than by
// someone running `docker logs`. Unset (or `text`) keeps the plain lines every other instance has.
//
// Done by swapping the console methods once, from src/bootLog.ts (the first import), rather than by
// touching the call sites: every host line and every plugin line goes through `console` (a plugin's
// `host.log` is `createHostApi`'s wrapper over it, src/plugins/host.ts), so one swap covers them all,
// the boot lines included. A multi-line message (an error's stack) stays one record, because JSON
// escapes the newlines.

import { format } from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** What LOG_FORMAT asks for: `json`, `text` (unset or blank too), or `invalid` for anything else. */
export function logFormatFrom(env: Record<string, string | undefined>): "json" | "text" | "invalid" {
  const raw = env.LOG_FORMAT?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "text") return "text";
  return raw === "json" ? "json" : "invalid";
}

/** One record: `{"time","level","msg"}`, `msg` built from the console arguments the way console
 *  itself builds them (`util.format`: `%s` substitution, objects inspected, an Error with its stack).
 *  Pure; never throws for any argument list. */
export function jsonLogLine(level: LogLevel, args: readonly unknown[], now: Date): string {
  let msg: string;
  try {
    msg = format(...args);
  } catch {
    msg = "(unformattable log arguments)";
  }
  return JSON.stringify({ time: now.toISOString(), level, msg });
}

type Writable = { write(chunk: string): unknown };
type ConsoleLike = Pick<Console, "log" | "info" | "debug" | "warn" | "error">;

/** Replaces `con`'s five methods with ones that write one JSON line each: log/info/debug to `out`,
 *  warn/error to `err` (the same streams console uses, so `docker logs`' stdout/stderr split holds). */
export function installJsonConsole(
  con: ConsoleLike,
  out: Writable,
  err: Writable,
  now: () => Date = () => new Date(),
): void {
  const to = (stream: Writable, level: LogLevel) => (...args: unknown[]) => {
    stream.write(`${jsonLogLine(level, args, now())}\n`);
  };
  con.log = to(out, "info");
  con.info = to(out, "info");
  con.debug = to(out, "debug");
  con.warn = to(err, "warn");
  con.error = to(err, "error");
}
