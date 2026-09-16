import { describe, expect, it } from "vitest";
import { createSchedulerD1Fixture } from "./test-support/local-d1";

const LEGACY_TABLES = [
  "companies",
  "game_companies",
  "game_external_ids",
  "game_genres",
  "game_images",
  "game_official_links",
  "game_platforms",
  "game_videos",
  "games",
  "genres",
  "platforms",
] as const;

async function seedEveryLegacyTable(binding: D1Database) {
  const statements = [
    "INSERT INTO games(id,slug,title,status,created_at,updated_at) VALUES(701,'seed','Seed','released',1700000000000,1700000000001)",
    "INSERT INTO game_external_ids(id,game_id,provider,external_id,external_url,created_at,updated_at) VALUES(702,701,'steam','1245620','https://store.steampowered.com/app/1245620',1700000000002,1700000000003)",
    "INSERT INTO game_official_links(id,game_id,provider,platform,link_type,url,region,is_official,verification_status,verification_method,http_status,redirect_url,verified_at,last_checked_at,created_at,updated_at) VALUES(703,701,'publisher','windows','official_website','https://example.com/seed','US',1,'verified','http',200,'https://example.com/final',1700000000004,1700000000005,1700000000006,1700000000007)",
    "INSERT INTO genres(id,slug,name,created_at,updated_at) VALUES(704,'action','Action',1700000000008,1700000000009)",
    "INSERT INTO game_genres(game_id,genre_id) VALUES(701,704)",
    "INSERT INTO platforms(id,slug,name,created_at,updated_at) VALUES(705,'windows','Windows',1700000000010,1700000000011)",
    "INSERT INTO game_platforms(game_id,platform_id) VALUES(701,705)",
    "INSERT INTO companies(id,slug,name,website_url,created_at,updated_at) VALUES(706,'studio','Studio','https://studio.example.com',1700000000012,1700000000013)",
    "INSERT INTO game_companies(game_id,company_id,role) VALUES(701,706,'developer')",
    "INSERT INTO game_images(id,game_id,type,source_url,source_provider,storage_url,storage_key,content_hash,mime_type,file_size,width,height,sort_order,created_at,updated_at) VALUES(707,701,'cover','https://cdn.example.com/cover.jpg','steam','https://images.example.com/object','images/sha256/aa/hash.jpg','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','image/jpeg',1234,600,900,0,1700000000014,1700000000015)",
    "INSERT INTO game_videos(id,game_id,provider,external_id,title,thumbnail_url,sort_order,created_at) VALUES(708,701,'youtube','video-1','Trailer','https://cdn.example.com/trailer.jpg',0,1700000000016)",
  ];
  for (const statement of statements) await binding.prepare(statement).run();
}

function schemaRows(dump: Record<string, unknown[]>) {
  return dump.__schema as Array<Record<string, unknown>>;
}

describe("V2.8 scheduler migration", () => {
  it("adds only scheduler tables and preserves every populated legacy table and schema object", async () => {
    const fixture = await createSchedulerD1Fixture({ migrationCount: 4 });
    try {
      await seedEveryLegacyTable(fixture.binding);
      const before = await fixture.dump();

      await fixture.applyV28();
      const after = await fixture.dump();

      for (const table of LEGACY_TABLES) expect(after[table]).toEqual(before[table]);
      for (const object of schemaRows(before)) expect(schemaRows(after)).toContainEqual(object);
      expect(Object.keys(after).filter((name) => name !== "__schema").sort()).toEqual([
        ...LEGACY_TABLES,
        "cron_sync_lease",
        "game_cron_sync_state",
      ].sort());
      await expect(fixture.binding.prepare("SELECT * FROM cron_sync_lease").all()).resolves.toMatchObject({
        results: [{
          name: "game-sync",
          lease_owner_token: null,
          lease_expires_at: 0,
          fence_epoch: 0,
        }],
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("enforces columns, named checks, foreign key cascade, and the scheduling index", async () => {
    const fixture = await createSchedulerD1Fixture();
    try {
      const stateColumns = await fixture.binding.prepare("PRAGMA table_info('game_cron_sync_state')").all();
      expect(stateColumns.results.map((row) => row.name)).toEqual([
        "game_id",
        "last_attempt_at",
        "last_status",
      ]);
      const leaseColumns = await fixture.binding.prepare("PRAGMA table_info('cron_sync_lease')").all();
      expect(leaseColumns.results.map((row) => row.name)).toEqual([
        "name",
        "lease_owner_token",
        "lease_expires_at",
        "fence_epoch",
      ]);

      const schema = schemaRows(await fixture.dump());
      const stateSql = String(schema.find((row) => row.name === "game_cron_sync_state")?.sql);
      const leaseSql = String(schema.find((row) => row.name === "cron_sync_lease")?.sql);
      expect(stateSql).toContain("game_cron_sync_state_attempt_check");
      expect(stateSql).toContain("game_cron_sync_state_status_check");
      expect(leaseSql).toContain("cron_sync_lease_name_check");
      expect(leaseSql).toContain("cron_sync_lease_expiry_check");
      expect(leaseSql).toContain("cron_sync_lease_epoch_check");
      expect(leaseSql).toContain("cron_sync_lease_owner_check");
      expect(schema).toContainEqual(expect.objectContaining({
        type: "index",
        name: "game_cron_sync_state_attempt_idx",
        tbl_name: "game_cron_sync_state",
      }));

      await fixture.binding.prepare("INSERT INTO games(id,slug,title) VALUES(801,'cascade','Cascade')").run();
      await fixture.binding.prepare("INSERT INTO game_cron_sync_state(game_id,last_attempt_at,last_status) VALUES(801,0,'started')").run();
      for (const statement of [
        "INSERT INTO game_cron_sync_state(game_id,last_attempt_at,last_status) VALUES(801,-1,'started')",
        "INSERT INTO game_cron_sync_state(game_id,last_attempt_at,last_status) VALUES(801,1.5,'started')",
        "INSERT INTO game_cron_sync_state(game_id,last_attempt_at,last_status) VALUES(801,1,'unknown')",
        "INSERT INTO game_cron_sync_state(game_id,last_attempt_at,last_status) VALUES(9999,1,'failed')",
        "UPDATE cron_sync_lease SET name='other' WHERE name='game-sync'",
        "UPDATE cron_sync_lease SET lease_expires_at=-1 WHERE name='game-sync'",
        "UPDATE cron_sync_lease SET lease_owner_token='owner',lease_expires_at=1.5 WHERE name='game-sync'",
        "UPDATE cron_sync_lease SET fence_epoch=-1 WHERE name='game-sync'",
        "UPDATE cron_sync_lease SET fence_epoch=1.5 WHERE name='game-sync'",
        "UPDATE cron_sync_lease SET fence_epoch=9007199254740992 WHERE name='game-sync'",
        "UPDATE cron_sync_lease SET lease_owner_token='owner',lease_expires_at=0 WHERE name='game-sync'",
        "UPDATE cron_sync_lease SET lease_owner_token='',lease_expires_at=1 WHERE name='game-sync'",
        "UPDATE cron_sync_lease SET lease_owner_token=NULL,lease_expires_at=1 WHERE name='game-sync'",
      ]) {
        await expect(fixture.binding.prepare(statement).run()).rejects.toThrow();
      }
      await fixture.binding.prepare("DELETE FROM games WHERE id=801").run();
      await expect(fixture.binding.prepare("SELECT * FROM game_cron_sync_state WHERE game_id=801").all())
        .resolves.toMatchObject({ results: [] });
    } finally {
      await fixture.dispose();
    }
  });

  it("does not reset a durable fence epoch when the migration runner is invoked again", async () => {
    const fixture = await createSchedulerD1Fixture();
    try {
      await fixture.binding.prepare(
        "UPDATE cron_sync_lease SET lease_owner_token='owner',lease_expires_at=1700000000000,fence_epoch=41 WHERE name='game-sync'",
      ).run();

      await fixture.applyV28();

      await expect(fixture.binding.prepare(
        "SELECT lease_owner_token,lease_expires_at,fence_epoch FROM cron_sync_lease WHERE name='game-sync'",
      ).all()).resolves.toMatchObject({
        results: [{ lease_owner_token: "owner", lease_expires_at: 1700000000000, fence_epoch: 41 }],
      });
    } finally {
      await fixture.dispose();
    }
  });
});
