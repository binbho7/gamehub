import { z } from "zod";
import { hashManifest, deriveRunId } from "./canonical";
import { parseInputManifest, parsePublicationSelection } from "./contracts";
import { ITEM_STAGES, RUN_STAGES, initialItemStages, initialRunStages, parseItemStages, parseRunStages,
  serializeItemStages, serializeRunStages, type ItemStage, type RunState } from "./state";
import { transitionItem, transitionRun, type ItemEvent, type RunEvent } from "./transitions";

const stamp = z.number().int().nonnegative().safe();
const runSchema = z.object({
  run_id: z.string().regex(/^pipeline-v2\.10:[0-9a-f]{64}$/),
  manifest_hash: z.string().regex(/^[0-9a-f]{64}$/),
  pipeline_version: z.literal("2.10"), policy_version: z.string(), snapshot_date: z.string(),
  status: z.enum(["created", "running", "paused", "failed", "ready"]),
  current_stage: z.enum(RUN_STAGES).nullable(), run_stage_states_json: z.string(),
  artifact_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(), created_at: stamp, updated_at: stamp,
}).strict();
const itemSchema = z.object({
  run_id: z.string(), ordinal: z.number().int().positive(), steam_app_id: z.string().regex(/^[1-9][0-9]*$/),
  game_id: z.number().int().positive().safe().nullable(), current_stage: z.enum(ITEM_STAGES),
  current_state: z.enum(["pending", "running", "succeeded", "retryable_failed", "permanently_failed", "blocked", "skipped"]),
  attempt_count: z.number().int().min(0).max(3), stage_states_json: z.string(), reason_code: z.string().nullable(),
  retry_class: z.enum(["none", "retryable", "permanent", "blocked", "run_fatal"]).nullable(), updated_at: stamp,
}).strict();
export type RunRow = z.infer<typeof runSchema>;
export type ItemRow = z.infer<typeof itemSchema>;
export type RunSnapshot = { run: RunRow; items: ItemRow[] };
export type RetryItemPlan = { expected: ItemRow; stage: ItemStage; events: ItemEvent[] };

function checkedRun(value: unknown): RunRow {
  const row = runSchema.parse(value);
  if (row.run_id !== `pipeline-v2.10:${row.manifest_hash}` || row.updated_at < row.created_at) throw new Error("invalid run scope");
  const stages = parseRunStages(row.run_stage_states_json);
  for (const key of RUN_STAGES) {
    if (stages[key].state === "running" && (row.current_stage !== key || row.status !== "running")) throw new Error("invalid run history");
    if (stages[key].state !== "pending" && RUN_STAGES.slice(0, RUN_STAGES.indexOf(key))
      .some((earlier) => stages[earlier].state !== "succeeded")) throw new Error("invalid run stage order");
  }
  if ((stages.export.state === "succeeded") !== (row.artifact_sha256 !== null)) throw new Error("invalid artifact history");
  if (row.status === "ready" && RUN_STAGES.some((key) => stages[key].state !== "succeeded")) throw new Error("invalid ready history");
  return row;
}
function checkedItem(value: unknown): ItemRow {
  const row = itemSchema.parse(value);
  const stages = parseItemStages(row.stage_states_json);
  // Admission alone needs no identity; import and every dependent success do.
  // Apply this on reads and before CAS writes, including reconciliation no-ops.
  if (row.game_id === null && ITEM_STAGES.slice(1).some((stage) => stages[stage].state === "succeeded")) {
    throw new Error("successful item history requires game identity");
  }
  const current = stages[row.current_stage];
  if (current.state !== row.current_state || current.attemptCount !== row.attempt_count
    || current.reasonCode !== row.reason_code || current.retryClass !== row.retry_class) throw new Error("invalid indexed item history");
  for (const [index, key] of ITEM_STAGES.entries()) {
    if (stages[key].state === "skipped" && !ITEM_STAGES.slice(0, index).some((earlier) =>
      stages[earlier].state === "permanently_failed" || stages[earlier].state === "blocked")) throw new Error("invalid skipped history");
  }
  return row;
}
function scope(snapshot: RunSnapshot) {
  const manifest = parseInputManifest({ manifestVersion: "1", pipelineVersion: snapshot.run.pipeline_version,
    policyVersion: snapshot.run.policy_version, snapshotDate: snapshot.run.snapshot_date,
    items: snapshot.items.map((item) => ({ ordinal: item.ordinal, steamAppId: item.steam_app_id })) });
  if (hashManifest(manifest) !== snapshot.run.manifest_hash || deriveRunId(manifest) !== snapshot.run.run_id
    || snapshot.items.some((item) => item.run_id !== snapshot.run.run_id)) throw new Error("stored scope mismatch");
  return manifest;
}
function nextStamp(now: number, previous: number) {
  return stamp.parse(Math.max(stamp.parse(now), previous + 1));
}
function asRunState(row: RunRow): RunState {
  return { status: row.status, currentStage: row.current_stage, stages: parseRunStages(row.run_stage_states_json), artifactSha256: row.artifact_sha256 };
}
// Column names come only from strict schemas above; values remain bound parameters.
function predicate(row: RunRow | ItemRow) {
  return Object.keys(row).map((key) => `${key} IS ?`).join(" AND ");
}
function conflict(): never { throw new Error("pipeline state conflict"); }

export function createRunRepository(binding: Pick<D1Database, "prepare" | "batch">) {
  async function load(runId: string): Promise<RunSnapshot> {
    const run = checkedRun(await binding.prepare("SELECT * FROM pipeline_runs WHERE run_id=?").bind(runId).first());
    const result = await binding.prepare("SELECT * FROM pipeline_run_items WHERE run_id=? ORDER BY ordinal").bind(runId).all();
    const snapshot = { run, items: result.results.map(checkedItem) };
    scope(snapshot);
    return snapshot;
  }
  async function saveRun(expected: RunRow, event: RunEvent, now: number, evidence?: ItemRow[]): Promise<RunRow> {
    const old = checkedRun(expected);
    const next = transitionRun(asRunState(old), event);
    const row = checkedRun({ ...old, status: next.status, current_stage: next.currentStage,
      run_stage_states_json: serializeRunStages(next.stages), artifact_sha256: next.artifactSha256, updated_at: nextStamp(now, old.updated_at) });
    // A single JSON parameter keeps admission below the bind budget even for 1000 includes.
    // Compare every reconciled item column in the same UPDATE that admits export.
    const guard = evidence ? ` AND NOT EXISTS (
      SELECT 1 FROM json_each(?) AS evidence WHERE NOT EXISTS (
        SELECT 1 FROM pipeline_run_items AS item WHERE ${Object.keys(itemSchema.shape).map((key) =>
          `item.${key} IS json_extract(evidence.value,'$.${key}')`).join(" AND ")}
      ))` : "";
    const result = await binding.prepare(`UPDATE pipeline_runs SET status=?,current_stage=?,run_stage_states_json=?,artifact_sha256=?,updated_at=?
      WHERE ${predicate(old)}${guard} RETURNING *`).bind(row.status, row.current_stage, row.run_stage_states_json,
      row.artifact_sha256, row.updated_at, ...Object.values(old), ...(evidence ? [JSON.stringify(evidence)] : [])).all();
    if (result.results.length !== 1) conflict();
    return checkedRun(result.results[0]);
  }
  return {
    load,
    async create(value: unknown, now: number): Promise<RunSnapshot> {
      const manifest = parseInputManifest(value);
      const runId = deriveRunId(manifest);
      stamp.parse(now);
      if (await binding.prepare("SELECT run_id FROM pipeline_runs WHERE run_id=?").bind(runId).first()) return load(runId);
      const statements = [binding.prepare(`INSERT INTO pipeline_runs
        (run_id,manifest_hash,pipeline_version,policy_version,snapshot_date,status,current_stage,run_stage_states_json,artifact_sha256,created_at,updated_at)
        VALUES(?,?,?,?,?,'created',NULL,?,NULL,?,?)`).bind(runId, hashManifest(manifest), manifest.pipelineVersion,
        manifest.policyVersion, manifest.snapshotDate, serializeRunStages(initialRunStages()), now, now)];
      // 5 binds per row; 16 rows per statement; ONE atomic batch, never one batch per chunk.
      for (let offset = 0; offset < manifest.items.length; offset += 16) {
        const chunk = manifest.items.slice(offset, offset + 16);
        statements.push(binding.prepare(`INSERT INTO pipeline_run_items
          (run_id,ordinal,steam_app_id,game_id,current_stage,current_state,attempt_count,stage_states_json,reason_code,retry_class,updated_at)
          VALUES ${chunk.map(() => "(?,?,?,NULL,'import','pending',0,?,NULL,'none',?)").join(",")}`)
          .bind(...chunk.flatMap((item) => [runId, item.ordinal, item.steamAppId, serializeItemStages(initialItemStages()), now])));
      }
      try {
        await binding.batch(statements);
      } catch (error) {
        // A concurrent identical creator may have won. Never repair partial/mismatched scope.
        if (!await binding.prepare("SELECT run_id FROM pipeline_runs WHERE run_id=?").bind(runId).first()) throw error;
      }
      return load(runId);
    },
    async transitionItem(expected: ItemRow, stage: ItemStage, event: ItemEvent, now: number) {
      const old = checkedItem(expected);
      const oldStages = parseItemStages(old.stage_states_json);
      const next = transitionItem(oldStages, stage, event);
      if (next.action === "skip_execution" && oldStages[stage].state === "succeeded") {
        const stored = await binding.prepare(`SELECT * FROM pipeline_run_items WHERE ${predicate(old)}`).bind(...Object.values(old)).first();
        if (!stored) conflict();
        return { item: checkedItem(stored), action: next.action };
      }
      const current = next.stages[next.currentStage];
      // transitionItem has validated the evidence. Only successful import
      // evidence may supply identity, committed with its history in the same CAS.
      let gameId = old.game_id;
      if (stage === "import" && (event.type === "succeed"
        || (event.type === "reconcile" && event.result === "consistent")) && event.gameId !== undefined) {
        gameId = event.gameId;
      }
      const row = checkedItem({ ...old, current_stage: next.currentStage, current_state: current.state,
        game_id: gameId,
        attempt_count: current.attemptCount, stage_states_json: serializeItemStages(next.stages),
        reason_code: current.reasonCode, retry_class: current.retryClass, updated_at: nextStamp(now, old.updated_at) });
      const result = await binding.prepare(`UPDATE pipeline_run_items
        SET current_stage=?,current_state=?,attempt_count=?,stage_states_json=?,reason_code=?,retry_class=?,updated_at=?,game_id=?
        WHERE ${predicate(old)} RETURNING *`).bind(row.current_stage, row.current_state, row.attempt_count,
        row.stage_states_json, row.reason_code, row.retry_class, row.updated_at, row.game_id, ...Object.values(old)).all();
      if (result.results.length !== 1) conflict();
      return { item: checkedItem(result.results[0]), action: next.action };
    },
    async commitRetryPlan(plans: RetryItemPlan[], now: number): Promise<ItemRow[]> {
      if (plans.length === 0) return [];
      const identities = new Set(plans.map(({ expected }) => `${expected.run_id}:${expected.ordinal}`));
      if (identities.size !== plans.length || plans.some(({ expected, stage, events }) =>
        checkedItem(expected).current_stage !== stage || events.length === 0)) throw new Error("invalid retry plan");
      const targets = plans.map(({ expected, stage, events }) => {
        const old = checkedItem(expected);
        let stages = parseItemStages(old.stage_states_json);
        let gameId = old.game_id;
        for (const event of events) {
          const next = transitionItem(stages, stage, event);
          if (stage === "import" && event.type === "reconcile" && event.result === "consistent" && event.gameId !== undefined) gameId = event.gameId;
          stages = next.stages;
        }
        const currentStage = ITEM_STAGES.find((key) => stages[key].state !== "succeeded") ?? "evaluate";
        const current = stages[currentStage];
        return checkedItem({ ...old, current_stage: currentStage, current_state: current.state, game_id: gameId,
          attempt_count: current.attemptCount, stage_states_json: serializeItemStages(stages), reason_code: current.reasonCode,
          retry_class: current.retryClass, updated_at: nextStamp(now, old.updated_at) });
      });
      const payload = JSON.stringify(plans.map(({ expected }, index) => ({ expected, target: targets[index] })));
      const expectedPredicate = Object.keys(itemSchema.shape).map((key) =>
        `item.${key} IS json_extract(plan.value,'$.expected.${key}')`).join(" AND ");
      const target = (key: string) => `json_extract((SELECT value FROM plan WHERE ordinal=pipeline_run_items.ordinal),'$.target.${key}')`;
      const result = await binding.prepare(`WITH plan AS MATERIALIZED (
          SELECT value,json_extract(value,'$.expected.ordinal') AS ordinal FROM json_each(?)
        ), valid AS MATERIALIZED (
          SELECT count(*) AS matched FROM plan WHERE EXISTS (
            SELECT 1 FROM pipeline_run_items AS item WHERE ${expectedPredicate}
          )
        )
        UPDATE pipeline_run_items SET
          current_stage=${target("current_stage")},current_state=${target("current_state")},attempt_count=${target("attempt_count")},
          stage_states_json=${target("stage_states_json")},reason_code=${target("reason_code")},retry_class=${target("retry_class")},
          updated_at=${target("updated_at")},game_id=${target("game_id")}
        WHERE run_id=? AND ordinal IN (SELECT ordinal FROM plan)
          AND (SELECT matched FROM valid)=(SELECT count(*) FROM plan)
        RETURNING *`).bind(payload, plans[0]!.expected.run_id).all();
      if (result.results.length !== plans.length) conflict();
      return result.results.map(checkedItem).sort((left, right) => left.ordinal - right.ordinal);
    },
    async recoverItem(expected: ItemRow, stage: ItemStage, now: number) {
      const result = await this.transitionItem(expected, stage, { type: "recover_stale" }, now);
      return { item: result.item, action: "persist" as const };
    },
    async reconcileItem(expected: ItemRow, stage: ItemStage, result: "consistent" | "missing" | "conflict", now: number) {
      return this.transitionItem(expected, stage, { type: "reconcile", result }, now);
    },
    async refreshItem(expected: ItemRow, stage: ItemStage, now: number) {
      return this.transitionItem(expected, stage, { type: "refresh" }, now);
    },
    async requeueItem(expected: ItemRow, stage: ItemStage, now: number) {
      return this.transitionItem(expected, stage, { type: "refresh" }, now);
    },
    async reconcileUncertain(..._args: [ItemRow, ItemStage, number]) {
      void _args;
      throw new Error("uncertain reconciliation unavailable; provider write will not be retried");
    },
    async recoverRun(expected: RunRow, now: number) {
      return saveRun(expected, { type: "fail", retryClass: "retryable", reasonCode: "interrupted" }, now);
    },
    async transitionRun(expected: RunRow, event: Exclude<RunEvent, { type: "admit_export" }>, now: number) {
      // Runtime guard as well as API intent: export admission must go through reviewed evidence.
      if ((event as RunEvent).type === "admit_export") throw new Error("export requires reviewed selection and reconciled evaluations");
      return saveRun(expected, event, now);
    },
    // Caller supplies snapshots whose eligibility/effects it has just reconciled read-only.
    // This repository verifies durable success and atomically rejects changed evidence.
    async admitExport(expected: RunRow, selectionValue: unknown, reconciledItems: ItemRow[], now: number) {
      const snapshot = await load(expected.run_id);
      const selection = parsePublicationSelection(selectionValue, { manifest: scope(snapshot), manifestHash: snapshot.run.manifest_hash });
      const included = selection.items.filter((item) => item.decision === "include");
      const evidence = reconciledItems.map(checkedItem);
      if (evidence.length !== included.length || new Set(evidence.map((item) => item.steam_app_id)).size !== included.length
        || included.some((item) => !evidence.some((row) => row.steam_app_id === item.steamAppId))
        || evidence.some((item) => item.run_id !== expected.run_id
          || ITEM_STAGES.some((stage) => parseItemStages(item.stage_states_json)[stage].state !== "succeeded"))) {
        throw new Error("export requires durable consistent evaluation success");
      }
      return saveRun(expected, { type: "admit_export" }, now, evidence);
    },
    async reconcileExportFailure(expected: RunRow, now: number) {
      return saveRun(expected, { type: "fail_stage", retryClass: "retryable", reasonCode: "export_replacement_failed" }, now);
    },
    async completeExport(expected: RunRow, _selectionValue: unknown, artifactSha256: string, now: number) {
      return saveRun(expected, { type: "complete_stage", artifactSha256 }, now);
    },
  };
}
