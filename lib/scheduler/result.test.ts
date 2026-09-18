import { describe, expect, it } from "vitest";
import { assertCronResult } from "./result";
import { safeCronError } from "./errors";
import type { CronExecutionResult } from "./types";

function complete(): CronExecutionResult {
  return { executionId: "execution-1", status: "completed", selected: 1, attempted: 1, succeeded: 1, failed: 0, notStarted: 0, stopReason: "none", games: [{ appId: "10", gameId: 1, status: "succeeded", stages: ["steam", "igdb", "links", "images"].map((name) => ({ name, status: "succeeded", summary: "done" })) }], primaryError: null, secondaryErrors: [], leaseDisposition: "released" } as CronExecutionResult;
}

describe("assertCronResult", () => {
  it("accepts a complete result and a single started invalid result counted separately", () => {
    expect(() => assertCronResult(complete(), 25)).not.toThrow();
    const result = complete();
    Object.assign(result, { status: "failed", selected: 2, attempted: 2, stopReason: "infrastructure_failure", primaryError: safeCronError("pipeline_contract_error") });
    expect(() => assertCronResult(result, 25)).not.toThrow();
  });

  it.each([
    { selected: 26 }, { attempted: -1 }, { succeeded: 0 }, { failed: 1 }, { notStarted: 1 }, { selected: 1.5 },
    { selected: 3, attempted: 3 }, { selected: 2, attempted: 2 }, { games: [] }, { status: "skipped" },
    { stopReason: "active_lease" }, { primaryError: safeCronError("state_write_failed") },
    { secondaryErrors: [safeCronError("lease_release_failed")] }, { leaseDisposition: "retained_until_expiry" },
    { extra: "secret" }, { primaryError: { code: "unknown", message: "secret" } },
  ])("rejects inconsistent or unsafe result %j", (change) => {
    expect(() => assertCronResult(Object.assign(complete(), change), 25)).toThrow();
  });

  it("rejects an invalid full game, even when counts balance", () => {
    const result = complete();
    result.games[0]!.stages.reverse();
    expect(() => assertCronResult(result, 25)).toThrow();
  });

  it.each(["partial", "completed"] as const)("does not permit an incomplete game in %s", (status) => {
    const result = complete();
    Object.assign(result, { selected: 2, attempted: 2, status });
    expect(() => assertCronResult(result, 25)).toThrow();
  });

  it("requires loss precedence and no ownership on observed secondary loss", () => {
    const result = complete();
    Object.assign(result, { status: "failed", primaryError: safeCronError("state_write_failed"), secondaryErrors: [safeCronError("fence_lost")], stopReason: "authority_lost", leaseDisposition: "no_longer_owned" });
    expect(() => assertCronResult(result, 25)).not.toThrow();
    result.leaseDisposition = "released";
    expect(() => assertCronResult(result, 25)).toThrow();
  });

  it("rejects claiming successful release after a release error", () => {
    const result = complete();
    Object.assign(result, { status: "failed", primaryError: safeCronError("lease_release_failed"), stopReason: "infrastructure_failure" });
    expect(() => assertCronResult(result, 25)).toThrow();
  });

  it("requires an admission stop reason when selected candidates remain", () => {
    const result = complete();
    Object.assign(result, { status: "partial", selected: 2, notStarted: 1 });
    expect(() => assertCronResult(result, 25)).toThrow();
  });

  it("rejects acquisition failure paired with acquired results", () => {
    const result = complete();
    Object.assign(result, { status: "failed", primaryError: safeCronError("lease_acquire_failed"), stopReason: "infrastructure_failure" });
    expect(() => assertCronResult(result, 25)).toThrow();
  });
});
