import { mkdir, readdir, readlink, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/** Local filesystem only. EPERM/PID reuse are conservatively treated as live. */
function isDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return hasCode(error, "ESRCH"); }
}

/**
 * Append-only generations avoid compare-then-delete and pathname ABA races.
 * Each atomic symlink creation publishes a complete PID/host/UUID owner record.
 * A release (or confirmed-dead recovery) only appends that generation's marker.
 * The next generation is atomically contested only after the preceding one is
 * released. No contender ever deletes, renames, or reuses a generation pathname.
 * Keep these small operational records: online garbage collection would break
 * the no-reuse invariant. Active owners have no time-based expiry.
 */
export async function acquirePublicationLock(path: string): Promise<() => Promise<void>> {
  const root = `${path}.lock`;
  await mkdir(root, { recursive: true });
  const owner = JSON.stringify({ host: hostname(), pid: process.pid, token: randomUUID() });
  const retire = async (generation: number, expectedOwner: string) => {
    try { await symlink(expectedOwner, `${root}/${generation}.released`); }
    catch (error) {
      if (!hasCode(error, "EEXIST") || await readlink(`${root}/${generation}.released`) !== expectedOwner) throw error;
    }
  };
  for (;;) {
    const entries = await readdir(root);
    const generations = entries.filter((entry) => /^(0|[1-9][0-9]*)\.owner$/.test(entry)).map((entry) => Number(entry.split(".")[0]));
    const latest = generations.reduce((max, value) => Math.max(max, value), -1);
    if (!Number.isSafeInteger(latest + 1)) throw new Error("publication lock generation exhausted");
    if (latest >= 0) {
      const previousOwner = await readlink(`${root}/${latest}.owner`);
      let released = false;
      try { released = await readlink(`${root}/${latest}.released`) === previousOwner; }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      if (!released) {
        const previous = JSON.parse(previousOwner) as { host?: unknown; pid?: unknown; token?: unknown };
        if (previous.host !== hostname() || typeof previous.pid !== "number" || !Number.isSafeInteger(previous.pid)
          || previous.pid <= 0 || typeof previous.token !== "string" || !isDead(previous.pid)) {
          throw new Error("artifact publication is already locked");
        }
        // Even two reclaimers may safely retire the same immutable generation.
        await retire(latest, previousOwner);
      }
    }
    const generation = latest + 1;
    try { await symlink(owner, `${root}/${generation}.owner`); }
    catch (error) { if (hasCode(error, "EEXIST")) continue; throw error; }
    return () => retire(generation, owner);
  }
}
