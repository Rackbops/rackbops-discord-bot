import { describe, expect, test } from "bun:test";
import { installJsonConsole, jsonLogLine, logFormatFrom } from "./logFormat";

const AT = new Date("2026-09-29T12:00:00.000Z");

describe("logFormatFrom (#324)", () => {
  test("unset, blank and text keep plain lines", () => {
    expect(logFormatFrom({})).toBe("text");
    expect(logFormatFrom({ LOG_FORMAT: "" })).toBe("text");
    expect(logFormatFrom({ LOG_FORMAT: "text" })).toBe("text");
  });

  test("json, in any case and with stray spaces, turns JSON on", () => {
    expect(logFormatFrom({ LOG_FORMAT: "json" })).toBe("json");
    expect(logFormatFrom({ LOG_FORMAT: " JSON " })).toBe("json");
  });

  test("anything else is invalid, not silently one of the two", () => {
    expect(logFormatFrom({ LOG_FORMAT: "jsonl" })).toBe("invalid");
  });
});

describe("jsonLogLine (#324)", () => {
  test("is one JSON object with time, level and msg", () => {
    const line = jsonLogLine("info", ["[plugins] tracker loaded"], AT);
    expect(JSON.parse(line)).toEqual({ time: "2026-09-29T12:00:00.000Z", level: "info", msg: "[plugins] tracker loaded" });
  });

  test("formats its arguments the way console does", () => {
    expect(JSON.parse(jsonLogLine("warn", ["%s n=%d", "a", 3, { k: 1 }], AT)).msg).toBe("a n=3 { k: 1 }");
  });

  test("keeps an error's stack inside the one line", () => {
    const line = jsonLogLine("error", ["[tick] failed", new Error("boom")], AT);
    expect(line).not.toContain("\n");
    const msg = JSON.parse(line).msg as string;
    expect(msg.startsWith("[tick] failed ")).toBe(true);
    expect(msg).toContain("boom");
    expect(msg).toContain("\n"); // the stack, escaped in the line and restored by the parse
  });
});

describe("installJsonConsole (#324)", () => {
  test("sends log/info/debug to out and warn/error to err, one JSON line each", () => {
    const out: string[] = [];
    const err: string[] = [];
    const noop = (..._args: unknown[]): void => {};
    const con = { log: noop, info: noop, debug: noop, warn: noop, error: noop };
    installJsonConsole(con, { write: (c) => out.push(c) }, { write: (c) => err.push(c) }, () => AT);
    con.log("a");
    con.info("b");
    con.debug("c");
    con.warn("d");
    con.error("e", new Error("x"));
    expect(out.map((l) => JSON.parse(l).level)).toEqual(["info", "info", "debug"]);
    expect(err.map((l) => JSON.parse(l).level)).toEqual(["warn", "error"]);
    for (const line of [...out, ...err]) expect(line.endsWith("}\n") && line.indexOf("\n") === line.length - 1).toBe(true);
  });
});
