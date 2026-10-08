import { spyOn } from "bun:test";

/**
 * Makes every `Bun.write` from now on hang for good, so a test can leave a real write provably
 * stuck rather than hope it is still running — on Linux a small write can finish before the next
 * event-loop turn (#394's round 2: a "three saves are surely still busy" test passed on Windows and
 * failed in CI). `reached` resolves once the first write is called; `restore()` puts `Bun.write`
 * back, and a write already stuck stays stuck.
 */
export function stallBunWrite(): { reached: Promise<void>; restore: () => void } {
  let reach!: () => void;
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const spy = spyOn(Bun, "write").mockImplementation((() => {
    reach();
    return new Promise<never>(() => {});
  }) as unknown as typeof Bun.write);
  return { reached, restore: () => spy.mockRestore() };
}
