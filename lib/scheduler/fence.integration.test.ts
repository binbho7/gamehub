import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLeaseRepository } from "../db/repositories/scheduled/lease";
import {
  assertFence,
  compileDomainQuery,
  executeFencedBatch,
  fencePredicate,
  type BuiltMutation,
} from "../db/repositories/scheduled/fence";
import { FenceLostError } from "./errors";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "./test-support/local-d1";
import type { LeaseAcquireResult, LeaseHandle } from "./types";
import { genres } from "../db/schema";

const DURATION = 1_500_000;
const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

function acquired(result: LeaseAcquireResult): LeaseHandle {
  expect(result.status).toBe("acquired");
  if (result.status !== "acquired") throw new Error("expected acquired lease");
  return result.lease;
}

function guardedGenreInsert(slug: string, name: string, authority: LeaseHandle): BuiltMutation {
  return {
    sql: `INSERT INTO genres(slug,name) SELECT ?1,?2 WHERE EXISTS (
      SELECT 1 FROM cron_sync_lease
      WHERE name='game-sync' AND lease_owner_token=?3 AND fence_epoch=?4
        AND lease_expires_at>${DB_NOW}
    )`,
    params: [slug, name, authority.ownerToken, authority.fenceEpoch],
    minChanges: 0,
    maxChanges: 1,
  };
}

describe("atomic D1 mutation fencing", () => {
  let fixture: SchedulerD1Fixture;
  beforeAll(async () => { fixture = await createSchedulerD1Fixture(); }, 30_000);
  afterAll(async () => { await fixture?.dispose(); });
  beforeEach(async () => {
    await fixture.binding.prepare("DELETE FROM genres").run();
    await fixture.binding.prepare("DELETE FROM cron_sync_lease").run();
    await fixture.binding.prepare("INSERT INTO cron_sync_lease(name) VALUES('game-sync')").run();
  });

  it("rejects an expired owner's guarded INSERT before it can publish", async () => {
    const lease = await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION);
    if (lease.status !== "acquired") throw new Error("fixture lease unavailable");
    await fixture.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1 WHERE name='game-sync'").run();
    await expect(executeFencedBatch(fixture.binding, lease.lease, [{
      sql: `INSERT INTO genres(slug,name) SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM cron_sync_lease WHERE name='game-sync' AND lease_owner_token=?3 AND fence_epoch=?4 AND lease_expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER))`,
      params: ["stale", "Stale", lease.lease.ownerToken, lease.lease.fenceEpoch],
      minChanges: 0,
      maxChanges: 1,
    }])).rejects.toMatchObject({ code: "fence_lost" });
    expect(await fixture.binding.prepare("SELECT id FROM genres WHERE slug='stale'").all()).toMatchObject({ results: [] });
  });

  it("proves unguarded check-then-write can publish after B acquires, while the guarded path cannot", async () => {
    const repo = createLeaseRepository(fixture.binding);
    const first = acquired(await repo.acquire(crypto.randomUUID(), DURATION));
    const inspected = await fixture.binding.prepare(
      "SELECT fence_epoch FROM cron_sync_lease WHERE name='game-sync' AND lease_owner_token=?",
    ).bind(first.ownerToken).first<{ fence_epoch: number }>();
    expect(inspected?.fence_epoch).toBe(first.fenceEpoch);

    await fixture.binding.prepare(`UPDATE cron_sync_lease SET lease_expires_at=${DB_NOW} WHERE name='game-sync'`).run();
    const second = acquired(await repo.acquire(crypto.randomUUID(), DURATION));
    expect(second.fenceEpoch).toBe(first.fenceEpoch + 1);

    await fixture.binding.prepare("INSERT INTO genres(slug,name) VALUES('ungarded','Unsafe')").run();
    expect(await fixture.binding.prepare("SELECT slug FROM genres WHERE slug='ungarded'").all()).toMatchObject({
      results: [{ slug: "ungarded" }],
    });

    await expect(executeFencedBatch(fixture.binding, first, [
      guardedGenreInsert("guarded", "Safe", first),
    ])).rejects.toMatchObject({ code: "fence_lost" });
    expect(await fixture.binding.prepare("SELECT slug FROM genres WHERE slug='guarded'").all()).toMatchObject({
      results: [],
    });
  });

  it("rolls back a successful guarded prefix when the final assertion trips the named CHECK", async () => {
    const lease = acquired(await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION));
    const before = await fixture.dump();
    const expire: BuiltMutation = {
      sql: "UPDATE cron_sync_lease SET lease_expires_at=1 WHERE name='game-sync'",
      params: [],
      minChanges: 1,
      maxChanges: 1,
    };
    await expect(executeFencedBatch(fixture.binding, lease, [
      guardedGenreInsert("rolled-back", "Rollback", lease),
      expire,
    ])).rejects.toBeInstanceOf(FenceLostError);
    expect(await fixture.dump()).toEqual(before);
  });

  it("rejects a naturally expired owner even when no later owner has acquired", async () => {
    const lease = acquired(await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION));
    await fixture.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1 WHERE name='game-sync'").run();
    await expect(assertFence(fixture.binding, lease)).rejects.toMatchObject({ code: "fence_lost" });
    await expect(executeFencedBatch(fixture.binding, lease, [
      guardedGenreInsert("expired", "Expired", lease),
    ])).rejects.toMatchObject({ code: "fence_lost" });
    expect(await fixture.binding.prepare("SELECT slug FROM genres").all()).toMatchObject({ results: [] });
  });

  it("keeps A when A commits before B acquires, and rejects A when B linearizes first", async () => {
    const repo = createLeaseRepository(fixture.binding);
    const first = acquired(await repo.acquire(crypto.randomUUID(), DURATION));
    const published = await executeFencedBatch(fixture.binding, first, [
      guardedGenreInsert("legal-a", "Legal", first),
    ]);
    expect(published.affectedRows).toBe(1);
    expect(published.changes).toEqual([1]);
    expect(published.results).toHaveLength(1);

    await fixture.binding.prepare(`UPDATE cron_sync_lease SET lease_expires_at=${DB_NOW} WHERE name='game-sync'`).run();
    const second = acquired(await repo.acquire(crypto.randomUUID(), DURATION));
    expect(second.fenceEpoch).toBe(2);
    expect(await fixture.binding.prepare("SELECT slug FROM genres WHERE slug='legal-a'").all()).toMatchObject({
      results: [{ slug: "legal-a" }],
    });

    await expect(executeFencedBatch(fixture.binding, first, [
      guardedGenreInsert("late-a", "Late", first),
    ])).rejects.toMatchObject({ code: "fence_lost" });
    const afterB = await executeFencedBatch(fixture.binding, second, [
      guardedGenreInsert("owner-b", "Owner B", second),
    ]);
    expect(afterB.affectedRows).toBe(1);
    expect(await fixture.binding.prepare("SELECT slug FROM genres ORDER BY slug").all()).toMatchObject({
      results: [{ slug: "legal-a" }, { slug: "owner-b" }],
    });
  });

  it("treats a missing singleton as a hard fence failure and a no-op for guarded writes", async () => {
    const lease = acquired(await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION));
    await fixture.binding.prepare("DELETE FROM cron_sync_lease").run();
    await expect(executeFencedBatch(fixture.binding, lease, [
      guardedGenreInsert("orphan", "Orphan", lease),
    ])).rejects.toMatchObject({ code: "fence_lost" });
    expect(await fixture.binding.prepare("SELECT slug FROM genres").all()).toMatchObject({ results: [] });
  });

  it("validates empty plans with assertions only and omits assertion rows from results", async () => {
    const lease = acquired(await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION));
    const empty = await executeFencedBatch(fixture.binding, lease, []);
    expect(empty).toEqual({ changes: [], affectedRows: 0, results: [] });
    await expect(assertFence(fixture.binding, lease)).resolves.toBeUndefined();
  });

  it("compiles drizzle UPDATE/INSERT/UPSERT/DELETE builders onto the live fence", async () => {
    const lease = acquired(await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION));
    await fixture.binding.prepare("INSERT INTO games(id,slug,title) VALUES(1,'g1','Game')").run();
    const guard = fencePredicate(lease);

    const created = compileDomainQuery(
      fixture.db.insert(genres).select((qb) => qb.select({
        id: sql`null`.as("id"),
        slug: sql`'compiled'`.as("slug"),
        name: sql`'Compiled'`.as("name"),
        createdAt: sql`(unixepoch('subsec') * 1000)`.as("created_at"),
        updatedAt: sql`(unixepoch('subsec') * 1000)`.as("updated_at"),
      }).from(sql`(select 1)`).where(guard)),
      { minChanges: 1, maxChanges: 1 },
    );
    expect(await executeFencedBatch(fixture.binding, lease, [created])).toMatchObject({ affectedRows: 1 });

    const updated = compileDomainQuery(
      fixture.db.update(genres).set({ name: "Renamed" }).where(and(eq(genres.slug, "compiled"), guard)),
      { minChanges: 1, maxChanges: 1 },
    );
    expect(await executeFencedBatch(fixture.binding, lease, [updated])).toMatchObject({ affectedRows: 1 });

    await fixture.binding.prepare(`
      CREATE TABLE IF NOT EXISTS fence_delete_probe (
        id integer PRIMARY KEY NOT NULL,
        label text NOT NULL
      )
    `).run();
    await fixture.binding.prepare("INSERT INTO fence_delete_probe(id,label) VALUES(1,'keep')").run();
    const deleted = await executeFencedBatch(fixture.binding, lease, [{
      sql: `DELETE FROM fence_delete_probe WHERE id=1 AND EXISTS (
        SELECT 1 FROM cron_sync_lease WHERE name='game-sync'
          AND lease_owner_token=?1 AND fence_epoch=?2
          AND lease_expires_at>${DB_NOW}
      ) RETURNING id`,
      params: [lease.ownerToken, lease.fenceEpoch],
      minChanges: 1,
      maxChanges: 1,
    }]);
    expect(deleted.affectedRows).toBe(1);
    expect(deleted.results[0]).toEqual([{ id: 1 }]);
    expect(await fixture.binding.prepare("SELECT id FROM fence_delete_probe").all()).toMatchObject({ results: [] });
  });

  it("does not treat a later diagnostic read as success after a failed assertion", async () => {
    const lease = acquired(await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION));
    await fixture.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1 WHERE name='game-sync'").run();
    await expect(executeFencedBatch(fixture.binding, lease, [
      guardedGenreInsert("diagnostic", "Diagnostic", lease),
    ])).rejects.toMatchObject({ code: "fence_lost" });
    const later = await fixture.binding.prepare("SELECT fence_epoch FROM cron_sync_lease").first<{ fence_epoch: number }>();
    expect(later?.fence_epoch).toBe(1);
    expect(await fixture.binding.prepare("SELECT slug FROM genres WHERE slug='diagnostic'").all()).toMatchObject({
      results: [],
    });
  });
});
