import { mkdtemp, rm, utimes, mkdir, symlink, readlink, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { acquirePublicationLock, OPERATOR_RECOVERY_CONFIRMATION, recoverPublicationLock } from "../lib/pipeline/publication-lock";

const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
  }));
});
async function contender(path: string) {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/test-support/publication-lock-child.ts", path]);
  children.push(child);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  expect((await lines.next()).value).toBe("ready");
  return { child, acquire: async () => { child.stdin.write("acquire\n"); return (await lines.next()).value; } };
}

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function destination() {
  const root = await mkdtemp(join(tmpdir(), "publication-lock-")); roots.push(root);
  return join(root, "site-data.json");
}

it.each(["same", "replaced", "gone", "domain", "unknown", "throws", "legacy"])("checks process incarnation: %s", async (scenario) => {
  const path = await destination();
  const identity = { domain: "test-boot-and-namespace", incarnation: "123:456" };
  const owner = JSON.stringify({ pid: process.pid, token: "old", identity: scenario === "legacy" ? undefined : identity });
  await mkdir(`${path}.lock`);
  await symlink(owner, `${path}.lock/0.owner`);
  let queries = 0;
  const query = async () => {
    if (++queries === 1) return { state: "present" as const, ...identity, incarnation: "new-owner" };
    if (scenario === "throws") throw new Error("denied");
    if (scenario === "unknown") return { state: "unknown" as const };
    if (scenario === "gone") return { state: "absent" as const, domain: identity.domain };
    return { state: "present" as const, ...identity,
      domain: scenario === "domain" ? "different-namespace" : identity.domain,
      incarnation: scenario === "replaced" ? "different-process" : identity.incarnation };
  };
  const attempt = acquirePublicationLock(path, query);
  if (["replaced", "gone"].includes(scenario)) {
    const release = await attempt;
    expect(await readlink(`${path}.lock/0.released`)).toBe(owner);
    await release();
  } else {
    await expect(attempt).rejects.toThrow(/locked|identity/);
    await expect(readlink(`${path}.lock/0.released`)).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await readlink(`${path}.lock/0.owner`)).toBe(owner);
});

it("does not steal a live owner's lock based on age", async () => {
  const path = await destination();
  const release = await acquirePublicationLock(path);
  await utimes(`${path}.lock`, new Date(0), new Date(0));
  const contenders = await Promise.allSettled([acquirePublicationLock(path), acquirePublicationLock(path)]);
  expect(contenders.map((value) => value.status)).toEqual(["rejected", "rejected"]);
  await release();
});

it("late repeated release cannot release a successor", async () => {
  const path = await destination();
  const releaseOld = await acquirePublicationLock(path);
  await releaseOld();
  const releaseNew = await acquirePublicationLock(path);
  await releaseOld();
  await expect(acquirePublicationLock(path)).rejects.toThrow();
  await releaseNew();
});

it("recovers a crashed owner with only one winner among independent processes", async () => {
  const path = await destination();
  const original = await contender(path);
  expect(await original.acquire()).toBe("acquired");
  const died = once(original.child, "exit"); original.child.kill("SIGKILL"); await died;
  const [a, b] = await Promise.all([contender(path), contender(path)]);
  const outcomes = await Promise.all([a.acquire(), b.acquire()]);
  expect(outcomes.sort()).toEqual(["acquired", "blocked"]);
  await expect(acquirePublicationLock(path)).rejects.toThrow("locked");
}, 15_000);

it("releases safely across repeated generations and concurrent stale observations", async () => {
  const path = await destination();
  const original = await contender(path);
  expect(await original.acquire()).toBe("acquired");
  const died = once(original.child, "exit"); original.child.kill("SIGKILL"); await died;
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => acquirePublicationLock(path)));
  const winners = attempts.filter((result) => result.status === "fulfilled");
  expect(winners).toHaveLength(1);
  const release = winners[0]!;
  if (release.status !== "fulfilled") throw new Error("missing winner");
  await release.value();
  const successor = await acquirePublicationLock(path);
  await Promise.all([release.value(), release.value()]);
  await expect(acquirePublicationLock(path)).rejects.toThrow("locked");
  await successor();
}, 15_000);

async function unknownOwner(path: string) {
  const identity = { domain: "old-namespace", incarnation: "old-start" };
  const owner = JSON.stringify({ pid: 1, token: "old", identity });
  await mkdir(`${path}.lock`);
  await symlink(owner, `${path}.lock/0.owner`);
  const query = async () => ({ state: "present" as const, domain: "new-namespace", incarnation: "new-start" });
  return { owner, query };
}

it("requires exact operator confirmation before retiring an incomparable owner", async () => {
  const path = await destination();
  const { owner, query } = await unknownOwner(path);
  await expect(recoverPublicationLock(path, "", query)).rejects.toThrow("confirmation");
  await expect(readlink(`${path}.lock/0.released`)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(recoverPublicationLock(path, OPERATOR_RECOVERY_CONFIRMATION, query)).resolves.toEqual({ generation: 0, status: "recovered" });
  expect(await readlink(`${path}.lock/0.released`)).toBe(owner);
});

it("does not allow operator confirmation to override a provably active owner", async () => {
  const path = await destination();
  const identity = { domain: "same", incarnation: "same" };
  const owner = JSON.stringify({ pid: process.pid, token: "active", identity });
  await mkdir(`${path}.lock`);
  await symlink(owner, `${path}.lock/0.owner`);
  await expect(recoverPublicationLock(path, OPERATOR_RECOVERY_CONFIRMATION,
    async () => ({ state: "present", ...identity }))).rejects.toThrow("still active");
  await expect(readlink(`${path}.lock/0.released`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("leaves normally recoverable owners to automatic acquisition", async () => {
  const path = await destination();
  const identity = { domain: "same", incarnation: "old" };
  const owner = JSON.stringify({ pid: 91, token: "gone", identity });
  await mkdir(`${path}.lock`);
  await symlink(owner, `${path}.lock/0.owner`);
  const query = async (pid: number) => pid === process.pid
    ? ({ state: "present" as const, domain: "same", incarnation: "new" })
    : ({ state: "absent" as const, domain: "same" });
  await expect(recoverPublicationLock(path, OPERATOR_RECOVERY_CONFIRMATION, query)).rejects.toThrow("automatic recovery");
  const release = await acquirePublicationLock(path, query);
  expect(await readlink(`${path}.lock/0.released`)).toBe(owner);
  await release();
});

it("fails closed when the latest generation changes during recovery", async () => {
  const path = await destination();
  const { query: baseQuery } = await unknownOwner(path);
  const successor = JSON.stringify({ pid: 2, token: "successor", identity: { domain: "other", incarnation: "2" } });
  let changed = false;
  const query = async () => {
    if (!changed) { changed = true; await symlink(successor, `${path}.lock/1.owner`); }
    return baseQuery();
  };
  await expect(recoverPublicationLock(path, OPERATOR_RECOVERY_CONFIRMATION, query)).rejects.toThrow("changed");
  await expect(readlink(`${path}.lock/0.released`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails closed when the exact owner record changes during recovery", async () => {
  const path = await destination();
  const { query: baseQuery } = await unknownOwner(path);
  const changedOwner = JSON.stringify({ pid: 3, token: "tampered", identity: { domain: "old-namespace", incarnation: "other" } });
  let changed = false;
  const query = async () => {
    if (!changed) {
      changed = true;
      await unlink(`${path}.lock/0.owner`);
      await symlink(changedOwner, `${path}.lock/0.owner`);
    }
    return baseQuery();
  };
  await expect(recoverPublicationLock(path, OPERATOR_RECOVERY_CONFIRMATION, query)).rejects.toThrow("changed");
  await expect(readlink(`${path}.lock/0.released`)).rejects.toMatchObject({ code: "ENOENT" });
});

it("is idempotent only for an exact existing release marker", async () => {
  const path = await destination();
  const { owner, query } = await unknownOwner(path);
  await symlink(owner, `${path}.lock/0.released`);
  await expect(recoverPublicationLock(path, OPERATOR_RECOVERY_CONFIRMATION, query)).resolves.toEqual({ generation: 0, status: "already_released" });
  await unlink(`${path}.lock/0.released`);
  await symlink("different", `${path}.lock/0.released`);
  await expect(recoverPublicationLock(path, OPERATOR_RECOVERY_CONFIRMATION, query)).rejects.toThrow("does not match");
});

it("keeps recovery append-only and permits a successor whose late predecessor release is harmless", async () => {
  const path = await destination();
  const { owner, query } = await unknownOwner(path);
  const [first, second] = await Promise.all([
    recoverPublicationLock(path, OPERATOR_RECOVERY_CONFIRMATION, query),
    recoverPublicationLock(path, OPERATOR_RECOVERY_CONFIRMATION, query),
  ]);
  expect([first.status, second.status].sort()).toEqual(["already_released", "recovered"]);
  expect(await readlink(`${path}.lock/0.owner`)).toBe(owner);
  expect(await readdir(`${path}.lock`)).toEqual(expect.arrayContaining(["0.owner", "0.released"]));
  const ownIdentity = { domain: "new-namespace", incarnation: "current" };
  const release = await acquirePublicationLock(path, async () => ({ state: "present", ...ownIdentity }));
  // The old generation's release is already immutable and a late repeat can
  // only observe/confirm generation 0; it cannot target the successor.
  expect(await readlink(`${path}.lock/0.released`)).toBe(owner);
  await expect(acquirePublicationLock(path, async () => ({ state: "present", ...ownIdentity }))).rejects.toThrow("locked");
  await release();
});
