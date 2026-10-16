import { spyOn } from "bun:test";
import { TMP_TOKEN } from "../src/storage";

/** Makes `Bun.file(...)` hand back a file that exists but whose `json()` throws `err` — a read that
 *  fails the way a real EIO/EACCES (or an ENOENT after `exists()`) does, which a test cannot provoke
 *  portably. `restore()` puts `Bun.file` back; call it in a `finally`, before anything else reads. */
export function failJsonRead(err: Error): { restore: () => void } {
  const spy = spyOn(Bun, "file").mockImplementation((() => ({
    exists: async () => true,
    json: async () => {
      throw err;
    },
  })) as never);
  return { restore: () => spy.mockRestore() };
}

/** The exact temp name `writeFileAtomic` gives a write to `file`: `<file>.<pid>.<TMP_TOKEN>.<n>.tmp`
 *  (#253), with the path escaped because a Windows path's backslashes are regex syntax. */
export function tempNameRegExp(file: string): RegExp {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\.${process.pid}\\.${TMP_TOKEN}\\.\\d+\\.tmp$`);
}
