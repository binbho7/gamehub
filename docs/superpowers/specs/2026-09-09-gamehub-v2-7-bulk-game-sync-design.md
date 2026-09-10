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

### Alternatives

Approach A (selected) is the pure reusable orchestrator with injected stage adapters and no schema/job system: it is testable, deterministic, avoids nested processes, and is directly reusable by V2.8. Approach B would spawn existing child CLIs; it duplicates parsing/composition, loses typed intermediate results, complicates cleanup, and makes failure boundaries opaque. Approach C would add durable DB-backed runs/checkpoints; it is useful for scheduled resume and progress, but adds schema and production state that V2.7 explicitly defers to V2.8.

## 5. CLI contract

```text
npm run games:sync -- 1245620 1091500 292030
npm run games:sync -- --file games.txt
npm run games:sync -- 1245620 --write
npm run games:sync -- --file games.txt --json
```

The default is dry-run. `--write` is the only mutation switch; `--json` selects sanitized machine-readable output. The command accepts positional App IDs and at most one `--file <path>`. Unsupported options, `--remote`, alternate Wrangler/config/database options, duplicate flags, missing file arguments, and mixed invalid input fail before any stage runs. Exit code 0 requires a complete batch with every game succeeded, successful cleanup, and successful result formatting/output. Exit code 1 means any game failure or any fatal validation, lifecycle, or output failure. Section 15 defines the complete stdout/stderr and exit contract.

## 6. Input normalization

File input is UTF-8, one App ID per line. Blank lines and lines whose first non-whitespace character is `#` are ignored; surrounding whitespace is trimmed. Arguments are expanded left-to-right: a `--file path` contributes its file IDs at that argv position, while positional IDs contribute in place. The resulting stream is normalized with `normalizeSteamAppId`, first-wins deduplicated, and kept in first appearance order. The normalized set must contain 1–100 IDs. Any invalid token, unsafe integer, duplicate option, unreadable file, or empty result fails closed before dependency composition or stage execution. File contents are data only and cannot inject CLI flags or shell commands.

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

The aggregate policy is exhaustive. Steam import `created`, `updated`, and `existing` are `succeeded`; typed provider/import errors and write conflicts are `failed`. IGDB enrichment `enrich` and `existing` are `succeeded`; `blocked`, provider errors, mapping ambiguity, schema errors, and write conflicts are `failed`. Link verification uses code-first precedence: any `write_conflict`, `partially_applied`, `game_not_found`, link-limit error, or native code `invalid_url`, `unsupported_scheme`, `unsafe_destination`, `dns_failure`, `tls_error`, `network_error`, `timeout`, `invalid_redirect`, `redirect_loop`, `too_many_redirects`, or `protocol_downgrade` fails the stage. Only when no operation code/error is present do completed HTTP diagnostics determine the outcome: `verified`, `reachable_but_unverified`, `broken`, `temporarily_unavailable`, `unsafe`, and `unknown` are retained as non-failing per-link classifications; HTTP 404/410 and other completed checks therefore remain diagnostics. `manual` metadata is preserved. Image results with status `completed` are `succeeded`; `partial` and `failed` are `failed`, including every storage, D1, deadline, source, download, validation, and consistency outcome. Benign per-image outcomes (`ingested`, `deduplicated`, `concurrent_dedup`, `already_ingested`, `restored`, `skipped`) do not fail the image stage when the Worker result is otherwise completed. No native result is silently treated as success.

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

The DTO is returned by the orchestrator and rendered only after shared presentation sanitization. Ordering follows normalized input order. Only a complete `BulkGameSyncResult` may cross the batch output boundary: `games` contains one completed game result for every normalized input, `total === games.length`, and `succeeded + failed === total` agrees with the game statuses. Expected per-game stage failures produce normal `BulkGameResult.status = "failed"` entries and do not constitute fatal CLI exceptions. A normally returned complete batch is authoritative even if later cleanup fails. If unexpected infrastructure or programming failure prevents a complete batch result from being produced, completed games or partially constructed DTOs must not be packaged or emitted as a batch result.

## 14. Error and presentation safety

CLI and adapters reuse the V2.5/V2.6 redaction boundary. Human and JSON output sanitize all nested summaries/errors and any URLs. Credentials, fragments, sensitive query values, `TWITCH_CLIENT_SECRET`, `IMAGE_INGEST_TOKEN`, Authorization values, signed query parameters, internal stacks, and environment details never appear. Malformed URLs use the approved `[INVALID_URL]` sentinel. Unexpected exceptions map to fixed public codes/messages.

Fatal CLI diagnostics retain exactly the public shape `{ code: string; message: string }`. They never expose `cause`, `stack`, raw `Error` objects, tokens, Authorization headers, secrets, sensitive/signed query values, or raw provider responses. These lifecycle codes and fixed safe messages are normative; caught exception text is never interpolated into them:

| Code | Fixed public message |
| --- | --- |
| `configuration_error` | `Bulk sync input or configuration is invalid.` |
| `platform_unavailable` | `The local bulk sync platform could not be acquired.` |
| `composition_failed` | `Bulk sync stage dependencies could not be created.` |
| `batch_execution_failed` | `Bulk sync could not produce a complete batch result.` |
| `cleanup_failed` | `The local bulk sync platform could not be disposed.` |
| `output_format_failed` | `The bulk sync result could not be formatted.` |
| `output_write_failed` | `The bulk sync result could not be written.` |

The existing per-stage public errors remain inside complete game results. Fatal CLI diagnostics are separate from `BulkGameSyncResult`; no result-plus-error envelope is added.

## 15. Local platform lifecycle

The CLI creates one persistent local Wrangler platform with the repository’s fixed config and `remoteBindings: false`, composes D1-backed Steam/IGDB/link stores from the same binding, and runs the whole batch. It does not restart Wrangler per game or stage. No remote/database-id/config selection flags are accepted. Before execution, the operator must start the Image Worker with the documented fixed local command and the same repository `.wrangler/state` persistence root. The CLI cannot inspect an HTTP Worker’s binding identity; shared-state visibility is therefore conditional on that documented startup precondition, and integration tests verify the configuration and cross-stage visibility rather than claiming runtime introspection.

### 15.1 Validation and disposal ownership

Argv, file input, required environment/configuration, and Image Worker endpoint validation all occur before platform acquisition. A failure in any of these validations produces `configuration_error`, with no batch execution, no result, no stdout, no acquisition, and zero dispose calls. Secret/config reads needed for validation remain inside the CLI composition boundary and never enter the pure orchestrator or output.

`createLocalBulkSyncDependencies` has exactly two ownership outcomes:

- Success returns `{ stages, dispose }`. Ownership transfers to the CLI, which attempts and awaits `dispose` exactly once after batch execution settles and before any result formatter runs.
- Failure returns no handle. If acquisition failed before a lifecycle handle was returned, the acquisition helper owns cleanup of any partially created resources; the outer factory/CLI does not dispose an unacquired handle. If platform acquisition succeeded but subsequent Steam, IGDB, link, or Image Worker stage composition fails before the factory returns, the factory attempts and awaits platform disposal exactly once and rejects with `composition_failed`. The CLI must not dispose again after factory rejection.

Platform acquisition failure is `platform_unavailable`, not configuration validation failure. Composition cleanup failure is secondary and cannot replace `composition_failed`. Each successfully acquired platform has one disposal owner and exactly one dispose attempt; the total is never greater than one. A rejected dispose counts as that attempt. There is no double disposal or dispose retry. Partial-resource cleanup before acquisition resolves remains exclusively the acquisition helper's responsibility.

### 15.2 Lifecycle matrix

“Dispose” counts attempts on a successfully acquired platform across the factory and CLI. The matrix applies equally to human and JSON modes. Each named stderr diagnostic is one safe public error, emitted best-effort; there is never a second competing diagnostic for a suppressed cleanup failure.

| Scenario | Batch / complete result | Stdout | Stderr | Exit | Dispose |
| --- | --- | --- | --- | --- | --- |
| Input/configuration/endpoint validation fails | Not run / none | None | `configuration_error` | 1 | 0; acquire 0 |
| Platform acquisition fails | Not run / none | None | `platform_unavailable` | 1 | Outer count 0 |
| Composition fails after acquisition | Not run / none | None | `composition_failed` | 1 | 1, factory-owned |
| Composition and its cleanup both fail | Not run / none | None | `composition_failed` only | 1 | 1, factory-owned |
| Unexpected batch execution exception, with or without cleanup failure | Started / none, including when earlier games completed | None | `batch_execution_failed` only | 1 | 1, CLI-owned |
| Complete batch and successful cleanup/output | Complete / authoritative result | Complete formatted result | None | 0 if `result.failed === 0`, otherwise 1 | 1 |
| Complete successful-game batch, then cleanup fails | Complete / authoritative result | Complete formatted result | `cleanup_failed` | 1 | 1 |
| Complete batch with failed games, then cleanup fails | Complete / authoritative result | Complete formatted result | `cleanup_failed` | 1 | 1 |
| Human formatter or JSON presentation/serialization fails, with or without prior cleanup failure | Complete result may exist in memory | None; stdout is not called | `output_format_failed` only | 1 | 1, already attempted |
| Stdout write fails, with or without prior cleanup failure | Complete / authoritative result | One attempted write; no retry or fallback | `output_write_failed` only | 1 | 1, already attempted |
| Stdout and stderr both fail | Complete / authoritative result | One attempted write | Best-effort attempt fails and is swallowed | 1; no escaping sink exception | 1 |
| Any fatal/cleanup diagnostic encounters stderr failure | Existing result/error remains unchanged | No additional stdout | Sink exception swallowed | Existing exit 1 unchanged | Unchanged; no additional call |

Expected per-game stage failures remain normal failed-game entries under the existing fail-fast and cross-game isolation rules. An unexpected throw from batch orchestration is different: even if earlier games finished, no partial batch result is emitted. A complete batch remains valid after cleanup failure, so both successful-game and failed-game batches must still be formatted and written before the cleanup diagnostic is emitted.

### 15.3 Primary error precedence

Primary operation/output failure always takes precedence over cleanup failure. The observable cases are fixed:

- Composition failure plus cleanup failure → `composition_failed`.
- Unexpected batch exception plus cleanup failure → `batch_execution_failed`.
- Complete result plus cleanup failure → result on stdout, `cleanup_failed` on stderr, exit 1.
- Complete result plus cleanup failure plus formatter failure → `output_format_failed`, no stdout.
- Complete result plus cleanup failure plus stdout failure → `output_write_failed`.
- Any stderr sink failure → swallow it without changing the selected primary result/error, exit code, or disposal count.

No cleanup diagnostic is emitted before formatting/output succeeds, since a later output failure must take precedence. A caught exception never becomes a competing public JSON object. There is no raw-object fallback, raw `console.log(Error)`, stdout retry, diagnostic retry, or cleanup retry.

### 15.4 Normative state machine

This pseudocode specifies observable semantics and ownership. Equivalent implementation structure is allowed. `publicError(code)` uses only the fixed table in section 14; `emitDiagnosticBestEffort` never invokes the batch formatter and never lets a sink exception escape. Sink calls are awaited so both synchronous throws and asynchronous write rejection follow the same contract.

```text
emitDiagnosticBestEffort(code, mode):
    try:
        diagnostic = fixed safe public error encoded for mode
        await stderr(diagnostic)
    catch:
        swallow

createLocalBulkSyncDependencies(validatedConfig):
    try:
        platform = await acquireLocalPlatform(validatedConfig)
    catch:
        # The acquisition helper cleans any partial resources internally.
        throw publicError(platform_unavailable)

    try:
        stages = await composeStages(platform, validatedConfig)
    catch:
        try:
            await platform.dispose()       # factory's single attempt
        catch:
            swallow                        # composition remains primary
        throw publicError(composition_failed)

    return { stages, dispose: platform's owned disposal operation }

runCli():
    requestedMode = diagnosticModeFromArgv()
    try:
        input, config, mode = validateInputAndConfig()
    catch:
        await emitDiagnosticBestEffort(configuration_error, requestedMode)
        return 1

    try:
        dependencies = await createLocalBulkSyncDependencies(config)
    catch safe factory error:
        await emitDiagnosticBestEffort(error.code, mode)
        return 1                            # CLI has no disposal ownership

    result = undefined
    operationError = undefined
    try:
        result = await runBulkSyncBatch(input, dependencies.stages)
        # Normal return means complete BulkGameSyncResult, never partial.
    catch:
        operationError = batch_execution_failed

    cleanupError = undefined
    try:
        await dependencies.dispose()        # CLI's single attempt
    catch:
        cleanupError = cleanup_failed

    if operationError:
        await emitDiagnosticBestEffort(operationError, mode)
        return 1

    try:
        formatted = formatCompleteSanitizedResult(result, mode)
    catch:
        await emitDiagnosticBestEffort(output_format_failed, mode)
        return 1

    try:
        await stdout(formatted)
    catch:
        await emitDiagnosticBestEffort(output_write_failed, mode)
        return 1

    if cleanupError:
        await emitDiagnosticBestEffort(cleanupError, mode)
        return 1

    return result.failed === 0 ? 0 : 1
```

The factory's existing fixed local configuration and required secret validation are performed before acquisition. The only exceptions leaving factory acquisition/composition are the safe public categories above. Before parsing completes, `requestedMode` means JSON diagnostics when the argv contains the literal `--json` flag, otherwise human diagnostics; it does not bypass normal flag validation.

### 15.5 Output contracts

In JSON mode, successful stdout emission contains exactly one complete, sanitized, valid `BulkGameSyncResult` JSON document, optionally followed by a newline. It contains no fatal envelope, result-plus-error schema, progress message, or second JSON object. Fatal diagnostics go only to stderr, as one `{ code, message }` JSON object followed by a newline. A complete result plus cleanup failure therefore emits valid result JSON to stdout and a separate safe `cleanup_failed` diagnostic to stderr, with exit 1.

In human mode, the complete formatted summary goes to stdout. The selected fatal/cleanup diagnostic goes to stderr as `code: fixed safe message` followed by a newline. The same result validity, precedence, cleanup, and exit rules apply in both modes.

Formatting and sanitization finish before stdout is called. A format failure makes zero stdout calls. A failing stdout sink may already have accepted a prefix of the serialized document; the CLI cannot retract those bytes and must not retry, append another object, or fall back to raw data. It attempts only the safe `output_write_failed` stderr diagnostic and returns 1. Stderr is always best-effort: swallow sink failure without throwing, retrying, changing the exit code, disposing again, or writing diagnostics/raw errors to stdout.

## 16. Image Worker boundary

The image adapter calls the dedicated Image Ingest Worker over authenticated HTTP. The CLI/orchestrator never reads image bytes, calls R2, or creates image D1 repositories. The default and only V2.7 endpoint is the fixed local Worker endpoint; non-local endpoints are rejected by the bulk CLI, including HTTPS production/preview URLs. This prevents a local canonical game ID from being sent to an unrelated remote database. Any future remote Worker mode requires a separately designed identity/target contract and is V2.8+ scope. `--write` never selects a production endpoint automatically.

## 17. Configuration and secrets

IGDB uses `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`; images use `IMAGE_INGEST_WORKER_URL` and `IMAGE_INGEST_TOKEN`. Secrets are read only inside CLI configuration validation/composition, with required configuration checked before platform acquisition. They are never passed as positional arguments, persisted, logged, or copied into results. Local D1 is mandatory; production bulk targets are out of scope.

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

Lifecycle/output tests exercise both human and JSON modes with injected acquisition, stage composition, batch runner, disposer, formatters, and stdout/stderr sinks. They assert these explicit cases:

1. Argv, file, required configuration, and endpoint validation failure → acquire 0, dispose 0, no batch/result/stdout, safe `configuration_error`, exit 1.
2. Platform acquisition failure → outer dispose 0, no batch/result/stdout, `platform_unavailable`, exit 1; any partially created resources are cleaned by the acquisition helper.
3. Stage composition failure after acquisition → factory dispose 1, CLI dispose 0, no batch/result/stdout, `composition_failed`, exit 1.
4. Composition plus cleanup failure → exactly one dispose attempt and only `composition_failed` as the primary diagnostic.
5. Unexpected batch throw after zero or some completed games → dispose 1, no partial result/stdout, `batch_execution_failed`, exit 1; simultaneous cleanup failure cannot replace it.
6. Complete successful result plus successful disposal → dispose precedes formatting, one complete result emitted, exit 0. A complete result containing failed games with successful disposal emits normally and exits 1.
7. Complete successful-game result plus dispose failure → result still emitted, only `cleanup_failed` on stderr, exit 1.
8. Complete failed-game result plus dispose failure → result still emitted, only `cleanup_failed` on stderr, exit 1.
9. Human formatter or JSON sanitization/serialization failure → dispose already attempted once, zero stdout calls, `output_format_failed`, exit 1.
10. Cleanup plus formatter failure → only `output_format_failed`, zero stdout calls, dispose 1, exit 1.
11. Stdout failure → safe `output_write_failed` stderr attempt, exit 1, no stdout retry/raw fallback; prior cleanup failure is suppressed.
12. Stdout plus stderr failure → exit 1, no escaping sink exception, no retry or additional dispose.
13. Fatal error plus stderr failure → selected primary error and exit 1 remain unchanged; platform failure retains dispose 0 and cleanup failure after a complete result retains dispose 1 and the already-emitted result.
14. Every acquired platform has one owner and exactly one dispose attempt across success, composition failure, batch exception, formatter failure, and output failure; factory rejection never transfers disposal ownership to CLI.
15. Rejected disposal is never retried, including when output/diagnostic operations also fail.

Assertions also verify `total === games.length`, count consistency, complete input-order results, JSON stdout parsing after successful writes, the lack of competing fatal objects, fixed public messages, and no `cause`/stack/raw provider/secret leakage from injected failures. Failing sinks are tested for both synchronous throws and asynchronous rejection.

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
- Complete batch versus fatal partial-result boundaries and every validation/acquisition/composition/batch/cleanup/output scenario are explicit.
- A successfully acquired platform has exactly one disposal owner and one attempt; partial acquisition cleanup remains internal, and dispose is never retried.
- Operation and output failures take precedence over cleanup; stderr failure cannot change the result, primary error, exit code, or disposal count.
- JSON stdout is one complete result document on successful emission; diagnostics remain safe and separate on stderr in both modes.
