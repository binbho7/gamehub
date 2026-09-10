# GameHub V2.7 Bulk Game Sync — Architectural Design

## 1. Goals

Provide a local/manual CLI that synchronizes a bounded set of Steam App IDs through the fixed pipeline Steam import → IGDB enrichment → official-link verification → R2 image ingest. The orchestration is reusable, deterministic, typed, safe by default, and suitable for a later V2.8 scheduler.

## 2. Non-goals

V2.7 has no Cron, Queues, Durable Objects, background job Worker, persistent run/checkpoint tables, resume flag, Admin UI, web progress UI, nightly scheduling, fuzzy matching, Steam keyword selection, batch API, remote D1 mode, or production bulk writes. It adds no schema migration and no production dependency.

## 3. Existing capability reuse

`lib/importers/steam.ts` remains the Steam stage and `normalizeSteamAppId` remains the identity validator. `createIgdbEnricher`, the official-link verification service/types, and the image ingest Worker HTTP contract are reused through explicit adapters. Existing provider clients, repositories, typed errors, conservative/idempotent writes, and shared presentation sanitizers remain authoritative. Existing child CLIs are not invoked.

## 4. Architecture

The reusable orchestrator lives under `lib/sync/` and depends only on injected stage interfaces, a clock, and no process, environment, console, filesystem, Wrangler, or network globals. The CLI (`scripts/sync-games.ts`) performs argv/file parsing, local dependency composition, output formatting, and exit-code mapping. A single local platform lifecycle supplies the D1 binding to Steam, IGDB, and link adapters; the image adapter calls the dedicated authenticated Worker endpoint and never receives D1/R2 bindings.

Each game is processed serially. The orchestrator executes one game’s complete pipeline before starting the next, records a typed game result, and continues after a game failure.

## 5. CLI contract

```text
npm run games:sync -- 1245620 1091500 292030
npm run games:sync -- --file games.txt
npm run games:sync -- 1245620 --write
npm run games:sync -- --file games.txt --json
```

The default is dry-run. `--write` is the only mutation switch; `--json` selects sanitized machine-readable output. The command accepts positional App IDs and at most one `--file <path>`. Unsupported options, `--remote`, alternate Wrangler/config/database options, duplicate flags, missing file arguments, and mixed invalid input fail before any stage runs. Exit code 0 means every game succeeded; exit code 1 means any game failure or CLI/configuration validation failure.

## 6. Input normalization

File input is UTF-8, one App ID per line. Blank lines and lines whose first non-whitespace character is `#` are ignored; surrounding whitespace is trimmed. Positional and file IDs are concatenated, normalized with `normalizeSteamAppId`, first-wins deduplicated, and kept in first appearance order. The normalized set must contain 1–100 IDs. Any invalid token, unsafe integer, duplicate option, unreadable file, or empty result fails closed before dependency composition or stage execution. File contents are data only and cannot inject CLI flags or shell commands.

## 7. Batch limits

`MAX_BATCH_SIZE = 100`, measured after normalization/deduplication. Game concurrency is exactly 1. No `Promise.all`, worker pool, delay flag, generic rate limiter, or unbounded input is introduced.

## 8. Pipeline stages

For each App ID:

1. Steam import receives `{ dryRun: !write }`.
2. IGDB enrichment receives the canonical game ID and the same dry-run mode.
3. Link verification receives that game ID and dry-run mode.
4. Image ingest sends an authenticated request to the Image Ingest Worker with the game ID and write flag.

The game pipeline is fail-fast: a failed stage marks all later stages `not_run` with a stable reason. A successful Steam dry-run with `plan.action=create` and no canonical game ID is a special successful Steam result; IGDB, links, and images become `not_run` with reason `canonical_game_not_persisted`. An existing canonical game continues through all four stages in dry-run. In write mode, Steam `created`, `updated`, or `existing` must yield a real canonical ID before downstream stages execute.

## 9. Dry-run semantics

Dry-run performs real provider reads and real planning. Existing canonical games execute IGDB planning, link verification, and image Worker dry-run. A new Steam game is never temporarily inserted, assigned a fake ID, or simulated with an in-memory canonical database; downstream stages are explicitly `not_run`. The image Worker still performs real source HTTP, validation/hash and R2 HEAD operations while performing zero R2 PUT and zero D1 INSERT/UPDATE/DELETE.

## 10. Write semantics

`--write` executes local Steam write, obtains the persisted canonical game ID, then performs IGDB write, link verification write, and authenticated image Worker write. The batch is not one transaction. Legal partial progress is retained and no cross-stage rollback is attempted. Image Worker write preserves its R2-first then optimistic D1 binding contract. Re-running an App ID relies on each existing stage’s idempotent/conservative behavior.

## 11. Failure isolation

Within one game, the first failed stage stops that game’s remaining stages. Across games, a failure is recorded and the next normalized App ID starts. Earlier successful games and stages are never rolled back. A stage result is considered failed for orchestration when its typed operation fails or reports a write conflict/unsafe operational outcome; benign per-item outcomes such as an image `deduplicated`, `already_ingested`, `restored`, or `skipped` are successful stage outcomes. A completed image batch may be `partial` internally, but a Worker operation error, D1 conflict, storage failure, or unsafe request makes the image stage failed.

## 12. Stage classification

Every stage adapter maps its native result to `succeeded`, `failed`, or `not_run`, retaining only a safe summary and typed public error. Provider payloads, access tokens, Authorization headers, stack traces, raw DNS/TLS data, and signed URLs are not embedded. `not_run` always carries a stable reason such as `canonical_game_not_persisted` or `previous_stage_failed`.

## 13. Result DTO

```ts
type BulkGameSyncResult = {
  dryRun: boolean;
  total: number;
  succeeded: number;
  failed: number;
  games: BulkGameResult[];
};

type BulkGameResult = {
  appId: string;
  gameId: number | null;
  status: "succeeded" | "failed";
  stages: BulkStageResult[];
};

type BulkStageResult = {
  name: "steam" | "igdb" | "links" | "images";
  status: "succeeded" | "failed" | "not_run";
  summary: string;
  reason?: string;
  error?: { code: string; message: string };
};
```

The DTO is returned by the orchestrator and rendered only after shared presentation sanitization. Ordering follows normalized input order.

## 14. Error and presentation safety

CLI and adapters reuse the V2.5/V2.6 redaction boundary. Human and JSON output sanitize all nested summaries/errors and any URLs. Credentials, fragments, sensitive query values, `TWITCH_CLIENT_SECRET`, `IMAGE_INGEST_TOKEN`, Authorization values, signed query parameters, internal stacks, and environment details never appear. Malformed URLs use the approved `[INVALID_URL]` sentinel. Unexpected exceptions map to fixed public codes/messages.

## 15. Local platform lifecycle

The CLI creates one persistent local Wrangler platform with the repository’s fixed config and `remoteBindings: false`, composes D1-backed Steam/IGDB/link stores from the same binding, runs the whole batch, and disposes it in `finally`. It does not restart Wrangler per game or stage. Platform construction errors fail CLI validation/configuration before any game stage. No remote/database-id/config selection flags are accepted.

## 16. Image Worker boundary

The image adapter calls the dedicated Image Ingest Worker over authenticated HTTP. The CLI/orchestrator never reads image bytes, calls R2, or creates image D1 repositories. Default endpoint is local; any non-local endpoint must satisfy the existing V2.6 HTTPS/explicit-token rules. `--write` never selects a production endpoint automatically.

## 17. Configuration and secrets

IGDB uses `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`; images use `IMAGE_INGEST_WORKER_URL` and `IMAGE_INGEST_TOKEN`. Secrets are read only during local composition, never passed as positional arguments, persisted, logged, or copied into results. Local D1 is mandatory; production bulk targets are out of scope.

## 18. Concurrency and rate limiting

The only V2.7 limiter is game concurrency 1 plus the existing per-stage limits/deadlines. No new pool, `p-limit`, token bucket, delay, or generic retry layer is added. Existing provider-specific throttling/recovery remains inside the provider/service modules.

## 19. Retry policy

The orchestrator performs no automatic retries or backoff. Native provider race recovery and image/link deadlines remain owned by their services. Failed App IDs are listed in the final report so users can rerun them explicitly.

## 20. Idempotency and re-run behavior

Steam preserves existing import identity and conflict handling; IGDB remains conservative; links preserve existing verification write semantics; images retain Worker R2 create-only and optimistic D1 binding. The batch has no run ID, checkpoint, journal, or resume state. Re-running the same normalized IDs is safe and convergent within those stage contracts.

## 21. Testing strategy

Unit tests cover argv/file parsing, comments/blanks/trim, first-wins order and dedupe, max-100 and invalid fail-before-execution, stage state machine, dry-run new-game downstream `not_run`, existing-game full dry-run, write full pipeline, per-game fail-fast, cross-game continuation, aggregate counts/exit code, typed error mapping, and safe formatting. Tests inject fake stage interfaces and assert no child-process execution.

Integration tests use one local D1 lifecycle for Steam → IGDB → links and deterministic local Image Worker HTTP for images. They do not call real Steam, IGDB, public image URLs, remote bindings, or production resources. Assertions cover dry-run zero mutations, write ordering, partial progress, and disposal.

Security tests cover rejection of `--remote`/alternate targets, no secret leakage, no arbitrary Worker URL weakening, `--write` not selecting production, file content unable to inject flags, no shell child commands, and sanitizer coverage for nested stage errors/URLs.

## 22. Security

Input is fail-closed and bounded. Local-only D1 and explicit Worker endpoint policy prevent accidental production writes. Typed adapters prevent raw provider payloads and credentials from crossing the result boundary. Serial execution limits provider, D1, and R2 pressure. No temporary dry-run writes, rollback deletes, schema additions, or unreviewed network paths are introduced.

## 23. V2.8 extension boundary

V2.8 may reuse the pure orchestrator with Worker-native dependencies and add Cron, Queues, Durable Objects, a persistent run/checkpoint model, retry scheduling, production batch APIs, and progress UI. None of those abstractions or storage tables are created in V2.7.

## 24. Operational examples

```bash
npm run games:sync -- 1245620 1091500 292030
npm run games:sync -- --file games.txt --json
npm run games:sync -- --file games.txt --write
```

The human summary reports total/succeeded/failed counts and each App ID’s game ID, stage statuses, summaries, and safe errors. JSON preserves the same typed structure and normalized order. Failed App IDs are printed explicitly for rerun.

## Design review checklist

- No placeholder language or unresolved implementation decisions.
- Fixed order, limits, concurrency, dry-run/write behavior, failure propagation, output states, and remote safety are explicit.
- No schema migration, job table, production dependency, child CLI, or production bulk target.
- Image Worker remains an HTTP boundary.
- `canonical_game_not_persisted` is the sole dry-run new-game downstream reason.
- V2.8 scheduling/job scope is explicitly excluded.
