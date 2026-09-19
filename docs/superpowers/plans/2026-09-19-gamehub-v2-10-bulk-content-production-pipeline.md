# GameHub V2.10 Bulk Content Production Pipeline — Implementation Plan

Design source: `docs/superpowers/specs/2026-09-19-gamehub-v2-10-bulk-content-production-pipeline-design.md`  
Design SHA-256: `0ecb64ca034cc83be850b4649c02239f0e3d8764ea57dc496832ec3a6305f151`  
Execution mode: SDD + TDD, local-only, no production migration, no deploy, no push/PR until the entire feature is complete.

This plan authorizes implementation only after explicit plan approval. It does not authorize migration execution, provider writes, publication, or deployment in this design/planning session.

## 1. Exact contracts

### 1.1 Input manifest

The first V2.10 version supports only Steam App IDs. The strict JSON shape is:

```ts
const InputManifestSchema = z.object({
  manifestVersion: z.literal("1"),
  pipelineVersion: z.literal("2.10"),
  policyVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/),
  snapshotDate: ExactCalendarDateSchema,
  items: z.array(z.object({
    ordinal: z.number().int().positive(),
    steamAppId: z.string().regex(/^[1-9][0-9]*$/),
  }).strict()).min(1).max(1000),
}).strict();
```

After validation, ordinals must be exactly `1..items.length`, item order must equal ordinal order, and Steam IDs must be unique. No deduplication is performed: duplicate IDs fail closed. The manifest contains no title, URL, provider payload, secret, timestamp, local path, or mutable display label.

Complete example:

```json
{
  "manifestVersion": "1",
  "pipelineVersion": "2.10",
  "policyVersion": "v2.10-production-1",
  "snapshotDate": "2026-09-19",
  "items": [
    { "ordinal": 1, "steamAppId": "1245620" },
    { "ordinal": 2, "steamAppId": "292030" }
  ]
}
```

### 1.2 Publication selection

The reviewed selection is a separate strict JSON contract:

```ts
const PublicationSelectionSchema = z.object({
  selectionVersion: z.literal("1"),
  pipelineVersion: z.literal("2.10"),
  policyVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/),
  snapshotDate: ExactCalendarDateSchema,
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(z.object({
    steamAppId: z.string().regex(/^[1-9][0-9]*$/),
    decision: z.enum(["include", "exclude"]),
  }).strict()).min(1).max(1000),
}).strict();
```

IDs must be unique and canonical decimal strings, and the selection ID set must equal the manifest ID set exactly (each manifest item has one decision). The selection must match the manifest hash, versions, and snapshot date exactly. Selection order is canonical Steam App ID ascending for hashing; report order remains manifest ordinal. No reviewer timestamp, raw row, payload, secret, token, local path, or free-form note is stored. Complete example:

```json
{
  "selectionVersion": "1",
  "pipelineVersion": "2.10",
  "policyVersion": "v2.10-production-1",
  "snapshotDate": "2026-09-19",
  "manifestHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "items": [
    { "steamAppId": "1245620", "decision": "include" },
    { "steamAppId": "292030", "decision": "exclude" }
  ]
}
```

### 1.3 Canonicalization, hashing, and run ID

`canonicalizeManifest(manifest): string` validates the strict schema, orders object keys lexicographically at every object level, preserves the validated `items` array in ordinal order, emits JSON with no insignificant whitespace, UTF-8 semantics, and exactly one final `\n`. It must not use incidental object insertion order.

`hashManifest(manifest): string` is lowercase SHA-256 over the exact UTF-8 bytes of `canonicalizeManifest(manifest)`.

`runId = "pipeline-v2.10:" + hashManifest(manifest)`.

Pipeline and policy versions are already part of canonical manifest bytes and are not appended a second time. No current time, UUID, random value, or completion order participates.

The same canonical rules apply to selection hashing if a selection hash is later needed, with selection items sorted by canonical Steam App ID for that contract.

### 1.4 Stage enum and ownership

The only stage enum is:

```ts
const PIPELINE_STAGES = [
  "discover", "import", "enrich", "verify", "images",
  "evaluate", "export", "preview", "publish-ready",
] as const;
```

Item-level stages: `discover`, `import`, `enrich`, `verify`, `images`, `evaluate`.  
Run-level stages: `export`, `preview`, `publish-ready`.

`discover` is a run-level manifest validation/admission stage that initializes one item row per manifest item. Its per-item result is `succeeded` only after the item is admitted; it is not a provider call. Run-level export/preview/publish-ready derive their outcomes from the whole reviewed selection and do not invent per-item provider states.

### 1.5 Exact stage transition contract

Item states are `pending | running | succeeded | retryable_failed | permanently_failed | blocked | skipped`. A stage may start only when every earlier item stage is `succeeded`. A durable `skipped` predecessor never permits a dependent stage to run. The transition table is:

| From | Event | To | Retry/dependents |
|---|---|---|---|
| pending | admitted | running | none |
| running | successful validated result | succeeded | next stage becomes pending |
| running | retryable reason | retryable_failed | retry stage only; later stages remain pending |
| running | permanent reason | permanently_failed | all dependent later stages become skipped |
| running | policy/safety/manual review reason | blocked | all dependent later stages become skipped |
| retryable_failed | automatic/manual retry allowed | running | max three attempts; later stages unchanged |
| succeeded | resume reconciliation passes | succeeded | runner action is `skip_execution`; next stage may proceed |
| succeeded | reconciliation finds missing expected idempotent effects | retryable_failed | retry that stage after reconciliation; later stages do not proceed |
| succeeded | reconciliation finds identity/invariant conflict | blocked | dependent later stages become skipped |
| running | stale-attempt recovery | retryable_failed | requires safe stale lease/attempt rule |
| any terminal item state | explicit refresh | pending | refresh resets stage and dependents only |

Stage dependency edges are exactly `discover → import → enrich → verify → images → evaluate`. `images` reuses the existing image ingestion service, may fetch approved sources, performs idempotent local writes, never enables production R2 publication, and never changes the V2.9 public DTO. `skipped` is durable only when a prerequisite ended `permanently_failed` or `blocked`; it never means “already succeeded, so resume did not execute it.” Run-level transitions are:

| Run from | Event | Run to |
|---|---|---|
| created | `create --write` atomically initializes the run/items with discover succeeded | created; item execution has not started |
| created | `run --write` starts item work | running |
| running | operator pause or safe interruption | paused |
| paused | resume with identical manifest/policy/snapshot | running |
| running | run-fatal error | failed |
| running | all selected item evaluations succeed | running; `current_stage=export`, export pending |
| running | export succeeds and artifact hash is recorded | running; export succeeded, preview pending |
| running | preview succeeds for the same artifact hash | running; preview succeeded, publish-ready pending |
| running | publish-ready succeeds for the same artifact hash | ready; publish-ready succeeded |
| running | run-level stage is interrupted or retryably fails | paused; same stage remains resumable |
| running | run-level stage permanently/run-fatally fails | failed; later run-level stages remain pending |
| any non-published run | changed manifest/policy/snapshot | rejected; create a new run |

The implementation must encode this table, not infer transitions from string comparisons.

### 1.6 Retry classification and backoff

Reason classes are exact and finite:

| Area | Retryable | Permanent | Blocked | Run-fatal |
|---|---|---|---|---|
| Steam | `steam_429`, `steam_5xx`, `steam_timeout`, transient `steam_network` | `steam_invalid_app`, `steam_malformed_response` | `steam_identity_conflict` | composition/config/D1 failure |
| IGDB | `igdb_timeout`, `igdb_429`, `igdb_5xx`, transient `igdb_network` | `igdb_no_match`, `igdb_malformed_response` | `igdb_ambiguous`, `igdb_invalid_credentials`, taxonomy/company conflict | composition/config/D1 failure |
| Verifier | `link_dns_transient`, `link_timeout`, `link_429`, `link_5xx`, transient network | `link_malformed_url`, `link_malformed_response` | `link_unsafe_destination`, protocol downgrade, policy rejection | verifier composition failure |
| Images | `image_source_timeout`, `image_download_failed`, transient image network, image service unavailable | `image_unsupported_format`, malformed image result | `image_unsafe_source`, source policy rejection, storage conflict | image/D1 composition failure |
| Database | transient busy/lock | constraint conflict after reconciliation | none | schema failure, migration failure, binding unavailable |

`idempotent_existing` is a successful image outcome, not a retry. Automatic retry is at most three attempts per stage. Attempt `n` waits `min(30_000, 1_000 * 2^(n-1))` milliseconds before the next attempt (`1s`, `2s`, `4s`); no random jitter. `Retry-After` may replace the delay only when it is a non-negative bounded integer no greater than the cap. Permanent, blocked, and run-fatal results are never automatically retried.

Run-level stages use the same three-attempt cap. Temporary local filesystem/process interruption before a validated result is `retryable`; deterministic export validation, artifact hash mismatch, site-data-check failure, or reproducible build failure is `permanent`; missing local bindings/configuration is `run_fatal`. A retry keeps `current_stage` unchanged and cannot reset an earlier succeeded run-level stage.

### 1.7 Exact operational SQL plan

The migration is additive, D1/SQLite-compatible, and must not rebuild existing tables:

```sql
CREATE TABLE pipeline_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  manifest_hash TEXT NOT NULL UNIQUE CHECK (length(manifest_hash) = 64),
  pipeline_version TEXT NOT NULL CHECK (pipeline_version = '2.10'),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 32),
  snapshot_date TEXT NOT NULL CHECK (snapshot_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('created','running','paused','failed','ready')),
  current_stage TEXT CHECK (current_stage IS NULL OR current_stage IN ('export','preview','publish-ready')),
  run_stage_states_json TEXT NOT NULL,
  artifact_sha256 TEXT CHECK (artifact_sha256 IS NULL OR (length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (updated_at >= created_at)
);

CREATE TABLE pipeline_run_items (
  run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  steam_app_id TEXT NOT NULL CHECK (length(steam_app_id) > 0 AND steam_app_id NOT GLOB '*[^0-9]*' AND substr(steam_app_id, 1, 1) <> '0'),
  game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  current_stage TEXT NOT NULL CHECK (current_stage IN ('discover','import','enrich','verify','images','evaluate')),
  current_state TEXT NOT NULL CHECK (current_state IN ('pending','running','succeeded','retryable_failed','permanently_failed','blocked','skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 3),
  stage_states_json TEXT NOT NULL,
  reason_code TEXT,
  retry_class TEXT CHECK (retry_class IS NULL OR retry_class IN ('none','retryable','permanent','blocked','run_fatal')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, ordinal),
  UNIQUE (run_id, steam_app_id)
);
```

The implementation must validate `run_id` derivation and `stage_states_json` in application code; `stage_states_json` is canonical JSON containing exactly one outcome/attempt/reason/retryClass for each six item-level stage, in enum order. It is not a public report. `current_*` is the indexed state for scheduling; the JSON is the compact durable history, avoiding one column per stage and avoiding a third table. `game_id` is nullable until import succeeds.

Required indexes:

```sql
CREATE INDEX pipeline_runs_status_idx ON pipeline_runs(status, updated_at, run_id);
CREATE INDEX pipeline_items_pending_idx ON pipeline_run_items(run_id, current_stage, current_state, ordinal);
CREATE INDEX pipeline_items_retryable_idx ON pipeline_run_items(run_id, current_state, ordinal);
CREATE INDEX pipeline_items_game_idx ON pipeline_run_items(game_id);
```

`run_stage_states_json` is canonical JSON with exactly the keys `export`, `preview`, and `publish-ready` in that order. Each value is `{ "state": RunStageState, "attemptCount": number, "reasonCode": string|null, "retryClass": RunRetryClass }`, where `RunStageState = "pending" | "running" | "succeeded" | "retryable_failed" | "permanently_failed"`, `RunRetryClass = "none" | "retryable" | "permanent" | "run_fatal"`, and attempt count is an integer from zero through three. It initializes all three stages as pending. Only `current_stage` may be running; later stages remain pending until their prerequisite succeeds. An interrupted `running` run-level stage becomes `retryable_failed` and the lifecycle status becomes `paused`. Resume advances that same stage to `running`; it never advances a later stage first.

`artifact_sha256` is NULL before successful export. Export success writes the exact lowercase SHA-256 of the serialized artifact; preview and publish-ready must verify and retain the same hash. They may not replace it with a wall-clock-dependent or rebuilt-different value. A failed export writes no hash. A failed preview/publish-ready retains the already exported hash but cannot mark the failed or later stage succeeded.

Operational timestamps are never copied into deterministic reports or public artifacts. Exact SQL output and migration journal details are implementation-test evidence, not to be improvised during coding.

### 1.8 CLI contract

Add one operator entrypoint following the existing script style:

```text
npm run games:pipeline -- create --manifest <tracked-path> [--write] [--json]
npm run games:pipeline -- run --run-id <run-id> [--write] [--json]
npm run games:pipeline -- resume --run-id <run-id> [--write] [--json]
npm run games:pipeline -- retry --run-id <run-id> [--write] [--json]
npm run games:pipeline -- report --run-id <run-id> [--json]
npm run games:pipeline -- evaluate --run-id <run-id> --selection <tracked-path> [--json]
npm run games:pipeline -- export --selection <tracked-path> --snapshot-date <YYYY-MM-DD> [--json]
npm run games:pipeline -- preview --selection <tracked-path> [--json]
```

Without `--write`, `create` strictly validates the manifest, canonicalizes/hashes it, computes the run ID, and reports the planned run and item count with zero D1 mutation. With `--write`, it atomically inserts `pipeline_runs` and all `pipeline_run_items` in local D1, records every item's `discover` state as succeeded, initializes `import` as pending, and performs no Steam/IGDB/verifier/images provider I/O. Repeating the identical manifest/run ID is an idempotent success after exact stored-scope reconciliation; any manifest hash, versions, snapshot date, item count/order, ordinal, or Steam ID mismatch fails closed. Thus `run`, `resume`, and `retry` can load durable scope using only `--run-id`.

`run`, `resume`, and `retry` require explicit `--write` for D1/provider mutation and otherwise perform dry-run plans; `report` is read-only; `evaluate` is read-only and validates selection; `export` and `preview` are local read/build operations and never select unreviewed rows. All commands are local-only, reject `--remote`, never shell out to existing CLIs, and fail before provider I/O when required credentials/configuration are missing.

### 1.9 Deterministic report JSON

The public report contract is strict and excludes operational timestamps:

```ts
type PipelineReport = {
  reportVersion: "1";
  runId: string;
  manifestHash: string;
  pipelineVersion: "2.10";
  policyVersion: string;
  snapshotDate: string;
  lifecycleStatus: "created" | "running" | "paused" | "failed" | "ready";
  currentRunStage: "export" | "preview" | "publish-ready" | null;
  artifactSha256: string | null;
  runStages: Record<"export" | "preview" | "publish-ready", {
    state: "pending" | "running" | "succeeded" | "retryable_failed" | "permanently_failed";
    attemptCount: number;
    reasonCode: string | null;
    retryClass: "none" | "retryable" | "permanent" | "run_fatal";
  }>;
  counts: {
    total: number; discovered: number; imported: number; enriched: number;
    verified: number; images: number; eligible: number; blocked: number;
    retryable: number; permanent: number; skipped: number; failed: number;
  };
  items: Array<{
    ordinal: number;
    steamAppId: string;
    gameId: number | null;
    slug: string | null;
    stages: Record<ItemStage, {
      state: ItemState;
      attemptCount: number;
      reasonCode: string | null;
      retryClass: "none" | "retryable" | "permanent" | "blocked" | "run_fatal";
    }>;
  }>;
};
```

Items sort by ordinal; stage keys sort by the exact stage enum; diagnostics sort by stage order then reason code. `gameId` and slug are permitted in this operator report only when safely known; neither enters the public artifact. No raw errors, provider bodies, secrets, credential-bearing URLs, local paths, R2 metadata, lease/fence values, or timestamps are allowed.

### 1.12 Operator workflow

1. Review the tracked manifest and run `create --manifest ...` without `--write` to validate scope and inspect the deterministic run ID/item count.
2. Run the same `create` with `--write` to atomically create the durable local run and item rows; no provider stage executes.
3. Load required ignored credentials and run/resume/retry by exact run ID. These commands never accept a replacement manifest.
4. Review the deterministic report, then review a publication selection whose IDs exactly cover the manifest.
5. Evaluate every included item. Only when all selected evaluations succeed does the durable run-level ledger enter export pending.
6. Run export, preview, and publish-ready in order. Interrupted export/preview resumes from the durable `current_stage`; succeeded stages remain succeeded and are skipped as an execution action.
7. Stop at publish-ready. No command in this plan deploys, pushes, publishes to production D1, or enables production R2 publication.

### 1.10 File policy and credentials

Tracked:

- reviewed candidate manifests under `content/manifests/`;
- reviewed publication selections under `content/publication-selections/`;
- final `generated/site-data.json`.

Ignored:

- `.env.local` and credential files;
- `content/.runs/`, generated pipeline reports, debug logs, temporary preview/build directories;
- local Wrangler/D1/R2 state and operator exports.

The implementation must update `.gitignore` only with explicit report/run/preview patterns and must prove `generated/site-data.json` remains tracked.

Operators load ignored `.env.local` explicitly with `set -a; source .env.local; set +a`. The command may verify only `TWITCH_CLIENT_ID: SET|MISSING` and `TWITCH_CLIENT_SECRET: SET|MISSING`; it must never print values or file contents. Steam requires no invented secret. Credentials never enter manifests, D1 run tables, reports, tracked config, URLs, or artifacts.

### 1.11 Images stage contract

The stage adapter uses the existing image ingestion service and its approved source validation. It may fetch source bytes and perform local/emulator R2 work only where the existing local service requires it for idempotent ingestion tests. V2.10 does not configure or invoke production R2 publication, does not add production bindings, and does not expose storage URL/key/hash/MIME metadata. The public artifact continues to emit approved Steam/IGDB source URLs through the V2.9 DTO. Image success means the local canonical metadata is reconciled; `idempotent_existing` is success. Image source/download/format/safety failures use the retry table above and block `evaluate` until resolved.

## 2. Task breakdown

Every task follows `RED → minimal implementation → GREEN → refactor → focused verification → independent review → ledger entry`. Each implementation commit must compile and pass its task gate. Tasks do not trigger GitHub PR review individually; push/PR occurs only after the complete V2.10 feature gate.

### Task 1 — Manifest and selection contracts

Files: create `lib/pipeline/contracts.ts`, `lib/pipeline/contracts.test.ts`; create tracked examples/fixtures under `content/manifests/` and `content/publication-selections/`; add only explicit ignore rules.

RED: strict unknown-field, date, ordinal, Steam ID, duplicate, selection linkage, and complete-example tests. Implement Zod contracts and safe parsers. Focused test, typecheck, lint, diff-check, independent review.

### Task 2 — Canonicalization, hashing, and run identity

Files: `lib/pipeline/canonical.ts`, tests. RED tests cover key ordering, UTF-8, final newline, array semantics, exact SHA-256, and `pipeline-v2.10:<hash>` run ID. Implement pure canonicalization with no clock/randomness. Focused test, typecheck, lint, diff-check, independent review.

### Task 3 — Additive D1 migration and schema contract

Files: `lib/db/schema.ts`, one new `drizzle/*.sql` migration, migration metadata, schema tests. RED tests run against populated local D1 and assert both tables, `pipeline_runs.current_stage`, canonical `run_stage_states_json`, validated nullable `artifact_sha256`, constraints, indexes, FK cascade/set-null, checks, rerun no-op, and no existing-table rebuild. Apply/verify only in the later implementation task under explicit local authority; never production. Focused migration tests, typecheck, lint, diff-check, independent review.

### Task 4 — Run repository and transition engine

Files: new `lib/pipeline/run-repository.ts`, `lib/pipeline/transitions.ts`, tests. RED tests cover atomic `create --write` run/item creation, identical-create idempotency, mismatched stored-scope rejection, canonical six-stage item history, canonical three-stage run history, artifact hash writes, complete item/run transition tables, stale running recovery, optimistic conflicts, and no public-read-model exposure. Tests must prove successful reconciliation leaves durable state `succeeded` while returning runner action `skip_execution`, and that only prerequisite failure writes `skipped`. Implement two-table persistence with no third stage table. Focused local D1 tests, typecheck, lint, diff-check, independent review.

### Task 5 — Retry classification and backoff

Files: `lib/pipeline/retry.ts`, tests. RED table-driven tests cover every Steam/IGDB/verifier/images/database code, three-attempt cap, exact 1/2/4 second backoff, bounded Retry-After, and no jitter. Implement pure classification and scheduler policy. Focused tests, typecheck, lint, diff-check, independent review.

### Task 6 — Stage adapters and local composition

Files: new `lib/pipeline/stages/*`, composition/tests; narrow reuse adapters around existing `lib/sync/*`, importer, enricher, verifier, and image service. RED tests prove exact stage order, typed result validation, local-only config, no child-process shell-out, image idempotency, and no production R2 path. Implement ports without changing V2.9 DTO or existing single-game commands. Focused tests, typecheck, lint, diff-check, independent review.

### Task 7 — Bounded runner/orchestrator

Files: `lib/pipeline/runner.ts`, runner tests, composition wiring. RED tests begin from rows atomically created by `create --write`; prove `run --run-id` loads that exact durable scope without a manifest parameter, then cover deterministic admission, worker cap 4, provider caps, serialized writes, per-item continuation, run-fatal stop, and no Promise.all over unbounded candidates. Implement bounded workers and exact state transitions; runner must never create or broaden run scope. Focused tests, typecheck, lint, diff-check, independent review.

### Task 8 — Resume, stale recovery, and retry commands

Files: runner/repository follow-up modules and tests. RED tests cover interrupted item and run-level `running` states, successful-stage reconciliation preserving `succeeded` plus `skip_execution`, missing expected idempotent effects becoming `retryable_failed`, identity/invariant conflicts becoming `blocked`, retry-only requeue, explicit refresh dependencies, changed manifest refusal, interrupted export/preview resuming the same stage, and no duplicate provider write after uncertain completion. Implement `resume`/`retry` semantics with max three attempts. Focused tests, typecheck, lint, diff-check, independent review.

### Task 9 — Deterministic report

Files: `lib/pipeline/report.ts`, tests. RED tests assert exact schema, lifecycle status, current run stage, canonical three-stage run ledger, artifact SHA, item counts, ordinal/stage/reason ordering, safe redaction, absence of timestamps/secrets/R2/lease data, and repeat byte identity. Implement JSON and human presentation. Focused tests, typecheck, lint, diff-check, independent review.

### Task 10 — Publication selection and evaluate gate

Files: `lib/pipeline/publication.ts`, tests, narrow exporter integration. RED tests cover include/exclude linkage, missing selected row, duplicate identity/slug, one ineligible selected row failing the whole selection, all eligible passing, explicit snapshot date, no mock fallback, and the atomic transition from all selected `evaluate=succeeded` to durable `export=pending`/`current_stage=export`. Implement selection resolution and fail-closed evaluate gate. Focused tests, typecheck, lint, diff-check, independent review.

### Task 11 — Selection-based deterministic export

Files: `scripts/export-site-data.ts`, `lib/site-data/*` integration tests as needed. RED tests cover reviewed selection only, exact artifact ordering, preserved media presentation order, limits, forbidden/private fields, source images only, unchanged last artifact on failure, export interruption/resume, successful export recording lowercase SHA-256, and atomic `export=succeeded → preview=pending`. Implement explicit selection input while retaining V2.9 behavior compatibility. Focused tests, typecheck, lint, diff-check, independent review.

### Task 12 — Preview and publish-ready gate

Files: new local preview/gate modules and tests. RED tests prove temporary output, site-data check, static build, artifact SHA verification, no tracked artifact overwrite on failure, durable preview interruption/resume, `preview=succeeded → publish-ready=pending`, `publish-ready=succeeded → lifecycle ready`, later stages remaining pending after failure, and no deploy/publish side effects. Implement `preview` and `publish-ready` as local read/build gates over the same stored artifact hash. Focused tests, typecheck, lint, diff-check, independent review.

### Task 13 — Operator CLI

Files: `scripts/run-games-pipeline.ts`, package scripts, CLI tests. RED tests cover every command/flag; `create` dry-run zero mutation; `create --write` atomic durable initialization with discover succeeded and no provider I/O; identical-create idempotency; mismatched scope failure; `run/resume/retry --run-id` durable loading; local-only rejection of `--remote`; early credential presence checks; safe output; and no child-process execution. Implement the exact CLI contract and exit codes. Focused tests, typecheck, lint, diff-check, independent review.

### Task 14 — Scenario and local integration suite

Files: `lib/pipeline/*.integration.test.ts`, migration/run harness, documentation. Cover create dry-run/write, durable run lookup, all-success, one ambiguous, unsafe link, image failure, 100 rate-limited, item interruption/resume, export and preview interruption/resume, stale recovery, succeeded-state preservation, genuine prerequisite skip, changed manifest, selection fail-closed, duplicate create/rerun, run-stage ledger persistence, and artifact stability. Wrangler/workerd tests remain in the repository; if local sandbox listener restrictions block them, record blocked rather than altering/skipping assertions. GitHub CI is the authoritative integration gate. Focused tests, typecheck, lint, diff-check, independent review.

### Task 15 — UI scalability backlog

Files: existing `/games`, `/search`, taxonomy routes/components, compact browse types, focused UI tests. Implement initial 24/load-more 24/reset behavior, bounded taxonomy pages, homepage upcoming/latest max 6, and data-driven taxonomy links. Do not add virtualization, runtime API, or pipeline coupling. Focused UI tests, typecheck, lint, diff-check, independent review.

### Task 16 — Documentation and final verification

Files: operator README/runbook, plan-specific ledger, final reports. Document local credential loading, manifest/selection review, run/resume/retry/report/export/preview commands, rollback, and scope boundaries. Run the complete approved verification set once, record exact test counts and environmental blocks, perform independent full-feature review, and only then consider a feature commit/push/PR. No implementation starts in this planning session.

## 3. Dependencies and task sizing

Dependency chain: `1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 16`; Task 15 can follow Task 1 and the existing V2.9 contracts but must finish before Task 16. Task 6 cannot start until the stage enum and repository transitions exist. Task 11 cannot start until Task 10's explicit selection gate exists. No task intentionally leaves typecheck broken; compile-time coupling may merge Tasks 10–11 only if each internal commit remains green.

Estimated complexity: high, approximately 16 independently reviewed tasks; roughly 2–3 implementation weeks for one experienced engineer excluding provider quota delays, with the migration/integration and review gates as the highest-risk work.

## 4. Scope boundaries

Not included: admin CMS, auth/users, production D1, runtime API, production Cron/Container, automatic deploy/push/merge, public R2 migration, ratings, translations/Chinese titles, free-status source, generic workflow engine, or any relaxation of V2.9 eligibility/security gates.

## 5. Verification policy

Pure tests run in ordinary Vitest. Local D1 migration/integration tests use isolated local fixtures. Wrangler/workerd listener failures caused by the sandbox are recorded as `LOCAL-INTEGRATION-BLOCKED-BY-SANDBOX`; tests are not skipped, weakened, or made to pass artificially. GitHub CI remains the authoritative full integration gate after the feature is complete.

Each task must report focused test count, typecheck, lint, and `git diff --check`. Full verification must include site-data checker, build, migration verification, security/no-secret checks, deterministic repeated export, and clean worktree. No generated report, `.env.local`, local state, or temporary preview output may be committed.

## 6. Independent plan review

Critical: 0  
Important: 0  
Minor: 0

Review conclusions:

- All 15 required exact contracts are defined before implementation.
- The stage enum and transition graph include `images` with explicit per-item ownership.
- Resume/retry cannot silently repeat uncertain writes and has a finite retry cap.
- Publication selection validates every included row and fails closed on any invalid selected row.
- Image ingestion cannot introduce production R2 publication or public R2 metadata.
- Tasks are ordered with explicit compile-time and migration dependencies.
- UI scalability is isolated from the pipeline and remains within the V2.9 backlog.
- No scope creep or implementation was introduced by this plan.
