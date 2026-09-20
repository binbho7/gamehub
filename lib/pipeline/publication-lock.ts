import { mkdir, readdir, readlink, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { compareOwner, queryProcessIdentity, type ProcessQuery } from "./process-identity";

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

/**
 * Append-only generations avoid compare-then-delete and pathname ABA races.
 * Each atomic symlink creation publishes a complete PID/incarnation/UUID record.
 * A release (or confirmed-dead recovery) only appends that generation's marker.
 * The next generation is atomically contested only after the preceding one is
 * released. No contender ever deletes, renames, or reuses a generation pathname.
 * Keep these small operational records: online garbage collection would break
 * the no-reuse invariant. Active owners have no time-based expiry.
 */
export async function acquirePublicationLock(path: string, query: ProcessQuery = queryProcessIdentity): Promise<() => Promise<void>> {
  const own = await query(process.pid);
  if (own.state !== "present") throw new Error("publication process identity unavailable; verify local OS inspection permissions and system Python");
  const root = `${path}.lock`;
  await mkdir(root, { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID(), identity: { domain: own.domain, incarnation: own.incarnation } });
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
        const previous = JSON.parse(previousOwner) as { pid?: unknown; token?: unknown; identity?: { domain?: unknown; incarnation?: unknown } };
        if (typeof previous.pid !== "number" || !Number.isSafeInteger(previous.pid) || previous.pid <= 0
          || typeof previous.token !== "string" || typeof previous.identity?.domain !== "string" || !previous.identity.domain
          || typeof previous.identity?.incarnation !== "string" || !previous.identity.incarnation) {
          throw new Error("publication lock identity unavailable (legacy or invalid record); stop exporters and investigate the owner; automatic recovery refused");
        }
        const ownership = await compareOwner({ domain: previous.identity.domain, incarnation: previous.identity.incarnation }, previous.pid, query);
        if (ownership === "UNKNOWN") throw new Error("publication lock identity incomparable; inspect OS permissions, boot and PID namespace; automatic recovery refused");
        if (ownership === "SAME_OWNER") {
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
