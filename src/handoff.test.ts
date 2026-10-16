import { describe, expect, test } from "bun:test";
import {
  bootMode,
  decideHandoffOutcome,
  handoffFailureMessage,
  HANDOFF_DEADLINE_MS,
  HANDOFF_FROM_ENV,
  ownContainerShortId,
  RETIREMENT_DEADLINE_MS,
  VERIFY_DEADLINE_MS,
  type HandoffMarker,
  type ReplacementState,
} from "./handoff";

const marker = (status: "ready" | "failed", error?: string): HandoffMarker => ({
  status,
  error,
  at: 0,
});
const running: ReplacementState = { running: true, status: "running", exitCode: 0 };
const exited: ReplacementState = { running: false, status: "exited", exitCode: 1 };
const created: ReplacementState = { running: false, status: "created", exitCode: 0 };

describe("ownContainerShortId (#506 item 10)", () => {
  test("Docker's 12-hex short id, as the hostname, is the container's id", () => {
    expect(ownContainerShortId({ HOSTNAME: "0123456789ab" })).toBe("0123456789ab");
  });

  // Mutation: returning env.HOSTNAME unconditionally would stamp a pinned name on every marker, and the original
  // would then take every marker the replacement writes for a stranger's.
  test("a hostname pinned in compose, an uppercase or too-long id, an empty one, or none at all is not an id", () => {
    expect(ownContainerShortId({ HOSTNAME: "my-pinned-host" })).toBeUndefined();
    expect(ownContainerShortId({ HOSTNAME: "0123456789AB" })).toBeUndefined();
    expect(ownContainerShortId({ HOSTNAME: "0123456789abc" })).toBeUndefined();
    expect(ownContainerShortId({ HOSTNAME: "" })).toBeUndefined();
    expect(ownContainerShortId({})).toBeUndefined();
  });

  test("reads process.env by default", () => {
    const before = process.env.HOSTNAME;
    process.env.HOSTNAME = "fedcba987654";
    try {
      expect(ownContainerShortId()).toBe("fedcba987654");
    } finally {
      if (before === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = before;
    }
  });
});

describe("bootMode", () => {
  test("HANDOFF_FROM is the raw standby instruction (resolveBootMode confirms it against the daemon, #46)", () => {
    expect(bootMode({ [HANDOFF_FROM_ENV]: "abc123" })).toBe("standby");
  });

  test("a normal boot has no handoff env at all", () => {
    expect(bootMode({})).toBe("normal");
  });

  // An empty value is what an unset compose variable interpolates to; it must not arm standby,
  // or an ordinary `docker compose up` would come up refusing to answer anything.
  test("an empty HANDOFF_FROM is a normal boot, not a standby", () => {
    expect(bootMode({ [HANDOFF_FROM_ENV]: "" })).toBe("normal");
  });
});

describe("decideHandoffOutcome", () => {
  test("waits while the replacement is running and nothing has been signalled", () => {
    expect(decideHandoffOutcome({ replacement: running, elapsedMs: 0 })).toBe("waiting");
  });

  test("a just-created container is still starting, not a failure", () => {
    expect(decideHandoffOutcome({ replacement: created, elapsedMs: 0 })).toBe("waiting");
  });

  test("a ready marker is the handoff", () => {
    expect(decideHandoffOutcome({ marker: marker("ready"), replacement: running, elapsedMs: 0 })).toBe(
      "ready",
    );
  });

  test("a failed marker ends it", () => {
    expect(decideHandoffOutcome({ marker: marker("failed"), replacement: running, elapsedMs: 0 })).toBe(
      "failed",
    );
  });

  test("a replacement that exited without signalling has failed", () => {
    expect(decideHandoffOutcome({ replacement: exited, elapsedMs: 0 })).toBe("failed");
  });

  test("a replacement that vanished has failed", () => {
    expect(decideHandoffOutcome({ replacement: undefined, elapsedMs: 0 })).toBe("failed");
  });

  test("running out of time is a timeout, distinct from a failure", () => {
    expect(decideHandoffOutcome({ replacement: running, elapsedMs: HANDOFF_DEADLINE_MS })).toBe(
      "timeout",
    );
  });

  // The race the marker exists to close: a verified replacement is already stopping us, so it
  // may be mid-stop when we look at it. What it *said* has to outrank how it currently looks,
  // or a successful handoff gets torn down one poll before it completes.
  test("a ready marker wins over a container caught mid-stop", () => {
    expect(decideHandoffOutcome({ marker: marker("ready"), replacement: exited, elapsedMs: 0 })).toBe(
      "ready",
    );
  });

  test("a ready marker wins over a container already gone", () => {
    expect(
      decideHandoffOutcome({ marker: marker("ready"), replacement: undefined, elapsedMs: 0 }),
    ).toBe("ready");
  });

  test("a ready marker wins over an expired deadline", () => {
    expect(
      decideHandoffOutcome({
        marker: marker("ready"),
        replacement: running,
        elapsedMs: HANDOFF_DEADLINE_MS * 2,
      }),
    ).toBe("ready");
  });

  // #433: a failed inspect (a 5xx, a timeout) says nothing about the replacement. It is not "gone" and
  // not "exited": the poll waits, and only the deadline can end it without the replacement's own word.
  test("a failed inspect is not a verdict: waiting before the deadline, timeout at it", () => {
    expect(decideHandoffOutcome({ inspectFailed: true, elapsedMs: 0 })).toBe("waiting");
    // The replacement is undefined on a failed inspect; that must not read as "vanished" (-> failed).
    expect(decideHandoffOutcome({ inspectFailed: true, replacement: undefined, elapsedMs: 0 })).toBe("waiting");
    expect(decideHandoffOutcome({ inspectFailed: true, elapsedMs: HANDOFF_DEADLINE_MS })).toBe("timeout");
  });

  test("the marker still decides when the inspect failed", () => {
    expect(decideHandoffOutcome({ marker: marker("ready"), inspectFailed: true, elapsedMs: 0 })).toBe("ready");
    expect(decideHandoffOutcome({ marker: marker("failed"), inspectFailed: true, elapsedMs: 0 })).toBe("failed");
  });
});

describe("handoffFailureMessage", () => {
  const sha = "abcdef1234567890";

  test("a timeout says how long it waited", () => {
    const msg = handoffFailureMessage("timeout", { targetSha: sha });
    expect(msg).toContain("abcdef1");
    expect(msg).toContain(`${HANDOFF_DEADLINE_MS / 1000}s`);
  });

  test("a failure carries the reason when there is one", () => {
    expect(handoffFailureMessage("failed", { targetSha: sha, error: "build failed: no such ref" })).toContain(
      "build failed: no such ref",
    );
  });

  test("a failure without a reason still reads as a sentence", () => {
    expect(handoffFailureMessage("failed", { targetSha: sha })).not.toContain("undefined");
  });

  // Distinct from `failed` on purpose: the new build verified fine — what broke is the
  // retiring, which points at the daemon, not the code being deployed.
  test("a stall blames the socket, not the build", () => {
    const msg = handoffFailureMessage("stalled", { targetSha: sha });
    expect(msg).toContain("verified");
    expect(msg).toContain("socket");
  });

  // #51 item 3: a stall can still carry a reason (e.g. the redeploy loop caught a `failed`
  // marker written just past the deadline) — it used to be discarded outright.
  test("a stall carries the reason when there is one", () => {
    expect(handoffFailureMessage("stalled", { targetSha: sha, error: "daemon unreachable" })).toContain(
      "daemon unreachable",
    );
  });

  test("a stall without a reason still reads as a sentence", () => {
    expect(handoffFailureMessage("stalled", { targetSha: sha })).not.toContain("undefined");
  });

  // The headline of nazumods/wow#879: whatever went wrong, the original is still serving.
  test("every failure says the current build is still running", () => {
    for (const outcome of ["failed", "timeout", "stalled"] as const) {
      expect(handoffFailureMessage(outcome, { targetSha: sha })).toContain("current build");
      for (const replacement of ["none", "removed", "left", "remove-failed"] as const) {
        expect(handoffFailureMessage(outcome, { targetSha: sha, replacement })).toContain("current build");
      }
    }
  });

  // #451: "I removed it" is only said when it was removed. Every other disposition says what is true.
  test("says what became of the replacement, per disposition, for every outcome", () => {
    for (const outcome of ["failed", "timeout", "stalled"] as const) {
      const none = handoffFailureMessage(outcome, { targetSha: sha, replacement: "none" });
      expect(none).toContain("nothing was left to clean up");
      expect(none).not.toContain("removed it");

      expect(handoffFailureMessage(outcome, { targetSha: sha, replacement: "removed" })).toContain("removed it");

      const left = handoffFailureMessage(outcome, { targetSha: sha, replacement: "left" });
      expect(left).toContain("left it alone");
      expect(left).toContain("-next");
      expect(left).not.toContain("removed it");

      const failed = handoffFailureMessage(outcome, {
        targetSha: sha,
        replacement: "remove-failed",
        replacementError: "409 Conflict",
      });
      expect(failed).toContain("could not remove it");
      expect(failed).toContain("409 Conflict");
      expect(failed).toContain("by hand");
      expect(failed).not.toContain("removed it");

      // A refused removal with no answer from the daemon still reads as a sentence.
      const unexplained = handoffFailureMessage(outcome, { targetSha: sha, replacement: "remove-failed" });
      expect(unexplained).toContain("could not remove it:");
      expect(unexplained).not.toContain("undefined");
      expect(unexplained).not.toContain("()");

      // Absent: no claim about the container at all.
      const unknown = handoffFailureMessage(outcome, { targetSha: sha });
      for (const claim of ["removed it", "left it alone", "could not remove", "nothing was left"]) {
        expect(unknown).not.toContain(claim);
      }
    }
  });

  // The sentences join cleanly: a space after the removal clause before the socket hint, and the answers in
  // parentheses.
  test("the clauses are punctuated, not run together", () => {
    const stalled = handoffFailureMessage("stalled", { targetSha: sha, replacement: "removed", error: "daemon unreachable" });
    expect(stalled).toContain("current build. Check the daemon socket. (daemon unreachable)");
    const refused = handoffFailureMessage("failed", {
      targetSha: sha,
      replacement: "remove-failed",
      replacementError: "409 Conflict",
    });
    expect(refused).toContain("could not remove it (409 Conflict): remove the");
  });

  // #433: a deadline spent on a daemon that would not answer is worth naming to the requester.
  test("a timeout names the last daemon error when there was one", () => {
    const withError = handoffFailureMessage("timeout", { targetSha: sha, error: "docker inspect c failed: 500" });
    expect(withError).toContain("(last daemon error: docker inspect c failed: 500)");
    expect(handoffFailureMessage("timeout", { targetSha: sha })).not.toContain("last daemon error");
  });
});

// #492 (redeploy-15): the deadlines are what README.md's "about 11 minutes" and the state table sum, and the
// relations between them are what the protocol relies on; none was pinned by a test.
describe("the deadlines (#492)", () => {
  test("the replacement's verify budget sits inside the original's handoff deadline, with margin", () => {
    expect(VERIFY_DEADLINE_MS).toBe(90_000);
    expect(HANDOFF_DEADLINE_MS).toBe(120_000);
    // The original's clock starts at startContainer, the replacement's at its module top: the margin is what is
    // left for the container's own start and import time before the replacement's `failed` marker can be read.
    expect(HANDOFF_DEADLINE_MS - VERIFY_DEADLINE_MS).toBeGreaterThanOrEqual(20_000);
  });

  test("the retirement wait is the documented three minutes", () => {
    expect(RETIREMENT_DEADLINE_MS).toBe(180_000);
  });
});
