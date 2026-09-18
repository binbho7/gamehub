import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLeaseRepository } from "../db/repositories/scheduled/lease";
import { safeCronError } from "./errors";
import type { LeaseAcquireResult, LeaseHandle } from "./types";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "./test-support/local-d1";

const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const DURATION = 1_500_000;
const OWNER = "f43241c0-7811-4d62-a1d4-45e6cd6b56cd";

function acquired(result: LeaseAcquireResult): LeaseHandle {
  expect(result.status).toBe("acquired");
  if (result.status !== "acquired") throw new Error("expected acquired lease");
  return result.lease;
}

// Intercept delivery, not execution: all SQL still runs on the real D1 fixture.
function interceptResults(binding: D1Database, deliver: (result: D1Result) => Promise<D1Result>): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
      if (property === "all") return async () => deliver(await target.all());
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(binding, {
    get(target, property) {
      if (property === "prepare") return (query: string) => wrap(target.prepare(query));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("atomic Cron lease repository", () => {
  let fixture: SchedulerD1Fixture;
  beforeAll(async () => { fixture = await createSchedulerD1Fixture(); }, 30_000);
  afterAll(async () => { await fixture?.dispose(); });
  beforeEach(async () => {
    await fixture.binding.prepare("DELETE FROM cron_sync_lease").run();
    await fixture.binding.prepare("INSERT INTO cron_sync_lease(name) VALUES('game-sync')").run();
  });

  const snapshot = async () => (await fixture.binding.prepare("SELECT * FROM cron_sync_lease").all()).results;
  const expire = async () => {
    await fixture.binding.prepare(`UPDATE cron_sync_lease SET lease_expires_at=${DB_NOW} WHERE name='game-sync'`).run();
  };

  it("has one concurrent winner, preserves the released epoch, and fences the previous handle", async () => {
    const repo = createLeaseRepository(fixture.binding);
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.acquire(crypto.randomUUID(), DURATION)));
    const winners = results.filter((result) => result.status === "acquired");
    expect(winners).toHaveLength(1);
    const first = acquired(winners[0]);
    expect(first.fenceEpoch).toBe(1);
    expect(Object.isFrozen(first)).toBe(true);
    expect(await repo.release(first)).toBe("released");
    expect(await snapshot()).toEqual([{ name: "game-sync", lease_owner_token: null, lease_expires_at: 0, fence_epoch: 1 }]);
    expect(await repo.assertOwned(first).catch((error: unknown) => error)).toEqual(safeCronError("lease_lost"));
    const second = acquired(await repo.acquire(crypto.randomUUID(), DURATION));
    expect(second.fenceEpoch).toBe(2);
    expect(await repo.release(first)).toBe("fence_lost");
    expect(await repo.assertOwned(second)).toMatchObject({ leaseExpiresAtMs: second.leaseExpiresAtMs });
    expect("renew" in repo).toBe(false);
  });

  it("checks token and epoch independently and ignores the caller's expiry", async () => {
    const repo = createLeaseRepository(fixture.binding);
    const lease = acquired(await repo.acquire(OWNER, DURATION));
    const before = await snapshot();
    for (const stale of [{ ...lease, ownerToken: crypto.randomUUID() }, { ...lease, fenceEpoch: 2 }]) {
      await expect(repo.assertOwned(stale)).rejects.toEqual(safeCronError("lease_lost"));
      expect(await repo.release(stale)).toBe("fence_lost");
    }
    expect(await repo.assertOwned({ ...lease, leaseExpiresAtMs: 1 })).toMatchObject({ leaseExpiresAtMs: lease.leaseExpiresAtMs });
    expect(await snapshot()).toEqual(before);
    expect(await repo.release({ ...lease, leaseExpiresAtMs: 1 })).toBe("released");
  });

  it("does not resurrect an expired owner and permits a higher epoch while old work is pending", async () => {
    const repo = createLeaseRepository(fixture.binding);
    const first = acquired(await repo.acquire(OWNER, DURATION));
    await expire();
    await expect(repo.assertOwned({ ...first, leaseExpiresAtMs: Number.MAX_SAFE_INTEGER })).rejects.toEqual(safeCronError("lease_lost"));
    expect(await repo.release(first)).toBe("fence_lost");
    const second = acquired(await repo.acquire(crypto.randomUUID(), DURATION));
    expect(second.fenceEpoch).toBe(2);
    expect(await repo.release(first)).toBe("fence_lost");
    expect(await snapshot()).toMatchObject([{ lease_owner_token: second.ownerToken, fence_epoch: 2 }]);
  });

  it("uses a strict comparison at equal database expiry", async () => {
    const lease = acquired(await createLeaseRepository(fixture.binding).acquire(OWNER, DURATION));
    // Pin the SQL time expression to stored expiry to exercise exact equality,
    // without depending on two separate workerd requests landing in one ms.
    const equalClock = new Proxy(fixture.binding, {
      get(target, property) {
        if (property === "prepare") return (query: string) => target.prepare(query.replaceAll(
          /CAST\(unixepoch\('subsec'\)\s*\*\s*1000 AS INTEGER\)/g,
          "(SELECT lease_expires_at FROM cron_sync_lease WHERE name='game-sync')",
        ));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const repo = createLeaseRepository(equalClock);
    await expect(repo.assertOwned(lease)).rejects.toEqual(safeCronError("lease_lost"));
    expect(await repo.release(lease)).toBe("fence_lost");
    expect(acquired(await repo.acquire(crypto.randomUUID(), DURATION)).fenceEpoch).toBe(2);
  });

  it("uses primary database time despite a skewed application clock", async () => {
    const repo = createLeaseRepository(fixture.binding);
    const before = await fixture.binding.prepare(`SELECT ${DB_NOW} AS now`).first<number>("now");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    try {
      const lease = acquired(await repo.acquire(OWNER, DURATION));
      const ownership = await repo.assertOwned(lease);
      expect(ownership.dbNowMs).toBeGreaterThanOrEqual(before!);
      expect(ownership.leaseExpiresAtMs).toBeGreaterThan(ownership.dbNowMs);
      expect(lease.leaseExpiresAtMs).toBeLessThan(before! + DURATION + 10_000);
      expect(await repo.release(lease)).toBe("released");
    } finally { clock.mockRestore(); }
  });

  it("fails missing singleton acquisition without recreating the epoch", async () => {
    await fixture.binding.prepare("DELETE FROM cron_sync_lease").run();
    await expect(createLeaseRepository(fixture.binding).acquire(OWNER, DURATION)).rejects.toEqual(safeCronError("lease_acquire_failed"));
    expect(await snapshot()).toEqual([]);
  });

  it("rejects corrupted active state instead of reporting a normal held lease", async () => {
    const repo = createLeaseRepository(fixture.binding);
    for (const [owner, epoch, expiry] of [
      ["invalid-private-owner", 1, Date.now() + DURATION],
      [OWNER, 0, Date.now() + DURATION],
      [OWNER, 1, Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      await fixture.binding.prepare("UPDATE cron_sync_lease SET lease_owner_token=?,fence_epoch=?,lease_expires_at=?").bind(owner, epoch, expiry).run();
      const before = await snapshot();
      await expect(repo.acquire(crypto.randomUUID(), DURATION)).rejects.toEqual(safeCronError("lease_acquire_failed"));
      expect(await snapshot()).toEqual(before);
    }
  });

  it("does not repair corrupted expired ownership through acquisition", async () => {
    const repo = createLeaseRepository(fixture.binding);
    for (const [owner, epoch] of [["invalid-private-owner", 1], [OWNER, 0]] as const) {
      await fixture.binding.prepare("UPDATE cron_sync_lease SET lease_owner_token=?,fence_epoch=?,lease_expires_at=1").bind(owner, epoch).run();
      const before = await snapshot();
      await expect(repo.acquire(crypto.randomUUID(), DURATION)).rejects.toEqual(safeCronError("lease_acquire_failed"));
      expect(await snapshot()).toEqual(before);
    }
  });

  it("uses the final safe epoch once and never resets an exhausted singleton", async () => {
    const repo = createLeaseRepository(fixture.binding);
    await fixture.binding.prepare("UPDATE cron_sync_lease SET fence_epoch=9007199254740990").run();
    const lease = acquired(await repo.acquire(OWNER, DURATION));
    expect(lease.fenceEpoch).toBe(Number.MAX_SAFE_INTEGER);
    await expect(repo.acquire(crypto.randomUUID(), DURATION)).rejects.toEqual(safeCronError("lease_acquire_failed"));
    expect(await repo.release(lease)).toBe("released");
    await expect(repo.acquire(crypto.randomUUID(), DURATION)).rejects.toEqual(safeCronError("lease_acquire_failed"));
    expect(await snapshot()).toMatchObject([{ fence_epoch: Number.MAX_SAFE_INTEGER, lease_owner_token: null }]);
  });

  it("rejects malformed inputs and overflow without changing durable state", async () => {
    const repo = createLeaseRepository(fixture.binding);
    const before = await snapshot();
    for (const [owner, duration] of [["secret-invalid-owner", DURATION], [OWNER, 0], [OWNER, -1], [OWNER, 1.5], [OWNER, NaN], [OWNER, Infinity], [OWNER, Number.MAX_SAFE_INTEGER]] as const) {
      await expect(repo.acquire(owner, duration)).rejects.toEqual(safeCronError("lease_acquire_failed"));
      expect(await snapshot()).toEqual(before);
    }
  });

  it("does not recover ownership from a lost acquisition response", async () => {
    const repo = createLeaseRepository(interceptResults(fixture.binding, async () => {
      throw new Error(`private transport details ${OWNER}`);
    }));
    await expect(repo.acquire(OWNER, DURATION)).rejects.toEqual(safeCronError("lease_acquire_failed"));
    expect(await snapshot()).toMatchObject([{ lease_owner_token: OWNER, fence_epoch: 1 }]);
    expect(await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION)).toEqual({ status: "held" });
  });

  it("accepts an early acquisition delivered late but never upgrades its captured authority", async () => {
    let notifyExecuted!: () => void;
    let resume!: () => void;
    const executed = new Promise<void>((resolve) => { notifyExecuted = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const lateRepo = createLeaseRepository(interceptResults(fixture.binding, async (result) => {
      notifyExecuted();
      await paused;
      return result;
    }));
    const pending = lateRepo.acquire(OWNER, DURATION);
    try {
      await executed;
      await expire();
      const repo = createLeaseRepository(fixture.binding);
      const next = acquired(await repo.acquire(crypto.randomUUID(), DURATION));
      resume();
      const old = acquired(await pending);
      expect(old.fenceEpoch).toBe(1);
      expect(next.fenceEpoch).toBe(2);
      await expect(repo.assertOwned(old)).rejects.toEqual(safeCronError("lease_lost"));
      expect(await repo.release(old)).toBe("fence_lost");
      expect(await repo.assertOwned(next)).toMatchObject({ leaseExpiresAtMs: next.leaseExpiresAtMs });
    } finally { resume(); await pending; }
  });

  it("sanitizes ownership and release transport failures", async () => {
    const lease = acquired(await createLeaseRepository(fixture.binding).acquire(OWNER, DURATION));
    const repo = createLeaseRepository(interceptResults(fixture.binding, async () => {
      throw new Error(`private provider payload ${OWNER}`);
    }));
    await expect(repo.assertOwned(lease)).rejects.toEqual(safeCronError("lease_lost"));
    await expect(repo.release(lease)).rejects.toEqual(safeCronError("lease_release_failed"));
    expect(await snapshot()).toMatchObject([{ lease_owner_token: null, fence_epoch: 1 }]);
  });
});
