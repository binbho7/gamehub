# GameHub V2.8 Cloudflare Cron Sync Design

Date: 2026-09-14. Design clarified: 2026-09-15. Monotonic fencing correction: 2026-09-15, following correction `ce9f7316ec115d245e96ed4fdb5a0060b9c25e75`.

Design baseline: `36f5bc17494111e65c1d3fcb93d111f631b8cd0c` (`main`, released V2.7; dereferenced `v2.7-bulk-game-sync`). Branch: `codex/v2-8-cloudflare-cron-sync`.

This document specifies architecture and externally observable contracts. It authorizes no implementation, deployment, migration execution, or production access. Implementation planning follows separate human Design approval.

## 1. Context

V2.7 supplies a local, manual, serial pipeline for Steam App IDs. V2.8 schedules the same domain work against existing production canonical games, selected from D1. The fixed pipeline remains Steam → IGDB → Official Links → Images. The scheduler adds bounded admission, fair rotation, overlap protection, and safe operational results; it does not become a job platform.

The approved transport decision is a Cron Worker plus D1 lease/state, shared V2.7 orchestration, a narrow Node verifier in Cloudflare Containers, and the existing Image Ingest Worker. V2.5 SSRF guarantees take precedence over runtime convenience.

## 2. Existing V2.7 Architecture

The following findings come from the release tree, not proposed interfaces:

| Existing surface | Actual responsibility / V2.8 reuse |
|---|---|
| `lib/sync/batch.ts` | `runBulkSyncBatch({appIds, dryRun, stages})` normalizes inputs, runs every requested game, and calls `assertCompleteBatch`. Its result cannot describe an unstarted suffix. |
| `lib/sync/game-pipeline.ts` | `runBulkSyncGame` executes four stages serially, catches stage errors, marks later stages `not_run`, and preserves prior writes. |
| `lib/sync/stages.ts`, `types.ts` | `BulkSyncStages`, typed stage errors, `BulkGameResult`, and `BulkGameSyncResult`; stage errors are allowlisted, not arbitrary messages. |
| `lib/sync/{steam,igdb,link,image}-stage.ts` | Native result validation and exhaustive stage aggregation. An HTTP 404 link result is domain data, whereas a link operation error fails the stage. |
| `scripts/sync-composition.ts` | Local Wrangler acquisition, local D1, Node DNS composition, and loopback Image Worker URL. This file is not a Cron dependency. |
| `scripts/sync-image-client.ts` | Fetch-based authenticated image client plus strict response parser; runtime-neutral code currently resides under `scripts`. |
| `lib/importers/steam.ts`, `lib/enrichers/igdb.ts` | Shared business logic with injected clients/stores. Steam permits create; Cron must explicitly constrain that capability. |
| `lib/verifiers/official-links/service.ts` | Reads D1 snapshots, calls injected `VerifyBoundUrl`, runs shared classification/planning, then optimistic D1 write. Maximum 20 links and 5-minute game deadline. |
| `verifier.ts`, `redirect.ts`, `transport.ts`, `destination.ts` | HEAD/GET selection, redirect policy, Node socket transport, and DNS/IP destination enforcement. Per-link 20 seconds, DNS 3 seconds, request 8 seconds, five followed redirects. |
| `workers/image-ingest/src/index.ts` | Authenticated `/internal/images/ingest`, fixed `{gameId,write}` body, image service, R2 and D1. Five-minute image-game deadline; each image has a 30-second deadline. |
| `lib/db/schema.ts`, `drizzle/` | Four SQL migrations; no sync metadata or scheduler lock. Existing `games.updated_at` is business metadata, not a scheduler clock. |

`game_external_ids` is unique on `(provider, external_id)`, not `(game_id, provider)`. Multiple Steam mappings on one game are possible and require explicit candidate exclusion. Baseline schema SHA-1 is `d959b11fc297164388f3cc28708beadab2d7842f`.

## 3. Discovered Worker Runtime Blocker

The Node verifier uses custom `lookup`, `autoSelectFamily:false`, `agent:false`, original hostname Host/SNI, certificate verification, and normalized socket `remoteAddress` comparison. Worker compatibility APIs do not provide an equivalent combination. Pre-resolving DNS and then ordinary Worker `fetch` does not bind the actual socket to the approved address.

The Node transport therefore runs in an actual Linux Node process in a Container. The Cron bundle must not import Node DNS/socket implementation modules. Container support for general runtime images makes this architecture feasible; actual remote deployment must pass socket conformance probes before enabling Cron. A failure of those probes is a release blocker, never permission to remove an invariant.

Primary platform references: [Workers Node HTTP compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/), [Node DNS compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/), and [Containers overview](https://developers.cloudflare.com/containers/).

## 4. Architecture Decision Record

| Option | Security and operations | Decision |
|---|---|---|
| A: Cron Worker + D1 + Node Verifier Container + Image Worker | Keeps the tested Node enforcement path, private Worker-controlled ingress, and one Cloudflare deployment environment. Adds Container startup/runtime operation. | Selected; user-approved. |
| B: Cron Worker + external Node verifier service | Can preserve the same contract and security, but adds external hosting, TLS/routing, secret distribution, and availability ownership. | Technically valid alternative; unnecessary operational spread for V2.8. |
| C: Worker-native rewritten SSRF transport | Would require proof of request-bound DNS, socket peer validation, Host/SNI and redirect equivalence that current APIs do not supply. | Rejected; no security-reducing fallback. |

For scheduling, use a D1 lease plus a durable monotonic fencing epoch and serial admission. The lease controls current ownership; atomic D1 fencing prevents expired or superseded owners from publishing authoritative state, even when their previously dispatched operations keep running. No platform maximum operation lifetime is assumed. Queue-per-game dispatch adds delivery/retry semantics and a second execution model; an application DO coordinator adds state ownership without a V2.8 requirement. Neither is selected. Container platform DO plumbing is permitted, but must contain no scheduler state, candidate logic, or job coordination.

## 5. Goals

Automatically refresh existing Steam-backed canonical games from production D1; rotate through the catalog deterministically across runs; process a configurable small candidate slice serially; admit one current Cron owner; recover after crashes by acquiring a higher epoch after expiry while rejecting stale authoritative writes; preserve cross-game failure isolation and every existing stage's mutation semantics; keep Container privileges limited to network verification. Old network/R2 operations can overlap a later owner; exclusive current D1 mutation authority is the correctness guarantee.

## 6. Non-goals

No new canonical-game discovery, fixed App ID catalog, public/manual trigger endpoint, full run history, durable resume, transactional rollback across stages, background retry engine, concurrency above one, or Admin feature. V2.7 CLI defaults and its local-only production restrictions remain unchanged.

## 7. Deployment Topology

```text
Cron trigger → Scheduler Worker → production D1 (selection, lease, stage stores)
                    ├─ Steam and IGDB APIs
                    ├─ private Container binding → Node verifier → official sites
                    └─ Image Worker service binding + authentication → R2 / same D1
Existing app/web → existing read paths (independent deployment)
```

| Component | Data authority | Secrets and ingress |
|---|---|---|
| Existing app/web | Existing application reads/writes only | Unchanged; no scheduler entry point. |
| Scheduler Worker | Fenced D1 scheduler tables and Steam/IGDB/link repositories | Twitch credentials, verifier service secret, scheduled Image token; scheduled handler only. |
| Container binding facade | Start/route to one named verifier instance; no D1/R2 | Injects only verifier service secret; no public routes, workers.dev, or preview URL. |
| Node verifier Container | Outbound public HTTP(S) after V2.5 checks; no database | Verifier service secret only; port reachable through the bound facade, no public proxy. |
| Image Ingest Worker | Fenced scheduled image D1 publication; conditional immutable R2 creation | Separate scheduled and legacy tokens/routes, public image base URL, DB and bucket bindings. |
| D1 | One database identity shared by scheduler and Image Worker | Binding capability; no Cloudflare API token in application code. |
| R2 | Existing image bucket | Only Image Worker owns bucket binding. |

The Container facade is deployed with the scheduler and uses a fixed per-environment instance name, `official-links-v1`. It does not forward caller-supplied paths, hosts, ports, methods, or headers. Scheduled Image requests use a private service binding, a distinct authenticated scheduled route, and required fencing authority (Section 21). The app and scheduler never receive an R2 mutation capability.

## 8. Cron Scheduler Worker

Add a separate `workers/cron-sync` deployment. Its `scheduled` handler awaits the scheduler promise and emits one terminal structured event. Its optional mandatory runtime `fetch` export returns 404 for all requests; there is no HTTP route to trigger synchronization or verification. Production writes are enabled only by validated production configuration; local tests use separate local bindings.

Configuration is validated before lease acquisition or provider calls. Secrets are checked for presence without printing values. The trigger expression is deployment configuration, initially daily UTC; domain code accepts execution metadata without branching on a specific expression.

```ts
type CronSyncConfig = {
  batchSize: number;                 // integer 1..25; default 25
  platformWallBudgetMs: 900_000;     // current scheduled-event contract
  softDeadlineMs: number;            // default 720_000; never above 720_000
  gameAdmissionReserveMs: number;    // default/minimum 780_000
  finishReserveMs: number;           // default/minimum 30_000
  leaseDurationMs: number;           // default/minimum 1_500_000
};
type CronExecutionInput = {
  executionId: string;               // cryptographic UUID, not the cron string
  scheduledAt: Date;
};
type SyncCandidate = { gameId: number; appId: string };
interface CandidateRepository {
  select(limit: number): Promise<SyncCandidate[]>;
  stillMatches(candidate: SyncCandidate): Promise<boolean>;
}
```

Batch 25 is an admission ceiling, not a promise to execute 25 games. V2.7's public batch ceiling remains 100. An invalid combination with no room for one game plus finish reserve fails configuration; a shorter soft deadline is permitted only as a deliberate earlier admission cutoff. Monotonic elapsed time measures admission; D1 time controls lease validity.

## 9. Candidate Selection

Select existing `games` with exactly one Steam mapping. That mapping must be canonical decimal `1..4294967295` (no sign, whitespace, leading zero or non-digit) and must normalize identically under `normalizeSteamAppId`. Exclude games with zero/multiple/malformed mappings before applying LIMIT. This prevents repeatedly choosing unusable rows and blocking healthy rows behind them. IDs are never inferred from titles or URLs.

LEFT JOIN the per-game Cron metadata. Order by `(last_attempt_at IS NOT NULL) ASC, last_attempt_at ASC, games.id ASC`, then limit to `batchSize`. The absence of a metadata row means never attempted by Cron. Failure attempts advance the same clock as successful attempts; ordering by last success would permanently prioritize poisoned games. The timestamp is obtained from D1. Stable `games.id` breaks equal-time ties.

The query must implement all eligibility filters before LIMIT, including one mapping per game and canonical uint32 validation. Re-run `stillMatches` before each admitted game. A changed/deleted mapping consumes the candidate as a safe failed attempt (existing Steam `write_conflict`, with later stages `not_run`) without provider calls or canonical creation. No cursor is required; a fixed snapshot of at most 25 candidates plus per-game stamps provides deterministic rotation. Continuous arrivals can delay old games, but a finite eligible catalog has no starvation from failed or interrupted entries.

## 10. Scheduler State

Use a new `game_cron_sync_state` table with exactly `game_id`, `last_attempt_at`, and `last_status`. `game_id` is the primary key/FK to `games.id` with cascade deletion; `last_attempt_at` is a required epoch-millisecond integer; `last_status` is `started | succeeded | failed`. Add index `(last_attempt_at, game_id)`.

Stamp `started` using D1 time immediately before launching each admitted game, atomically guarded by current owner, epoch and expiry. A resolved game result updates status to succeeded/failed under the same guard while retaining the attempt timestamp. If the Worker crashes, `started` remains evidence of an interrupted/unknown attempt, not success. The stamp makes that game rotate behind older work even after a crash. Do not automatically rewrite old `started` values during selection.

There is no `last_sync_at` success-only field, recent raw error, cursor, run history or per-stage state. The UI-free V2.8 scheduler needs the last attempt for fairness and last status for interpreting its metadata. Future last-success history can be added by a later migration. Scheduler lease is a separate singleton row; no global start/finish timestamps are necessary because current execution logs supply them.

```ts
type GameCronStatus = "started" | "succeeded" | "failed";
type AttemptStamp = {
  gameId: number;
  attemptedAt: Date;
  authority: ScheduledMutationAuthority;
};
interface SchedulerStateRepository {
  startAttempt(gameId: number, authority: ScheduledMutationAuthority): Promise<AttemptStamp>;
  finishAttempt(stamp: AttemptStamp, status: "succeeded" | "failed"):
    Promise<void>;
}
```

Both methods include Section 11's atomic fence boundary; finish additionally matches the attempt timestamp and `started` state. An invalid fence is `fence_lost`; a valid fence with a failed expected mutation is `state_conflict`. Neither is silent success. Start's INSERT/UPSERT and its conflict-update arm are both guarded. If `stillMatches` discovers the canonical game itself was deleted before stamping, record the complete safe Steam failure in the Cron result and omit metadata for that absent game; no metadata row is recreated without its FK. A deletion racing after that check is a state-write failure and stops further admissions. Other metadata write failure is also a Cron infrastructure failure, retaining prior game results. No late completion may overwrite a newer owner's metadata.

## 11. D1 Lease and Monotonic Fencing

### 11.1 Durable state and time

`cron_sync_lease` has exactly four columns: `name` (TEXT PK, CHECK `game-sync`), nullable `lease_owner_token` (TEXT), `lease_expires_at` (INTEGER NOT NULL DEFAULT 0), and `fence_epoch` (INTEGER NOT NULL DEFAULT 0). Consistency requires null owner with zero expiry, or a nonempty owner with positive expiry. Epoch and expiry require SQLite integer storage and nonnegative values; epoch is bounded by `9007199254740991` for exact TypeScript/JSON representation. Migration seeds `(game-sync, NULL, 0, 0)`. The singleton is never deleted, reset or reseeded during runtime; preserving its high-water epoch across release/deployment is mandatory.

All expiry comparisons use database time, `CAST(unixepoch('subsec') * 1000 AS INTEGER)`, called `db_now_ms` below. Neither Worker time nor caller-supplied expiry grants authority. Candidate clocks and admission diagnostics may be local; admission remaining-lease calculations obtain DB time in the same primary statement as the lease read. Boundary is strict: expiry equal to DB time is invalid.

```ts
type ScheduledMutationAuthority = Readonly<{
  ownerToken: string; // fresh UUID for each ownership acquisition
  fenceEpoch: number; // positive safe integer; durable DB epoch
  leaseExpiresAtMs: number; // issued expiry; diagnostic/admission data only
}>;
type LeaseHandle = ScheduledMutationAuthority;
type LeaseAcquireResult =
  | { status: "acquired"; lease: LeaseHandle }
  | { status: "held" };
interface LeaseRepository {
  acquire(ownerToken: string, durationMs: number): Promise<LeaseAcquireResult>;
  assertOwned(lease: LeaseHandle): Promise<{
    dbNowMs: number;
    leaseExpiresAtMs: number;
  }>; // admission optimization only; one primary DB statement
  release(lease: LeaseHandle): Promise<"released" | "fence_lost">;
}
```

### 11.2 Acquire, expiry, release and renewal

Acquire is one conditional UPDATE with RETURNING on the seeded singleton: expired/released row only, set fresh owner, DB-time expiry and `fence_epoch = fence_epoch + 1`, subject to the safe-integer ceiling. Exactly one returned row is a winner. Concurrent acquisition has one winner; active lease yields `held`. Missing singleton, corrupt state or epoch exhaustion is an infrastructure failure, never insert/reset-to-zero recovery. Initial absence is handled only by migration initialization before Cron is enabled. Post-failure primary inspection can distinguish these safe failures, but never grants authority or retries mutation based on a read. Lost acquire response leaves any acquired lease to expire; do not infer success from the proposed owner token.

Lease expiry revokes old mutation authority; it does not prove an operation has settled. A new owner may acquire immediately after expiry and must receive a higher epoch, even if old promises remain pending or the old process restarts. No waiting for old-operation acknowledgement and no durable quarantine are required. Old authority is also invalid immediately after an owned release. Release is one conditional UPDATE requiring owner AND epoch AND still-valid DB expiry; it clears owner/expiry and preserves epoch. A late or expired release returns `fence_lost` without altering current state. A matching new acquisition never reuses the old epoch.

V2.8 uses no renewal: its 25-minute lease and existing admission reserves cover the intended 15-minute invocation operational envelope. This sizing affects throughput and availability, not stale-write safety. An overrun loses write authority. No background heartbeat may renew a detected unsettled invocation. If renewal is introduced by a future approved design, it must condition on owner, epoch and still-valid DB expiry, keep the same epoch, and forbid resurrection; an expired process must obtain a fresh ownership/epoch through acquire. No renewal endpoint or code is added in V2.8.

Before each candidate and stage, verify local loss/unsettled signals and use `assertOwned` to avoid needless remote work. This check is never the D1 write guard. Uncertain delivery/native Image mutation signals stop new admission and suppress voluntary early release while the invocation lives. Process death may lose those signals. Durable safety comes from atomic epoch/expiry validation on writes; expiry permits the next ownership regardless of pending old work.

### 11.3 Atomic mutation boundary

Every scheduled authoritative INSERT, UPDATE, DELETE (none currently selected), and UPSERT update arm must include the bound predicate:

```sql
EXISTS (
  SELECT 1 FROM cron_sync_lease
  WHERE name = 'game-sync'
    AND lease_owner_token = :owner
    AND fence_epoch = :epoch
    AND lease_expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
)
```

UPDATE/DELETE add it to their existing WHERE; INSERT uses an explicit-column `INSERT ... SELECT ... WHERE EXISTS (...)`; UPSERT also guards DO UPDATE. Preserve all existing identity, manual-verification, snapshot, uniqueness and fill-empty predicates. The authority is captured immutably when the stage/request is composed, including in a promise that finishes much later. Never replace it with a newly read epoch. `checkFence(); await network; write()` and `SELECT epoch` followed by a separate unguarded write are forbidden.

Existing multi-statement domain operations retain one transactional D1 `batch()`. All writes in that batch carry the same owner/epoch and live DB expiry predicate. To preserve all-or-nothing behavior if validity changes as DB time advances between statements, add fence assertion statements at both ends of the same batch. An assertion conditionally preserves `fence_epoch` when the full predicate holds, otherwise assigns an invalid negative epoch and trips a named epoch CHECK constraint, rolling back the entire batch. This is a transactional assertion, never a committed decrement. Assertion results must match exactly one singleton row; missing row makes every guarded write a no-op and is a hard failure. No auxiliary table/column or interactive transaction across HTTP is required. A final assertion failure rolls back earlier domain writes, so a batch cannot silently commit a prefix after expiry. Both assertions and writes use database-evaluated time; an application-sampled timestamp cannot freeze validity.

The same boundary is used for one-write operations when fence/no-op distinction is needed. Inspect assertion outcomes and each domain statement's affected rows/RETURNING, not just the sum. Invalid authority yields a branded fixed-message `fence_lost`, including when the domain mutation would otherwise be a no-op. With valid assertions, zero changes retains native semantics (unchanged/idempotent, snapshot conflict, manual skip, existing identity); unexpected counts are repository invariant failure. Constraint rollback for the named assertion is decoded safely; other DB failures remain their existing safe failure class. Later diagnostic SELECT may explain an unknown error but cannot turn a failed fence into success. Empty plans validate current authority without issuing business writes.

D1 transaction ordering is the linearization boundary: a valid A mutation transaction that linearizes before B's ownership acquisition is legal; B's acquisition then increases the epoch. If B acquires first, A's old epoch fails inside its transaction. A is also rejected when already expired and no B exists. Expiry is judged at the atomic database validity boundary, not when a queued request was sent or a response reached the Worker. A response delivered after expiry may report a transaction legally ordered earlier; it does not authorize another write. No read replica, application clock or out-of-transaction fence result participates in this decision. Test the concrete D1 batch assertion/rollback ordering before enabling production.

### 11.4 Authoritative mutation inventory and ownership

The release repositories were inspected at `lib/db/repositories/{steam-import,igdb-enrichment,link-verification,image-ingest}.ts`; current code does not fence writes. The required scheduled variants retain their query builders/business policy and add the atomic boundary above. They may share narrow SQL builders with legacy repositories; production composition cannot delegate a write to an unfenced store after a stage-start check.

| Authoritative operation | Actual existing path / complete scheduled coverage |
|---|---|
| Steam canonical data | `SteamImportStore.applyPlan`: Cron permits update/existing only. Current update arm writes `game_external_ids`, `game_official_links`, `game_videos`; guard every UPDATE and the whole existing batch. Canonical `games`/taxonomy/relation/media INSERTs in the create arm are rejected before SQL in scheduled mode. Any future permitted canonical write must join this inventory. |
| IGDB canonical and reference data | `IgdbEnrichmentStore.applyPlan`: guard `games` fill-empty UPDATE; external identity INSERT and its identity-conflict assertion INSERT; taxonomy INSERTs into `genres`, `platforms`, `companies`; relationship INSERTs into `game_genres`, `game_platforms`, `game_companies`; and `game_official_links`, `game_images`, `game_videos` INSERTs. Preserve one batch and all uniqueness/conflict behavior. |
| Official Link verification metadata | `LinkVerificationStore.writePlan`: every planned `game_official_links` UPDATE plus fence assertions inside the existing optimistic batch; full snapshot and manual exclusion remain. Container response is read-only and conveys no D1 permission. |
| Per-game scheduler state | `startAttempt` INSERT/UPSERT and `finishAttempt` UPDATE in `game_cron_sync_state`, both fenced; last attempt/status/failure completion cannot be overwritten by stale owners. |
| Global lease state | Acquire is its own atomic ownership transition; release conditions owner/epoch/live expiry and preserves epoch. No persistent global run-completion/status fields exist; future scheduler state writes require the same fencing before being added. |
| Image metadata/publication | `optimisticBindImage` UPDATE and `conditionallyCreateImage` INSERT in `game_images`, including all reference/storage metadata, use the scheduled fenced repository in Image Worker. Any future canonical cover/hero reference write would also require the guard; current image repository does not write `games`. |

No planned scheduler operation deletes canonical data, relations, images, lease state or R2 objects. Logs, read-only Container responses and conditional immutable R2 artifacts are non-authoritative; D1 image-reference publication is authoritative. The same production D1 binding identity is required for Scheduler and Image Worker. Bound owner/epoch travels through every scheduled store; neither Container nor an untrusted provider controls it. Owner capability is secret-safe and must not be logged or put into public results.

D1 statement/transaction atomicity is the concurrency primitive. See [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/) and [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## 12. Soft Deadline

Soft-deadline admission checks occur between games only; authority-loss checks also occur before stages and at every D1 commit. The defaults are 15-minute platform wall budget, 12-minute soft admission cutoff, 13-minute conservative game reserve, 30-second completion reserve, and 25-minute lease. Admit only when elapsed is below the soft cutoff and remaining platform/lease time covers game reserve plus completion reserve. Thus the conservative default admits new work only in roughly the first 90 seconds; fast games can fill the selected slice, while a slow game can consume most of the event.

The 13-minute reserve includes Steam's 10-second request, IGDB's three requests with existing single authentication retry (up to 120 seconds conservatively including token calls), Links' 300-second game budget including remote startup, Images' 300-second game budget, and remaining network/SQL overhead. It is an admission estimate, not an assertion that D1, network or platform CPU cannot fail. No timer races the whole game and no soft deadline aborts an admitted stage. Existing stage deadlines still apply.

Container startup and remote overhead count inside the existing Links game deadline; they do not create another five-minute allowance. Image response receipt has a bounded extra 10-second transport envelope outside its 300-second service budget. Image delivery uncertainty and parsed native deadlines stop this Cron and retain its lease voluntarily until expiry. D1 hangs, unexpected CPU limits, or platform hard termination can still interrupt a game; prior legal writes remain and no success is invented. A later run may acquire a higher epoch after expiry; late old D1 mutations are rejected by Section 11. Platform duration limits size operations only and are never a proof of old-operation settlement.

Production requires the supported paid scheduled-event wall/CPU budget. Configure CPU allowance independently from wall time, and validate a canary under actual limits. A schedule more frequent than the supported long-run CPU tier must be rejected during deployment validation. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) is the deployment authority; changing platform limits requires revalidating these inequalities, not silently extending a run.

## 13. V2.7 Orchestrator Integration

Choose a complete singleton batch for each admitted candidate: `runBulkSyncBatch({appIds:[candidate.appId], dryRun:false, stages})`. This reuses `runBulkSyncGame` internally and the complete-batch runtime assertion. A scheduler-specific outer loop controls admission, stamps metadata, and aggregates the one-game results. It never calls the batch runner with a suffix it might abandon, never truncates a `BulkGameSyncResult`, and never redefines V2.7's completeness contract.

Stages are bound to the candidate's expected canonical ID and acquired immutable authority for that singleton call. Validate the returned identity before accepting the game. A malformed/incomplete singleton batch is `pipeline_contract_error` at Cron level; retain validated earlier results, stop admission, and do not manufacture a result for the incomplete candidate. Each normal game failure continues to the next candidate if time and authority permit. The scheduler separately inspects internal authority-loss and unsettled-work signals after the singleton settles or throws; the public V2.7 stage error cannot carry sufficient evidence for that decision. Every stage wrapper refuses to start if authority loss or unsettled work was already observed.

Fenced store wrappers mark a shared invocation authority-loss latch before translating the branded fence error to the native safe stage failure (`write_conflict` for Steam/IGDB, `write_failed` for Links, `d1_write_failed` inside native Image results). This preserves V2.7 failure enums while ensuring its catch/first-error behavior cannot hide Cron `fence_lost`. The scheduled Image envelope additionally carries loss explicitly (Section 21). No known fence failure is retried under a newly fetched epoch; the current run ends and does not overwrite later-owner metadata.

All production composition belongs under `workers/cron-sync`; reusable scheduling policy belongs in `lib/scheduler/`. No `child_process`, local Wrangler acquisition, CLI invocation or `process.env` is imported into scheduler domain code. The V2.7 public CLI contract and its errors remain backward compatible.

## 14. Steam Stage Composition

Compose existing Steam client/importer/stage with production D1. Use a narrow scheduled store implementing `SteamImportStore`: every snapshot for the selected Steam mapping must belong to the expected candidate game, and `applyPlan` must reject `create` or a differing `existingGameId` before building SQL. Its update SQL uses Section 11's fence-aware shared builders/atomic batch; it cannot delegate to the unmodified unfenced store. Existing games may receive exactly the V2.2 update behavior; the Cron cannot create a canonical game even if its mapping disappears between candidate selection and import planning.

The store checks identity again on importer post-write lookup. A mapping mismatch is an existing `SteamImportError` with code `write_conflict`; after a wrong/missing identity, later stages cannot start. It does not duplicate normalization, slug allocation, update planning, or importer retry logic. A late Steam fetch may finish after expiry; its real apply still checks the captured authority atomically and marks `fence_lost` before native error translation. Creation-capable behavior remains available to local CLI only. No Steam credentials or arbitrary provider base URL are accepted from D1 rows.

## 15. IGDB Stage Composition

Create existing Twitch auth/client/enricher/store/stage against the same production DB. Cache Twitch tokens in Worker memory per composition/isolate with existing expiration and invalidation rules; token absence/expiry is not persisted in D1. Identity remains the canonical game's sole Steam mapping → IGDB external mapping, with ambiguous identity blocked. Existing fill-empty scalar updates, additive relationships, optimistic conflict handling, and safe errors remain unchanged. No generic retry, title matching, overwrite policy, or company URL inference is added.

The scheduled store uses the complete IGDB SQL inventory in Section 11.4, including taxonomy rows and the external-identity conflict assertion. Network completion never grants authority: the final batch validates owner/epoch/live expiry atomically. A late provider response or retry after authority loss cannot commit any prefix of the enrichment batch.

## 16. Official-Link Transport Abstraction

The existing `VerifyBoundUrl` injection is the correct seam. Add a runtime-neutral named interface returning the existing `TerminalOutcome`; do not move classification or the D1 service into the Container.

```ts
interface OfficialLinkVerificationTransport {
  verify(exactUrl: string, options?: {
    linkDeadlineMs?: number;
    signal?: AbortSignal;
  }): Promise<TerminalOutcome>;
}
type VerifierServiceErrorCode =
  | "verifier_service_unavailable"
  | "verifier_timeout"
  | "verifier_protocol_error"
  | "verifier_auth_error"
  | "verifier_invalid_response";
type RemoteVerifierError = {
  code: VerifierServiceErrorCode;
  message: string; // fixed code-indexed text, never upstream text
};
```

Local Node implementation delegates to existing `verifyUrl`, `executeRedirectChain`, resolver and `requestHeaders`. Remote implementation delegates to the authenticated Container protocol. Both have the same target-verification domain outcomes. Service-delivery failures throw a branded safe error; they are not fabricated `TerminalOutcome`s about a website. A parent signal already aborted returns the existing `timeout` terminal without starting remote work; a delivery deadline during an active RPC is `verifier_timeout`.

Strict compatibility additions extend `StageFailureCode`, its exhaustive allowlist, and `createLinkStage`'s branded-error handling with the five service codes. They do not extend persisted verification statuses or repurpose V2.5 target codes. Classification and plan code remain one shared implementation.

## 17. Node Verifier Container

Package the existing Node transport and its dependency graph into a small pinned supported Node LTS Linux image. The service accepts exactly one verification per request, uses fixed policy, and returns bounded observations. It runs as non-root, does not use a shell for requests, writes no request data to disk, and has no database/provider/storage SDK clients.

For every hop: parse and validate URL/default port; resolve all addresses; reject the entire destination if any address is unsafe; choose an approved address; custom lookup returns only that address; preserve original Host and DNS hostname SNI; validate TLS certificates and normalized socket peer; use a fresh connection; independently revalidate every redirect. IP literals bypass DNS but use the same classifier. The existing special-use tables and IPv4-mapped IPv6 handling are shared unchanged.

HEAD is first; GET fallback is only for existing statuses 400/403/404/405/501, restarts from original URL, shares the total link deadline and five-followed-redirect allowance, and consumes zero response body bytes. `301/302/303/307/308` follow; malformed/missing Location gives `invalid_redirect`; other 3xx are terminal HTTP observations. HTTPS downgrade, redirect loops, DNS mixtures, mismatched socket peers, unsafe literals, and special-use destinations fail closed.

One fixed named instance is used per environment; service concurrency is one active verification and no internal queue. A concurrent request receives a bounded unavailable response. On-demand startup is limited to 10 seconds and is counted in the caller's deadline. After startup, the facade computes the remaining per-link budget before signing/sending the request; it never grants a fresh 20 seconds after cold start. The service sleeps after 5 minutes idle, remains alive during active verification, and destroys sockets on request cancellation or deadline. Restart loses only transient observations. No startup failure can bypass Links or invoke Worker-native target fetch.

## 18. Container Contract

Only `POST /internal/v1/official-links/verify`, JSON content type, fixed HTTP request policy, no query or fragment. No supplied headers, method, DNS server, chosen IP, TLS settings, credentials, request body for the target, or arbitrary response-header selection are allowed.

```ts
type RemoteVerifierRequest = {
  version: 1;
  operation: "verify_official_link";
  requestId: string; // UUID
  exactUrl: string;
  budgetMs: number; // integer 1..20_000; remaining existing per-link budget
};
type WireAttempt = {
  method: "HEAD" | "GET";
  url: string;
  resolvedAddress: string | null;
  addressFamily: 4 | 6 | null;
  httpStatus: number | null;
  startedAtMs: number;
  finishedAtMs: number;
};
type WireRedirectHop = {
  fromUrl: string;
  status: 301 | 302 | 303 | 307 | 308;
  location: string;
  resolvedUrl: string | null;
};
type WireTerminalOutcome = {
  code: VerificationCode;
  attempts: WireAttempt[];
  redirectChain: WireRedirectHop[];
  finalUrl: string | null;
  httpStatus: number | null;
  checkedAtMs: number;
};
type RemoteVerifierResponse =
  | { version: 1; requestId: string; status: "completed";
      outcome: WireTerminalOutcome }
  | { version: 1; requestId: string; status: "failed";
      error: RemoteVerifierError };
type VerifierServiceConfig = {
  protocolVersion: 1;
  port: 8080;
  secret: string; // at least 32 random bytes, supplied at runtime
  startupTimeoutMs: 10_000;
  idleSleepSeconds: 300;
  maxRequestBytes: 16_384;
  maxResponseBytes: 262_144;
  maxActiveRequests: 1;
};
```

Request body is counted while reading, not trusted from Content-Length; request compression is rejected. Validate keys strictly at every nesting level, duplicate JSON keys are rejected, and unrecognized versions/operations fail protocol validation. `exactUrl` accepts any string of at most 2,048 UTF-16 code units, including malformed strings, so the Node verifier produces the existing `invalid_url`/`unsafe_destination` outcome. The remote adapter locally returns `invalid_url` for strings exceeding the same existing 2,048 limit, without a network request. Empty strings also produce existing `invalid_url`.

Response size is capped while streaming, before JSON decoding; compression is rejected. Every key/enum and correlation ID is exact. Numeric times are finite safe epoch milliseconds, attempts have nondecreasing times, addresses and families agree, statuses are integers 100..599 or null, and date conversion occurs only after validation. At most 12 attempts and 6 recorded redirect hops are accepted: a rejected sixth redirect can be recorded even though only five redirects may be followed. Attempt/final/from/resolved URL strings are bounded to 2,048 code units; raw malformed Location is bounded to 16,384, matching the Node header bound. Over-limit observations become service protocol failure, never truncation into a successful result.

Structural validation recognizes the actual V2.5 layout: a HEAD attempt block followed by at most one GET block restarting at the original URL; returned redirectChain is the final executed chain, not a concatenation invented by the remote adapter. Each chain edge must start at the original URL or its previous resolved URL, accepted redirects must resolve identically, and terminal fields must match the terminal code and last attempt where present. `http_result` requires terminal HTTP status/final URL and a completed matching attempt; non-HTTP outcomes require null final URL. A rejected unsafe redirect may contain the blocked resolved URL but must not have a corresponding contacted attempt. Conformance fixtures cover all tolerated failure forms, especially timeout retaining only completed HEAD attempts and no redirectChain.

The Worker trusts the authenticated Container to enforce socket-level security. Strict DTO validation proves protocol integrity and consistency, not that a compromised Container told the truth about a socket. The response contains no `safe:true` or classification claim. Worker shared classification derives domain status from `TerminalOutcome`; Container compromise remains a trusted-computing-base risk. No body, cookies, arbitrary response headers, raw socket/TLS/request object, stack trace, or provider dump crosses this boundary.

## 19. Container Authentication

Ingress is a private Container/DO binding reachable only through scheduler code, with public routes and preview URLs disabled. Node service still authenticates every request before target network activity. Use a distinct 256-bit verifier service secret, separate from Image and Twitch credentials, injected from Worker secrets into Container environment. No D1 or R2 binding is forwarded into Container environment.

Use HMAC-SHA256 over versioned request bytes with domain separation: `request-v1`, request ID, timestamp, and SHA-256 of the exact body, newline-delimited UTF-8. Headers carry request ID, timestamp and MAC; all have strict lengths. Reject more than 30 seconds clock skew, invalid MAC, or ID/body mismatch; constant-time compare the decoded MAC. Request ID and body are fixed by scheduler composition, never a public caller. Read-only verification tolerates a replay inside this brief authenticated window; no durable nonce table is introduced.

Responses are MACed with `response-v1`, the same request ID, SHA-256 of the exact request body, HTTP status, and SHA-256 of the exact response bytes. Remote adapter verifies MAC before accepting JSON. This binds a response to its request and prevents accidental cross-request substitution or body tampering. All errors after successful authentication use the signed bounded envelope; unauthenticated requests receive a fixed 401 without echoing data. Neither signer forwards its secret or signature to the target website.

Method/path rejection uses fixed 404/405; oversized bodies 413; unsupported schema 400; auth rejection 401; unavailable/busy/startup 503; completed target observations 200. The private facade maps startup failures into a signed service-unavailable envelope if able; absent/unverifiable envelopes are delivery/protocol failures. No redirects are followed on internal calls.

## 20. Links Classification / Write Boundary

The Cron Worker retains `createLinkVerificationService`, `createLinkVerificationResult`, `planGameLinkVerification`, and shared link repository query logic. It reads exact D1 snapshots, calls the injected remote transport, classifies using the shared switch, and performs the existing full compare-before-update batch through its scheduled fenced store. Every actual link UPDATE and the batch assertions validate the originally captured authority at D1. A late Container response may be valid verification data yet have no current permission to apply; it then produces `fence_lost` and no D1 changes. Manual metadata is preserved; link creation/deletion/replacement is prohibited.

If any RPC fails at the service-delivery level, `verifyGame` throws before plan/write; previously observed terminals for that game are discarded and no links from this call are updated. Existing website outcomes, including unsafe or network failures, remain ordinary `TerminalOutcome`s, are classified/persisted through existing policy, and the V2.7 stage then fails for non-`http_result` codes. A 404 target may classify broken while its Links stage succeeds, exactly as V2.7 defines.

Internal exact URL values remain available for requests, redirect derivation and optimistic comparison. Presentation/logging must use existing redaction. No Container service failures are persisted as website `failed`, `unknown`, or `temporarily_unavailable` merely because the verifier itself is unavailable.

## 21. Image Worker Integration

### 21.1 Mandatory scheduled mode and trust separation

Current `workers/image-ingest/src/index.ts` accepts one legacy `/internal/images/ingest` route with `IMAGE_INGEST_TOKEN`, and `request.ts` strictly accepts only `{gameId,write}`. It has no fencing today. Preserve that local/manual contract and introduce a distinct private scheduled route, `POST /internal/v1/images/ingest-scheduled`, authenticated only with new `IMAGE_INGEST_SCHEDULED_TOKEN`. Scheduler composition receives only the scheduled token; it must never receive the legacy token. The Image Worker validates tokens separately per route and rejects configurations where their values are equal. Production scheduled callers cannot omit authority and fall back to the legacy route. Service binding alone is not authorization; no redirect or route fallback is allowed.

```ts
type ScheduledImageRequest = {
  version: 1;
  mode: "scheduled";
  requestId: string; // UUID; response correlation
  gameId: number; // positive safe integer
  write: true;
  authority: ScheduledMutationAuthority;
};
type ScheduledImageResponse = {
  version: 1;
  requestId: string;
  authorityStatus: "not_observed_lost" | "fence_lost";
  result: ImageResult;
};
```

Require all fields, exact nested keys, fixed version/mode/write, UUID owner/request IDs, positive safe integer epoch and expiry, bounded JSON body, same method/content type restrictions and fixed response-size budget. Missing/malformed authority is 400; wrong caller credential is 401 before source HTTP/R2/D1 access. Both tokens are environment secrets. Legacy requests reject scheduled fields; scheduled requests cannot select legacy mode. Legacy credentials cannot call the scheduled route, and scheduled credentials cannot call the legacy route. Local V2.7 keeps its current loopback composition and token; production operator legacy access is a distinct existing authority outside this Cron lock, never an alternate Cron execution path.

Extract only the runtime-neutral client/parser from `scripts/sync-image-client.ts` to a shared client module; keep the local script wrapper and local URL validation. Add a separate scheduled envelope codec around the same strict native `ImageResult` parser. Production injects service-binding fetch, fixed path and required captured authority. Response must match request ID/gameId/write; `not_observed_lost` is only an observation, not an assertion that the lease is still valid or all operations settled. Fixed-error HTTP envelopes before result creation do not fabricate an ImageResult; delivery uncertainty still applies after dispatch.

The Scheduler Worker never downloads source images, validates image bytes, hashes content, writes R2, or reproduces R2-first/D1-second logic. Image Worker DB and Scheduler DB must be the same production database; deployment validation compares configured identity, and integration proves visibility through real reads.

### 21.2 Image D1 fencing and immutable R2 artifacts

Scheduled service composition always injects a repository bound to the request's immutable authority. Both `optimisticBindImage` and `conditionallyCreateImage` use Section 11's atomic fence assertions and guarded SQL with all existing complete-binding, source identity, game snapshot and optimistic predicates. A preflight SELECT may reject early but cannot authorize the later commit. Expiry/token/epoch validation is performed in the same transaction as the final D1 mutation after R2, on the shared authoritative D1. A stale or expired request is rejected even if no new owner exists; caller `leaseExpiresAtMs` never overrides the stored expiry.

The scheduled repository records `fence_lost` in a request-local latch before translating to the existing image service's safe `d1_write_failed` result. Subsequent repository calls refuse known-lost authority; scheduled service admission checks that latch before each further image. The scheduled envelope exposes the latch independently of native first-error aggregation, and Cron copies it into its invocation loss latch. Native Image DTO/outcomes stay unchanged. A pending DB request that returns after its image deadline cannot update an already completed envelope; its SQL is nevertheless fenced, while the native deadline signal already stops Cron admission. No authoritative mutation relies on the latch for durable safety.

New V2.6 artifacts in `lib/images/storage-key.ts` use `images/sha256/<prefix>/<prefix>/<sha256>.<extension>`. `r2-store.ts` uses `onlyIf: {etagDoesNotMatch:"*"}`, a supplied SHA-256 checksum, immutable cache metadata, and metadata equality checks on both existing objects and concurrent winners. It exposes only HEAD and ensureObject; no DELETE or overwrite call exists. Existing service repair reuses a stored key after downloaded hash/MIME/size match the recorded binding; it does not currently recompute that stored key. Therefore scheduled composition must additionally validate every ensureObject key against `buildImageStorageKey(hash,mimeType)` before issuing HEAD/PUT. A legacy/corrupt mutable alias fails with native `storage_conflict` and zero R2 mutation; it is not silently normalized or repaired. This narrow scheduled guard is mandatory for the content-addressed proof and leaves local V2.6 behavior unchanged. V2.8 permits no unconditional PUT, metadata overwrite, rename, cleanup/delete or mutable alias.

Therefore a scheduled R2 PUT is non-authoritative artifact creation. A stale epoch can at most create an immutable unreferenced object, deduplicate identical bytes, or restore a missing content-addressed object at an existing reference with exactly the recorded content. It cannot overwrite an existing object or remove the current object. The authoritative publication point is the fenced D1 image metadata/reference commit. If B acquired epoch N+1 while A's epoch N PUT was pending, A may still finish that conditional PUT but cannot change the current D1 reference. B may independently reuse identical content after its own verification. Existing R2-first → D1-second ordering and orphan tolerance remain; no cross-service transaction or orphan cleanup system is introduced. Operational assumption remains SHA-256/content-checksum integrity and exclusive use of this conditional-write path by scheduled code. A future mutable key/delete path would invalidate this proof and requires Design review before deployment.

### 21.3 Live invocation uncertainty

Add a 310-second client envelope for Cron composition, bounded response bytes and no redirects. A delivery failure may occur after Image Worker mutation; do not retry that game in the same run and do not roll back. Treat it as the existing safe image stage error, stop further Cron admission when mutation settlement is unknown, and retain the lease voluntarily until expiry. A complete parsed image result is not by itself a settlement acknowledgement.

The production image client wrapper inspects the entire validated `ImageResult` before returning it to `createImageSyncStage`. It records an internal monotonic signal for any `preflightError: "game_deadline"`, any image `outcome: "deadline"`, or any image error `code: "image_deadline"`. Conservatively, `storage_failed` and `d1_write_failed` outcomes also record mutation uncertainty because the current DTO does not prove whether a dispatched mutation committed before its error. Delivery error, timeout, nonaccepted HTTP response or invalid/oversized response after dispatch records delivery uncertainty. Inspect all images and nested errors, not only the first failure or the aggregate result status. A preceding `source_rejected`/`write_conflict` must not mask a later deadline item.

```ts
type UnsettledImageWorkReason =
  | "image_delivery_unknown" | "image_deadline" | "image_mutation_unknown";
type CronGameRuntime = {
  stages: BulkSyncStages;
  readUnsettledImageWork(): readonly UnsettledImageWorkReason[];
  readAuthorityLoss(): "lease_lost" | "fence_lost" | null;
};
```

Create this closure per candidate and merge any observed reason into a monotonic invocation latch. Only the production image-client wrapper can add these uncertainty reasons; once observed, a reason remains for the live Cron execution and cannot be cleared by later fulfilled promises, another successful image, result formatting or stage error aggregation. The authority-loss latch is separate, because any scheduled D1 stage can lose authority. These channels contain only fixed codes and preserve native `ImageResult`, `BulkGameResult` and V2.7 failure precedence. If a later stage wrapper/pipeline validation throws, the scheduler's finally path still inspects both latches. Use normal game-result metadata status (`failed` for native failure) only while the write fence remains valid; after fence loss leave the existing stamp untouched. That status records the observed attempt, not proof that its writes settled.

After uncertainty is observed, keep already validated game results and existing safe first-failure error, set `stopReason: "unsettled_remote_work"`, skip remaining candidates, and suppress voluntary release while authority is still owned. Unless a scheduler infrastructure error has precedence, Cron is `partial`. This signal only controls the live invocation; it may disappear on crash. Expiry still permits a new higher epoch without knowing whether old operations settled. Atomic D1 fences reject those operations whenever they eventually reach the publication boundary. Normal parsed failure without uncertainty/loss continues through ordinary cross-game isolation. No quarantine/acknowledgement table, blocked reacquisition rule or platform operation-lifetime prerequisite is added.

## 22. Failure Semantics

| Failure | Result / subsequent work |
|---|---|
| Invalid configuration/composition before lease | Cron failed; zero provider work and no release. |
| Lease acquire D1 failure | Cron failed; no candidates run; uncertain acquisition is left to expire. |
| Active lease | Cron skipped; no candidate/provider/state work. |
| Candidate query failure | Cron failed; best-effort owner+epoch-conditional release if no uncertainty/loss. |
| Normal settled game stage failure | Save failed status, retain legal writes, continue next admitted candidate. |
| Container unavailable/startup/restart/5xx/auth/protocol failure | Links stage failed with safe service code; Images not_run; other candidates remain eligible. |
| Lost mapping before start | Safe failed candidate result; no canonical create; continue. |
| Game returns malformed singleton batch | Cron failed (`pipeline_contract_error`); preserve prior validated results; stop. |
| Metadata start failure | Cron failed; do not launch this game. |
| Metadata finish failure | Cron failed; retain game result and writes; no next admission. |
| Soft admission cutoff | Cron partial when selected candidates remain; no new game begins. |
| Uncertain Image delivery or parsed native deadline/mutation-uncertainty result | Keep normal game failure result; Cron partial with `unsettled_remote_work`; no next admission and no early lease release. |
| Fence assertion/authority check fails, or scheduled Image reports fence_lost | Cron failed with `fence_lost` (or `lease_lost` for admission-only observation); no next stage/game, no later metadata write, and no voluntary release. Prior legal results/writes remain. |
| Owned release D1 transport/invariant failure | Cron failed with `lease_release_failed`; preserve an earlier primary failure if present; leave any remaining lease to expire. |
| Late/expired release returns fence_lost | Cron failed/authority_lost; no mutation to new owner's lease; do not retry release. |
| Worker hard timeout/crash | No fabricated final result; legal writes/start stamp survive. After expiry a new owner acquires a higher epoch; old delayed D1 commits fail closed regardless of lost in-memory signals. |

Scheduler failures have fixed safe messages. First fatal error is primary; a later release error or authority loss is retained as a safe secondary error without replacing that primary. Any authority loss sets stopReason `authority_lost`, taking precedence over uncertainty/deadline, and prevents subsequent scheduled mutation attempts. Unsettled evidence suppresses voluntary release while owned; loss records `no_longer_owned` instead. These dispositions survive finally/cleanup paths; the scheduler cannot clear another owner's row. Log write failure is swallowed to avoid changing database correctness or causing a second run; failure to emit a log never authorizes retries. Container unavailability is not a Cron infrastructure failure unless local composition/config is invalid.

Remote errors map exhaustively: connection/cold-start failure, 5xx or busy → `verifier_service_unavailable`; active request delivery budget exceeded → `verifier_timeout`; unsupported protocol version, wrong method/content type/operation, missing envelope → `verifier_protocol_error`; 401/403 or invalid MAC → `verifier_auth_error`; invalid JSON, unknown outcome enum, excess keys/bytes or inconsistent observations → `verifier_invalid_response`. A target TLS/network/timeout outcome retains the original V2.5 code. No raw cause is copied into a safe error.

## 23. Cron Result Taxonomy

```ts
type CronFailureCode =
  | "configuration_error" | "composition_failed" | "lease_acquire_failed"
  | "lease_lost" | "fence_lost" | "candidate_read_failed" | "state_write_failed"
  | "state_conflict" | "pipeline_contract_error" | "lease_release_failed";
type CronExecutionResult = {
  executionId: string;
  status: "completed" | "partial" | "skipped" | "failed";
  selected: number;
  attempted: number;
  succeeded: number;
  failed: number;
  notStarted: number;
  stopReason: "none" | "active_lease" | "soft_deadline"
    | "unsettled_remote_work" | "authority_lost" | "infrastructure_failure";
  games: BulkGameResult[];
  primaryError: { code: CronFailureCode; message: string } | null;
  secondaryErrors: Array<{
    code: "lease_release_failed" | "lease_lost" | "fence_lost";
    message: string;
  }>;
  leaseDisposition: "not_acquired" | "released" | "retained_until_expiry" | "no_longer_owned";
};
```

`completed` means every selected candidate finished successfully; an empty eligible catalog is completed with all counts zero. `partial` means scheduler infrastructure completed normally but at least one game failed, selected work was not started due to deadline, or uncertain remote work caused admission to stop. `skipped` means active lease only; all counts zero. `failed` means a scheduler infrastructure error, including lost mutation authority, regardless of preceding successful games. `lease_lost` identifies admission/read detection; `fence_lost` identifies an atomic write rejection or scheduled Image authority-loss report. Both revoke the remainder of this invocation; neither becomes a persisted website outcome.

`retained_until_expiry` describes leaving the currently owned row intact instead of voluntary early release. Expiry authorizes a later acquisition with an incremented epoch, and says nothing about old-operation settlement. `no_longer_owned` records observed loss and makes no claim over the current DB row. A lost acquire response remains a `lease_acquire_failed` result with no trusted handle; any acquired lease expires normally. Runtime results/logs do not persist new last-run/completion fields; if such fields are later approved they require the same fence.

`games` contains complete, validated four-stage results only. `attempted` equals games.length plus at most one started game whose result could not be validated; in that exceptional failed Cron case the incomplete game is represented only by counts and its persisted `started` stamp. `succeeded + failed = games.length`; `notStarted = selected - attempted`. Lost-candidate handling creates a valid Steam failure with subsequent not_run stages and selected App ID, using the existing public stage error shape. All counts are nonnegative integers bounded by batchSize; no scheduler result is passed off as `BulkGameSyncResult`.

## 24. Idempotency

Cron provides at-least-later re-attempts, not exactly-once execution. Existing identity uniqueness, fill-empty/additive enrichment, optimistic link writes and image content identity remain domain write protection; epoch/expiry guards additionally exclude stale scheduled owners. Failed or interrupted games can have applied legal earlier stages. After expiry/release and a new acquisition, run the full four-stage pipeline again without rollback or a durable stage checkpoint, regardless of whether old operations settled.

Stamping a failed attempt moves it behind older entries, allowing recovery without repeatedly monopolizing the head of the catalog. An old owner cannot stamp, apply business writes or release under its obsolete epoch. Current scheduled D1 mutation authority is serialized; old remote operations may still exist. This is not a global lock against a separately authenticated operator or existing app writer; existing optimistic repository semantics still protect those races. Scheduler credentials/composition cannot enter an unfenced operator path.

## 25. Schema Changes

The final minimum is two additive tables, `game_cron_sync_state` and `cron_sync_lease`, with the exact columns and constraints in Sections 10–11. No existing business-table column is added or altered. No sync_runs, jobs, cursor, scheduler error text, per-stage status, history, or next-eligible timestamp is added.

State status has a CHECK; attempt/expiry timestamps have nonnegative integer validation; game metadata has cascading FK and PK; lease has constant-name, released/owned consistency, and named safe-integer epoch CHECKs. Epoch is the only additional correctness field versus the previous lease proposal. The state index supports deterministic order without changing existing indexes. Runtime validation mirrors these shapes. The epoch CHECK doubles as the transactional assertion mechanism; it cannot be relaxed without invalidating fenced-batch rollback.

## 26. Migration Strategy

One new D1/SQLite migration creates the two tables/index and seeds the released epoch-0 lease once. SQL migration count becomes **4 → 5**. Existing migrations remain byte-identical; existing rows, columns, defaults, foreign keys, indexes and verification/image metadata remain intact because no existing table is rebuilt. No live three-column V2.8 lease migration has been released; correct the proposed migration before its first implementation. Never reset the singleton during upgrades, rollbacks or restarts. Restoring an older DB snapshot with a lower epoch is outside normal rollback: scheduling and all old scheduled caller credentials/instances must be revoked before any such disaster restore is operated, so obsolete authority cannot reappear.

Schema SHA-1 before: `d959b11fc297164388f3cc28708beadab2d7842f`. The schema source will change during implementation; the exact after hash is calculated from the implemented file, verified at release and recorded as the new V2.8 baseline. This Design does not invent a hash for unwritten code. Container DO registration migrations are Wrangler control-plane metadata and are not counted as D1 SQL migrations.

Verify migration on a populated local copy with every existing table, FK checks, row/value comparisons, indexes and new-table constraints. Older V2.7 code can continue using the migrated DB because changes are additive. Rollback disables scheduler deployment and leaves these small tables in place; no destructive down-migration is part of V2.8.

## 27. Security Model

Threats include malicious stored URLs, DNS rebinding, mixed DNS answers, private/metadata addresses, IPv4-mapped IPv6, redirect loops/downgrades/unsafe hops, TLS mismatch, malformed or oversized service responses, exposed verification endpoints, confused-deputy authority, secrets in errors, lease races, stale workers, unfenced SQL bypass and scheduled Image calls falling back to legacy credentials. All scheduled authoritative writes require owner+epoch+live DB expiry inside their atomic commit boundary; valid service authentication alone never authorizes D1 publication.

The Container is the sole official-site socket enforcement boundary. It must retain all V2.5 URL/IP/DNS/connection/redirect invariants and never trust Caller-selected DNS or IP. Actual outbound requests are Node HTTP(S); ordinary fetch is used only for authenticated internal service delivery and provider clients, not official-site verification. An unsafe URL cannot instruct the service to access container metadata, local administration, D1 or R2.

Authenticated DTOs cannot add target methods, credentials, headers or response bodies. Worker strict parsing and MACs prevent protocol substitution but do not make a compromised verifier trustworthy. A deployment probe that sees a proxy/NAT peer incompatible with the existing normalized `remoteAddress` invariant blocks production; never whitelist the proxy to make the test pass.

Exact URL transport and D1 persistence have controlled access. Any human/JSON diagnostic uses the existing shared sanitizer: sensitive query values are redacted case-insensitively; username/password and fragment never appear; malformed URL sentinel is `[INVALID_URL]`. No result, exception, signature, raw body or target headers are logged by default.

## 28. Secret / Permission Boundaries

Separate production/preview/local values for Twitch credentials, scheduled Image token, legacy Image token and verifier secret. Scheduler gets only the scheduled Image token; Image Worker never treats it as a legacy token. Production bindings are explicit and must not fall back to local databases or placeholder IDs. Container receives only its verifier secret; no Cloudflare API token, D1 mutation token, R2 credentials, Twitch secret, Image token or scheduler capability is injected. Request ID or epoch may be used as non-authorizing verifier correlation metadata only; ownerToken and ScheduledMutationAuthority are never forwarded to the Container.

Secrets are runtime inputs, never baked into the image, source, Wrangler vars, migration, result DTO, request URL or logs. Rotation deploys matching scheduler and Container secret versions with Cron disabled until the authenticated health/conformance check passes; no multi-key rollover framework is required. Fixed endpoint composition prevents database values from selecting a service host.

## 29. Observability

Emit bounded JSON events: `cron_started`, `lease_acquired`, `lease_skipped`, `candidates_selected`, `game_finished`, `deadline_stop`, `authority_lost`, `verifier_unavailable`, and `cron_finished`. Allow fields execution ID, timestamp, canonical numeric ID, normalized App ID, numeric fence epoch (correlation only), stage name, fixed safe code, status, elapsed milliseconds and counts. Never log ownerToken/authority envelopes. No full game results or provider payload dumps in logs.

`cron_finished` reports selected/attempted/succeeded/failed/notStarted and lease disposition. Container logs only request correlation ID, bounded elapsed time and fixed outcome/service code. URLs, MACs, tokens, internal hostnames, target DNS diagnostics and stack traces are omitted. No telemetry platform, alerting or persistent run history is introduced.

## 30. Local Development

Unit tests inject repositories, clock, stages and transport. Local development composes a local D1, local Image Worker and a local Node verifier service/Container with dev-only secrets. Production Container is never required for ordinary tests. Local container runs use the same Node modules and protocol codec; local target fixtures must use controlled seams or a test-only isolated fixture network, never add test bypass flags to production SSRF logic.

Wrangler local development uses explicit shared persistence paths across scheduler and Image Worker; harness asserts both see the same seeded canonical rows. Temporary state, Node processes and container resources have acquisition ledgers and deterministic disposal on partial startup failure. `.wrangler/tmp` artifacts must not pollute lint or be committed. Production D1/R2 remains unavailable to local tests.

The Cloudflare platform integration tier validates supported local Container emulation where available and runs separate authenticated preview probes for actual socket semantics, cold starts and service bindings. Unsupported local emulation is reported for that tier and does not become a fabricated PASS.

## 31. Testing Strategy

Unit coverage includes pre-LIMIT candidate eligibility, zero/multiple/invalid Steam IDs, never-attempted first, oldest attempt, ties, limit; success/failure/crash rotation; metadata start-before-execute; no game after soft cutoff; no soft abort of admitted game; stop on metadata failure; complete singleton batches; safe result/count invariants and precedence.

Lease tests use real local D1 and concurrent requests: initial acquisition obtains epoch 1 (general fixture N); release preserves N; next acquisition obtains N+1; active lease blocks a competitor; expired lease permits exactly one higher-epoch winner; missing/corrupt singleton and epoch exhaustion fail closed; stale owner cannot release B; expired owner cannot release or write even before B; strict equal-expiry boundary; Worker clock skew cannot grant authority. V2.8 exposes no renew operation; assert no heartbeat/renew route exists and expired authority cannot resurrect through assertOwned/release/reuse. If renewal is ever added, its required negative tests are stale owner, expired matching owner and unchanged epoch on valid renewal.

Fencing tests exercise actual guarded SQL in each production scheduled repository, not only mocks of checkFence: stale UPDATE, INSERT and scheduler UPSERT are rejected; ordinary new-owner writes succeed; empty/no-op plans with invalid authority cannot report success; expected zero-row domain conflicts remain distinct under a valid fence; every business table in Section 11.4 is covered. Test the complete IGDB batch (including taxonomy/reference inserts and identity assertion), every Steam update kind, manual-preserving Links comparisons, and both Image D1 methods. Include generated-SQL/ownership scans to reject unguarded VALUES inserts, unguarded UPSERT arms, and composition that delegates to unfenced repositories. A separate SELECT then write is a negative control: inject B acquisition in the gap and demonstrate the vulnerable control fails while real guarded code refuses A.

Atomic-batch tests force the fence assertion to fail after an earlier successful statement and verify all earlier changes rollback. Verify named CHECK failure mapping, statement/row count accounting and real D1 support for the chosen assertion. Expiry during a multi-statement batch cannot commit a prefix. No sampled Worker timestamp is bound as DB-now. Interleavings use deterministic barriers: (1) A valid mutation commits first, then release/expiry makes B acquisition eligible, so A is retained and B obtains N+1; (2) after expiry B acquisition commits first and A's delayed mutation arrives second, so A is rejected. A commit after expiry is invalid even when B has not acquired. Assertions compare committed D1 values, not request start/response arrival order.

Integration uses real local D1, real repositories and pipeline, controlled Steam/IGDB HTTP fixtures, local Node verifier API, and authenticated Image Worker with local R2. Observe Steam → IGDB → Links → Images ordering; verify common DB identity; seed existing unmapped/unbound images; exercise actual download/validation/hash/R2 HEAD and writes; observe R2-first then D1 binding; assert concrete nonempty repeat-run outcomes and no duplicate canonical games/images.

Exercise concurrent scheduled invocations (one current owner), stale-owner expiry/higher-epoch recovery, attempt stamp after crash, ordinary failed first game followed by healthy game, soft deadline leaves remaining selected games untouched, metadata failure after legal game writes, release failure, ambiguous Image delivery with live lease retention, and Container startup/restart failures. Each injected startup failure occurs after the relevant resource was actually acquired; verify exactly-once cleanup of acquired resources. Pause Steam provider response, IGDB provider response and Container result independently; acquire B after A expires, resume A and assert each real D1 apply is rejected with no downstream stage/candidate. First-error aggregation must not hide the authority-loss latch; A cannot finish its stamp over B's state.

Image integration crosses the real authenticated scheduled HTTP route: missing authority, wrong caller class, equal configured tokens, scheduled token on legacy route and legacy token on scheduled route all fail before mutation. A holds epoch N and pauses after R2 PUT is dispatched; B acquires N+1; resume A and observe conditional immutable R2 creation plus rejected D1 binding/create. Assert existing current object bytes/metadata and current canonical D1 reference are unchanged, no R2 delete occurs, and any new object is unreferenced unless a separately valid owner publishes it. Also test a stale repair of an already-bound missing content-addressed object: only identical recorded content may be restored. A noncanonical stored key and a key whose hash/MIME differs both fail scheduled ensureObject before PUT; no mutable alias may be restored even if D1 contains legacy metadata. Capture real R2-first → fenced D1 ordering and validate the scheduled envelope's loss flag through nested/first-error cases.

For native Image uncertainty, deliberately keep real harness-injected `optimisticBindImage` and `conditionallyCreateImage` promises pending after R2-first success; advance the service deadline and deliver its actual parsed deadline `ImageResult` to the Cron client wrapper. Assert its internal signal is set, no next candidate/stage begins, no lease release occurs, failure metadata retains its normal meaning, and later promise settlement cannot clear the signal or cause duplicate completion. Cover pending R2 conditional writes, `game_deadline`, storage/D1 errors, and finally paths after metadata or pipeline validation failure.

Add a masking regression: image 1 returns a normal earlier failure such as `source_rejected`; image 2 has a pending mutation and returns `deadline`. Existing `createImageSyncStage` may keep image 1's first-failure code, but the scheduler must still observe image 2 through the full-result side channel, stop, and retain the lease while live. Test both item orders and nonempty exact item counts. A crash test then discards all A latches, holds its dependency unresolved beyond lease expiry, lets B acquire N+1, and resumes the delayed A SQL operation. A's authoritative write must be rejected, B's writes/state/release remain correct, and old late release is a no-op. The test must not cancel or magically delete A's pending operation to claim safety. Pending immutable R2 may finish without publishing stale D1 state.

Security tests cover secret-safe output (including ownerToken), redaction across URL fields, strict MAC/schema/size/path/method validation, no public ingress, no insecure fallback, no D1/R2/scheduler credentials in Container, and no Node DNS/socket modules in the Cron bundle. Deployment review proves complete fenced write inventory and scheduled/legacy credential separation. Full V2.7/V2.5/V2.6 tests, typecheck, lint, build, local migration/FK verification and production-dependency audit must pass as fresh evidence. Environmental failures are recorded as blocked, not PASS. No dependency upgrade is justified by this design.

## 32. Transport Conformance Testing

Run identical target vectors through LocalNode and RemoteContainer transports. Compare terminal code, classification via the same shared classifier, status, final URL, redirect records and attempt method/order; normalize only timestamps and controlled resolver addresses. Service-delivery failure vectors exist additionally for the remote adapter and must never classify/persist a website outcome.

Vectors include HTTP 2xx/404/410/429/5xx; other 3xx; every supported redirect; malformed/missing/duplicate Location; fallback statuses and GET starting at original URL; shared redirect budget; zero GET body consumption; default ports only; protocol downgrade; private, loopback, link-local, metadata, mapped IPv6 and all pinned special-use categories; public+unsafe DNS; unsafe redirects; DNS rebinding-sensitive selected-IP/lookup/socket checks; normalization; Host/SNI/certificate identity; TLS/network/DNS/timeouts; redirect loops/overflow.

Protocol vectors include unauthenticated request, wrong MAC, tampered response, mismatched request ID/body, replay outside skew window, oversized/chunked body, unknown keys/enums/version, invalid JSON, impossible chain/attempt layout, cold-start timeout, unavailable service, 5xx, restart mid-request and late response after timeout. All fail closed with bounded safe service codes. Live preview conformance specifically proves actual remoteAddress, TLS SNI and custom-lookup behavior on the deployed Node image; passing a mock is insufficient for release.

## 33. Production Deployment

The intended ownership files are `workers/cron-sync/wrangler.jsonc` and entry/composition modules; `lib/scheduler/` authority/lease/policy contracts; narrow scheduled D1 repositories plus minimal shared query-builder changes in existing repositories; shared verifier transport/codec and remote adapter; `containers/official-link-verifier/` Node entry/image; the shared image client extraction and scheduled codec; Image Worker scheduled auth/request/composition; one schema migration; tests and documentation. These are future ownership boundaries, not an implementation sequence.

Use private service bindings and the Container class registration supported by Cloudflare. Container runtime plumbing may require the official `@cloudflare/containers` dependency, pinned during implementation and confined to the scheduler build; prefer its supported lifecycle rather than reimplementing container orchestration. This is the only newly justified runtime platform dependency; no unrelated production dependency or framework is introduced. The Node image reuses compiled shared modules and built-ins.

D1 database identity, R2 bucket, image public origin, service bindings and Container support must be real provisioned values at deployment time; existing example/zero IDs in repository configs are not a production deployment. Disable public Cron Worker and Container routing. Deploy with Cron disabled, apply additive migration once, deploy the scheduled Image route/fenced repository and distinct tokens, then deploy scheduler/Container compatibility. Verify auth separation, socket conformance, actual shared D1 identity and Section 11's transactional fencing/rollback tests before enabling the schedule. A legacy-only Image Worker must fail readiness; no scheduled fallback is permitted. Validate all production scheduled SQL builders in the mutation inventory. No platform maximum operation lifetime or settlement bound is a correctness prerequisite. Production deployment is a separate authorization gate.

## 34. Rollout

First validate local and preview with nonproduction bindings. Production canary uses batchSize 1 and the full four stages against an existing game; inspect safe logs, scheduler stamp, D1/R2 effects and lease release. Repeat canary proves idempotence. Increase only to the default ceiling 25 after actual wall/CPU and Container cold-start evidence fits admission assumptions; schedule remains independently configurable.

No runtime feature silently skips Links. Disable the trigger if Container compatibility, auth, lease or deadline checks fail. This release does not enable a public canary endpoint or manual Admin control; deployment/operator tooling supplies the controlled initial scheduled test.

## 35. Rollback

Disable future Cron triggers first. Keep the fenced Image deployment and lease table active while previously dispatched requests may still arrive; let the current lease expire without deleting/resetting its epoch. Expiry revokes old D1 authority even if remote operations continue. Roll back scheduler and Container as a matched protocol version with scheduling disabled; an unfenced pre-V2.8 scheduled Image write path must never be restored or receive the scheduled credential. Existing app and V2.7 local CLI continue working. Preserve valid D1/R2 writes and additive scheduler tables. Do not clear live leases by hand, delete image objects, reverse metadata or reset epochs. Re-enabling requires fenced-write/auth/conformance checks and a new higher-epoch acquisition. Disabling a trigger alone does not revoke already issued authority before expiry, and rollback does not claim old operations have settled.

## 36. Operational Requirements

Production requires a Cloudflare plan/environment supporting Containers and scheduled execution limits, a pinned Node image, matching service secrets and private bindings. A low-duty-cycle daily schedule lets the verifier sleep between runs; cold start consumes the first Links budget and may fail that game. No large batch microservice is introduced to amortize startup. Container availability and real socket behavior are operational dependencies, not guarantees derived from a unit test. [Container lifecycle](https://developers.cloudflare.com/containers/concepts/lifecycle/) and [local development](https://developers.cloudflare.com/containers/local-dev/) describe the supported platform workflow.

Known limits: conservative admission can process fewer than 25 games; interrupted attempts retain `started`; scheduler metadata errors recover through later runs; remote Image calls/native deadlines have mutation uncertainty and may create immutable orphan artifacts. Live uncertainty suppresses admission/early release; durable owner/epoch/expiry guards protect D1 across crashes and reacquisition without a settlement proof. Old network requests may consume resources after loss. Fencing correctness depends on complete scheduled SQL coverage, atomic D1 batch rollback and preserving the epoch high-water mark; deployment tests must verify these. SHA-256 integrity and conditional R2 writes underpin artifact immutability. Separately authorized operator writes remain governed by existing optimistic rules. Verifier compromise remains inside the SSRF trust boundary. No discovered authoritative scheduled mutation requires a quarantine system or platform-lifetime assumption.

## 37. V2.9 Compatibility

Per-game last attempt/status can support an eventual Admin read model without exposing raw errors. Candidate repositories and scheduler service remain reusable ports. V2.9 may add last-success history, safe recent error, next-eligible display or authenticated manual execution through a separately approved design. V2.8 does not reserve columns, routes or a generic scheduler API for those hypothetical needs.

## 38. Explicit Out-of-Scope and Design Gate

No Queues, application DO scheduler, Workflow engine, generic retry/backoff, distributed transaction manager, saga engine, durable quarantine/acknowledgement system, distributed worker pool, concurrency above one, durable jobs/resume, full run history, Admin UI/controls, public verifier endpoint, HTTP proxy, webhook, alerting/email/Slack, or telemetry platform. Container exists only to preserve the V2.5 Node transport. If any actual authoritative mutation cannot participate in the atomic fence, stop and identify that mutation/mechanism gap before expanding architecture.

Self-review gate: all requested architectural areas have concrete ownership and result contracts; placeholder/contradiction/scope/security/Cloudflare assumption scans must pass; independent Design Review must report Critical 0 and Important 0 before `DESIGN-READY`. Implementation Plan, TDD, production code, Worker implementation and migration implementation are prohibited until separate human approval.
