import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLeaseRepository } from "../db/repositories/scheduled/lease";
import { createSchedulerStateRepository } from "../db/repositories/scheduled/state";
import { FenceLostError, safeCronError } from "./errors";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "./test-support/local-d1";
import type { LeaseHandle } from "./types";

const DURATION = 1_500_000;
const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

function interceptResults(binding: D1Database, deliver: (result: D1Result[]) => Promise<D1Result[]>): D1Database {
  return new Proxy(binding, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => deliver(await target.batch(statements));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function acquire(): Promise<LeaseHandle> {
  const result = await createLeaseRepository(fixture.binding).acquire(crypto.randomUUID(), DURATION);
  expect(result.status).toBe("acquired");
  if (result.status !== "acquired") throw new Error("fixture lease unavailable");
  return result.lease;
}

let fixture: SchedulerD1Fixture;

describe("fenced Cron attempt state", () => {
  beforeAll(async () => { fixture = await createSchedulerD1Fixture(); }, 30_000);
  afterAll(async () => { await fixture?.dispose(); });
  beforeEach(async () => {
    await fixture.binding.prepare("DELETE FROM game_cron_sync_state").run();
    await fixture.binding.prepare("DELETE FROM games").run();
    await fixture.binding.prepare("DELETE FROM cron_sync_lease").run();
    await fixture.binding.prepare("INSERT INTO cron_sync_lease(name) VALUES('game-sync')").run();
    await fixture.binding.prepare("INSERT INTO games(id,slug,title) VALUES(2,'g2','Game')").run();
  });

  it("returns the committed start timestamp even if a later owner mutates before delivery", async () => {
    const first = await acquire();
    let resume!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    const atBatch = new Promise<void>((resolve) => { reached = resolve; });
    const delayed = interceptResults(fixture.binding, async (result) => {
      reached();
      await held;
      return result;
    });
    const pending = createSchedulerStateRepository(delayed).startAttempt(2, first);
    await atBatch;
    await fixture.binding.prepare(`UPDATE cron_sync_lease SET lease_expires_at=${DB_NOW}`).run();
    const second = await acquire();
    const overlay = await createSchedulerStateRepository(fixture.binding).startAttempt(2, second);
    resume();
    const stamp = await pending;
    expect(stamp.attemptedAt.valueOf()).toBeLessThan(overlay.attemptedAt.valueOf());
    expect(stamp.authority.fenceEpoch).toBe(first.fenceEpoch);
    expect(await fixture.binding.prepare("SELECT last_attempt_at FROM game_cron_sync_state WHERE game_id=2")
      .first<number>("last_attempt_at")).toBe(overlay.attemptedAt.valueOf());
  });

  it("rejects a stale start UPSERT and a stale finish after B stamps the same game", async () => {
    const first = await acquire();
    const firstStamp = await createSchedulerStateRepository(fixture.binding).startAttempt(2, first);
    await fixture.binding.prepare(`UPDATE cron_sync_lease SET lease_expires_at=${DB_NOW}`).run();
    const second = await acquire();
    const secondStamp = await createSchedulerStateRepository(fixture.binding).startAttempt(2, second);
    await expect(createSchedulerStateRepository(fixture.binding).startAttempt(2, first))
      .rejects.toBeInstanceOf(FenceLostError);
    await expect(createSchedulerStateRepository(fixture.binding).finishAttempt(firstStamp, "succeeded"))
      .rejects.toBeInstanceOf(FenceLostError);
    await createSchedulerStateRepository(fixture.binding).finishAttempt(secondStamp, "succeeded");
    expect(await fixture.binding.prepare("SELECT last_status FROM game_cron_sync_state WHERE game_id=2")
      .first<string>("last_status")).toBe("succeeded");
  });

  it("maps a valid fence with zero finish rows to state_conflict", async () => {
    const lease = await acquire();
    const stamp = await createSchedulerStateRepository(fixture.binding).startAttempt(2, lease);
    await createSchedulerStateRepository(fixture.binding).finishAttempt(stamp, "failed");
    await expect(createSchedulerStateRepository(fixture.binding).finishAttempt(stamp, "succeeded"))
      .rejects.toEqual(safeCronError("state_conflict"));
  });

  it("fails start when the canonical game is absent", async () => {
    const lease = await acquire();
    await expect(createSchedulerStateRepository(fixture.binding).startAttempt(99, lease))
      .rejects.toEqual(safeCronError("state_write_failed"));
    expect(await fixture.binding.prepare("SELECT game_id FROM game_cron_sync_state").all()).toMatchObject({
      results: [],
    });
  });
});
