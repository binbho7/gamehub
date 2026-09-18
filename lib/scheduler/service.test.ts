import { describe, expect, it } from "vitest";
import { runBulkSyncBatch } from "../sync/batch";
import { stageError, type BulkSyncStages } from "../sync/stages";
import type { BulkGameSyncResult } from "../sync/types";
import { parseCronSyncConfig } from "./config";
import { FenceLostError, safeCronError } from "./errors";
import { runCronSync, type CronSyncDependencies } from "./service";
import type { CronGameRuntime, CronSignals } from "./types";

const input = { executionId: "execution-1", scheduledAt: new Date(0) };

function setup() {
  let elapsed = 0;
  const calls: string[] = [];
  const authority = { ownerToken: "11111111-1111-4111-8111-111111111111", fenceEpoch: 1, leaseExpiresAtMs: 1500000 };
  const stages: BulkSyncStages = {
    steam: { execute: async (appId) => { calls.push(`steam:${appId}`); return { gameId: Number(appId) / 10, action: "existing", summary: "existing" }; } },
    igdb: { execute: async (id) => { calls.push(`igdb:${id}`); return { summary: "existing" }; } },
    links: { execute: async (id) => { calls.push(`links:${id}`); return { summary: "verified" }; } },
    images: { execute: async (id) => { calls.push(`images:${id}`); return { summary: "ingested" }; } },
  };
  const deps: CronSyncDependencies = {
    config: parseCronSyncConfig({}), elapsedMs: () => elapsed, newOwnerToken: () => authority.ownerToken,
    lease: {
      acquire: async () => { calls.push("acquire"); return { status: "acquired", lease: authority }; },
      assertOwned: async () => { calls.push("assert"); return { dbNowMs: elapsed, leaseExpiresAtMs: 1500000 }; },
      release: async () => { calls.push("release"); return "released"; },
    },
    candidates: {
      select: async () => { calls.push("select"); return [{ gameId: 1, appId: "10" }, { gameId: 2, appId: "20" }]; },
      stillMatches: async (candidate) => { calls.push(`matches:${candidate.gameId}`); return true; },
    },
    state: {
      startAttempt: async (gameId, issued) => { calls.push(`start:${gameId}`); return { gameId, attemptedAt: new Date(0), authority: issued }; },
      finishAttempt: async (stamp, status) => { calls.push(`finish:${stamp.gameId}:${status}`); },
    },
    gameExists: async () => true, runBatch: runBulkSyncBatch,
    createGameRuntime: (_candidate, _authority, signals) => ({ stages, readAuthorityLoss: signals.readAuthorityLoss, readUnsettledImageWork: signals.readUnsettledImageWork }),
  };
  return { deps, stages, calls, setElapsed: (value: number) => { elapsed = value; } };
}

describe("runCronSync", () => {
  it("serializes full games between start and finish stamps", async () => {
    const { deps, calls } = setup();
    expect(await runCronSync(input, deps)).toMatchObject({ status: "completed", selected: 2, attempted: 2, succeeded: 2, failed: 0, notStarted: 0, stopReason: "none", leaseDisposition: "released", primaryError: null });
    expect(calls).toEqual(["acquire", "select", "assert", "matches:1", "start:1", "steam:10", "igdb:1", "links:1", "images:1", "finish:1:succeeded", "assert", "matches:2", "start:2", "steam:20", "igdb:2", "links:2", "images:2", "finish:2:succeeded", "release"]);
  });

  it("finishes an admitted game but leaves the next candidate unstarted", async () => {
    const { deps, stages, calls, setElapsed } = setup();
    stages.steam.execute = async (appId) => { calls.push(`steam:${appId}`); setElapsed(800000); return { gameId: 1, action: "existing", summary: "existing" }; };
    const result = await runCronSync(input, deps);
    expect(result).toMatchObject({ status: "partial", attempted: 1, notStarted: 1, stopReason: "soft_deadline", leaseDisposition: "released" });
    expect(result.games[0]!.stages.map((stage) => stage.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(calls.filter((call) => call.startsWith("steam:"))).toEqual(["steam:10"]);
  });

  it.each([
    { elapsed: 90000, dbNow: 0, expiry: 1500000, attempted: 2 },
    { elapsed: 90001, dbNow: 0, expiry: 1500000, attempted: 0 },
    { elapsed: 0, dbNow: 690000, expiry: 1500000, attempted: 2 },
    { elapsed: 0, dbNow: 690001, expiry: 1500000, attempted: 0 },
  ])("enforces wall and DB-issued lease reserves: %j", async ({ elapsed, dbNow, expiry, attempted }) => {
    const { deps, setElapsed } = setup();
    setElapsed(elapsed);
    deps.lease.assertOwned = async () => ({ dbNowMs: dbNow, leaseExpiresAtMs: expiry });
    expect(await runCronSync(input, deps)).toMatchObject({ attempted, notStarted: 2 - attempted, stopReason: attempted ? "none" : "soft_deadline" });
  });

  it("does not admit at the configured soft cutoff", async () => {
    const { deps, setElapsed } = setup();
    deps.config.softDeadlineMs = 100;
    setElapsed(100);
    expect(await runCronSync(input, deps)).toMatchObject({ status: "partial", attempted: 0, notStarted: 2, stopReason: "soft_deadline" });
  });

  it("completes an empty catalog and releases", async () => {
    const { deps } = setup();
    deps.candidates.select = async () => [];
    expect(await runCronSync(input, deps)).toMatchObject({ status: "completed", selected: 0, attempted: 0, notStarted: 0, leaseDisposition: "released" });
  });

  it("skips an active lease without querying candidates", async () => {
    const { deps, calls } = setup();
    deps.lease.acquire = async () => ({ status: "held" });
    expect(await runCronSync(input, deps)).toMatchObject({ status: "skipped", selected: 0, attempted: 0, stopReason: "active_lease", leaseDisposition: "not_acquired" });
    expect(calls).toEqual([]);
  });

  it.each(["configuration", "composition", "acquire", "select", "matches", "start", "finish", "pipeline"] as const)("handles %s failure safely", async (phase) => {
    const { deps, calls } = setup();
    const fail = async (): Promise<never> => { throw new Error("https://secret.example/token"); };
    if (phase === "configuration") deps.config.batchSize = 26;
    if (phase === "composition") deps.runBatch = undefined as unknown as typeof runBulkSyncBatch;
    if (phase === "acquire") deps.lease.acquire = fail;
    if (phase === "select") deps.candidates.select = fail;
    if (phase === "matches") deps.candidates.stillMatches = fail;
    if (phase === "start") deps.state.startAttempt = fail;
    if (phase === "finish") deps.state.finishAttempt = fail;
    if (phase === "pipeline") deps.runBatch = fail;
    const codes = { configuration: "configuration_error", composition: "composition_failed", acquire: "lease_acquire_failed", select: "candidate_read_failed", matches: "candidate_read_failed", start: "state_write_failed", finish: "state_write_failed", pipeline: "pipeline_contract_error" };
    const result = await runCronSync(input, deps);
    expect(result).toMatchObject({ status: "failed", primaryError: { code: codes[phase] }, attempted: ["finish", "pipeline"].includes(phase) ? 1 : 0, leaseDisposition: ["configuration", "composition", "acquire"].includes(phase) ? "not_acquired" : "released" });
    expect(result.games).toHaveLength(phase === "finish" ? 1 : 0);
    expect(calls).not.toContain("steam:20");
    expect(JSON.stringify(result)).not.toContain("secret.example");
  });

  it("preserves state conflict and an already validated successful game", async () => {
    const { deps } = setup();
    deps.state.finishAttempt = async () => { throw safeCronError("state_conflict"); };
    expect(await runCronSync(input, deps)).toMatchObject({ status: "failed", succeeded: 1, attempted: 1, notStarted: 1, primaryError: { code: "state_conflict" } });
  });

  it("finishes a failed game and continues with the next candidate", async () => {
    const { deps, stages, calls } = setup();
    stages.links.execute = async (id) => { if (id === 1) throw stageError("links", "verifier_service_unavailable"); return { summary: "verified" }; };
    const result = await runCronSync(input, deps);
    expect(result).toMatchObject({ status: "partial", attempted: 2, succeeded: 1, failed: 1, notStarted: 0, stopReason: "none", primaryError: null });
    expect(calls).toContain("finish:1:failed");
    expect(calls).toContain("finish:2:succeeded");
    expect(calls).not.toContain("images:1");
  });

  it.each([true, false])("handles lost mapping with game existence %s without provider work", async (exists) => {
    const { deps, calls } = setup();
    deps.candidates.stillMatches = async (candidate) => candidate.gameId !== 1;
    deps.gameExists = async () => exists;
    const result = await runCronSync(input, deps);
    expect(result).toMatchObject({ status: "partial", attempted: 2, succeeded: 1, failed: 1 });
    expect(result.games[0]).toMatchObject({ appId: "10", gameId: null, status: "failed", stages: [{ name: "steam", status: "failed", error: { code: "write_conflict" } }, { name: "igdb", status: "not_run" }, { name: "links", status: "not_run" }, { name: "images", status: "not_run" }] });
    expect(calls).not.toContain("steam:10");
    expect(calls.includes("start:1")).toBe(exists);
    expect(calls.includes("finish:1:failed")).toBe(exists);
  });

  it("does not fabricate a lost-mapping result when deletion races its stamp", async () => {
    const { deps } = setup();
    deps.candidates.stillMatches = async () => false;
    deps.state.startAttempt = async () => { throw safeCronError("state_write_failed"); };
    expect(await runCronSync(input, deps)).toMatchObject({ status: "failed", attempted: 0, games: [], notStarted: 2, primaryError: { code: "state_write_failed" } });
  });

  it.each(["wrongApp", "wrongGame", "dryRun", "extraGame", "stageOrder", "stageSkip", "publicError", "counts", "extraKey"])("rejects malformed singleton %s without inventing results", async (defect) => {
    const { deps, calls } = setup();
    deps.runBatch = async (batchInput) => {
      const result = await runBulkSyncBatch(batchInput);
      if (batchInput.appIds[0] === "10") return result;
      if (defect === "wrongApp") result.games[0]!.appId = "30";
      if (defect === "wrongGame") result.games[0]!.gameId = 9;
      if (defect === "dryRun") result.dryRun = true;
      if (defect === "extraGame") result.games.push(result.games[0]!);
      if (defect === "stageOrder") result.games[0]!.stages.reverse();
      if (defect === "stageSkip") result.games[0]!.stages[1] = { name: "igdb", status: "not_run", reason: "previous_stage_failed", summary: "Stage not run: previous_stage_failed." };
      if (defect === "publicError") result.games[0]!.stages[0] = { name: "steam", status: "failed", summary: "Stage failed.", error: { code: "arbitrary", message: "secret" } };
      if (defect === "counts") result.succeeded = 0;
      if (defect === "extraKey") Object.assign(result, { extra: true });
      return result;
    };
    const result = await runCronSync(input, deps);
    expect(result).toMatchObject({ status: "failed", attempted: 2, succeeded: 1, failed: 0, notStarted: 0, primaryError: { code: "pipeline_contract_error" } });
    expect(result.games).toHaveLength(1);
    expect(calls).not.toContain("finish:2:succeeded");
  });

  it("retains authority for uncertainty masked by an ordinary image failure", async () => {
    const { deps, stages, calls } = setup();
    deps.createGameRuntime = (_candidate, _authority, signals) => {
      stages.images.execute = async () => { signals.markUnsettled("image_mutation_unknown"); throw stageError("images", "source_rejected"); };
      return { stages, readAuthorityLoss: signals.readAuthorityLoss, readUnsettledImageWork: signals.readUnsettledImageWork };
    };
    expect(await runCronSync(input, deps)).toMatchObject({ status: "partial", attempted: 1, failed: 1, notStarted: 1, stopReason: "unsettled_remote_work", leaseDisposition: "retained_until_expiry", primaryError: null });
    expect(calls).toContain("finish:1:failed");
    expect(calls).not.toContain("release");
    expect(calls).not.toContain("steam:20");
  });

  it.each(["throw", "invalid"])("merges runtime latches even when pipeline %s prevents validation", async (mode) => {
    const { deps, stages, calls } = setup();
    deps.createGameRuntime = () => ({ stages, readAuthorityLoss: () => "fence_lost", readUnsettledImageWork: () => ["image_deadline"] });
    deps.runBatch = async () => { if (mode === "throw") throw new Error("pipeline"); return {} as BulkGameSyncResult; };
    const result = await runCronSync(input, deps);
    expect(result).toMatchObject({ status: "failed", attempted: 1, games: [], primaryError: { code: "pipeline_contract_error" }, secondaryErrors: [{ code: "fence_lost" }], stopReason: "authority_lost", leaseDisposition: "no_longer_owned" });
    expect(calls).not.toContain("release");
    expect(calls.some((call) => call.startsWith("finish:"))).toBe(false);
  });

  it("keeps uncertainty through a later finish failure", async () => {
    const { deps, stages, calls } = setup();
    deps.createGameRuntime = () => ({ stages, readAuthorityLoss: () => null, readUnsettledImageWork: () => ["image_deadline"] });
    deps.state.finishAttempt = async () => { throw new Error("state"); };
    expect(await runCronSync(input, deps)).toMatchObject({ status: "failed", succeeded: 1, primaryError: { code: "state_write_failed" }, stopReason: "infrastructure_failure", leaseDisposition: "retained_until_expiry" });
    expect(calls).not.toContain("release");
  });

  it("retains uncertainty through malformed singleton cleanup without loss", async () => {
    const { deps, stages, calls } = setup();
    deps.createGameRuntime = () => ({ stages, readAuthorityLoss: () => null, readUnsettledImageWork: () => ["image_deadline"] });
    deps.runBatch = async () => ({} as BulkGameSyncResult);
    expect(await runCronSync(input, deps)).toMatchObject({ status: "failed", attempted: 1, games: [], primaryError: { code: "pipeline_contract_error" }, secondaryErrors: [], stopReason: "infrastructure_failure", leaseDisposition: "retained_until_expiry" });
    expect(calls).not.toContain("release");
  });

  it("fails closed on invalid DB ownership timing without starting providers", async () => {
    const { deps, calls } = setup();
    deps.lease.assertOwned = async () => ({ dbNowMs: NaN, leaseExpiresAtMs: 1500000 });
    expect(await runCronSync(input, deps)).toMatchObject({ status: "failed", attempted: 0, primaryError: { code: "lease_lost" }, stopReason: "authority_lost", leaseDisposition: "no_longer_owned" });
    expect(calls).not.toContain("steam:10");
    expect(calls).not.toContain("release");
  });

  it.each(["admission", "start", "finish"])("stops on %s authority loss without release or further candidates", async (phase) => {
    const { deps, calls } = setup();
    if (phase === "admission") deps.lease.assertOwned = async () => { throw safeCronError("lease_lost"); };
    if (phase === "start") deps.state.startAttempt = async () => { throw new FenceLostError(); };
    if (phase === "finish") deps.state.finishAttempt = async () => { throw new FenceLostError(); };
    expect(await runCronSync(input, deps)).toMatchObject({ status: "failed", attempted: phase === "finish" ? 1 : 0, stopReason: "authority_lost", leaseDisposition: "no_longer_owned", primaryError: { code: phase === "admission" ? "lease_lost" : "fence_lost" } });
    expect(calls).not.toContain("steam:20");
    expect(calls).not.toContain("release");
  });

  it("observes a stage loss signal before metadata finish", async () => {
    const { deps, stages, calls } = setup();
    deps.createGameRuntime = (_candidate, _authority, signals) => {
      stages.igdb.execute = async () => { signals.markAuthorityLoss("fence_lost"); throw stageError("igdb", "write_failed"); };
      return { stages, readAuthorityLoss: signals.readAuthorityLoss, readUnsettledImageWork: signals.readUnsettledImageWork };
    };
    expect(await runCronSync(input, deps)).toMatchObject({ status: "failed", attempted: 1, failed: 1, stopReason: "authority_lost", leaseDisposition: "no_longer_owned", primaryError: { code: "fence_lost" } });
    expect(calls).not.toContain("links:1");
    expect(calls).not.toContain("finish:1:failed");
    expect(calls).not.toContain("release");
  });

  it.each([false, true])("retains the first fatal error on release failure, earlier=%s", async (earlier) => {
    const { deps } = setup();
    if (earlier) deps.candidates.select = async () => { throw new Error("query"); };
    deps.lease.release = async () => { throw new Error("release secret"); };
    const result = await runCronSync(input, deps);
    expect(result).toMatchObject({ status: "failed", primaryError: { code: earlier ? "candidate_read_failed" : "lease_release_failed" }, leaseDisposition: "retained_until_expiry", stopReason: "infrastructure_failure" });
    expect(result.secondaryErrors.map((error) => error.code)).toEqual(earlier ? ["lease_release_failed"] : []);
  });

  it.each([false, true])("records expired release as loss, earlier=%s", async (earlier) => {
    const { deps } = setup();
    if (earlier) deps.candidates.select = async () => { throw new Error("query"); };
    deps.lease.release = async () => "fence_lost";
    const result = await runCronSync(input, deps);
    expect(result).toMatchObject({ status: "failed", primaryError: { code: earlier ? "candidate_read_failed" : "fence_lost" }, leaseDisposition: "no_longer_owned", stopReason: "authority_lost" });
    expect(result.secondaryErrors.map((error) => error.code)).toEqual(earlier ? ["fence_lost"] : []);
  });

  it("merges shared latches when runtime construction throws", async () => {
    const { deps, calls } = setup();
    deps.createGameRuntime = (_candidate, _authority, signals: CronSignals): CronGameRuntime => { signals.markUnsettled("image_delivery_unknown"); throw new Error("construction"); };
    expect(await runCronSync(input, deps)).toMatchObject({ status: "failed", primaryError: { code: "composition_failed" }, leaseDisposition: "retained_until_expiry" });
    expect(calls).not.toContain("release");
  });
});
