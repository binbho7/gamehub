# GameHub V2.7 Bulk Game Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a bounded local/manual Steam App ID batch through Steam import → IGDB enrichment → official-link verification → authenticated Image Ingest Worker.

**Architecture:** Pure orchestration and injected adapters live under lib/sync/. Scripts own argv/file input, environment, Wrangler, HTTP client construction and terminal output. One local D1 platform supplies Steam/IGDB/links; images cross the existing authenticated Worker HTTP boundary against the same local persisted state.

**Tech Stack:** Existing TypeScript, Node, Vitest, Zod, Drizzle, Wrangler and V2.2–V2.6 services.

**Spec:** docs/superpowers/specs/2026-09-09-gamehub-v2-7-bulk-game-sync-design.md, approved authority 7ae96d2211d3bce5d11158b46bb1c2f26315d4b7. Original Plan commit: 50b131680afb216bff7da42d12649dcbc3d02857. Stable baseline: 122a78085b7ba8b2a01521dfc9cbcfc5ada1ec9a.

## Global Constraints

- This document is a plan; implementation has not started. Execution requires subsequent human Plan approval.
- Maximum 100 normalized/deduplicated App IDs, first wins, game concurrency exactly 1.
- Fixed four-stage order; fail-fast within a game; record expected stage failures and continue the next game.
- Default dry-run. Only --write enables mutation. New dry-run create has no invented canonical ID and makes no temporary D1 writes.
- No cross-stage transaction, rollback, deletion, retry engine, backoff, delay, or pool.
- No process, environment, console, filesystem, Wrangler or network globals under lib/sync/. Imported provider code owns its existing native behavior; orchestration only calls injected ports.
- Image ingest stays authenticated HTTP; bulk modules never receive image R2 bindings, download bytes or instantiate image repositories.
- Fixed local D1 configuration, remoteBindings: false, no target selection flags or remote Image Worker.
- No schema/dependency changes. Migration count remains 4; schema SHA-1 remains d959b11fc297164388f3cc28708beadab2d7842f. package-lock.json and dependency/devDependency versions remain unchanged.
- No Cron, Queues, Durable Objects, persistent jobs, sync_runs, checkpoint, durable resume, Admin UI, web progress, nightly sync, production batch API or V2.8 scaffolding.
- Each task has its own RED → implementation → GREEN → regression → commit steps below; code blocks describe future edits, not authorization to execute now.
- Commands below run in /Users/binbho/Developer/gamehub/.worktrees/codex-v2-7-bulk-game-sync. Only task-owned files are staged. Each task needs independent review before its dependents start.

## File and ownership map

| Task | Owned future files | Responsibility |
| --- | --- | --- |
| 1 | lib/sync/types.ts, errors.ts, types.test.ts | Public DTO and fatal errors |
| 2 | lib/sync/input.ts, input.test.ts | Pure injected-file parsing and normalization |
| 3 | lib/sync/stages.ts, stages.test.ts | Shared ports, outputs and stage error contracts only |
| 4 | lib/sync/steam-stage.ts, steam-stage.test.ts | createSteamStage |
| 5 | lib/sync/igdb-stage.ts, igdb-stage.test.ts | createIgdbStage |
| 6 | lib/sync/link-stage.ts, link-stage.test.ts | createLinkStage |
| 7 | lib/sync/image-stage.ts, image-stage.test.ts | createImageSyncStage; no HTTP construction |
| 8 | lib/sync/game-pipeline.ts, game-pipeline.test.ts | One-game state machine |
| 9 | lib/sync/batch.ts, batch.test.ts | Serial complete-result aggregation |
| 10 | scripts/sync-composition.ts, sync-composition.test.ts, sync-image-client.ts, sync-image-client.test.ts | Config/env, one platform, stage composition, HTTP client, factory disposal ownership |
| 11 | scripts/sync-games.ts, sync-games.test.ts; lib/sync/presentation.ts, presentation.test.ts; README.md; package.json script only | Invocation, CLI disposal/output/exit, presentation, operator instructions |
| 12 | test/sync/local-bulk-harness.ts, bulk-sync.integration.test.ts, bulk-sync.security.test.ts; docs/superpowers/reports/2026-09-10-gamehub-v2-7-bulk-game-sync-verification.md | Local integration, security and fresh verification evidence |

Dependencies: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12. Task 3 does not implement factories owned by Tasks 4–7. Task 10 does not invoke argv, batch, formatters or sinks. Task 11 does not acquire Wrangler or build provider clients itself.

## Task 1 — Public DTOs and fatal error taxonomy

**Files:** Create lib/sync/types.ts, lib/sync/errors.ts and lib/sync/types.test.ts.

**Interfaces:**
- Consumes: approved Spec sections 13–15; no service dependencies.
- Produces: BulkGameSyncResult, BulkGameResult, BulkStageResult, StageName, NotRunReason, PublicError, FatalCode, publicError(code).

- [ ] **Step 1: Write failing tests.**

~~~ts
import { expect, it } from "vitest";
import { publicError } from "./errors";
import { STAGE_NAMES } from "./types";

it("defines four stages and fixed public fatal diagnostics", () => {
  expect(STAGE_NAMES).toEqual(["steam", "igdb", "links", "images"]);
  expect(publicError("cleanup_failed")).toEqual({
    code: "cleanup_failed",
    message: "The local bulk sync platform could not be disposed.",
  });
  expect(Object.keys(publicError("batch_execution_failed")).sort())
    .toEqual(["code", "message"]);
});
~~~

Add a parameterized assertion for each of the seven exact code/message pairs below; test name: "all fatal diagnostics contain only code and fixed message".

- [ ] **Step 2: Observe RED.**

Run: npm test -- lib/sync/types.test.ts

Expected RED: imports "./errors" and "./types" do not resolve. An unrelated runner/config error does not qualify as RED.

- [ ] **Step 3: Implement the public contracts.**

~~~ts
export const STAGE_NAMES = ["steam", "igdb", "links", "images"] as const;
export type StageName = typeof STAGE_NAMES[number];
export type NotRunReason = "canonical_game_not_persisted" | "previous_stage_failed";
export type PublicError = { code: string; message: string };
export type BulkStageResult = {
  name: StageName;
  status: "succeeded" | "failed" | "not_run";
  summary: string;
  reason?: NotRunReason;
  error?: PublicError;
};
export type BulkGameResult = {
  appId: string;
  gameId: number | null;
  status: "succeeded" | "failed";
  stages: BulkStageResult[];
};
export type BulkGameSyncResult = {
  dryRun: boolean;
  total: number;
  succeeded: number;
  failed: number;
  games: BulkGameResult[];
};
~~~

In errors.ts:

~~~ts
export const FATAL_MESSAGES = {
  configuration_error: "Bulk sync input or configuration is invalid.",
  platform_unavailable: "The local bulk sync platform could not be acquired.",
  composition_failed: "Bulk sync stage dependencies could not be created.",
  batch_execution_failed: "Bulk sync could not produce a complete batch result.",
  cleanup_failed: "The local bulk sync platform could not be disposed.",
  output_format_failed: "The bulk sync result could not be formatted.",
  output_write_failed: "The bulk sync result could not be written.",
} as const;
export type FatalCode = keyof typeof FATAL_MESSAGES;
export function publicError<C extends FatalCode>(code: C) {
  return Object.freeze({ code, message: FATAL_MESSAGES[code] });
}
~~~

These are plain public objects, not raw Error instances. Never attach cause, stack, provider body, URL, Authorization, token, environment or a native message. Task 3 defines the separate stage-specific rejection object; the DTO embeds only its code/message.

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- lib/sync/types.test.ts

Expected: both test names and all seven error rows PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/verifiers/official-links/errors.test.ts lib/images/presentation.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add lib/sync/types.ts lib/sync/errors.ts lib/sync/types.test.ts
git commit -m "feat: define bulk sync result and fatal error contracts"
~~~

## Task 2 — Input expansion, normalization and bounded validation

**Files:** Create lib/sync/input.ts and lib/sync/input.test.ts.

**Interfaces:**
- Consumes: normalizeSteamAppId(input: string | number): string from lib/providers/steam/app-id.ts; Task 1 publicError.
- Produces: MAX_BATCH_SIZE = 100; BulkSyncArgs; ReadUtf8; parseBulkSyncArgs(argv, readFile); normalizeBulkSyncAppIds(values). File I/O is injected, never imported here.

- [ ] **Step 1: Write failing tests.**

~~~ts
import { expect, it, vi } from "vitest";
import { parseBulkSyncArgs } from "./input";

it("expands files in argv order and deduplicates after normalization", () => {
  const read = vi.fn(() => "20\n010\n");
  expect(parseBulkSyncArgs(["10", "--file", "ids.txt", "30"], read))
    .toEqual({ appIds: ["10", "20", "30"], write: false, json: false });
  expect(read).toHaveBeenCalledWith("ids.txt", "utf8");
});
it("accepts exactly 100 and rejects 101 unique after dedupe", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => String(i + 1));
  expect(parseBulkSyncArgs(hundred, () => "").appIds).toHaveLength(100);
  expect(() => parseBulkSyncArgs([...hundred, "101"], () => ""))
    .toThrow();
  expect(parseBulkSyncArgs([...hundred, "001"], () => "").appIds)
    .toHaveLength(100);
});
it("treats file flags as invalid App IDs", () => {
  expect(() => parseBulkSyncArgs(["--file", "ids.txt"], () => "--write\n"))
    .toThrow();
});
~~~

Because rejection objects are not Error instances, use try/catch plus expect(error).toEqual(publicError("configuration_error")) for exact error-shape assertions; use toThrow only for whether a callable throws, never for its raw text. Add table tests named "rejects invalid input before composition" for [], "0", "-1", "1.5", "NaN", "4294967296", "9007199254740993", duplicate --write/--json/--file, absent file argument, read failure, --remote/--env/--config/--database-id and unknown flags. Test "trims file lines and ignores comments" with blank/CRLF/whitespace and # comments.

- [ ] **Step 2: Observe RED.**

Run: npm test -- lib/sync/input.test.ts

Expected RED: "./input" is missing.

- [ ] **Step 3: Implement pure parsing.**

~~~ts
export const MAX_BATCH_SIZE = 100;
export type ReadUtf8 = (path: string, encoding: "utf8") => string;
export type BulkSyncArgs = { appIds: string[]; write: boolean; json: boolean };

export function normalizeBulkSyncAppIds(values: readonly string[]): string[] {
  try {
    const appIds = [...new Set(values.map((value) => normalizeSteamAppId(value)))];
    if (appIds.length < 1 || appIds.length > MAX_BATCH_SIZE) throw null;
    return appIds;
  } catch { throw publicError("configuration_error"); }
}
export function parseBulkSyncArgs(argv: readonly string[], readFile: ReadUtf8): BulkSyncArgs {
  const values: string[] = [];
  const seen = new Set<string>();
  let write = false;
  let json = false;
  try {
    for (let i = 0; i < argv.length; i += 1) {
      const token = argv[i]!;
      if (token === "--write" || token === "--json" || token === "--file") {
        if (seen.has(token)) throw null;
        seen.add(token);
        if (token === "--write") write = true;
        else if (token === "--json") json = true;
        else {
          const path = argv[++i];
          if (!path || path.startsWith("-")) throw null;
          values.push(...readFile(path, "utf8").split(/\r?\n/)
            .map((line) => line.trim()).filter((line) => line && !line.startsWith("#")));
        }
      } else {
        if (token.startsWith("-")) throw null;
        values.push(token);
      }
    }
    return { appIds: normalizeBulkSyncAppIds(values), write, json };
  } catch { throw publicError("configuration_error"); }
}
~~~

CLI positional tokens retain normalizeSteamAppId's exact numeric contract; file lines alone receive trim. File tokens never return to option parsing.

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- lib/sync/input.test.ts

Expected: every boundary/input/order row PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/sync/types.test.ts lib/providers/steam/app-id.test.ts scripts/import-steam-game.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add lib/sync/input.ts lib/sync/input.test.ts
git commit -m "feat: parse bounded bulk Steam App ID inputs"
~~~

## Task 3 — Shared stage ports, outputs and rejection contracts

**Files:** Create lib/sync/stages.ts and lib/sync/stages.test.ts. No adapter factory belongs to this task.

**Interfaces:**
- Consumes: Task 1 StageName; native SteamImportResult, IgdbEnrichmentResult, LinkVerificationService and ImageResult types.
- Produces: SteamImporterPort, IgdbEnricherPort, LinkVerifierPort, ImageWorkerClient; SteamStageOutput, StageOutput; SteamSyncStage, CanonicalSyncStage, BulkSyncStages; StageFailureCode, BulkSyncStageError, stageError, isStageError.

- [ ] **Step 1: Write failing tests.**

~~~ts
import { expect, expectTypeOf, it } from "vitest";
import { stageError, isStageError, type SteamImporterPort } from "./stages";
import type { createSteamImporter } from "../importers/steam";

it("uses the real Steam signature and plain stage errors", () => {
  expectTypeOf<ReturnType<typeof createSteamImporter>>().toExtend<SteamImporterPort>();
  const error = stageError("igdb", "mapping_ambiguous");
  expect(error).toEqual({
    stage: "igdb", code: "mapping_ambiguous",
    message: "Bulk sync igdb stage failed (mapping_ambiguous).",
  });
  expect(isStageError(error, "igdb")).toBe(true);
  expect(isStageError(new Error("secret"), "igdb")).toBe(false);
  expect(isStageError({ ...error, cause: "secret" }, "igdb")).toBe(false);
});
~~~

Add "shared contracts have no factory ownership" asserting module exports do not include createSteamStage/createIgdbStage/createLinkStage/createImageSyncStage. Add type compatibility assertions for ReturnType<typeof createIgdbEnricher>, LinkVerificationService and native ImageResult.

- [ ] **Step 2: Observe RED.**

Run: npm test -- lib/sync/stages.test.ts

Expected RED: "./stages" is missing.

- [ ] **Step 3: Define ports and contracts.**

~~~ts
export type SteamImporterPort = {
  importGame(input: string | number, options: { dryRun?: boolean }): Promise<SteamImportResult>;
};
export type IgdbEnricherPort = {
  enrichGame(gameId: number, options: { dryRun: boolean }): Promise<IgdbEnrichmentResult>;
};
export type LinkVerifierPort = Pick<LinkVerificationService, "verifyGame">;
export type ImageWorkerClient = {
  ingest(gameId: number, input: { write: boolean }): Promise<ImageResult>;
};
export type StageContext = { dryRun: boolean };
export type StageOutput = { summary: string };
export type SteamStageOutput = StageOutput & {
  gameId: number | null;
  action: SteamImportResult["plan"]["action"];
};
export type SteamSyncStage = {
  execute(appId: string, context: StageContext): Promise<SteamStageOutput>;
};
export type CanonicalSyncStage = {
  execute(gameId: number, context: StageContext): Promise<StageOutput>;
};
export type BulkSyncStages = {
  steam: SteamSyncStage;
  igdb: CanonicalSyncStage;
  links: CanonicalSyncStage;
  images: CanonicalSyncStage;
};
~~~

Import native types from lib/importers/candidate.ts, lib/enrichers/igdb-candidate.ts, lib/verifiers/official-links/service.ts and lib/images/types.ts, respectively. Do not redefine their DTOs.

StageFailureCode is the union of SteamProviderErrorCode, SteamImportErrorCode, IgdbErrorCode, LinkVerificationOperationCode, Exclude<VerificationCode, "http_result">, Exclude<ImageOutcome, the six benign outcomes listed in Task 7>, Exclude<ImageResult["preflightError"], null>, plus these explicit adapter codes:

~~~ts
type AdapterFailureCode =
  | "blocked" | "partially_applied" | "partial_result" | "failed_result"
  | "invalid_result" | "unexpected_error"
  | "worker_network_error" | "worker_http_error" | "worker_invalid_response";
export type BulkSyncStageError = {
  stage: StageName;
  code: StageFailureCode;
  message: string;
};
export function stageError(stage: StageName, code: StageFailureCode): BulkSyncStageError {
  return Object.freeze({
    stage, code, message: "Bulk sync " + stage + " stage failed (" + code + ").",
  });
}
~~~

Export STAGE_FAILURE_CODES as a readonly literal array containing every member of that union. Use satisfies readonly StageFailureCode[] plus a compile-time Exclude<StageFailureCode, typeof STAGE_FAILURE_CODES[number]> equals never assertion to detect omissions. isStageError(value, stage) returns true only for a non-null object with exactly stage/code/message keys, matching stage, a member code and message equal to stageError(stage, code).message; it never accepts caller-controlled message text. Signature: (value: unknown, stage: StageName) => value is BulkSyncStageError. Each adapter rethrows only this validated form; all other errors map to a fixed known code. Pipeline stores {code, message} only, excluding stage and all native details.

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- lib/sync/stages.test.ts

Expected: port assignability and rejection-shape tests PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/sync/types.test.ts lib/sync/input.test.ts lib/providers/igdb/errors.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add lib/sync/stages.ts lib/sync/stages.test.ts
git commit -m "feat: define bulk sync stage ports and rejection contracts"
~~~

## Task 4 — Steam adapter

**Files:** Create lib/sync/steam-stage.ts and lib/sync/steam-stage.test.ts.

**Interfaces:**
- Consumes: SteamImporterPort and StageContext.
- Produces: createSteamStage(importer: SteamImporterPort): SteamSyncStage. This factory does not construct importer/store/client; Task 10 supplies them.

- [ ] **Step 1: Write failing tests.**

~~~ts
import { expect, it, vi } from "vitest";
import { createSteamStage } from "./steam-stage";
import { SteamProviderError } from "../providers/steam/errors";
import { stageError } from "./stages";

it("passes scalar App ID and mode and discards Steam exception detail", async () => {
  const importGame = vi.fn().mockRejectedValue(
    new SteamProviderError("network_error", "token=secret", {
      retryable: true, cause: new Error("Authorization: secret"),
    }),
  );
  await expect(createSteamStage({ importGame }).execute("10", { dryRun: true }))
    .rejects.toEqual(stageError("steam", "network_error"));
  expect(importGame).toHaveBeenCalledExactlyOnceWith("10", { dryRun: true });
});
~~~

For success test fixtures create a complete SteamImportResult using parseSteamAppDetails + normalizeSteamGame on existing test/fixtures/steam/appdetails-minimal-valid.json (App ID 1245620). Set plan fields action, existingGameId, selectedSlug "elden-ring", candidate from normalization, resolvedCompanies/creates/updates/skips/warnings empty arrays. Return status created/updated/existing, matching plan action create/update/existing, appId "1245620", mode and gameId. Test "Steam native statuses preserve canonical identity" for created dry/null, created write/41, updated dry/41 and existing dry/41. Reject mismatched appId/dryRun, nonpositive/unsafe gameId and missing write gameId with invalid_result. Test native error rows below by constructing real error classes.

- [ ] **Step 2: Observe RED.**

Run: npm test -- lib/sync/steam-stage.test.ts

Expected RED: "./steam-stage" is missing.

- [ ] **Step 3: Implement the adapter.**

~~~ts
export function createSteamStage(importer: SteamImporterPort): SteamSyncStage {
  return {
    async execute(appId, context) {
      try {
        const result = await importer.importGame(appId, { dryRun: context.dryRun });
        const validId = result.gameId !== null && Number.isSafeInteger(result.gameId) && result.gameId > 0;
        const newDry = context.dryRun && result.status === "created"
          && result.plan.action === "create" && result.gameId === null;
        if (result.appId !== appId || result.dryRun !== context.dryRun
          || !["created", "updated", "existing"].includes(result.status)
          || !["create", "update", "existing"].includes(result.plan.action) || (!validId && !newDry)) {
          throw stageError("steam", "invalid_result");
        }
        return { gameId: result.gameId, action: result.plan.action, summary: "Steam " + result.status + "." };
      } catch (error) {
        if (isStageError(error, "steam")) throw error;
        if (error instanceof SteamProviderError || error instanceof SteamImportError) {
          throw stageError("steam", error.code);
        }
        throw stageError("steam", "unexpected_error");
      }
    },
  };
}
~~~

Native statuses created/updated/existing succeed after identity/mode checks. An existing write result may retain plan.action=update after native zero-row recovery; do not require status and action to be a one-to-one pair. Include that case in the status fixture test. Native codes map one-to-one to the same BulkSyncStageError.code with stage steam and the fixed stage message:

| Native class | All mapped codes |
| --- | --- |
| SteamProviderError | timeout, network_error, rate_limited, provider_unavailable, http_error, malformed_json, schema_changed, app_not_found, app_id_mismatch, unsupported_app_type, invalid_app_id |
| SteamImportError | taxonomy_conflict, company_conflict, write_conflict, write_incomplete |
| Other throw | unexpected_error |

No provider plan, title, URL, warning, exception message or retryable flag enters the output. Native importer retry/conservative behavior is unchanged; the adapter itself invokes importGame once.

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- lib/sync/steam-stage.test.ts

Expected: scalar signature, all native statuses, invalid returns and every native error row PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/sync/stages.test.ts lib/importers/steam.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add lib/sync/steam-stage.ts lib/sync/steam-stage.test.ts
git commit -m "feat: adapt Steam import for bulk sync"
~~~

## Task 5 — IGDB adapter

**Files:** Create lib/sync/igdb-stage.ts and lib/sync/igdb-stage.test.ts.

**Interfaces:**
- Consumes: IgdbEnricherPort and StageContext.
- Produces: createIgdbStage(enricher: IgdbEnricherPort): CanonicalSyncStage.

- [ ] **Step 1: Write failing tests.**

~~~ts
import { expect, it, vi } from "vitest";
import { createIgdbStage } from "./igdb-stage";
import { stageError } from "./stages";

it("maps enrich and existing to success and blocked to failure", async () => {
  for (const action of ["enrich", "existing", "blocked"] as const) {
    const enrichGame = vi.fn().mockResolvedValue({
      status: action, gameId: 41, dryRun: true, affectedRows: 0,
      plan: { action, gameId: 41, slug: "game", matchedIgdbGame: null,
        creates: [], updates: [], skips: [], warnings: [], conflicts: [] },
    });
    const promise = createIgdbStage({ enrichGame }).execute(41, { dryRun: true });
    if (action === "blocked") await expect(promise).rejects.toEqual(stageError("igdb", "blocked"));
    else await expect(promise).resolves.toEqual({ summary: "IGDB " + action + "." });
    expect(enrichGame).toHaveBeenCalledExactlyOnceWith(41, { dryRun: true });
  }
});
~~~

Add "maps every IgdbError without payload or secret" using all rows below and IgdbError(code, "secret", {retryable:false,cause:"secret"}). Add "rejects IGDB identity or mode mismatch"; include write propagation and unknown throw. Benign fill-empty conflicts in an enrich/existing plan are not independently reclassified; native blocked or thrown write_conflict determines failure.

- [ ] **Step 2: Observe RED.**

Run: npm test -- lib/sync/igdb-stage.test.ts

Expected RED: "./igdb-stage" is missing.

- [ ] **Step 3: Implement the adapter.**

~~~ts
export function createIgdbStage(enricher: IgdbEnricherPort): CanonicalSyncStage {
  return { async execute(gameId, context) {
    try {
      const result = await enricher.enrichGame(gameId, { dryRun: context.dryRun });
      if (result.gameId !== gameId || result.dryRun !== context.dryRun
        || result.plan.action !== result.status) throw stageError("igdb", "invalid_result");
      if (result.status === "blocked") throw stageError("igdb", "blocked");
      if (result.status !== "enrich" && result.status !== "existing")
        throw stageError("igdb", "invalid_result");
      return { summary: "IGDB " + result.status + "." };
    } catch (error) {
      if (isStageError(error, "igdb")) throw error;
      if (error instanceof IgdbError) throw stageError("igdb", error.code);
      throw stageError("igdb", "unexpected_error");
    }
  } };
}
~~~

Exhaustive native IgdbErrorCode mapping; every target uses stage igdb and message generated solely from the literal code:

| IgdbError.code | BulkSyncStageError.code |
| --- | --- |
| missing_credentials | missing_credentials |
| invalid_credentials | invalid_credentials |
| authentication_failed | authentication_failed |
| timeout | timeout |
| network_error | network_error |
| rate_limited | rate_limited |
| provider_unavailable | provider_unavailable |
| http_error | http_error |
| malformed_json | malformed_json |
| schema_changed | schema_changed |
| canonical_game_not_found | canonical_game_not_found |
| steam_external_id_missing | steam_external_id_missing |
| mapping_not_found | mapping_not_found |
| mapping_ambiguous | mapping_ambiguous |
| unsupported_mapping | unsupported_mapping |
| igdb_game_not_found | igdb_game_not_found |
| write_conflict | write_conflict |
| invalid_game_id | invalid_game_id |

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- lib/sync/igdb-stage.test.ts

Expected: status and all 18 code rows PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/sync/stages.test.ts lib/sync/steam-stage.test.ts lib/enrichers/igdb.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add lib/sync/igdb-stage.ts lib/sync/igdb-stage.test.ts
git commit -m "feat: adapt IGDB enrichment for bulk sync"
~~~

## Task 6 — Official-link adapter and code-first precedence

**Files:** Create lib/sync/link-stage.ts and lib/sync/link-stage.test.ts.

**Interfaces:**
- Consumes: LinkVerifierPort, native GameLinkVerificationResult, VerificationCode.
- Produces: createLinkStage(verifier: LinkVerifierPort): CanonicalSyncStage.

- [ ] **Step 1: Write failing tests.**

~~~ts
import { expect, it, vi } from "vitest";
import { createLinkStage } from "./link-stage";
import { stageError } from "./stages";
import type { GameLinkVerificationResult, VerificationCode } from "../verifiers/official-links/types";

function linkResult(code: VerificationCode): GameLinkVerificationResult {
  return {
    gameId: 41, dryRun: true, status: "planned", affectedRows: 0, conflicts: [],
    plan: { gameId: 41, dryRun: true, linksRead: 1, items: [], verificationResults: [{
      gameId: 41, linkId: 1, originalUrl: "https://example.com/?token=secret",
      code, classification: "broken", httpStatus: 404,
      finalUrl: null, attempts: [], redirectChain: [], checkedAt: new Date(0),
    }] },
  };
}
it("keeps completed HTTP 404 diagnostic but fails transport code", async () => {
  const verifyGame = vi.fn().mockResolvedValue(linkResult("http_result"));
  await expect(createLinkStage({ verifyGame }).execute(41, { dryRun: true }))
    .resolves.toEqual({ summary: "Links planned; checked=1; broken=1." });
  verifyGame.mockResolvedValue(linkResult("dns_failure"));
  await expect(createLinkStage({ verifyGame }).execute(41, { dryRun: true }))
    .rejects.toEqual(stageError("links", "dns_failure"));
});
it("reads write conflicts separately from VerificationCode", async () => {
  const result = linkResult("http_result");
  result.conflicts = [{ linkId: 1, code: "write_conflict" }];
  await expect(createLinkStage({ verifyGame: vi.fn().mockResolvedValue(result) })
    .execute(41, { dryRun: true })).rejects.toEqual(stageError("links", "write_conflict"));
});
~~~

Add "fails every non-http VerificationCode", "partial application fails without conflicts", "HTTP classifications alone do not fail", "empty and manual-only plans succeed", "preserves link mode and game ID", and "maps link operation errors without raw text".

- [ ] **Step 2: Observe RED.**

Run: npm test -- lib/sync/link-stage.test.ts

Expected RED: "./link-stage" is missing.

- [ ] **Step 3: Implement classification in this exact order.**

~~~ts
export function createLinkStage(verifier: LinkVerifierPort): CanonicalSyncStage {
  return { async execute(gameId, context) {
    try {
      const result = await verifier.verifyGame(gameId, { dryRun: context.dryRun });
      if (result.gameId !== gameId || result.dryRun !== context.dryRun)
        throw stageError("links", "invalid_result");
      if (result.conflicts.length > 0) throw stageError("links", "write_conflict");
      if (result.status === "partially_applied") throw stageError("links", "partially_applied");
      const operation = result.plan.verificationResults.find((item) => item.code !== "http_result");
      if (operation) throw stageError("links", operation.code as Exclude<VerificationCode, "http_result">);
      const classes = ["verified", "reachable_but_unverified", "broken",
        "temporarily_unavailable", "unsafe", "unknown"] as const;
      const counts = classes.map((value) => [value,
        result.plan.verificationResults.filter((item) => item.classification === value).length] as const)
        .filter(([, count]) => count > 0).map(([name, count]) => name + "=" + count);
      const suffix = counts.length ? "; " + counts.join("; ") : "";
      return { summary: "Links " + result.status + "; checked="
        + result.plan.verificationResults.length + suffix + "." };
    } catch (error) {
      if (isStageError(error, "links")) throw error;
      if (error instanceof LinkVerificationError) throw stageError("links", error.code);
      throw stageError("links", "unexpected_error");
    }
  } };
}
~~~

Before aggregate selection, validate status is planned/applied/partially_applied/no_changes, every classification is a member of the six-value native enum and every code belongs to the exact enum below; otherwise invalid_result. No raw field is interpolated into summary.

| Native source | Rule |
| --- | --- |
| VerificationCode http_result | Completed diagnostic; eligible success |
| invalid_url, unsupported_scheme, unsafe_destination, dns_failure, timeout, network_error, tls_error, redirect_loop, too_many_redirects, invalid_redirect, protocol_downgrade | Failed with identical code, regardless of classification |
| result.conflicts[] nonempty | Failed write_conflict; conflicts are not VerificationCode |
| status partially_applied | Failed partially_applied |
| planned, applied, no_changes with no operation failure/conflict | Succeeded |
| HTTP classifications verified, reachable_but_unverified, broken, temporarily_unavailable, unsafe, unknown | Numeric diagnostics only; never independently fail |
| LinkVerificationError invalid_game_id, game_not_found, link_limit_exceeded, database_unavailable, local_platform_unavailable, write_failed, cleanup_failed, unexpected_error | Failed identical code |
| Other throw | Failed unexpected_error |

Manual verification remains owned by the existing planner/store: adapter does not write or edit metadata. Test a real service plan containing manual_verification_preserved and verify adapter leaves it unchanged.

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- lib/sync/link-stage.test.ts

Expected: all code/classification/conflict/empty/manual rows PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/sync/stages.test.ts lib/verifiers/official-links/service.test.ts lib/verifiers/official-links/plan.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add lib/sync/link-stage.ts lib/sync/link-stage.test.ts
git commit -m "feat: adapt official link verification with code-first failure mapping"
~~~

## Task 7 — Image adapter and exhaustive native result mapping

**Files:** Create lib/sync/image-stage.ts and lib/sync/image-stage.test.ts.

**Interfaces:**
- Consumes: Task 3 ImageWorkerClient and native ImageResult/ImageOutcome.
- Produces: createImageSyncStage(client: ImageWorkerClient): CanonicalSyncStage; IMAGE_OUTCOMES readonly tuple for exhaustive tests. HTTP implementation belongs to Task 10.

- [ ] **Step 1: Write failing tests.**

~~~ts
import { expect, it, vi } from "vitest";
import { createImageSyncStage } from "./image-stage";
import { stageError } from "./stages";
import { imageItemFixture } from "../../test/helpers/image-result-fixture";

it("maps image status and forwards only gameId and write", async () => {
  const ingest = vi.fn().mockResolvedValue({
    gameId: 41, status: "completed", preflightError: null, plan: null,
    images: [imageItemFixture({ outcome: "concurrent_dedup" })],
  });
  await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: true }))
    .resolves.toEqual({ summary: "Images completed; concurrent_dedup=1." });
  expect(ingest).toHaveBeenCalledExactlyOnceWith(41, { write: false });
  ingest.mockResolvedValue({ gameId: 41, status: "partial", preflightError: null,
    plan: null, images: [imageItemFixture({ outcome: "storage_failed" })] });
  await expect(createImageSyncStage({ ingest }).execute(41, { dryRun: false }))
    .rejects.toEqual(stageError("images", "storage_failed"));
});
~~~

Add "covers all nineteen ImageOutcome values" as table using every row below; "maps all image preflight errors"; "completed empty result succeeds"; "partial and failed cannot become success"; "unknown client throw is redacted". No lib/sync HTTP or env import.

- [ ] **Step 2: Observe RED.**

Run: npm test -- lib/sync/image-stage.test.ts

Expected RED: "./image-stage" is missing.

- [ ] **Step 3: Implement aggregate mapping.**

| ImageOutcome | Completed result | Partial/failed result |
| --- | --- | --- |
| ingested | benign | Aggregate failed |
| deduplicated | benign | Aggregate failed |
| concurrent_dedup | benign | Aggregate failed |
| already_ingested | benign | Aggregate failed |
| restored | benign | Aggregate failed |
| skipped | benign | Aggregate failed |
| inconsistent_state | Invalid contradictory completed result | Failed inconsistent_state |
| source_rejected | Invalid contradictory completed result | Failed source_rejected |
| redirect_rejected | Invalid contradictory completed result | Failed redirect_rejected |
| download_failed | Invalid contradictory completed result | Failed download_failed |
| deadline | Invalid contradictory completed result | Failed deadline |
| invalid_image | Invalid contradictory completed result | Failed invalid_image |
| mime_mismatch | Invalid contradictory completed result | Failed mime_mismatch |
| too_large | Invalid contradictory completed result | Failed too_large |
| storage_conflict | Invalid contradictory completed result | Failed storage_conflict |
| storage_failed | Invalid contradictory completed result | Failed storage_failed |
| source_changed | Invalid contradictory completed result | Failed source_changed |
| write_conflict | Invalid contradictory completed result | Failed write_conflict |
| d1_write_failed | Invalid contradictory completed result | Failed d1_write_failed |

Valid native status completed succeeds; partial and failed always fail. An impossible completed result containing a failing outcome/preflight is rejected as invalid_result, not accepted as a native completed success. Task 10 response validation enforces the same consistency rule.

~~~ts
export function createImageSyncStage(client: ImageWorkerClient): CanonicalSyncStage {
  return { async execute(gameId, context) {
    try {
      const result = await client.ingest(gameId, { write: !context.dryRun });
      if (result.gameId !== gameId) throw stageError("images", "invalid_result");
      const benign: readonly ImageOutcome[] = [
        "ingested", "deduplicated", "concurrent_dedup", "already_ingested", "restored", "skipped",
      ];
      const failedItem = result.images.find((image) => !benign.includes(image.outcome));
      if (result.status === "completed") {
        if (result.preflightError !== null || failedItem) throw stageError("images", "invalid_result");
        const counts = IMAGE_OUTCOMES.map((outcome) =>
          [outcome, result.images.filter((image) => image.outcome === outcome).length] as const)
          .filter(([, count]) => count > 0).map(([outcome, count]) => outcome + "=" + count);
        return { summary: "Images completed" + (counts.length ? "; " + counts.join("; ") : "") + "." };
      }
      if (result.preflightError !== null) throw stageError("images", result.preflightError);
      if (failedItem) throw stageError("images", failedItem.outcome as StageFailureCode);
      if (result.status === "partial") throw stageError("images", "partial_result");
      if (result.status === "failed") throw stageError("images", "failed_result");
      throw stageError("images", "invalid_result");
    } catch (error) {
      if (isStageError(error, "images")) throw error;
      throw stageError("images", "unexpected_error");
    }
  } };
}
~~~

Define IMAGE_OUTCOMES in the exact 19-row order above with satisfies readonly ImageOutcome[] and an exhaustiveness type assertion. Preflight invalid_request/game_not_found/image_limit_exceeded/game_deadline each maps to an identical public code, stage images, fixed stage message. Choose preflight first, then first failing item in response order, then aggregate fallback. Summaries contain only enum literals/counts; discard full plan, URLs, attempts and response error text at the adapter boundary.

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- lib/sync/image-stage.test.ts

Expected: every native outcome/preflight/status row PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/sync/stages.test.ts lib/images/service.test.ts lib/images/presentation.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add lib/sync/image-stage.ts lib/sync/image-stage.test.ts
git commit -m "feat: adapt image Worker results for bulk sync"
~~~

## Task 8 — Single-game state machine

**Files:** Create lib/sync/game-pipeline.ts and lib/sync/game-pipeline.test.ts.

**Interfaces:**
- Consumes: BulkSyncStages, Task 1 DTOs.
- Produces: runBulkSyncGame(input: { appId: string; dryRun: boolean; stages: BulkSyncStages }): Promise<BulkGameResult>.

- [ ] **Step 1: Write failing tests.**

~~~ts
import { expect, it, vi } from "vitest";
import { runBulkSyncGame } from "./game-pipeline";
import { stageError } from "./stages";

it("new dry-run create skips three stages without a fake ID", async () => {
  const next = vi.fn();
  const result = await runBulkSyncGame({ appId: "10", dryRun: true, stages: {
    steam: { execute: async () => ({ gameId: null, action: "create", summary: "Steam created." }) },
    igdb: { execute: next }, links: { execute: next }, images: { execute: next },
  } });
  expect(result.status).toBe("succeeded");
  expect(result.gameId).toBeNull();
  expect(result.stages.map((stage) => [stage.name, stage.status, stage.reason])).toEqual([
    ["steam", "succeeded", undefined],
    ["igdb", "not_run", "canonical_game_not_persisted"],
    ["links", "not_run", "canonical_game_not_persisted"],
    ["images", "not_run", "canonical_game_not_persisted"],
  ]);
  expect(next).not.toHaveBeenCalled();
});
it("a failed stage stops only remaining stages", async () => {
  const images = vi.fn();
  const result = await runBulkSyncGame({ appId: "10", dryRun: false, stages: {
    steam: { execute: async () => ({ gameId: 41, action: "create", summary: "Steam created." }) },
    igdb: { execute: async () => ({ summary: "IGDB enrich." }) },
    links: { execute: async () => { throw stageError("links", "write_conflict"); } },
    images: { execute: images },
  } });
  expect(result.status).toBe("failed");
  expect(result.stages[3]).toMatchObject({ status: "not_run", reason: "previous_stage_failed" });
  expect(images).not.toHaveBeenCalled();
});
~~~

Add "fixed four-stage order and mode on existing dry-run and write" with event log; parameterize "fail-fast at each stage" for all four positions; "write requires real canonical ID"; "unknown stage exception becomes fixed error without rollback".

- [ ] **Step 2: Observe RED.**

Run: npm test -- lib/sync/game-pipeline.test.ts

Expected RED: "./game-pipeline" is missing.

- [ ] **Step 3: Implement the state machine.**

~~~ts
export async function runBulkSyncGame(input: {
  appId: string; dryRun: boolean; stages: BulkSyncStages;
}): Promise<BulkGameResult> {
  let gameId: number | null = null;
  let failed = false;
  let skip: NotRunReason | undefined;
  const results: BulkStageResult[] = [];
  const context = { dryRun: input.dryRun };
  for (const name of STAGE_NAMES) {
    if (skip) {
      results.push({ name, status: "not_run", reason: skip, summary: "Stage not run: " + skip + "." });
      continue;
    }
    try {
      let output: StageOutput;
      if (name === "steam") {
        const steam = await input.stages.steam.execute(input.appId, context);
        gameId = steam.gameId;
        const hasId = gameId !== null && Number.isSafeInteger(gameId) && gameId > 0;
        if (!hasId) {
          if (input.dryRun && steam.action === "create" && gameId === null)
            skip = "canonical_game_not_persisted";
          else { gameId = null; throw stageError(name, "invalid_result"); }
        }
        output = steam;
      } else {
        if (gameId === null) throw stageError(name, "invalid_result");
        output = await input.stages[name].execute(gameId, context);
      }
      results.push({ name, status: "succeeded", summary: output.summary });
    } catch (cause) {
      const error = isStageError(cause, name) ? cause : stageError(name, "unexpected_error");
      results.push({ name, status: "failed", summary: "Stage failed.",
        error: { code: error.code, message: error.message } });
      failed = true;
      skip = "previous_stage_failed";
    }
  }
  return { appId: input.appId, gameId, status: failed ? "failed" : "succeeded", stages: results };
}
~~~

No direct store, transaction, rollback, child process, retry or network call. Expected adapter rejections become failed entries. Unexpected infrastructure outside this per-stage catch is left to Task 9/11's fatal complete-result rule.

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- lib/sync/game-pipeline.test.ts

Expected: every game result has exactly four ordered stages; all failure-position tests PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/sync/stages.test.ts lib/sync/steam-stage.test.ts lib/sync/igdb-stage.test.ts lib/sync/link-stage.test.ts lib/sync/image-stage.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add lib/sync/game-pipeline.ts lib/sync/game-pipeline.test.ts
git commit -m "feat: implement fail-fast single-game sync pipeline"
~~~

## Task 9 — Serial batch and complete-result boundary

**Files:** Create lib/sync/batch.ts and lib/sync/batch.test.ts.

**Interfaces:**
- Consumes: BulkSyncStages and runBulkSyncGame from Task 8.
- Produces: runBulkSyncBatch(input: { appIds: readonly string[]; dryRun: boolean; stages: BulkSyncStages }): Promise<BulkGameSyncResult>; assertCompleteBatch(result: BulkGameSyncResult, appIds: readonly string[], dryRun: boolean): void.

- [ ] **Step 1: Write failing tests.**

~~~ts
import { expect, it } from "vitest";
import { runBulkSyncBatch } from "./batch";
import { stageError, type BulkSyncStages } from "./stages";

it("runs A complete pipeline before B and continues after game failure", async () => {
  const events: string[] = [];
  const stages: BulkSyncStages = {
    steam: { execute: async (id) => {
      events.push(id + " steam");
      return { gameId: Number(id), action: "existing", summary: "Steam existing." };
    } },
    igdb: { execute: async (id) => { events.push(id + " igdb"); return { summary: "IGDB existing." }; } },
    links: { execute: async (id) => {
      events.push(id + " links");
      if (id === 20) throw stageError("links", "timeout");
      return { summary: "Links no_changes; checked=0." };
    } },
    images: { execute: async (id) => { events.push(id + " images"); return { summary: "Images completed." }; } },
  };
  const result = await runBulkSyncBatch({ appIds: ["10", "20", "30"], dryRun: true, stages });
  expect(events).toEqual([
    "10 steam", "10 igdb", "10 links", "10 images",
    "20 steam", "20 igdb", "20 links",
    "30 steam", "30 igdb", "30 links", "30 images",
  ]);
  expect(result).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
});
~~~

Add "awaits unresolved game before starting next" using a manually released Promise in game A image stage; B steam count stays zero until release. Add "validates batch before stage calls", "returns counts and normalized order", "rejects incomplete count or input mismatch", "no retries after failed game". Use input ["010","10"] to verify normalize/dedupe; output total is 1.

- [ ] **Step 2: Observe RED.**

Run: npm test -- lib/sync/batch.test.ts

Expected RED: "./batch" is missing.

- [ ] **Step 3: Implement serial execution.**

~~~ts
export async function runBulkSyncBatch(input: {
  appIds: readonly string[]; dryRun: boolean; stages: BulkSyncStages;
}): Promise<BulkGameSyncResult> {
  const appIds = normalizeBulkSyncAppIds(input.appIds);
  const games: BulkGameResult[] = [];
  for (const appId of appIds) {
    games.push(await runBulkSyncGame({ appId, dryRun: input.dryRun, stages: input.stages }));
  }
  const failed = games.filter((game) => game.status === "failed").length;
  const result = { dryRun: input.dryRun, total: games.length,
    succeeded: games.length - failed, failed, games };
  assertCompleteBatch(result, appIds, input.dryRun);
  return result;
}
~~~

assertCompleteBatch checks expected normalized length/order/appId, dryRun, total === games.length, exact succeeded/failed counts, exactly four STAGE_NAMES per game, valid gameId/null, allowed status/reason/error shapes and game failed iff a stage failed. New-create successful games may contain three canonical_game_not_persisted skips; after the first failure all later entries must be previous_stage_failed skips. A failed check throws publicError("batch_execution_failed"). A rejected runBulkSyncGame call is not caught to fabricate partial output; Task 11 emits no batch when this occurs. No Promise.all, pool, sleep, retry or rollback.

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- lib/sync/batch.test.ts

Expected: event sequence, gating, counts and invariant tests PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/sync/game-pipeline.test.ts lib/sync/input.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add lib/sync/batch.ts lib/sync/batch.test.ts
git commit -m "feat: aggregate complete bulk sync results sequentially"
~~~

## Task 10 — CLI-side configuration, HTTP client and lifecycle factory

**Files:** Create scripts/sync-composition.ts, scripts/sync-composition.test.ts, scripts/sync-image-client.ts and scripts/sync-image-client.test.ts.

**Interfaces:**
- Consumes: native createDatabase, createSteamClient/createSteamImporter/createSteamImportStore, createIgdbAuthClient/createIgdbClient/createIgdbEnricher/createIgdbEnrichmentStore, createLinkVerificationService/createLinkVerificationStore, V2.5 resolver/transport/verifier, and Task 4–7 factories.
- Produces: BulkSyncConfig, validateBulkSyncConfig; LocalPlatform, BulkSyncDependencies, CompositionHooks, createLocalBulkSyncDependencies, composeLocalBulkSyncStages; createImageWorkerClient and parseImageWorkerResponse.
- Task 10 owns endpoint/token/request/fetch/JSON/DTO validation and platform setup. Task 11 owns invocation, batch, CLI disposal and sinks.

- [ ] **Step 1: Write failing tests.**

~~~ts
import { expect, it, vi } from "vitest";
import { createImageWorkerClient } from "./sync-image-client";
import { stageError } from "../lib/sync/stages";

it("builds one authenticated local request and fails closed on wrong gameId", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    gameId: 42, status: "completed", preflightError: null, plan: null, images: [],
  }), { status: 200 }));
  const client = createImageWorkerClient({
    workerUrl: "http://127.0.0.1:8787/internal/images/ingest", token: "fixture-token", fetchImpl,
  });
  await expect(client.ingest(41, { write: false }))
    .rejects.toEqual(stageError("images", "worker_invalid_response"));
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    "http://127.0.0.1:8787/internal/images/ingest",
    { method: "POST", redirect: "error", headers: {
      "Content-Type": "application/json", Authorization: "Bearer fixture-token",
    }, body: JSON.stringify({ gameId: 41, write: false }) },
  );
});
~~~

In sync-composition.test.ts:

~~~ts
it("factory owns one disposal when composition and cleanup both fail", async () => {
  const dispose = vi.fn().mockRejectedValue(new Error("cleanup-secret"));
  const acquire = vi.fn().mockResolvedValue({ env: { DB: {} }, dispose });
  const compose = vi.fn(() => { throw new Error("compose-secret"); });
  const config = validateBulkSyncConfig({
    TWITCH_CLIENT_ID: "fixture-id", TWITCH_CLIENT_SECRET: "fixture-secret",
    IMAGE_INGEST_TOKEN: "fixture-token",
  });
  await expect(createLocalBulkSyncDependencies(config, { acquire, compose }))
    .rejects.toEqual(publicError("composition_failed"));
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
});
~~~

Add "validates all configuration before acquisition", "acquisition failure transfers no handle", "successful factory transfers disposal without invoking it", "all local stores receive one D1 binding", "fixed local config rejects remote target", and the HTTP failure table below.

- [ ] **Step 2: Observe RED.**

Run: npm test -- scripts/sync-composition.test.ts scripts/sync-image-client.test.ts

Expected RED: the two production modules do not resolve.

- [ ] **Step 3: Implement exact CLI-side contracts and ownership.**

~~~ts
export type BulkSyncConfig = {
  clientId: string;
  clientSecret: string;
  workerUrl: string;
  token: string;
};
export type LocalPlatform = {
  env: { DB: AnyD1Database };
  dispose(): Promise<void> | void;
};
export type BulkSyncDependencies = {
  stages: BulkSyncStages;
  dispose(): Promise<void>;
};
export type CompositionHooks = {
  acquire(): Promise<LocalPlatform>;
  compose(binding: AnyD1Database, config: BulkSyncConfig): BulkSyncStages;
};
export function validateBulkSyncConfig(
  env: Readonly<Record<string, string | undefined>>,
): BulkSyncConfig;
export async function createLocalBulkSyncDependencies(
  config: BulkSyncConfig,
  hooks: CompositionHooks = defaultCompositionHooks,
): Promise<BulkSyncDependencies> {
  let platform: LocalPlatform;
  try { platform = await hooks.acquire(); }
  catch { throw publicError("platform_unavailable"); }
  try {
    const stages = hooks.compose(platform.env.DB, config);
    return { stages, dispose: async () => { await platform.dispose(); } };
  } catch {
    try { await platform.dispose(); } catch { /* composition remains primary */ }
    throw publicError("composition_failed");
  }
}
~~~

Config validation requires nonblank TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET (preserve the supplied exact strings; never include them in errors) and IMAGE_INGEST_TOKEN with length > 0, no whitespace and no leading/trailing whitespace. IMAGE_INGEST_WORKER_URL unset/blank defaults to http://127.0.0.1:8787/internal/images/ingest. An explicit URL must parse as http, hostname 127.0.0.1 or localhost, port 8787, exact /internal/images/ingest path, no username/password/query/fragment. Normalize localhost to 127.0.0.1. Reject HTTPS, IPv6 alternate endpoint, other ports/paths, preview/production names, credentials or query at validation; --write does not influence endpoint. Every rejection is publicError("configuration_error"). There is no remote/config/database override argument.

defaultCompositionHooks.acquire dynamically imports Wrangler and calls its real getPlatformProxy with:

~~~ts
{
  configPath: fileURLToPath(new URL("../wrangler.jsonc", import.meta.url)),
  persist: { path: fileURLToPath(new URL("../.wrangler/state/v3", import.meta.url)) },
  remoteBindings: false,
  envFiles: [],
}
~~~

This is equivalent persistent local storage with an explicit repository path. The existing V2.6 test helper documents that wrangler dev --persist-to P uses P/v3; do not accidentally point proxy to P while Worker points to P/v3. Use GetPlatformProxyOptions from Wrangler; do not invent a reduced library signature. Acquisition helper owns incomplete resources if it rejects before a handle exists. The factory must never call dispose on a rejected acquisition. A successful handle owns exactly one dispose attempt in the CLI; failed composition owns exactly one in the factory. No retry.

composeLocalBulkSyncStages(binding: AnyD1Database, config: BulkSyncConfig, ports?: BulkSyncTransportOverrides): BulkSyncStages is exported for deterministic integration composition. The test-only transport overrides are injected function values, never CLI flags or environment options:

~~~ts
export type BulkSyncTransportOverrides = {
  steamFetch?: typeof fetch;
  igdbFetch?: typeof fetch;
  authFetch?: typeof fetch;
  verifyBoundUrl?: VerifyBoundUrl;
  imageFetch?: typeof fetch;
};
export function composeLocalBulkSyncStages(
  binding: AnyD1Database, config: BulkSyncConfig, ports: BulkSyncTransportOverrides = {},
): BulkSyncStages {
  const db = createDatabase(binding);
  const auth = createIgdbAuthClient({
    clientId: config.clientId, clientSecret: config.clientSecret, fetch: ports.authFetch,
  });
  return {
    steam: createSteamStage(createSteamImporter({
      client: createSteamClient({ fetch: ports.steamFetch }), store: createSteamImportStore(db),
    })),
    igdb: createIgdbStage(createIgdbEnricher({
      client: createIgdbClient({ auth, clientId: config.clientId, fetch: ports.igdbFetch }),
      store: createIgdbEnrichmentStore(db),
    })),
    links: createLinkStage(createLinkVerificationService({
      store: createLinkVerificationStore(db),
      verifyUrl: ports.verifyBoundUrl ?? createLocalBoundVerifier(),
    })),
    images: createImageSyncStage(createImageWorkerClient({
      workerUrl: config.workerUrl, token: config.token, fetchImpl: ports.imageFetch ?? fetch,
    })),
  };
}
~~~

createLocalBoundVerifier(): VerifyBoundUrl is private in sync-composition.ts. Reproduce only the composition from scripts/verify-official-links.ts: createSafeDestinationResolver with node:dns/promises lookup(hostname, {all:true}); reject families outside 4/6; executeRedirectChain uses that resolver, the unchanged requestHeaders and now:()=>new Date(); return (url,options)=>verifyUrl(url,{executeChain},options). Reuse V2.5 code for every SSRF validation, HEAD/GET fallback, DNS/socket binding, deadline and write rule. Do not copy or change verifier internals.

**HTTP client ownership and contract**

createImageWorkerClient({workerUrl,token,fetchImpl}: {workerUrl:string;token:string;fetchImpl:typeof fetch}): ImageWorkerClient closes over validated endpoint/token; lib/sync receives only the ingest method. The client alone builds POST {gameId,write}, sets JSON and Bearer headers, uses redirect:"error", calls the injected fetch, parses response JSON, validates it and checks requested identity/mode. No response body is logged. No redirect follows credentials.

~~~ts
export function createImageWorkerClient(input: {
  workerUrl: string; token: string; fetchImpl: typeof fetch;
}): ImageWorkerClient {
  return { async ingest(gameId, options) {
    let response: Response;
    try {
      response = await input.fetchImpl(input.workerUrl, {
        method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + input.token },
        body: JSON.stringify({ gameId, write: options.write }),
      });
    } catch { throw stageError("images", "worker_network_error"); }
    if (!response.ok) throw stageError("images", "worker_http_error");
    try {
      return parseImageWorkerResponse(await response.json(), gameId, options.write);
    } catch { throw stageError("images", "worker_invalid_response"); }
  } };
}
~~~

parseImageWorkerResponse(value: unknown, gameId: number, write: boolean): ImageResult lives in sync-image-client.ts. Use existing Zod, not a cast of response.json(). Native Worker presentation converts gameSnapshot.updatedAt to ISO string; validate and convert that field back to Date so this port returns the actual native ImageResult type. All objects below are z.strictObject, every listed key required, null permitted only where stated. No unknown provider fields enter the result.

~~~ts
const id = z.number().int().positive().safe();
const n = z.number().int().nonnegative().safe();
const text = z.string();
const nullableText = text.nullable();
const provider = z.enum(["steam", "igdb"]);
const timing = z.strictObject({
  startedAt: z.number().finite(), finishedAt: z.number().finite(), durationMs: z.number().nonnegative().finite(),
});
const dimensions = z.strictObject({ width: id, height: id }).nullable();
const redirect = z.strictObject({
  fromUrl: text, location: nullableText, resolvedUrl: nullableText, status: z.number().int(),
});
const attempt = z.strictObject({
  url: text, presentationUrl: text, provider, method: z.literal("GET"),
  hopStatus: z.enum(["redirect", "response", "failed"]), status: z.number().int().nullable(),
  headers: z.strictObject({ contentType: nullableText, contentLength: nullableText }),
  location: nullableText, redirectChain: z.array(redirect), finalUrl: nullableText,
  selectedMimeType: nullableText, byteCount: n.nullable(), contentHash: nullableText,
  dimensions, timing, errorCode: nullableText,
});
const item = z.strictObject({
  imageId: id.nullable(), outcome: z.enum(IMAGE_OUTCOMES),
  sourceUrl: text, presentationUrl: text, provider: provider.nullable(),
  attempts: z.array(attempt), redirectChain: z.array(redirect), finalUrl: nullableText,
  httpStatus: z.number().int().nullable(), selectedMimeType: nullableText,
  byteCount: n.nullable(), contentHash: nullableText, dimensions, timing,
  error: z.strictObject({
    stage: z.enum(["source", "download", "validation", "hash", "storage", "d1"]), code: text,
  }).nullable(),
});
const candidate = z.strictObject({
  gameId: id, type: z.enum(["cover", "hero", "screenshot", "artwork", "logo"]),
  sourceUrl: text, provider, width: id.nullable(), height: id.nullable(),
  sortOrder: n, existingId: id.nullable(), mode: z.enum(["read_only", "write"]),
  reason: z.enum(["create_missing_scalar", "inspect_existing_storage", "ingest_existing_image"]),
});
const plan = z.strictObject({
  gameId: id,
  gameSnapshot: z.strictObject({
    id, coverUrl: nullableText, heroUrl: nullableText,
    updatedAt: z.iso.datetime().transform((value) => new Date(value)),
  }).nullable(),
  candidates: z.array(candidate),
  rejected: z.array(z.strictObject({
    imageId: id.nullable(), sourceUrl: text, mode: z.literal("read_only"), reason: z.literal("source_rejected"),
  })),
  preflight: z.enum(["ok", "game_not_found", "image_limit_exceeded"]),
  dryRun: z.boolean(),
});
const imageResponseSchema = z.strictObject({
  gameId: id, status: z.enum(["completed", "partial", "failed"]),
  preflightError: z.enum(["invalid_request", "game_not_found", "image_limit_exceeded", "game_deadline"]).nullable(),
  plan: plan.nullable(), images: z.array(item),
});
~~~

After schema.parse, enforce result.gameId === requested gameId; if plan exists its gameId and gameSnapshot?.id and every candidate.gameId must agree, plan.dryRun === !write, and dry-run candidates must all be read_only. completed requires preflightError null and only the six benign outcomes. Return a value assignable to ImageResult; a compile-time assertion catches schema/native DTO drift. Sanitized presentation strings may legitimately be [INVALID_URL] or contain [REDACTED], so do not reject them for failing URL parsers; they are never used as outbound destinations.

Required response table; each has its own test row name and expects the fixed stageError object:

| Test name | Injection | Public code |
| --- | --- | --- |
| network reject | fetch rejects with secret-bearing Error | worker_network_error |
| non-2xx | HTTP 401, 403, 429, 500, 302 with secret body | worker_http_error |
| invalid JSON | 200 with malformed JSON | worker_invalid_response |
| malformed object | null, array, primitive, empty object | worker_invalid_response |
| wrong gameId | root/plan/snapshot/candidate identity mismatch | worker_invalid_response |
| unexpected status | unknown aggregate status | worker_invalid_response |
| unexpected outcome | any unknown image outcome | worker_invalid_response |
| missing property | remove each required root key; remove nested attempt/location/error/timing key | worker_invalid_response |
| wrong mode | plan dryRun mismatch or write candidate in dry-run | worker_invalid_response |
| contradictory completion | completed with failed outcome or preflightError | worker_invalid_response |

All rows assert no raw body/secret in JSON.stringify(rejection), one request, zero retry, no R2/D1 methods. Test valid complete plan with ISO updatedAt round-trips to Date.

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- scripts/sync-composition.test.ts scripts/sync-image-client.test.ts

Expected: all ownership/config and response-table cases PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/sync scripts/ingest-images.test.ts scripts/enrich-igdb-game.test.ts scripts/verify-official-links.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add scripts/sync-composition.ts scripts/sync-composition.test.ts scripts/sync-image-client.ts scripts/sync-image-client.test.ts
git commit -m "feat: compose local bulk sync lifecycle and validated image HTTP client"
~~~

## Task 11 — CLI, output lifecycle, presentation and operator documentation

**Files:** Create scripts/sync-games.ts, scripts/sync-games.test.ts, lib/sync/presentation.ts and lib/sync/presentation.test.ts. Modify README.md and only the package.json games:sync script.

**Interfaces:**
- Consumes: parseBulkSyncArgs/ReadUtf8, validateBulkSyncConfig/BulkSyncConfig/BulkSyncDependencies, runBulkSyncBatch/assertCompleteBatch, all public DTOs/errors.
- Produces: runBulkSyncCli(argv: readonly string[], deps: BulkSyncCliDependencies): Promise<number>; presentBulkSyncResult(result: BulkGameSyncResult): BulkGameSyncResult; formatBulkSyncResultHuman(result: BulkGameSyncResult): string; formatBulkSyncResultJson(result: BulkGameSyncResult): string.

- [ ] **Step 1: Write failing lifecycle and presentation tests.**

~~~ts
import { expect, it, vi } from "vitest";
import { runBulkSyncCli } from "./sync-games";
import { publicError } from "../lib/sync/errors";
import type { BulkGameSyncResult } from "../lib/sync/types";

const complete: BulkGameSyncResult = {
  dryRun: true, total: 1, succeeded: 1, failed: 0,
  games: [{ appId: "10", gameId: null, status: "succeeded", stages: [
    { name: "steam", status: "succeeded", summary: "Steam created." },
    ...(["igdb", "links", "images"] as const).map((name) => ({
      name, status: "not_run" as const, reason: "canonical_game_not_persisted" as const,
      summary: "Stage not run: canonical_game_not_persisted.",
    })),
  ] }],
};
it("cleanup plus formatter failure emits only output_format_failed", async () => {
  const stdout = vi.fn();
  const stderr = vi.fn();
  const dispose = vi.fn().mockRejectedValue(new Error("cleanup secret"));
  const code = await runBulkSyncCli(["10", "--json"], {
    readFile: () => "", env: { TWITCH_CLIENT_ID: "id", TWITCH_CLIENT_SECRET: "secret", IMAGE_INGEST_TOKEN: "token" },
    createDependencies: async () => ({ stages: {
      steam: { execute: vi.fn() }, igdb: { execute: vi.fn() },
      links: { execute: vi.fn() }, images: { execute: vi.fn() },
    }, dispose }),
    runBatch: async () => complete,
    formatHuman: () => { throw new Error("formatter secret"); },
    formatJson: () => { throw new Error("formatter secret"); },
    stdout, stderr,
  });
  expect(code).toBe(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify(publicError("output_format_failed")) + "\n",
  );
});
~~~

Presentation test skeleton:

~~~ts
it("sanitizes nested summaries and error URLs without mutating exact input", () => {
  const url = "https://user:password@example.com/a?ToKeN=source-secret#fragment-secret";
  const result: BulkGameSyncResult = {
    dryRun: true, total: 1, succeeded: 0, failed: 1, games: [{
      appId: "10", gameId: 41, status: "failed", stages: [{
        name: "images", status: "failed", summary: "Request " + url,
        error: { code: "worker_invalid_response", message: "Response " + url },
      }],
    }],
  };
  const original = JSON.stringify(result);
  const json = formatBulkSyncResultJson(result);
  const human = formatBulkSyncResultHuman(result);
  for (const output of [json, human]) {
    for (const secret of ["source-secret", "password", "fragment-secret"]) expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
  }
  expect(JSON.stringify(result)).toBe(original);
});
~~~

The presentation fixture tests redaction directly; complete-batch validity is separately enforced at the invocation boundary. Add test "malformed URL uses approved sentinel" for text "Request https://?token=secret", expecting [INVALID_URL]. Parameterize every sensitive key below.

- [ ] **Step 2: Observe RED.**

Run: npm test -- scripts/sync-games.test.ts lib/sync/presentation.test.ts

Expected RED: CLI/presentation modules do not resolve.

- [ ] **Step 3: Implement the approved lifecycle and output contracts.**

~~~ts
export type BulkSyncCliDependencies = {
  readFile: ReadUtf8;
  env: Readonly<Record<string, string | undefined>>;
  createDependencies(config: BulkSyncConfig): Promise<BulkSyncDependencies>;
  runBatch: typeof runBulkSyncBatch;
  formatHuman(result: BulkGameSyncResult): string;
  formatJson(result: BulkGameSyncResult): string;
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
};
export async function runBulkSyncCli(
  argv: readonly string[], deps: BulkSyncCliDependencies,
): Promise<number> {
  let json = argv.includes("--json");
  const diagnostic = async (code: FatalCode): Promise<void> => {
    const error = publicError(code);
    try {
      await deps.stderr((json ? JSON.stringify(error) : error.code + ": " + error.message) + "\n");
    } catch { /* stderr is a best-effort sink */ }
  };
  let args: BulkSyncArgs;
  let config: BulkSyncConfig;
  try {
    args = parseBulkSyncArgs(argv, deps.readFile);
    config = validateBulkSyncConfig(deps.env);
    json = args.json;
  } catch { await diagnostic("configuration_error"); return 1; }
  let handle: BulkSyncDependencies;
  try { handle = await deps.createDependencies(config); }
  catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error
      && error.code === "platform_unavailable" ? "platform_unavailable" : "composition_failed";
    await diagnostic(code); return 1;
  }
  let result: BulkGameSyncResult | undefined;
  try {
    const value = await deps.runBatch({ appIds: args.appIds, dryRun: !args.write, stages: handle.stages });
    assertCompleteBatch(value, args.appIds, !args.write);
    result = value;
  } catch { /* no partial batch is emitted */ }
  let cleanupFailed = false;
  try { await handle.dispose(); } catch { cleanupFailed = true; }
  if (!result) { await diagnostic("batch_execution_failed"); return 1; }
  let formatted: string;
  try { formatted = json ? deps.formatJson(result) : deps.formatHuman(result); }
  catch { await diagnostic("output_format_failed"); return 1; }
  try { await deps.stdout(formatted + "\n"); }
  catch { await diagnostic("output_write_failed"); return 1; }
  if (cleanupFailed) { await diagnostic("cleanup_failed"); return 1; }
  return result.failed === 0 ? 0 : 1;
}
~~~

Use the exact validation, acquired-handle and output sequence. No formatter runs before dispose. A complete result remains authoritative after cleanup failure. No retry, fallback or second diagnostic occurs.

Entrypoint is guarded by import.meta.url === pathToFileURL(process.argv[1]).href, following existing scripts. Supply readFileSync, process.env, createLocalBulkSyncDependencies, runBulkSyncBatch, both formatters and stdout/stderr Promise wrappers that resolve/reject from stream.write's callback, handling synchronous throws and asynchronous errors (including EPIPE). Set process.exitCode from the runner; do not call process.exit before awaited sinks/cleanup. The diagnostic wrapper always catches write rejection. Guarded unexpected entrypoint failure produces only the fixed batch_execution_failed diagnostic with exit 1; it does not retry disposal or output.

Presentation reconstructs only the DTO's named fields; never recursively copy unknown keys, causes or Error objects. Apply sanitizeTextForPresentation from lib/verifiers/official-links/presentation.ts to every summary and nested error code/message. IDs and statuses come from validated DTOs. Both formatters call presentBulkSyncResult before serialization/formatting. This API adds no native plans or URLs; adapter summaries use literals/counts only. URL substrings in injected text still pass through the shared sanitizer. Sensitive query keys, case insensitive: token, access_token, auth, authorization, key, api_key, apikey, signature, sig, secret, credential, x-amz-signature, x-amz-credential. Values become [REDACTED]; credentials and fragment disappear; malformed URLs use [INVALID_URL]. Internal inputs stay unchanged.

~~~ts
export function presentBulkSyncResult(result: BulkGameSyncResult): BulkGameSyncResult {
  return {
    dryRun: result.dryRun, total: result.total, succeeded: result.succeeded, failed: result.failed,
    games: result.games.map((game) => ({
      appId: game.appId, gameId: game.gameId, status: game.status,
      stages: game.stages.map((stage) => ({
        name: stage.name, status: stage.status, summary: sanitizeTextForPresentation(stage.summary),
        ...(stage.reason ? { reason: stage.reason } : {}),
        ...(stage.error ? { error: {
          code: sanitizeTextForPresentation(stage.error.code),
          message: sanitizeTextForPresentation(stage.error.message),
        } } : {}),
      })),
    })),
  };
}
export function formatBulkSyncResultJson(result: BulkGameSyncResult): string {
  return JSON.stringify(presentBulkSyncResult(result));
}
export function formatBulkSyncResultHuman(result: BulkGameSyncResult): string {
  const value = presentBulkSyncResult(result);
  return [
    "Bulk sync " + (value.dryRun ? "dry-run" : "write") + ": total=" + value.total
      + " succeeded=" + value.succeeded + " failed=" + value.failed,
    ...value.games.flatMap((game) => [
      "App " + game.appId + " game=" + (game.gameId ?? "none") + " " + game.status,
      ...game.stages.map((stage) => "  " + stage.name + " " + stage.status + " " + stage.summary
        + (stage.reason ? " reason=" + stage.reason : "")
        + (stage.error ? " " + stage.error.code + ": " + stage.error.message : "")),
    ]),
    "Failed App IDs: " + (value.games.filter((game) => game.status === "failed").map((game) => game.appId).join(" ") || "none"),
  ].join("\n");
}
~~~

**Lifecycle matrix and executable test expansion**

Each row below is a separate named case inside it.each for both json=false and json=true. Use the complete fixture above. To obtain a failed-game result, replace steam status with failed/error=stageError("steam","network_error") projected to code/message, downstream reasons with previous_stage_failed, game status failed and counts succeeded=0/failed=1. Use vi.fn spies for acquire/compose/dispose/batch/format/stdout/stderr; inject failures at the named function. For validation use invalid argv/config and assert createDependencies count 0. For acquisition/composition cases use the actual Task 10 factory with injected acquire/compose. All other cases use its successful handle. Inject secrets in every thrown error and assert neither output contains them.

| Exact test case name | Injection | Result/stdout | Stderr code | Exit | Dispose attempts |
| --- | --- | --- | --- | --- | --- |
| validation failure has zero acquisition | invalid argv/file/config/endpoint | none / 0 calls | configuration_error | 1 | 0 |
| platform acquisition failure has no outer disposal | acquire rejects | none / 0 | platform_unavailable | 1 | 0 |
| composition failure owns factory cleanup | compose throws | none / 0 | composition_failed | 1 | 1 factory |
| composition and cleanup failure keep operation error | compose throws + dispose rejects | none / 0 | composition_failed only | 1 | 1 factory |
| unexpected batch throw emits no partial result | batch throws after recording earlier game in local test event array | none / 0 | batch_execution_failed | 1 | 1 CLI |
| batch and cleanup failure keep operation error | batch throws + dispose rejects | none / 0 | batch_execution_failed only | 1 | 1 CLI |
| complete successful result emits after cleanup | normal complete fixture | complete / 1 | none | 0 | 1 CLI |
| complete failed-game result is emitted | complete failed fixture | complete / 1 | none | 1 | 1 CLI |
| success result survives dispose failure | normal fixture + dispose rejects | complete / 1 | cleanup_failed | 1 | 1 CLI |
| failed-game result survives dispose failure | failed fixture + dispose rejects | complete / 1 | cleanup_failed | 1 | 1 CLI |
| formatter failure emits no stdout | selected formatter throws | complete in memory / 0 | output_format_failed | 1 | 1 already |
| cleanup plus formatter failure selects output error | dispose rejects + selected formatter throws | complete in memory / 0 | output_format_failed only | 1 | 1 already |
| stdout failure has no retry | stdout throws/rejects | one attempt, prefix may exist | output_write_failed | 1 | 1 already |
| cleanup plus stdout failure selects output error | dispose rejects + stdout throws/rejects | one attempt | output_write_failed only | 1 | 1 already |
| stdout and stderr failure cannot escape | both sinks throw/reject | one stdout attempt | one failed stderr attempt swallowed | 1 | 1 |
| fatal error and stderr failure preserve exit | platform failure + stderr throws/rejects | none / 0 | one failed attempt swallowed | 1 | 0 |
| cleanup diagnostic sink failure retains result | dispose rejects + stderr throws/rejects | complete / 1 | one failed attempt swallowed | 1 | 1 |

For each sink failure row run once with () => { throw new Error("sink secret"); } and once with async () => { throw new Error("sink secret"); }. Assert ordering in an event log: batch settles → dispose attempt → formatter → stdout → optional stderr. Assert disposal count <=1 always; no diagnostic retry. For successful JSON writes JSON.parse(stdout.mock.calls[0][0]) equals the sanitized complete DTO, counts/order agree, stdout is one JSON document and has no fatal envelope. Fatal JSON stderr parses to exactly {code,message}; human stderr is "code: fixed message\n". Ensure formatter spies are zero on pre-result errors and stdout is zero on formatter errors.

Modify package.json with exactly:

~~~json
"games:sync": "tsx scripts/sync-games.ts"
~~~

README must show positional IDs, --file, --json, --write; UTF-8 format; first-wins and 100 limit; dry-run new-create skip; fail-fast/continued games; no rollback/retry; failed App ID rerun; credentials set out-of-band without real values; the required operator startup from repository root:

~~~bash
npx wrangler dev --config workers/image-ingest/wrangler.jsonc --local --persist-to .wrangler/state --port 8787
npm run games:sync -- 1245620 1091500 292030
npm run games:sync -- --file games.txt --json
npm run games:sync -- --file games.txt --write
~~~

Worker IMAGE_INGEST_TOKEN must equal CLI token using local secret configuration. Both use the same repository .wrangler/state/v3 and local gamehub D1 identity. CLI cannot introspect the Worker binding; this is an operator precondition, not a claimed automatic check. Document no remote bulk target. tests "CLI examples and package script are exact" and "README documents shared-state operator precondition" inspect these exact strings and script value.

- [ ] **Step 4: Observe GREEN.**

Run: npm test -- scripts/sync-games.test.ts lib/sync/presentation.test.ts

Expected: every lifecycle matrix row in human/JSON, sync/async sink failures and sanitizer cases PASS.

- [ ] **Step 5: Run regression and checks.**

~~~bash
npm test -- lib/sync scripts/sync-composition.test.ts scripts/sync-image-client.test.ts lib/verifiers/official-links/presentation.test.ts lib/images/presentation.test.ts
npm run typecheck
npm run lint
git diff --check
~~~

- [ ] **Step 6: Commit the task.**

~~~bash
git add scripts/sync-games.ts scripts/sync-games.test.ts lib/sync/presentation.ts lib/sync/presentation.test.ts README.md package.json
git commit -m "feat: add local bulk sync CLI with complete-result lifecycle output"
~~~

## Task 12 — Real local shared-state integration and final verification

**Files:** Create test/sync/local-bulk-harness.ts, test/sync/bulk-sync.integration.test.ts, test/sync/bulk-sync.security.test.ts and docs/superpowers/reports/2026-09-10-gamehub-v2-7-bulk-game-sync-verification.md. Do not change service implementations, Worker code, schemas, dependencies, existing test helpers or production targets in this task; a discovered behavior bug returns to the owning task's regression/fix/review gate.

**Interfaces:**
- Consumes: runBulkSyncCli, createLocalBulkSyncDependencies, composeLocalBulkSyncStages, real D1 stores and native services; existing test/helpers/local-image-worker.ts and test/helpers/image-worker-fixture.ts.
- Produces: startBulkSyncHarness(): Promise<BulkSyncHarness> in test/sync/local-bulk-harness.ts; integration/security tests and factual verification report.
- BulkSyncHarness exposes run(argv: readonly string[]): Promise<{exitCode:number;stdout:string[];stderr:string[]}>; read(sql:string,...params:unknown[]):Promise<Record<string,unknown>[]>; snapshot():Promise<Record<string,unknown[]>>; close():Promise<void>; events:string[]; imageResponses:ImageResult[]; rejectedIgdbAppIds:Set<string>; mutations:{d1:number;r2Puts:number;r2Heads:number}. These are test facilities, never production APIs.

- [ ] **Step 1: Write failing integration tests.**

~~~ts
import { expect, it } from "vitest";
import { startBulkSyncHarness } from "./local-bulk-harness";

it("Steam write is visible to IGDB links and the real image Worker", async () => {
  const harness = await startBulkSyncHarness();
  try {
    const result = await harness.run(["10", "--write", "--json"]);
    expect(result.exitCode).toBe(0);
    const batch = JSON.parse(result.stdout[0]!);
    const gameId = batch.games[0].gameId;
    expect(batch.games[0].stages.map((stage: { status: string }) => stage.status))
      .toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(await harness.read("SELECT provider, external_id FROM game_external_ids WHERE game_id = ? ORDER BY provider", gameId))
      .toEqual([{ provider: "igdb", external_id: "1010" }, { provider: "steam", external_id: "10" }]);
    expect(harness.events).toContain("igdb mapping uid=10");
    expect(harness.events).toContain("verify https://official.example/game/1010");
    expect(harness.imageResponses[0]).toMatchObject({ gameId, status: "completed",
      plan: { gameId, gameSnapshot: { id: gameId } } });
    const rows = await harness.read("SELECT storage_key, content_hash FROM game_images WHERE game_id = ?", gameId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => typeof row.storage_key === "string" && typeof row.content_hash === "string")).toBe(true);
    expect(harness.mutations.r2Puts).toBeGreaterThan(0);
    expect(result.stderr).toEqual([]);
  } finally { await harness.close(); }
}, 60_000);
~~~

Add exact named tests:
- "existing dry-run performs provider checks and zero D1 or R2 writes": seed with one prior full write run, reset test counters, snapshot all local tables and R2 head state, then run existing ID without --write. Assert all four stages succeeded, provider/verifier/source reads occur, R2 HEAD >0, R2 PUT=0, instrumented D1 mutations=0, before/after rows equal.
- "new dry-run has no canonical state and three not_run stages": fresh ID 30 default mode; assert no canonical rows, no IGDB/link/Worker request for 30, three canonical_game_not_persisted reasons, d1=0 and r2Puts=0.
- "failed game retains prior writes and next game completes": make deterministic IGDB fixture fail only App ID 20; run ["10","20","30","--write","--json"]; expect total=3, succeeded=2, failed=1, Steam row 20 remains, its links/images not_run, game 30 reaches images and no repeated 20 stage attempt.
- "repeat write reuses identities and image objects": run one successful ID twice, compare external identities and image row counts, second image outcomes benign, no rollback/delete.
- "shared-state operator configuration matches local identity": fixed root and Worker configs have matching database_name/database_id/preview_database_id; proxy P/v3 matches Worker --persist-to P; README command contains the approved persistence root.
- "integration is local only and closes owned resources on failure": reject every unmapped provider transport destination; simulate startup failure and ensure no orphaned fixture listener or owned Worker remains.

- [ ] **Step 2: Observe RED.**

Run: npm test -- test/sync/bulk-sync.integration.test.ts

Expected RED: "./local-bulk-harness" is missing. Do not treat unavailable workerd, occupied port or sandbox permission as an application RED.

- [ ] **Step 3: Implement the deterministic local harness.**

Use the same real Worker helper as test/images/worker-d1-r2.integration.test.ts. The CLI remains an in-process function invocation; spawning the test-owned Wrangler Worker is permitted for integration infrastructure and never becomes child-CLI orchestration.

Core harness startup and invocation skeleton:

~~~ts
export async function startBulkSyncHarness(): Promise<BulkSyncHarness> {
  const root = await mkdtemp(join(tmpdir(), "gamehub-v27-sync-"));
  const persistPath = join(root, "state");
  const events: string[] = [];
  const imageResponses: ImageResult[] = [];
  const rejectedIgdbAppIds = new Set<string>();
  const mutations = { d1: 0, r2Puts: 0, r2Heads: 0 };
  let worker: LocalImageWorker | undefined;
  let fixture: Server | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await worker?.stop(); }
    finally {
      try { await new Promise<void>((resolve, reject) =>
        fixture?.close((error) => error ? reject(error) : resolve()) ?? resolve()); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  };
  try {
    fixture = createServer(createFixtureHandler(events, rejectedIgdbAppIds));
    await new Promise<void>((resolve, reject) => {
      fixture!.once("error", reject);
      fixture!.listen(0, "127.0.0.1", resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("Fixture startup failed");
    const fixtureOrigin = "http://127.0.0.1:" + address.port;
    worker = await startLocalImageWorker({
      port: 8787, persistPath, token: "v27-fixture-token", fixtureOrigin,
    });
    const readiness = await fetch(worker.baseUrl + "/internal/images/ingest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: 10, write: false }), redirect: "error",
    });
    if (readiness.status !== 401 || readiness.headers.get("x-test-runtime") !== "workerd")
      throw new Error("Owned fixture Worker was not ready");
    const read = (sql: string, ...params: unknown[]) => worker!.read(sql, ...params);
    return {
      events, imageResponses, rejectedIgdbAppIds, mutations, close, read,
      snapshot: async () => {
        const tables = await read("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
        const snapshot: Record<string, unknown[]> = {};
        for (const row of tables) {
          const name = String(row.name);
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("Unexpected table name");
          snapshot[name] = await read('SELECT * FROM "' + name + '" ORDER BY rowid');
        }
        return snapshot;
      },
      async run(argv) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const env = { TWITCH_CLIENT_ID: "v27-fixture-client", TWITCH_CLIENT_SECRET: "v27-fixture-secret",
          IMAGE_INGEST_TOKEN: "v27-fixture-token" };
        const exitCode = await runBulkSyncCli(argv, {
          readFile: readFileSync, env, runBatch: runBulkSyncBatch,
          formatHuman: formatBulkSyncResultHuman, formatJson: formatBulkSyncResultJson,
          stdout: (text) => { stdout.push(text); }, stderr: (text) => { stderr.push(text); },
          createDependencies: (config) => createLocalBulkSyncDependencies(config, {
            acquire: async () => {
              const { getPlatformProxy } = await import("wrangler");
              const platform = await getPlatformProxy<{ DB: AnyD1Database }>({
                configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
                persist: { path: join(persistPath, "v3") }, remoteBindings: false, envFiles: [],
              });
              return { env: { DB: instrumentBinding(platform.env.DB, mutations) },
                dispose: () => platform.dispose() };
            },
            compose: (binding, config) => composeLocalBulkSyncStages(binding, config,
              createFixtureTransports(fixtureOrigin, events, imageResponses, mutations)),
          }),
        });
        return { exitCode, stdout, stderr };
      },
    };
  } catch (error) { await close(); throw error; }
}
~~~

Import Node fs/promises mkdtemp/rm, fs readFileSync, path join, os tmpdir, url fileURLToPath, http createServer/Server; existing local Worker helper, native types and Tasks 9–11 APIs. startLocalImageWorker applies all four checked-in SQL migrations before startup using its existing local setup binding. It opens seed/read bindings against the same P/v3 and cleans owned child/persistPath on failure. Do not use its fixed default shared temp directory. Reserve/check port 8787 before startup; if occupied, fail this test explicitly without killing any unrelated process or silently connecting to it. Production endpoint policy remains fixed; only test injection replaces the local persistence path.

createFixtureHandler(events: string[], rejectedIgdbAppIds: Set<string>): http.RequestListener reads POST bodies, then selects exact paths:
- GET /steam?appids=N&cc=us&l=english returns status 200 and JSON {[N]:{success:true,data:{type:"game",steam_appid:Number(N),name:"Fixture "+N,header_image:"https://cdn.akamai.steamstatic.com/steam/apps/"+N+"/header.jpg",website:"https://steam-official.example/game/"+N}}}. IDs N are 10,20,30 only.
- POST /oauth2/token returns {access_token:"v27-fixture-access-token",expires_in:3600,token_type:"bearer"}.
- POST /v4/external_games extracts uid from the exact query, records "igdb mapping uid=N", and returns [{id:Number(N),game:1000+Number(N),uid:N,external_game_source:1}]. The alternate mapping query containing "game !=" returns []. The failure-isolation test adds "20" to harness.rejectedIgdbAppIds before invocation; membership causes HTTP 503. Production config has no corresponding option.
- POST /v4/games extracts where id = I and returns [{id:I,name:"Fixture "+I,summary:"IGDB fixture summary",websites:[{type:1,trusted:true,url:"https://official.example/game/"+I}]}]. No fuzzy identity match.
- GET /fixture.jpg returns Content-Type:image/jpeg and the exact valid 48×32 JPEG fixture bytes below.
- Every other route returns 500 and records an unexpected-route event; tests fail on any such event.

~~~ts
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 0x03,
  0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);
~~~

createFixtureTransports(origin, events, imageResponses, mutations): BulkSyncTransportOverrides:
- steamFetch validates incoming hostname store.steampowered.com and path /api/appdetails, then forwards init and query to local /steam.
- authFetch validates id.twitch.tv/oauth2/token then forwards to local /oauth2/token.
- igdbFetch validates api.igdb.com with /v4/external_games or /v4/games, then forwards POST body/headers to the identical local path.
- verifyBoundUrl calls the real verifyUrl using an injected executeChain terminal fixture {code:"http_result",httpStatus:200,finalUrl:exactUrl,attempts:[],redirectChain:[],checkedAt:new Date()}; record "verify "+exactUrl. This replaces only external link transport; real LinkVerificationService, planner and D1 store run and persist metadata. Existing V2.5 tests separately verify DNS/socket transport safety.
- imageFetch accepts only the fixed local endpoint, calls real fetch with the actual authenticated request, records r2 counters from x-test-r2-head/x-test-r2-put, and stores response.clone().json() after parseImageWorkerResponse(...). Expect x-test-runtime=workerd. Do not call handleImageIngest directly in this test; existing test-only Worker entrypoint routes actual downloader GET to local /fixture.jpg and uses real workerd D1/R2.
- Every other destination throws immediately. No real Steam, Twitch, IGDB, public link or public image request is allowed. No global provider fetch fallback in the harness.

instrumentBinding(binding:AnyD1Database, counters:{d1:number}): AnyD1Database is test-only. Proxy prepare(sql) and its returned statement; retain SQL and underlying target in WeakMaps. Proxy bind(...args) to wrap the newly bound statement with the same SQL. On run/all/first/raw, increment d1 iff SQL begins INSERT/UPDATE/DELETE/REPLACE (case insensitive after trim), then call the underlying statement method with its original receiver. Proxy batch(statements) to count mutating statements and pass unwrapped originals to binding.batch. Do not double-count statements in batch; do not count prepare/read-only queries. Assert d1=0 in both dry-run tests. Worker-side dry-run writes are checked by D1 before/after snapshots plus native V2.6 mutation tests and R2 header counts; the CLI binding counter does not claim to intercept a separate workerd binding.

Ownership: one factory/CLI D1 lifecycle per run; helper migration/seed/read inspection lifecycles are separate test resources, not batch platform acquisition. Each test closes its own fixture server and its own Worker in finally, and only removes the unique mkdtemp root. Existing helper sends SIGTERM, waits, then SIGKILL only to its spawned ChildProcess. No broad pkill, borrowed listener termination, shared state deletion, production writes or remote commands. Do not parallelize integration tests using port 8787.

**Security test skeleton and assertions**

~~~ts
it("preserves V2.6 schema migrations and dependency graph", () => {
  const baseline = "122a78085b7ba8b2a01521dfc9cbcfc5ada1ec9a";
  const schema = readFileSync("lib/db/schema.ts");
  expect(createHash("sha1").update(schema).digest("hex"))
    .toBe("d959b11fc297164388f3cc28708beadab2d7842f");
  expect(readdirSync("drizzle").filter((name) => name.endsWith(".sql"))).toHaveLength(4);
  const before = JSON.parse(execFileSync("git", ["show", baseline + ":package.json"], { encoding: "utf8" }));
  const after = JSON.parse(readFileSync("package.json", "utf8"));
  expect(after.dependencies).toEqual(before.dependencies);
  expect(after.devDependencies).toEqual(before.devDependencies);
  expect(readFileSync("package-lock.json", "utf8"))
    .toBe(execFileSync("git", ["show", baseline + ":package-lock.json"], { encoding: "utf8", maxBuffer: 10_000_000 }));
});
~~~

Read-only git process here is test verification, never CLI orchestration. Add "pure bulk runtime has no environment network or child-process globals" by scanning production lib/sync files (exclude tests) and disallow Node I/O imports, Wrangler, process/console, global fetch calls, child_process, exec/spawn and orchestrator Promise.all. Add "remote and file-injected flags never acquire platform" through runBulkSyncCli spies for remote/config/database/env options and file "--write". Add "public output omits provider payload tokens Authorization and unknown keys" injecting secret-bearing native errors and a DTO extra-property object; formatter returns only whitelisted DTO fields. Add "V2.8 facilities are absent" checking branch production diff contains no jobs/tables/scheduler/config additions and tests verify no retry after failure, no resume/remote option.

- [ ] **Step 4: Observe GREEN.**

~~~bash
npm test -- test/sync/bulk-sync.integration.test.ts
npm test -- test/sync/bulk-sync.security.test.ts
~~~

Expected: real Worker header/DB visibility assertions, dry-run counters and all security tests PASS. Unavailable local runtime/network sandbox permissions are recorded as a verification blocker and never converted to a passing mocked integration result.

- [ ] **Step 5: Run fresh final verification and report evidence.**

~~~bash
npm test
npm run typecheck
npm run lint
npm run build
npm run db:migrate:local
npm run db:check:local
npm run db:verify:local
npm audit
npm audit --omit=dev
git diff --exit-code 122a78085b7ba8b2a01521dfc9cbcfc5ada1ec9a -- package-lock.json lib/db/schema.ts drizzle
git diff --check
~~~

Run local D1 commands only with the existing fixed local scripts. Record commands, exit statuses, actual test counts, build result, integration observations, migration count 4, schema hash, dependency/lock baseline comparison and main unchanged. Existing dev-only audit exception is not a new approval to change packages or run audit fix. Record current audit evidence; never silently claim a historical audit number as a fresh PASS. A build that cannot run is not PASS. Request required environment access through the normal approval mechanism; do not mark merge-ready without actual required verification.

Whole-branch review follows completed task reviews. If Critical/Important findings exist, run one final fix agent against open findings, then scoped re-review and fresh affected checks. This task's report must distinguish implemented, reviewed, verified, and environment-blocked statuses. No PR/merge/push is authorized by this plan alone.

- [ ] **Step 6: Commit verification artifacts.**

~~~bash
git add test/sync/local-bulk-harness.ts test/sync/bulk-sync.integration.test.ts test/sync/bulk-sync.security.test.ts docs/superpowers/reports/2026-09-10-gamehub-v2-7-bulk-game-sync-verification.md
git commit -m "test: verify bulk sync shared-state integration and security"
~~~

## Spec coverage and exact verification map

Each entry identifies an executable test name, not a general assertion that coverage exists.

| Spec section / normative requirement | Plan Task | Test file | Exact test name(s) |
| --- | --- | --- | --- |
| 1 Goals: local manual complete sync | 8,11,12 | test/sync/bulk-sync.integration.test.ts | Steam write is visible to IGDB links and the real image Worker |
| 2 No schema/dependency/job/scheduler scope | 12 | test/sync/bulk-sync.security.test.ts | preserves V2.6 schema migrations and dependency graph; V2.8 facilities are absent |
| 3 Reuse native V2.2–V2.6 ports | 3–7,12 | lib/sync/stages.test.ts; test/sync/bulk-sync.integration.test.ts | uses the real Steam signature and plain stage errors; Steam write is visible to IGDB links and the real image Worker |
| 4 Pure orchestrator, no child CLI | 3,8–11,12 | test/sync/bulk-sync.security.test.ts | pure bulk runtime has no environment network or child-process globals |
| 5 CLI/options/default/exit | 2,11 | lib/sync/input.test.ts; scripts/sync-games.test.ts | rejects invalid input before composition; CLI examples and package script are exact; complete successful result emits after cleanup; complete failed-game result is emitted |
| 6 Left-to-right file expansion | 2 | lib/sync/input.test.ts | expands files in argv order and deduplicates after normalization |
| 6 File whitespace/comments/data | 2 | lib/sync/input.test.ts | trims file lines and ignores comments; treats file flags as invalid App IDs |
| 6 Dedupe after normalize | 2,9 | lib/sync/input.test.ts; lib/sync/batch.test.ts | expands files in argv order and deduplicates after normalization; returns counts and normalized order |
| 7 Max100 after dedupe | 2,9 | lib/sync/input.test.ts; lib/sync/batch.test.ts | accepts exactly 100 and rejects 101 unique after dedupe; validates batch before stage calls |
| 7 Serial execution | 9 | lib/sync/batch.test.ts | runs A complete pipeline before B and continues after game failure; awaits unresolved game before starting next |
| 8 Fixed four stages/mode/gameId | 4–8 | lib/sync/game-pipeline.test.ts | fixed four-stage order and mode on existing dry-run and write; write requires real canonical ID |
| 9 New dry-run create special case | 8,12 | lib/sync/game-pipeline.test.ts; test/sync/bulk-sync.integration.test.ts | new dry-run create skips three stages without a fake ID; new dry-run has no canonical state and three not_run stages |
| 9 Existing dry-run real checks/zero mutation | 4–8,12 | test/sync/bulk-sync.integration.test.ts | existing dry-run performs provider checks and zero D1 or R2 writes |
| 10 Write flow/no rollback | 8,12 | test/sync/bulk-sync.integration.test.ts | Steam write is visible to IGDB links and the real image Worker; failed game retains prior writes and next game completes |
| 11 Fail-fast within game | 8 | lib/sync/game-pipeline.test.ts | fail-fast at each stage; a failed stage stops only remaining stages |
| 11 Cross-game isolation | 9,12 | lib/sync/batch.test.ts; test/sync/bulk-sync.integration.test.ts | runs A complete pipeline before B and continues after game failure; failed game retains prior writes and next game completes |
| 12 Steam success/errors | 4 | lib/sync/steam-stage.test.ts | Steam native statuses preserve canonical identity; passes scalar App ID and mode and discards Steam exception detail |
| 12 IGDB native statuses/error codes | 5 | lib/sync/igdb-stage.test.ts | maps enrich and existing to success and blocked to failure; maps every IgdbError without payload or secret |
| 12 Links code-first/conflict separation | 6 | lib/sync/link-stage.test.ts | fails every non-http VerificationCode; reads write conflicts separately from VerificationCode; partial application fails without conflicts |
| 12 HTTP diagnostic classifications/manual | 6 | lib/sync/link-stage.test.ts | HTTP classifications alone do not fail; empty and manual-only plans succeed |
| 12 Image native status/19 outcomes/preflight | 7 | lib/sync/image-stage.test.ts | covers all nineteen ImageOutcome values; maps all image preflight errors; partial and failed cannot become success |
| 13 DTO complete counts/order boundary | 1,9,11 | lib/sync/batch.test.ts; scripts/sync-games.test.ts | rejects incomplete count or input mismatch; unexpected batch throw emits no partial result |
| 14 Fatal taxonomy/no raw diagnostics | 1,3,11,12 | lib/sync/types.test.ts; test/sync/bulk-sync.security.test.ts | all fatal diagnostics contain only code and fixed message; public output omits provider payload tokens Authorization and unknown keys |
| 14 URL and nested error redaction | 11 | lib/sync/presentation.test.ts | sanitizes nested summaries and error URLs without mutating exact input; malformed URL uses approved sentinel |
| 15 Shared D1 factory and local persistence | 10,12 | scripts/sync-composition.test.ts; test/sync/bulk-sync.integration.test.ts | all local stores receive one D1 binding; shared-state operator configuration matches local identity |
| 15.1 Validation before acquisition | 2,10,11 | scripts/sync-games.test.ts | validation failure has zero acquisition |
| 15.1 Failed acquisition/factory ownership | 10,11 | scripts/sync-composition.test.ts; scripts/sync-games.test.ts | acquisition failure transfers no handle; composition failure owns factory cleanup |
| 15.2 Every lifecycle failure | 10,11 | scripts/sync-games.test.ts | all seventeen named rows in Task 11 lifecycle matrix, each in human and JSON |
| 15.3 Operation/output error precedence | 11 | scripts/sync-games.test.ts | composition and cleanup failure keep operation error; batch and cleanup failure keep operation error; cleanup plus formatter failure selects output error; cleanup plus stdout failure selects output error |
| 15.4 Disposal before formatter/once | 10,11 | scripts/sync-games.test.ts | complete successful result emits after cleanup; stdout and stderr failure cannot escape; cleanup diagnostic sink failure retains result |
| 15.5 Single JSON stdout/separate diagnostics | 11 | scripts/sync-games.test.ts | complete successful result emits after cleanup; success result survives dispose failure; unexpected batch throw emits no partial result |
| 16 Image HTTP authenticated boundary | 7,10,12 | scripts/sync-image-client.test.ts; test/sync/bulk-sync.integration.test.ts | builds one authenticated local request and fails closed on wrong gameId; Steam write is visible to IGDB links and the real image Worker |
| 16 HTTP JSON/identity/DTO rejection | 10 | scripts/sync-image-client.test.ts | network reject; non-2xx; invalid JSON; malformed object; wrong gameId; unexpected status; unexpected outcome; missing property; wrong mode; contradictory completion |
| 16 Shared-state operator precondition | 11,12 | scripts/sync-games.test.ts; test/sync/bulk-sync.integration.test.ts | README documents shared-state operator precondition; shared-state operator configuration matches local identity |
| 17 Secrets/config only in scripts | 10,12 | scripts/sync-composition.test.ts; test/sync/bulk-sync.security.test.ts | validates all configuration before acquisition; pure bulk runtime has no environment network or child-process globals |
| 17 No remote or target switching | 2,10,12 | scripts/sync-composition.test.ts; test/sync/bulk-sync.security.test.ts | fixed local config rejects remote target; remote and file-injected flags never acquire platform |
| 18 Concurrency=1/existing limits | 9,12 | lib/sync/batch.test.ts; test/sync/bulk-sync.security.test.ts | awaits unresolved game before starting next; pure bulk runtime has no environment network or child-process globals |
| 19 No retry/rerun failed IDs | 9,11,12 | lib/sync/batch.test.ts; scripts/sync-games.test.ts | no retries after failed game; CLI examples and package script are exact |
| 20 Conservative idempotent rerun | 4–7,12 | test/sync/bulk-sync.integration.test.ts | repeat write reuses identities and image objects |
| 21 Unit/integration/security/lifecycle strategy | 1–12 | all task-owned test files | task-local test names and fresh Task 12 commands |
| 22 Safety/no new network paths | 10,12 | test/sync/bulk-sync.integration.test.ts; test/sync/bulk-sync.security.test.ts | integration is local only and closes owned resources on failure; pure bulk runtime has no environment network or child-process globals |
| 23 V2.8 exclusions | 12 | test/sync/bulk-sync.security.test.ts | V2.8 facilities are absent |
| 24 Human/JSON operational examples | 11 | scripts/sync-games.test.ts; lib/sync/presentation.test.ts | CLI examples and package script are exact; sanitizes nested summaries and error URLs without mutating exact input |

## Plan self-review and review gate

- Spec coverage: all numbered sections and lifecycle subsections map above to owned files and named tests.
- Task-local TDD: Tasks 1–12 each contain six checkboxes, failing test code, exact RED command/reason, implementation/interface code, GREEN command, regression/typecheck/lint/diff-check and explicit git add/commit.
- Adapter ownership: only Task 3 shared contracts; factories are owned by Tasks 4/5/6/7; HTTP client and actual composition are Task 10; invocation/output are Task 11.
- Type consistency: Task 1 BulkGameResult/BulkStageResult feed 8/9/11; Task 3 exact native ports feed 4–7; all four factories produce BulkSyncStages; Task 8 accepts {appId,dryRun,stages}; Task 9 accepts {appIds,dryRun,stages}; Task 11 injects Task 9's exact signature and Task 10's {stages,dispose} handle.
- Lifecycle coverage: every factory/CLI error combination has an explicit matrix row. Factory return transfers ownership; rejected acquisition never transfers it. Complete results survive cleanup; no partial stdout on batch throw; output failures suppress cleanup diagnostics; stderr is best-effort.
- Security coverage: fixed diagnostics, strict Worker DTO, no redirect forwarding, local target validation before acquisition, shared sanitizer, no raw native payload copy.
- Integration realism: actual native importer/enricher/link stores share local D1 and real authenticated workerd Image Worker sees the same canonical state. Only external provider transports are fixtures.
- Scope: future code is limited to the file map; no schema or dependency additions. Main stays at the stable baseline throughout plan revision.

Before requesting independent review, scan this document for unresolved placeholder wording and check whitespace. The required scanner patterns are assembled below so the scanner does not match its own instruction text:

~~~bash
node --input-type=module -e 'import fs from "node:fs"; const p="docs/superpowers/plans/2026-09-10-gamehub-v2-7-bulk-game-sync.md"; const patterns=[["TO","DO"],["TB","D"],["later ","decide"],["appropriate","ly"],["as ","needed"],["handle ","edge cases"],["map ","exactly"],["safe ","summary"],["typed ","failures"],["similar ","to"]].map(x=>x.join("")); const lines=fs.readFileSync(p,"utf8").split("\n"); const matches=lines.flatMap((line,i)=>patterns.filter(x=>line.toLowerCase().includes(x.toLowerCase())).map(x=>({line:i+1,pattern:x}))); console.log(JSON.stringify(matches)); if(matches.length) process.exitCode=1;'
git diff --check
~~~

Independent reviewer reads the complete approved Spec, this complete Plan and the referenced real interfaces. Required checks: task-local TDD; Steam signature; adapter ownership; full public errors; IGDB/link/image mappings; HTTP DTO parsing; lifecycle/disposal/error precedence; complete JSON stdout; local shared-state harness; section coverage; no new Design decisions or implementation edits. Resolve Critical/Important findings in this document, rerun self-review and scoped independent re-review. Report all Minor findings. Only when Critical=0, Important=0 and every required check passes may the controller record PLAN-READY.

Plan revision commit (not an amend of the original):

~~~bash
git add docs/superpowers/plans/2026-09-10-gamehub-v2-7-bulk-game-sync.md
git commit -m "docs: refine V2.7 bulk sync implementation plan"
~~~

Final planning handoff records Design authority 7ae96d2211d3bce5d11158b46bb1c2f26315d4b7, original Plan 50b131680afb216bff7da42d12649dcbc3d02857, revision SHA, review counts, all self-review results and clean worktree. V2.7 implementation 尚未开始，等待人工最终 Plan approval。Stop at PLAN-READY.
