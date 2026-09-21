import { describe, expect, it } from "vitest";
import { createSchedulerD1Fixture } from "../scheduler/test-support/local-d1";

describe("V2.10 pipeline migration on isolated D1", () => {
  it("preserves populated legacy tables and schema objects and reruns as a no-op", async () => {
    const fixture = await createSchedulerD1Fixture();
    try {
      for (const sql of [
        "INSERT INTO games(id,slug,title) VALUES(701,'seed','Seed')",
        "INSERT INTO game_external_ids(id,game_id,provider,external_id) VALUES(702,701,'steam','123')",
        "INSERT INTO game_official_links(id,game_id,provider,link_type,url) VALUES(703,701,'publisher','official_website','https://example.com')",
        "INSERT INTO genres(id,slug,name) VALUES(704,'action','Action')",
        "INSERT INTO game_genres(game_id,genre_id) VALUES(701,704)",
        "INSERT INTO platforms(id,slug,name) VALUES(705,'windows','Windows')",
        "INSERT INTO game_platforms(game_id,platform_id) VALUES(701,705)",
        "INSERT INTO companies(id,slug,name) VALUES(706,'studio','Studio')",
        "INSERT INTO game_companies(game_id,company_id,role) VALUES(701,706,'developer')",
        "INSERT INTO game_images(id,game_id,type,source_url) VALUES(707,701,'cover','https://example.com/cover.jpg')",
        "INSERT INTO game_videos(id,game_id,provider,external_id) VALUES(708,701,'youtube','video')",
        "INSERT INTO game_cron_sync_state(game_id,last_attempt_at,last_status) VALUES(701,1,'succeeded')",
        "UPDATE cron_sync_lease SET fence_epoch=41 WHERE name='game-sync'",
      ]) await fixture.binding.prepare(sql).run();
      const before = await fixture.dump();
      expect(before.d1_migrations).toHaveLength(5);
      expect(before).not.toHaveProperty("pipeline_runs");
      expect(before).not.toHaveProperty("pipeline_run_items");
      await fixture.applyV210();
      const after = await fixture.dump();
      expect(Object.keys(after).filter((key) => !(key in before)).sort()).toEqual([
        "pipeline_run_items", "pipeline_runs",
      ]);
      for (const [table, rows] of Object.entries(before)) {
        if (table === "__schema") {
          for (const row of rows) expect(after.__schema).toContainEqual(row);
        } else if (table !== "d1_migrations") expect(after[table]).toEqual(rows);
      }
      expect(after.d1_migrations).toHaveLength(6);
      await fixture.binding.prepare(`INSERT INTO pipeline_runs
        (run_id,manifest_hash,pipeline_version,policy_version,snapshot_date,status,run_stage_states_json,created_at,updated_at)
        VALUES('run',?,'2.10','1','2026-09-19','created','{}',1,1)`)
        .bind("a".repeat(64)).run();
      await fixture.binding.prepare(`INSERT INTO pipeline_run_items
        (run_id,ordinal,steam_app_id,current_stage,current_state,stage_states_json,updated_at)
        VALUES('run',1,'123','discover','pending','{}',1)`).run();
      const populated = await fixture.dump();
      await fixture.applyV210();
      expect(await fixture.dump()).toEqual(populated);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});
