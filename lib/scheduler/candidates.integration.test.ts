import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalGameExists, createCandidateRepository } from "../db/repositories/scheduled/candidates";
import { createLeaseRepository } from "../db/repositories/scheduled/lease";
import { createSchedulerStateRepository } from "../db/repositories/scheduled/state";
import { safeCronError } from "./errors";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "./test-support/local-d1";

const DURATION = 1_500_000;

async function seedGame(binding: D1Database, id: number, appId: string | null) {
  await binding.prepare("INSERT INTO games(id,slug,title) VALUES(?1,?2,?2)").bind(id, `g${id}`).run();
  if (appId != null) {
    await binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(?1,'steam',?2)")
      .bind(id, appId).run();
  }
}

describe("Cron candidate selection", () => {
  let fixture: SchedulerD1Fixture;
  beforeAll(async () => { fixture = await createSchedulerD1Fixture(); }, 30_000);
  afterAll(async () => { await fixture?.dispose(); });
  beforeEach(async () => {
    await fixture.binding.prepare("DELETE FROM game_cron_sync_state").run();
    await fixture.binding.prepare("DELETE FROM game_external_ids").run();
    await fixture.binding.prepare("DELETE FROM games").run();
    await fixture.binding.prepare("DELETE FROM cron_sync_lease").run();
    await fixture.binding.prepare("INSERT INTO cron_sync_lease(name) VALUES('game-sync')").run();
  });

  it("filters malformed mappings before LIMIT and advances failed attempts", async () => {
    const f = fixture;
    for (const [id, appId] of [[1, "001"], [2, "20"], [3, "30"]] as const) {
      await f.binding.prepare("INSERT INTO games(id,slug,title) VALUES(?1,?2,?2)").bind(id, `g${id}`).run();
      await f.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(?1,'steam',?2)").bind(id, appId).run();
    }
    const repo = createCandidateRepository(f.binding);
    expect(await repo.select(1)).toEqual([{ gameId: 2, appId: "20" }]);
    const acquired = await createLeaseRepository(f.binding).acquire(crypto.randomUUID(), DURATION);
    if (acquired.status !== "acquired") throw new Error("fixture lease unavailable");
    const state = createSchedulerStateRepository(f.binding);
    const stamp = await state.startAttempt(2, acquired.lease);
    await state.finishAttempt(stamp, "failed");
    expect(await repo.select(2)).toEqual([{ gameId: 3, appId: "30" }, { gameId: 2, appId: "20" }]);
  });

  it("excludes zero, multiple, signed, spaced, non-digit, and overflowing Steam mappings", async () => {
    const cases: Array<[number, string | string[]]> = [
      [1, "0"],
      [2, ["21", "22"]],
      [3, "-30"],
      [4, " 40"],
      [5, "5a"],
      [6, "4294967296"],
      [7, "70"],
    ];
    for (const [id, appIds] of cases) {
      await seedGame(fixture.binding, id, null);
      for (const appId of Array.isArray(appIds) ? appIds : [appIds]) {
        await fixture.binding.prepare(
          "INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(?1,'steam',?2)",
        ).bind(id, appId).run();
      }
    }
    const repo = createCandidateRepository(fixture.binding);
    expect(await repo.select(25)).toEqual([{ gameId: 7, appId: "70" }]);
    expect(await repo.stillMatches({ gameId: 7, appId: "70" })).toBe(true);
    expect(await repo.stillMatches({ gameId: 7, appId: "71" })).toBe(false);
    expect(await repo.stillMatches({ gameId: 2, appId: "21" })).toBe(false);
  });

  it("orders equal timestamps by game id and caps the final LIMIT at 25", async () => {
    for (let id = 1; id <= 30; id += 1) {
      await seedGame(fixture.binding, id, String(100 + id));
      await fixture.binding.prepare(
        "INSERT INTO game_cron_sync_state(game_id,last_attempt_at,last_status) VALUES(?1,50,'failed')",
      ).bind(id).run();
    }
    const selected = await createCandidateRepository(fixture.binding).select(25);
    expect(selected).toHaveLength(25);
    expect(selected[0]).toEqual({ gameId: 1, appId: "101" });
    expect(selected[24]).toEqual({ gameId: 25, appId: "125" });
    expect(selected.some((candidate) => candidate.gameId > 25)).toBe(false);
  });

  it("rotates started and failed catalog entries and reports canonical existence", async () => {
    await seedGame(fixture.binding, 8, "80");
    await seedGame(fixture.binding, 9, "90");
    await fixture.binding.prepare(
      "INSERT INTO game_cron_sync_state(game_id,last_attempt_at,last_status) VALUES(8,10,'started'),(9,20,'failed')",
    ).run();
    const repo = createCandidateRepository(fixture.binding);
    expect(await repo.select(2)).toEqual([
      { gameId: 8, appId: "80" },
      { gameId: 9, appId: "90" },
    ]);
    expect(await canonicalGameExists(fixture.binding, 8)).toBe(true);
    await fixture.binding.prepare("DELETE FROM games WHERE id=8").run();
    expect(await canonicalGameExists(fixture.binding, 8)).toBe(false);
    expect(await repo.select(2)).toEqual([{ gameId: 9, appId: "90" }]);
    expect(await fixture.binding.prepare("SELECT game_id FROM game_cron_sync_state").all()).toMatchObject({
      results: [{ game_id: 9 }],
    });
  });

  it("rejects invalid candidate reads without leaking SQL errors", async () => {
    await expect(createCandidateRepository(fixture.binding).select(0))
      .rejects.toEqual(safeCronError("candidate_read_failed"));
  });
});
