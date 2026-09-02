import { describe, expect, test } from "bun:test";

// dmf.ts imports the `config` singleton (env resolved at import time), so satisfy the required
// vars before pulling it in. Every test below passes `tz` explicitly rather than relying on
// config.dmfTimezone -- config resolves process.env exactly once per process (see
// config.test.ts's gotcha), which can't represent two regions in one test run anyway.
process.env.DISCORD_TOKEN ??= "test-token";
process.env.ANNOUNCE_CHANNEL_ID ??= "100";
const { dmfWindow, dmfKey, currentOrNextDmf, decideDmfAnnouncement } = await import("./dmf");

const EU = "Europe/Paris";
const US = "America/Los_Angeles";

describe("dmfKey (EU)", () => {
  test("distinguishes months whose windows straddle a UTC month boundary", () => {
    // Feb 1 2026 is a Sunday, so February's window opens 2026-01-31T23:01Z -- the same UTC
    // month as January's own window (2026-01-03T23:01Z).
    expect(dmfKey(dmfWindow(2026, 0, EU))).not.toBe(dmfKey(dmfWindow(2026, 1, EU)));
    // Nov 1 2026 is also a Sunday: the same collision one month-in-seven later.
    expect(dmfKey(dmfWindow(2026, 9, EU))).not.toBe(dmfKey(dmfWindow(2026, 10, EU)));
  });
});

describe("currentOrNextDmf (EU)", () => {
  test("is active during the pre-midnight-UTC tail of a window that opened in the previous UTC month", () => {
    // February 2026's window opens 2026-01-31T23:01Z; this instant is inside it.
    const { active, window } = currentOrNextDmf(new Date("2026-01-31T23:30:00Z"), EU);
    expect(active).toBe(true);
    expect(window.monthIndex).toBe(1); // February
  });

  test("is inactive before this month's window has opened", () => {
    const { active } = currentOrNextDmf(new Date("2026-01-03T00:00:00Z"), EU);
    expect(active).toBe(false);
  });
});

describe("decideDmfAnnouncement (EU)", () => {
  test("announces a new key when active and unannounced", () => {
    const decision = decideDmfAnnouncement(new Date("2026-01-31T23:30:00Z"), undefined, EU);
    expect(decision).not.toBeNull();
    expect(decision?.key).toBe(dmfKey(dmfWindow(2026, 1, EU)));
  });

  test("stays silent once that key has already been announced", () => {
    const key = dmfKey(dmfWindow(2026, 1, EU));
    const decision = decideDmfAnnouncement(new Date("2026-01-31T23:30:00Z"), key, EU);
    expect(decision).toBeNull();
  });

  test("stays silent while inactive", () => {
    const decision = decideDmfAnnouncement(new Date("2026-01-03T00:00:00Z"), undefined, EU);
    expect(decision).toBeNull();
  });

  test("regression: November's window still announces after October's Faire already stored its key", () => {
    // The exact failure scenario from issue #36: October announces and stores "2026-10", then
    // November's window (bled into UTC October) must not be swallowed by that stored key.
    const octoberKey = dmfKey(dmfWindow(2026, 9, EU));
    const decision = decideDmfAnnouncement(new Date("2026-10-31T23:30:00Z"), octoberKey, EU);
    expect(decision).not.toBeNull();
    expect(decision?.key).not.toBe(octoberKey);
    expect(decision?.key).toBe(dmfKey(dmfWindow(2026, 10, EU)));
  });
});

describe("dmfWindow (US)", () => {
  test("end reflects a DST fall-back landing inside the window (November)", () => {
    // Nov 1 2026 is a Sunday, and US DST also ends that day -- the window's last day (Nov 8)
    // is entirely in PST, so its 00:01 realm-local close must not be a fixed 168h-from-start
    // UTC offset (which would still be counting in the PDT-based start offset).
    const { end } = dmfWindow(2026, 10, US);
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: US,
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
        .formatToParts(end)
        .map((p) => [p.type, p.value]),
    );
    expect(`${parts.hour}:${parts.minute} ${parts.dayPeriod}`).toBe("12:01 AM");
  });
});
