import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSchedulerD1Fixture, type SchedulerD1Fixture } from "../scheduler/test-support/local-d1";
import { createRunRepository } from "./run-repository";
import { deriveRunId } from "./canonical";
import type { InputManifest } from "./contracts";

const manifest = (policyVersion: string, count = 2): InputManifest => ({ manifestVersion: "1", pipelineVersion: "2.10",
  policyVersion, snapshotDate: "2026-09-19", items: Array.from({ length: count }, (_, i) => ({ ordinal: i + 1, steamAppId: String(i + 100) })) });

describe("pipeline repository on isolated D1", () => {
  let fixture: SchedulerD1Fixture;
  let repository: ReturnType<typeof createRunRepository>;
  beforeAll(async () => {
    fixture = await createSchedulerD1Fixture();
    await fixture.applyV210();
    await fixture.binding.prepare("INSERT INTO games(id,slug,title) VALUES(701,'pipeline-fixture','Pipeline Fixture')").run();
    repository = createRunRepository(fixture.binding);
  }, 60_000);
  afterAll(async () => { await fixture?.dispose(); });

  it("atomically admits 1000 items in one bounded batch and identical create never rewrites", async () => {
    const batch = vi.fn();
    const prepare = vi.fn((sql: string) => fixture.binding.prepare(sql));
    const measured = createRunRepository({
      batch<T>(statements: D1PreparedStatement[]) { batch(statements); return fixture.binding.batch<T>(statements); },
      prepare,
    });
    const input = manifest("max", 1000);
    const before = await fixture.dump();
    const snapshot = await measured.create(input, 100);
    expect(batch).toHaveBeenCalledTimes(1);
    for (const [sql] of prepare.mock.calls) expect((sql.match(/\?/g) ?? []).length).toBeLessThanOrEqual(80);
    expect(snapshot.items).toHaveLength(1000);
    expect(snapshot.items[999]).toMatchObject({ ordinal: 1000, steam_app_id: "1099", current_stage: "import", current_state: "pending", game_id: null });
    const states = JSON.parse(snapshot.items[0].stage_states_json);
    expect(Object.keys(states)).toEqual(["discover", "import", "enrich", "verify", "images", "evaluate"]);
    expect(states.discover.state).toBe("succeeded");
    expect(snapshot.run).toMatchObject({ status: "created", current_stage: null, artifact_sha256: null });
    expect(Object.keys(JSON.parse(snapshot.run.run_stage_states_json))).toEqual(["export", "preview", "publish-ready"]);
    const after = await fixture.dump();
    for (const table of Object.keys(before).filter((key) => !key.startsWith("pipeline_"))) expect(after[table]).toEqual(before[table]);
    expect(await repository.create(input, 200)).toEqual(snapshot);
    expect(await fixture.dump()).toEqual(after);
  }, 60_000);
  it("rolls back the run and every earlier item statement if a later insert fails", async () => {
    await fixture.binding.prepare(`CREATE TRIGGER reject_pipeline_item BEFORE INSERT ON pipeline_run_items
      WHEN NEW.ordinal=17 AND (SELECT count(*) FROM pipeline_run_items WHERE run_id=NEW.run_id)=16
      BEGIN SELECT RAISE(ABORT,'injected failure after first chunk'); END`).run();
    try {
      const input = manifest("rollback", 20);
      await expect(repository.create(input, 100)).rejects.toThrow(/injected failure after first chunk/);
      expect(await fixture.binding.prepare("SELECT * FROM pipeline_runs WHERE run_id=?").bind(deriveRunId(input)).first()).toBeNull();
      expect((await fixture.binding.prepare("SELECT * FROM pipeline_run_items WHERE run_id=?").bind(deriveRunId(input)).all()).results).toEqual([]);
    } finally { await fixture.binding.prepare("DROP TRIGGER reject_pipeline_item").run(); }
  });
  it.each([
    "UPDATE pipeline_runs SET policy_version='other' WHERE run_id=?",
    "UPDATE pipeline_runs SET snapshot_date='2026-09-18' WHERE run_id=?",
    "UPDATE pipeline_runs SET manifest_hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE run_id=?",
    "DELETE FROM pipeline_run_items WHERE run_id=? AND ordinal=2",
    "UPDATE pipeline_run_items SET steam_app_id='999' WHERE run_id=? AND ordinal=2",
    "UPDATE pipeline_run_items SET ordinal=3 WHERE run_id=? AND ordinal=2",
  ])("rejects mismatched stored scope: %s", async (sql) => {
    const input = manifest(`scope-${Math.abs(sql.split('').reduce((n, c) => (n * 31 + c.charCodeAt(0)) | 0, 0))}`);
    await repository.create(input, 100);
    await fixture.binding.prepare(sql).bind(deriveRunId(input)).run();
    await expect(repository.create(input, 200)).rejects.toThrow();
  });
  it("rejects malformed histories on load", async () => {
    const snapshot = await repository.create(manifest("malformed"), 100);
    await fixture.binding.prepare("UPDATE pipeline_run_items SET stage_states_json='{}' WHERE run_id=?").bind(snapshot.run.run_id).run();
    await expect(repository.load(snapshot.run.run_id)).rejects.toThrow();
  });
  it("uses full-snapshot CAS, rejects stale item and run updates, and preserves reconciled success bytes", async () => {
    const snapshot = await repository.create(manifest("cas"), 100);
    const running = await repository.transitionRun(snapshot.run, { type: "start" }, 100);
    await expect(repository.transitionRun(snapshot.run, { type: "start" }, 100)).rejects.toThrow(/conflict/);
    const item = snapshot.items[0];
    const started = await repository.transitionItem(item, "import", { type: "start" }, 100);
    await expect(repository.transitionItem(item, "import", { type: "start" }, 100)).rejects.toThrow(/conflict/);
    const done = await repository.transitionItem(started.item, "import", { type: "succeed", gameId: 701 }, 100);
    const before = await fixture.dump();
    const reconciled = await repository.transitionItem(done.item, "import", { type: "reconcile", result: "consistent" }, 500);
    expect(reconciled.action).toBe("skip_execution");
    expect(reconciled.item).toEqual(done.item);
    expect(await fixture.dump()).toEqual(before);
    await repository.transitionItem(done.item, "import", { type: "refresh" }, 500);
    await expect(repository.transitionItem(done.item, "import", { type: "reconcile", result: "consistent" }, 500)).rejects.toThrow(/conflict/);
    expect((await repository.transitionRun(running, { type: "pause" }, 100)).status).toBe("paused");
  });
  it("persists a consistent interrupted import reconciliation as durable success", async () => {
    const snapshot = await repository.create(manifest("interrupted-import", 1), 100);
    let item = (await repository.transitionItem(snapshot.items[0], "import", { type: "start" }, 101)).item;
    item = (await repository.transitionItem(item, "import", { type: "recover_stale" }, 102)).item;
    const reconciled = await repository.transitionItem(item, "import", { type: "reconcile", result: "consistent", gameId: 701 }, 103);
    expect(reconciled.action).toBe("skip_execution");
    expect(reconciled.item).toMatchObject({ game_id: 701, current_stage: "enrich", current_state: "pending" });
    expect(JSON.parse(reconciled.item.stage_states_json).import).toMatchObject({ state: "succeeded", reasonCode: null, retryClass: "none" });
    expect((await repository.load(snapshot.run.run_id)).items[0]).toEqual(reconciled.item);
  });

  it("persists retry exhaustion without changing the artifact hash", async () => {
    const input = manifest("retry-exhausted", 1);
    const snapshot = await repository.create(input, 100);
    let run = await repository.transitionRun(snapshot.run, { type: "start" }, 101);
    run = await repository.admitExport(run, { selectionVersion: "1", pipelineVersion: "2.10", policyVersion: input.policyVersion,
      snapshotDate: "2026-09-19", manifestHash: run.manifest_hash, items: [{ steamAppId: "100", decision: "include" }] }, [], 102).catch(() => run);
    // Establish an exported artifact before exercising a later run-level stage.
    if (run.current_stage === null) {
      let item = snapshot.items[0];
      for (const stage of ["import", "enrich", "verify", "images", "evaluate"] as const) {
        item = (await repository.transitionItem(item, stage, { type: "start" }, 102)).item;
        item = (await repository.transitionItem(item, stage, stage === "import" ? { type: "succeed", gameId: 701 } : { type: "succeed" }, 102)).item;
      }
      run = await repository.admitExport(run, { selectionVersion: "1", pipelineVersion: "2.10", policyVersion: input.policyVersion,
        snapshotDate: "2026-09-19", manifestHash: run.manifest_hash, items: [{ steamAppId: "100", decision: "include" }] }, [item], 103);
    }
    run = await repository.transitionRun(run, { type: "start_stage" }, 104);
    run = await repository.transitionRun(run, { type: "succeed", artifactSha256: "a".repeat(64) }, 105);
    run = await repository.transitionRun(run, { type: "start_stage" }, 106);
    for (let attempt = 1; attempt <= 3; attempt++) {
      run = await repository.transitionRun(run, { type: "pause" }, 106 + attempt);
      if (attempt < 3) run = await repository.transitionRun(run, { type: "resume" }, 110 + attempt);
    }
    run = await repository.transitionRun(run, { type: "retry_exhausted", reasonCode: "retry_exhausted" }, 114);
    const reloaded = await repository.load(snapshot.run.run_id);
    const preview = JSON.parse(reloaded.run.run_stage_states_json).preview;
    expect(reloaded.run.status).toBe("failed");
    expect(preview).toMatchObject({ state: "permanently_failed", attemptCount: 3, reasonCode: "retry_exhausted", retryClass: "run_fatal" });
    expect(reloaded.run.artifact_sha256).toBe("a".repeat(64));
  });
  it("export requires exact reviewed selection and current durable evaluations and writes only run ledger", async () => {
    const input = manifest("export");
    const snapshot = await repository.create(input, 100);
    let run = await repository.transitionRun(snapshot.run, { type: "start" }, 101);
    const selection = { selectionVersion: "1", pipelineVersion: "2.10", policyVersion: input.policyVersion,
      snapshotDate: input.snapshotDate, manifestHash: run.manifest_hash,
      items: [{ steamAppId: "100", decision: "include" }, { steamAppId: "101", decision: "exclude" }] };
    await expect(repository.admitExport(run, selection, [snapshot.items[0]], 102)).rejects.toThrow();
    let item = snapshot.items[0];
    for (const stage of ["import", "enrich", "verify", "images", "evaluate"] as const) {
      item = (await repository.transitionItem(item, stage, { type: "start" }, 102)).item;
      item = (await repository.transitionItem(item, stage, stage === "import" ? { type: "succeed", gameId: 701 } : { type: "succeed" }, 102)).item;
    }
    await expect(repository.admitExport(run, { ...selection, snapshotDate: "2026-09-18" }, [item], 103)).rejects.toThrow();
    await expect(repository.admitExport(run, selection, [], 103)).rejects.toThrow();
    const before = (await repository.load(run.run_id)).items;
    run = await repository.admitExport(run, selection, [item], 103);
    expect((await repository.load(run.run_id)).items).toEqual(before);
    for (const stage of ["export", "preview", "publish-ready"] as const) {
      expect(run.current_stage).toBe(stage);
      run = await repository.transitionRun(run, { type: "start_stage" }, 104);
      run = await repository.transitionRun(run, { type: "succeed", artifactSha256: "a".repeat(64) }, 105);
    }
    expect(run.status).toBe("ready");
    expect(run.artifact_sha256).toBe("a".repeat(64));
    expect((await repository.load(run.run_id)).items).toEqual(before);
  });
  it("completes export in one repository CAS transition", async () => {
    const input = manifest("atomic-export", 1);
    const snapshot = await repository.create(input, 100);
    const running = await repository.transitionRun(snapshot.run, { type: "start" }, 101);
    let item = snapshot.items[0];
    for (const stage of ["import", "enrich", "verify", "images", "evaluate"] as const) {
      item = (await repository.transitionItem(item, stage, { type: "start" }, 102)).item;
      item = (await repository.transitionItem(item, stage, stage === "import" ? { type: "succeed", gameId: 701 } : { type: "succeed" }, 102)).item;
    }
    const prepared = await repository.admitExport(running, { selectionVersion: "1", pipelineVersion: "2.10", policyVersion: input.policyVersion,
      snapshotDate: input.snapshotDate, manifestHash: running.manifest_hash, items: [{ steamAppId: "100", decision: "include" }] }, [item], 102);
    const completed = await repository.completeExport(prepared, {}, "a".repeat(64), 103);
    expect(completed.current_stage).toBe("preview");
    expect(JSON.parse(completed.run_stage_states_json).export.state).toBe("succeeded");
  });
  it("rejects stale evaluation evidence instead of manufacturing success", async () => {
    const snapshot = await repository.create(manifest("stale-evaluation", 1), 100);
    const run = await repository.transitionRun(snapshot.run, { type: "start" }, 101);
    let item = snapshot.items[0];
    for (const stage of ["import", "enrich", "verify", "images", "evaluate"] as const) {
      item = (await repository.transitionItem(item, stage, { type: "start" }, 102)).item;
      item = (await repository.transitionItem(item, stage, stage === "import" ? { type: "succeed", gameId: 701 } : { type: "succeed" }, 102)).item;
    }
    await repository.transitionItem(item, "evaluate", { type: "refresh" }, 103);
    await expect(repository.admitExport(run, { selectionVersion: "1", pipelineVersion: "2.10", policyVersion: "stale-evaluation",
      snapshotDate: "2026-09-19", manifestHash: run.manifest_hash, items: [{ steamAppId: "100", decision: "include" }] }, [item], 104)).rejects.toThrow(/conflict/);
    expect((await repository.load(run.run_id)).run.current_stage).toBeNull();
  });
  it("persists an import game ID atomically and rejects stale game identity changes", async () => {
    const snapshot = await repository.create(manifest("game-id", 1), 100);
    const started = await repository.transitionItem(snapshot.items[0], "import", { type: "start" }, 101);
    const done = await repository.transitionItem(started.item, "import", { type: "succeed", gameId: 701 }, 102);
    expect(done.item.game_id).toBe(701);
    await fixture.binding.prepare("UPDATE pipeline_run_items SET game_id=NULL WHERE run_id=?").bind(snapshot.run.run_id).run();
    await expect(repository.transitionItem(done.item, "enrich", { type: "start" }, 103)).rejects.toThrow(/conflict/);
  });
  it("rejects import success without supplied or existing identity without a write", async () => {
    const snapshot = await repository.create(manifest("missing-identity", 1), 100);
    const started = await repository.transitionItem(snapshot.items[0], "import", { type: "start" }, 101);
    await expect(repository.transitionItem(started.item, "import", { type: "succeed" }, 102)).rejects.toThrow(/identity/);
    expect((await repository.load(snapshot.run.run_id)).items[0]).toEqual(started.item);
  });
  it("retains an existing valid game identity when a refreshed import succeeds without gameId", async () => {
    const snapshot = await repository.create(manifest("existing-identity", 1), 100);
    let item = (await repository.transitionItem(snapshot.items[0], "import", { type: "start" }, 101)).item;
    item = (await repository.transitionItem(item, "import", { type: "succeed", gameId: 701 }, 102)).item;
    item = (await repository.transitionItem(item, "import", { type: "refresh" }, 103)).item;
    item = (await repository.transitionItem(item, "import", { type: "start" }, 104)).item;
    item = (await repository.transitionItem(item, "import", { type: "succeed" }, 105)).item;
    expect(item.game_id).toBe(701);
    expect(JSON.parse(item.stage_states_json).import.state).toBe("succeeded");
  });

  it("fails closed on uncertain completion without a second provider write", async () => {
    const snapshot = await repository.create(manifest("uncertain", 1), 100);
    const started = await repository.transitionItem(snapshot.items[0], "import", { type: "start" }, 101);
    const failed = await repository.transitionItem(started.item, "import", { type: "fail", retryClass: "retryable", reasonCode: "steam_timeout" }, 102);
    await expect(repository.reconcileUncertain(failed.item, "import", 103)).rejects.toThrow(/uncertain reconciliation unavailable/);
    expect((await repository.load(snapshot.run.run_id)).items[0]).toEqual(failed.item);
  });

  it("persists requeue as a refresh transition", async () => {
    const snapshot = await repository.create(manifest("requeue", 1), 100);
    const started = await repository.transitionItem(snapshot.items[0], "import", { type: "start" }, 101);
    const failed = await repository.transitionItem(started.item, "import", { type: "fail", retryClass: "retryable", reasonCode: "steam_timeout" }, 102);
    const requeued = await repository.requeueItem(failed.item, "import", 103);
    expect(requeued.item.current_state).toBe("pending");
    expect((await repository.load(snapshot.run.run_id)).items[0].current_state).toBe("pending");
  });
  it.each(["import", "enrich", "verify", "images", "evaluate"] as const)("rejects durable %s success without game identity, including stale downstream history", async (lastStage) => {
    const snapshot = await repository.create(manifest(`null-${lastStage}`, 1), 100);
    let item = snapshot.items[0];
    for (const stage of ["import", "enrich", "verify", "images", "evaluate"] as const) {
      item = (await repository.transitionItem(item, stage, { type: "start" }, 101)).item;
      item = (await repository.transitionItem(item, stage, stage === "import" ? { type: "succeed", gameId: 701 } : { type: "succeed" }, 102)).item;
      if (stage === lastStage) break;
    }
    if (lastStage !== "import") item = (await repository.transitionItem(item, "import", { type: "reconcile", result: "missing" }, 103)).item;
    await fixture.binding.prepare("UPDATE pipeline_run_items SET game_id=NULL WHERE run_id=?").bind(snapshot.run.run_id).run();
    await expect(repository.load(snapshot.run.run_id)).rejects.toThrow(/identity/);
    await expect(repository.transitionItem({ ...item, game_id: null }, lastStage, { type: "reconcile", result: "consistent" }, 104)).rejects.toThrow(/identity/);
  });
  it.each([
    { export: "pending", preview: "succeeded", "publish-ready": "pending" },
    { export: "pending", preview: "pending", "publish-ready": "succeeded" },
  ])("rejects out-of-order run history %j", async (states) => {
    const snapshot = await repository.create(manifest(`history-${states.preview}`, 1), 100);
    const history = Object.fromEntries(Object.entries(states).map(([key, state]) => [key,
      { state, attemptCount: state === "succeeded" ? 1 : 0, reasonCode: null, retryClass: "none" }]));
    await fixture.binding.prepare("UPDATE pipeline_runs SET run_stage_states_json=? WHERE run_id=?")
      .bind(JSON.stringify(history), snapshot.run.run_id).run();
    await expect(repository.load(snapshot.run.run_id)).rejects.toThrow();
  });
});
