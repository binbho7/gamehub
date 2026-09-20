import { mkdtemp, rm, utimes, mkdir, symlink, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { acquirePublicationLock } from "../lib/pipeline/publication-lock";

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
