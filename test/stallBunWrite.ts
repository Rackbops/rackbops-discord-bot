import { spyOn } from "bun:test";

/**
 * Makes every `Bun.write` from now on hang for good, so a test can leave a real write provably
 * stuck rather than hope it is still running — on Linux a small write can finish before the next
 * event-loop turn (#394's round 2: a "three saves are surely still busy" test passed on Windows and
 * failed in CI). `reached` resolves once the first write is called; `calls` holds the arguments of
 * every stalled call (`calls[0]![0]` is the path the first write was given); `restore()` puts
 * `Bun.write` back, and a write already stuck stays stuck.
 */
export function stallBunWrite(): { reached: Promise<void>; calls: unknown[][]; restore: () => void } {
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const calls: unknown[][] = [];
  const spy = spyOn(Bun, "write").mockImplementation(((...args: unknown[]) => {
    calls.push(args);
    reach();
    return new Promise<never>(() => {});
  }) as unknown as typeof Bun.write);
  return { reached, calls, restore: () => spy.mockRestore() };
}
