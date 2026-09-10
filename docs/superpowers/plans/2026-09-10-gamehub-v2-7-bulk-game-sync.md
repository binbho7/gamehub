# GameHub V2.7 Bulk Game Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Implement the approved V2.7 local/manual bulk sync CLI for Steam App IDs. It runs Steam import → IGDB enrichment → official-link verification → authenticated Image Ingest Worker, with max 100 deduplicated IDs, game concurrency 1, dry-run by default, fail-fast per game, and cross-game failure isolation.

## Architecture

Create reusable contracts and orchestration under `lib/sync/`; keep `scripts/sync-games.ts` limited to argv/file parsing, local Wrangler composition, output, and exit code. Adapters call existing importer/enricher/verifier interfaces; no child CLI execution. Image ingest remains an HTTP Worker boundary. One local platform lifecycle supplies D1 to Steam/IGDB/links; the Image Worker must be started by the operator against the same `.wrangler/state` root documented by the Spec.

## Tech Stack

Existing Node.js, TypeScript, Zod, Drizzle, Wrangler, and Vitest only. No production dependency, schema migration, job table, queue, scheduler, or new runtime library.

## Spec

Authority: `docs/superpowers/specs/2026-09-09-gamehub-v2-7-bulk-game-sync-design.md` at Design HEAD `78eef9a`. Migration count remains 4 and schema SHA-1 remains `d959b11fc297164388f3cc28708beadab2d7842f`; package-lock and dependency graph must remain unchanged.

## Global Constraints

- Strict TDD for every task: write one failing test, run and observe RED, implement minimally, run GREEN, run relevant regression, commit.
- No `process`, `console`, `process.env`, filesystem, Wrangler, or network globals in `lib/sync`.
- No `Promise.all`, game pool, retry loop, backoff, sleep, shell command, or child CLI.
- All inputs fail closed before any stage call; file lines are data and never flags.
- Default dry-run; only `--write` enables mutations. No rollback across stages.
- Local-only D1 and local Image Worker; reject `--remote`, `--env`, `--config`, `--database-id`, and other target selectors.
- Every task owns explicit files, interfaces, tests, and one commit; later tasks consume the exact types defined earlier.
- Each task includes executable checkbox steps: named failing test and RED command, minimal implementation, focused GREEN command, regression/lint/diff-check, then commit/report before the next task.
- Every task follows these exact steps: `- [ ] Write the named failing test and run it to confirm RED`; `- [ ] Implement the smallest production change`; `- [ ] Run the focused test and confirm GREEN`; `- [ ] Run relevant regression, lint, and diff-check`; `- [ ] Commit the task and record the SHA/report before the next task`. No task may skip the RED observation.

## Task 1 — Bulk contracts, DTOs, and error taxonomy

**Files:** add `lib/sync/types.ts`, `lib/sync/errors.ts`, tests `lib/sync/types.test.ts`.

Define and export:

```ts
export type BulkGameSyncStageName = "steam" | "igdb" | "links" | "images";
export type BulkGameSyncStageStatus = "succeeded" | "failed" | "not_run";
export type BulkGameSyncStageResult = { name: BulkGameSyncStageName; status: BulkGameSyncStageStatus; summary: string; reason?: string; error?: { code: string; message: string } };
export type BulkGameSyncGameResult = { appId: string; gameId: number | null; status: "succeeded" | "failed"; stages: BulkGameSyncStageResult[] };
export type BulkGameSyncResult = { dryRun: boolean; total: number; succeeded: number; failed: number; games: BulkGameSyncGameResult[] };
export type BulkSyncNotRunReason = "canonical_game_not_persisted" | "previous_stage_failed";
```

Add typed public errors for invalid input/configuration and stage mapping. Tests assert exact literals, safe public error shape, and no raw causes/stacks.

## Task 2 — Input expansion and validation

**Files:** add `lib/sync/input.ts`, `lib/sync/input.test.ts`.

Define:

```ts
export function loadSteamAppIdsFile(path: string, readFile: (path: string, encoding: "utf8") => string): string[];
export function expandBulkSyncInputs(argv: string[], readFile: (path: string, encoding: "utf8") => string): string[];
export function normalizeBulkSyncAppIds(values: string[]): string[];
export function parseBulkSyncArgs(argv: string[], readFile: (path: string, encoding: "utf8") => string): { appIds: string[]; write: boolean; json: boolean };
```

Expand `--file` left-to-right at its argv position; trim lines, ignore blanks/comments, first-wins dedupe after `normalizeSteamAppId`, and enforce 1–100 after dedupe. Test positional/file ordering, duplicate flags, missing file value, invalid IDs, flag-like file content, exact 100, raw 101 deduped to ≤100, and invalid input producing zero downstream calls.

## Task 3 — Stage adapter interfaces and aggregate mapping

**Files:** add `lib/sync/stages.ts`, `lib/sync/stages.test.ts`.

Define exact boundaries and concrete outputs (all summaries/errors are presentation-safe):

```ts
export type SteamSyncStage = { execute(appId: string, ctx: { dryRun: boolean }): Promise<SteamStageOutput> };
export type IgdbSyncStage = { execute(gameId: number, ctx: { dryRun: boolean }): Promise<IgdbStageOutput> };
export type LinkSyncStage = { execute(gameId: number, ctx: { dryRun: boolean }): Promise<LinkStageOutput> };
export type ImageSyncStage = { execute(gameId: number, ctx: { dryRun: boolean }): Promise<ImageStageOutput> };
export function createSteamStage(importer: { importGame(input: { appId: string }, options: { dryRun: boolean }): Promise<unknown> }): SteamSyncStage;
export function createIgdbStage(enricher: { enrichGame(gameId: number, options: { dryRun: boolean }): Promise<unknown> }): IgdbSyncStage;
export function createLinkStage(verifier: { verifyGame(gameId: number, options: { dryRun: boolean }): Promise<unknown> }): LinkSyncStage;
export function createImageSyncStage(client: { ingest(gameId: number, input: { write: boolean }): Promise<ImageResult> }): ImageSyncStage;
```

`SteamStageOutput = { gameId: number | null; summary: string; status: "created" | "updated" | "existing" }`; `IgdbStageOutput = { summary: string; status: "enrich" | "existing" }`; `LinkStageOutput = { summary: string; operationCode: "http_result" | "invalid_url" | "unsupported_scheme" | "unsafe_destination" | "dns_failure" | "tls_error" | "network_error" | "timeout" | "invalid_redirect" | "redirect_loop" | "too_many_redirects" | "protocol_downgrade" | "conflict" | null; verificationStatuses: string[] }`; `ImageStageOutput = { summary: string; result: ImageResult }`. Adapters throw `BulkSyncStageError { stage, code, message }` without raw causes. Link codes are read from every `plan.verificationResults[].code`; `http_result` and no-error/empty plans succeed, all other operation codes (including conflicts) fail. Task 7 tests the complete native 19-outcome enum plus non-2xx, non-JSON, malformed, and mismatched-game responses as safe typed failures; only `completed` succeeds, `partial`/`failed` fail.

## Task 4 — Steam stage adapter

**Files:** add `lib/sync/steam-stage.ts`, `lib/sync/steam-stage.test.ts`.

Compose `createSteamImporter` without copying import logic. `execute` passes `{ dryRun }`, maps importer result to Task 3 output, preserves `gameId`, and never writes during dry-run. Tests cover existing dry-run, create dry-run with null ID, write-created ID, typed errors, and no store write in dry-run.

## Task 5 — IGDB stage adapter

**Files:** add `lib/sync/igdb-stage.ts`, `lib/sync/igdb-stage.test.ts`.

Compose `createIgdbEnricher`; accept only canonical `gameId` from Task 4; pass the batch dry-run flag; map `enrich`/`existing` to success and blocked/provider/mapping/write conflicts to typed failure. Tests assert exact game ID propagation, dry-run propagation, safe summary, and no raw payload/token.

## Task 6 — Official links stage adapter

**Files:** add `lib/sync/link-stage.ts`, `lib/sync/link-stage.test.ts`.

Compose `createLinkVerificationService`. Apply code-first precedence from the Spec: operation codes (`invalid_url`, `unsupported_scheme`, `unsafe_destination`, `dns_failure`, `tls_error`, `network_error`, `timeout`, `invalid_redirect`, `redirect_loop`, `too_many_redirects`, `protocol_downgrade`) and conflicts/partial application fail; completed HTTP classifications (`verified`, `reachable_but_unverified`, `broken`, `temporarily_unavailable`, `unsafe`, `unknown`) are diagnostics and do not fail when no operation code exists. Tests cover each code/classification, manual metadata, dry-run, conflicts causing failure, and no image stage eligibility after failure.

## Task 7 — Image Worker stage adapter

**Files:** add `lib/sync/image-stage.ts`, `lib/sync/image-stage.test.ts`.

Define an injected authenticated client:

```ts
export type ImageWorkerClient = { ingest(gameId: number, input: { write: boolean }): Promise<ImageResult> };
export function createImageSyncStage(client: ImageWorkerClient): ImageSyncStage;
```

Pass only `write` derived from batch mode. Map ImageResult status/outcomes exactly, preserve safe diagnostics, and never import R2/D1/image downloader code. Tests assert local endpoint/token composition stays outside the adapter, write flag propagation, all outcome groups, and secret-safe errors.

## Task 8 — Single-game pipeline state machine

**Files:** add `lib/sync/game-pipeline.ts`, `lib/sync/game-pipeline.test.ts`.

Define:

```ts
export function runBulkSyncGame(input: { appId: string; dryRun: boolean; steam: SteamSyncStage; igdb: IgdbSyncStage; links: LinkSyncStage; images: ImageSyncStage }): Promise<BulkGameSyncGameResult>;
```

Implement Steam → IGDB → links → images. Steam create dry-run yields downstream `not_run` with `canonical_game_not_persisted`; any stage failure yields later `not_run` with `previous_stage_failed`; no rollback. Tests explicitly cover each failure position, existing-game full dry-run, new-game dry-run, write path, game ID propagation, and exact stage order.

## Task 9 — Batch orchestrator and isolation

**Files:** add `lib/sync/batch.ts`, `lib/sync/batch.test.ts`.

Define:

```ts
export function runBulkSyncBatch(input: { appIds: string[]; dryRun: boolean; runGame: (appId: string) => Promise<BulkGameSyncGameResult> }): Promise<BulkGameSyncResult>;
```

Run sequentially, prove Game A completes before Game B starts, continue after failures, preserve normalized order, and compute exact totals. Tests assert all-success exit data, mixed failures, cross-game continuation, no retries/sleeps, and max-100 boundary.

## Task 10 — Local composition and lifecycle

**Files:** add `scripts/sync-composition.ts`, `scripts/sync-composition.test.ts`.

Define injected composition:

```ts
export function createLocalBulkSyncDependencies(input: { getPlatformProxy: GetPlatformProxy; env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Promise<{ stages: { steam: SteamSyncStage; igdb: IgdbSyncStage; links: LinkSyncStage; images: ImageSyncStage }; dispose(): Promise<void> }>;
```

Keep all Wrangler, environment, filesystem, and process access in this CLI-side composition module; `lib/sync` remains pure. Define `GetPlatformProxy = (options: { configPath: string; persist: true; remoteBindings: false }) => Promise<{ env: Record<string, unknown>; dispose?: () => Promise<void> }>` and use one fixed Wrangler local platform with shared D1. Accept only `http://127.0.0.1:8787/internal/images/ingest` (normalize localhost spelling), reject every other target or redirect, validate before acquisition, dispose partial acquisition exactly once, and preserve results on cleanup/output failure. Require the documented Worker `.wrangler/state` precondition; tests cover lifecycle and endpoint rules.

## Task 11 — CLI, presentation, README, and script

**Files:** add `scripts/sync-games.ts`, `scripts/sync-games.test.ts`; create `lib/sync/presentation.ts`, `lib/sync/presentation.test.ts`; update `README.md` and `package.json` script only.

Define `formatBulkSyncResultHuman(result: BulkGameSyncResult): string` and `presentBulkSyncResult(result): PresentedBulkGameSyncResult`. Render totals, each App ID/canonical ID/status/stage/reason/error through shared sanitization. CLI parses Task 2 args, composes Task 10 once, runs Task 9, prints human/JSON, disposes once, and exits 0 only when failed=0. Tests cover all commands, local-only rejection, file injection, `--write` target safety, no shell execution, secret/URL redaction, and README command examples.

## Task 12 — Integration, security, and final verification

**Files:** add `test/sync/bulk-sync.integration.test.ts`, `test/sync/bulk-sync.security.test.ts`; update `docs/superpowers/reports/2026-09-10-gamehub-v2-7-bulk-game-sync-verification.md`.

Use deterministic Steam/IGDB fixtures, one local D1 lifecycle, and the local Image Worker boundary. Assert existing/new dry-run semantics, write ordering, cross-stage visibility, zero dry-run mutations, failure isolation, no remote bindings, no child process/shell, secret safety, and file flag injection resistance. Run fresh:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run db:migrate:local
npm run db:check:local
npm audit
npm audit --omit=dev
git diff --check
```

Record build/audit environment exceptions honestly. Confirm migration count 4, schema SHA-1 unchanged, package-lock unchanged, and worktree clean. No code/dependency/schema change is allowed in this verification task beyond the planned CLI/docs/tests.

## Task-local execution checklist

For each task, the implementer must check every line below in that task section and record the command output before proceeding:

- [ ] Write the named failing test and run the exact focused command (RED is required; do not continue if it unexpectedly passes).
- [ ] Implement only the interfaces and behavior listed for that task.
- [ ] Rerun the same focused command and record GREEN.
- [ ] Run `npm run typecheck`, the relevant regression tests, `npm run lint`, and `git diff --check`.
- [ ] Commit only the task-owned files with the task’s conventional message and record the SHA/report.

Focused RED/GREEN commands are respectively `npm test -- <task-test-file>`, and each task’s test file is named in its **Files** block; expected RED is at least one assertion failure for the behavior under test, and expected GREEN is all assertions passing. This checklist is repeated per Task 1–12 in execution order; no task may combine, skip, or pre-implement a later task.

## Task dependency and ownership map

1 → 2 → 3 → 4/5/6/7 → 8 → 9 → 10 → 11 → 12. Tasks 4–7 touch separate adapter files and may run sequentially; Task 8 consumes their exact interfaces. Task 10 owns CLI-side process/env/Wrangler composition; Task 11 owns CLI/docs/package script; Task 12 owns integration/security tests and verification report. No task modifies `lib/db/schema.ts`, Drizzle migrations, or package dependency versions.

## Plan self-review

- Spec coverage: pipeline/CLI→Tasks 2,8,10,11; dry-run/write→4–8; limits/isolation→2,8,9; DTOs/errors→1,3,11; links→6; images→7; mapping→3; lifecycle→10; local-only/no schema/deps→10–12; security→2,6,7,10–12; verification→12.
- Placeholder scan: run the required `rg` patterns on plan prose (excluding this label) and confirm zero unresolved placeholders.
- Type consistency: Task 1 DTOs and stage error contract are consumed unchanged by Tasks 3, 8, 9, 11, and 12; adapter outputs above are the sole cross-task contracts.
- Ownership: `lib/sync` contracts/adapters/orchestrators are isolated; CLI and composition remain in scripts/composition; only Task 11 edits package.json script and README.
- Scope: no Cron, Queue, Durable Object, job table, resume DB, Admin UI, production batch API, or parallel game execution.
