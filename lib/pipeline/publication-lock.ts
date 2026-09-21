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

export const OPERATOR_RECOVERY_CONFIRMATION = "ALL_EXPORTERS_STOPPED";

type OwnerRecord = { pid: number; token: string; identity: { domain: string; incarnation: string } };

function parseOwnerRecord(value: string): OwnerRecord {
  let owner: Partial<OwnerRecord>;
  try { owner = JSON.parse(value) as Partial<OwnerRecord>; }
  catch { throw new Error("publication lock owner record is invalid; operator recovery refused"); }
  if (typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.token !== "string" || !owner.token
    || typeof owner.identity?.domain !== "string" || !owner.identity.domain
    || typeof owner.identity?.incarnation !== "string" || !owner.identity.incarnation) {
    throw new Error("publication lock owner record is invalid; operator recovery refused");
  }
  return owner as OwnerRecord;
}

async function latestGeneration(root: string): Promise<number> {
  const entries = await readdir(root);
  const generations = entries.filter((entry) => /^(0|[1-9][0-9]*)\.owner$/.test(entry))
    .map((entry) => Number(entry.split(".")[0]));
  return generations.reduce((max, value) => Math.max(max, value), -1);
}

async function releasedOwner(root: string, generation: number): Promise<string | null> {
  try { return await readlink(`${root}/${generation}.released`); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
}

/** Manual authority boundary used only after every exporter has been stopped. */
export async function recoverPublicationLock(
  path: string,
  confirmation: string,
  query: ProcessQuery = queryProcessIdentity,
): Promise<{ generation: number; status: "recovered" | "already_released" }> {
  if (confirmation !== OPERATOR_RECOVERY_CONFIRMATION) {
    throw new Error("exact operator confirmation is required; stop all exporters before lock recovery");
  }
  const root = `${path}.lock`;
  const generation = await latestGeneration(root);
  if (generation < 0) throw new Error("publication lock has no owner generation to recover");
  const expectedOwner = await readlink(`${root}/${generation}.owner`);
  const existingRelease = await releasedOwner(root, generation);
  if (existingRelease !== null) {
    if (existingRelease !== expectedOwner) throw new Error("publication lock released marker does not match owner; operator recovery refused");
    return { generation, status: "already_released" };
  }
  const owner = parseOwnerRecord(expectedOwner);
  const ownership = await compareOwner(owner.identity, owner.pid, query);
  if (ownership === "SAME_OWNER") throw new Error("publication lock owner is still active; operator recovery refused");
  if (ownership === "OWNER_GONE_OR_REPLACED") {
    throw new Error("publication lock supports automatic recovery for this owner; rerun export without operator recovery");
  }
  if (await latestGeneration(root) !== generation) throw new Error("publication lock generation changed during operator recovery");
  if (await readlink(`${root}/${generation}.owner`) !== expectedOwner) throw new Error("publication lock owner changed during operator recovery");
  const releaseBeforeCommit = await releasedOwner(root, generation);
  if (releaseBeforeCommit !== null) {
    if (releaseBeforeCommit !== expectedOwner) throw new Error("publication lock released marker does not match owner; operator recovery refused");
    return { generation, status: "already_released" };
  }
  try {
    await symlink(expectedOwner, `${root}/${generation}.released`);
    return { generation, status: "recovered" };
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    if (await readlink(`${root}/${generation}.released`) !== expectedOwner) {
      throw new Error("publication lock released marker does not match owner; operator recovery refused");
    }
    return { generation, status: "already_released" };
  }
}
