import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  compileDomainQuery,
  fencePredicate,
} from "../db/repositories/scheduled/fence";
import { createDatabase } from "../db/client";
import { gameCronSyncState, genres } from "../db/schema";
import { parseScheduledMutationAuthority } from "./types";

const authority = parseScheduledMutationAuthority({
  ownerToken: "11111111-1111-4111-8111-111111111111",
  fenceEpoch: 4,
  leaseExpiresAtMs: 1_500_000,
});

function fakeBinding() {
  return {
    prepare() { throw new Error("SQL compile tests must not execute D1"); },
    batch() { throw new Error("SQL compile tests must not execute D1"); },
  } as unknown as D1Database;
}

describe("fenced SQL compilation", () => {
  const db = createDatabase(fakeBinding());
  const guard = fencePredicate(authority);

  it("adds the live lease predicate to UPDATE and DELETE WHERE clauses", () => {
    const update = compileDomainQuery(
      db.update(genres).set({ name: "Action" }).where(and(eq(genres.slug, "action"), guard)),
      { minChanges: 0, maxChanges: 1 },
    );
    const remove = compileDomainQuery(
      db.delete(genres).where(and(eq(genres.slug, "probe"), guard)),
      { minChanges: 0, maxChanges: 1 },
    );
    for (const compiled of [update, remove]) {
      expect(compiled.sql.toLowerCase()).toMatch(/where[\s\S]*exists[\s\S]*cron_sync_lease/);
      expect(compiled.sql).toContain("lease_owner_token");
      expect(compiled.sql).toContain("fence_epoch");
      expect(compiled.sql.toLowerCase()).toContain("unixepoch('subsec')");
      expect(compiled.params).toContain(authority.ownerToken);
      expect(compiled.params).toContain(authority.fenceEpoch);
      expect(compiled.legacyQuery).toBeDefined();
    }
    expect(update.sql.toLowerCase()).toContain("update");
    expect(remove.sql.toLowerCase()).toContain("delete");
  });

  it("compiles INSERT as explicit-column SELECT guarded by the fence", () => {
    const insert = compileDomainQuery(
      db.insert(genres).select((qb) => qb.select({
        id: sql`null`.as("id"),
        slug: sql`'action'`.as("slug"),
        name: sql`'Action'`.as("name"),
        createdAt: sql`(unixepoch('subsec') * 1000)`.as("created_at"),
        updatedAt: sql`(unixepoch('subsec') * 1000)`.as("updated_at"),
      }).from(sql`(select 1)`).where(guard)),
      { minChanges: 0, maxChanges: 1 },
    );
    expect(insert.sql.toLowerCase()).toMatch(/insert[\s\S]*select[\s\S]*exists[\s\S]*cron_sync_lease/);
    expect(insert.sql.toLowerCase()).not.toMatch(/insert into genres values/i);
    expect(insert.params).toContain(authority.ownerToken);
    expect(insert.params).toContain(authority.fenceEpoch);
  });

  it("guards both UPSERT INSERT SELECT and DO UPDATE arms", () => {
    const upsert = compileDomainQuery(
      db.insert(gameCronSyncState).select((qb) => qb.select({
        gameId: sql`1`.as("game_id"),
        lastAttemptAt: sql`2`.as("last_attempt_at"),
        lastStatus: sql`'started'`.as("last_status"),
      }).from(sql`(select 1)`).where(guard)).onConflictDoUpdate({
        target: gameCronSyncState.gameId,
        set: {
          lastAttemptAt: sql`excluded.last_attempt_at`,
          lastStatus: "started",
        },
        setWhere: guard,
      }),
      { minChanges: 0, maxChanges: 1 },
    );
    const sqlText = upsert.sql.toLowerCase();
    expect(sqlText).toMatch(/insert[\s\S]*select[\s\S]*exists[\s\S]*cron_sync_lease/);
    expect(sqlText).toMatch(/on conflict[\s\S]*do update[\s\S]*exists[\s\S]*cron_sync_lease/);
    expect(upsert.params.filter((value) => value === authority.ownerToken)).toHaveLength(2);
    expect(upsert.params.filter((value) => value === authority.fenceEpoch)).toHaveLength(2);
  });
});
