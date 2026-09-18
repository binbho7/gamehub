# GameHub V2.8 Cloudflare Cron Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing four-stage GameHub pipeline serially for production D1-selected canonical games, with durable fencing, bounded Cron admission, and the existing Node verifier security boundary preserved in a private Cloudflare Container.

**Architecture:** A dedicated Cron Worker owns candidate selection, lease/state repositories, and production composition. Each admitted candidate uses a complete V2.7 singleton batch; Steam, IGDB, Links and Images publish through atomically fenced D1 repositories. A private Node Container produces link observations only; scheduled Image Worker requests require independent authentication and authority, with immutable R2 artifacts preceding fenced D1 publication.

**Tech Stack:** TypeScript, existing Drizzle/D1, Vitest, Wrangler/workerd, Node HTTP/HTTPS, Cloudflare Containers, existing R2 Image Worker, existing Zod and shared URL sanitization. Only the official Container runtime package is a permitted new platform dependency.

**Spec:** `docs/superpowers/specs/2026-09-14-gamehub-v2-8-cloudflare-cron-sync-design.md`, approved commit `533bfd2d016f006f412d92ceb2cb9e50dd8a332f`. Base `36f5bc17494111e65c1d3fcb93d111f631b8cd0c`; branch `codex/v2-8-cloudflare-cron-sync`; worktree `/Users/binbho/Developer/gamehub/.worktrees/codex-v2-8-cloudflare-cron-sync`.

## Global Constraints

- This document is the sole deliverable of the planning phase. All commands/code below are future implementation instructions; no TDD, migration, Worker, Container or deployment execution is authorized by writing this document.
- Approved Spec is the sole architecture authority. A newly discovered correctness contradiction stops implementation and requires Design resolution.
- Pipeline is Steam → IGDB → Official Links → Images; existing canonical games only; games concurrency 1; game fail-fast; cross-game failure isolation; no cross-stage rollback.
- Scheduler uses a complete `runBulkSyncBatch({appIds:[candidate.appId],dryRun:false,stages})`; public V2.7 batch completeness, local CLI and batch limit 100 remain unchanged. Cron batch integer 1..25, default 25.
- No Queue, application Durable Object scheduler, generic retry engine, public/manual trigger, generic verifier proxy, Admin UI, durable job/resume, history, quarantine or acknowledgement system.
- D1 database time is `CAST(unixepoch('subsec') * 1000 AS INTEGER)`; strict live validity is stored expiry greater than that value. Caller expiry and application time never authorize writes.
- The immutable captured owner/epoch is required at every scheduled D1 mutation. Preserve identity, snapshot, manual-verification and fill-empty predicates. Check-then-write is prohibited.
- Spec §11.2 explicitly chooses **no renewal in V2.8**. The suggested renewal task in the request is covered by absence/resurrection tests; no `renew` method, timer, endpoint or heartbeat is implemented. The same approved Spec requires a seeded singleton; runtime missing-row recovery must fail, not insert an epoch-zero row.
- Release clears owner/expiry only; never delete, reset or reseed the epoch high-water mark. Expiry permits a higher epoch even while old operations remain pending.
- Two additive tables only; D1 SQL migration count 4 → 5; no existing business table rewrite; existing four migrations byte-identical. Schema SHA-1 starts at `d959b11fc297164388f3cc28708beadab2d7842f`; calculate the new value from implemented source, never invent it.
- Default wall 900,000 ms; soft cutoff 720,000 ms maximum; game reserve minimum/default 780,000 ms; finish reserve minimum/default 30,000 ms; lease minimum/default 1,500,000 ms. No whole-game deadline race or soft cancellation. Existing stage deadlines remain.
- Node verification preserves request-bound custom lookup, all-address SSRF classification, normalized socket peer check, Host/SNI, certificate validation, fresh connections and per-redirect revalidation. No Worker target-fetch fallback.
- Native Image DTO/outcomes remain unchanged. Scheduled envelope/latches carry authority loss independently of first-error aggregation. Exact URLs remain internal; diagnostics use existing sanitizer with `[INVALID_URL]` sentinel. Tokens, authority, signatures, payloads and raw errors never enter logs/results.
- R2 is conditional immutable content-addressed artifact storage. The authoritative publication is D1. No mutable aliases, unconditional PUT, deletion, rename, overwrite or orphan cleanup in scheduled composition.
- Production deployment is separate authorization. Local tests use isolated real local D1/R2 and dev secrets; no production binding, audit fix or unrelated dependency upgrade.
- Each task has one independent review gate after its commit. No next dependent task before Critical/Important are zero and all findings are resolved or explicitly recorded according to the approved development workflow. Final Plan Review must have Critical/Important/Minor all zero before implementation starts.

## Authoritative Mutation Inventory (before task decomposition)

Inventory inspected from the approved branch's actual repositories, not inferred from subsystem names. `applyPlan`, `writePlan` and the two image methods are the only scheduled business commit seams. Guards are implemented at those SQL statements, including auxiliary inserts; invoking an unfenced method after checking the lease is forbidden.

| ID | Existing/new write site and tables | Classification | Scheduled treatment / owning task |
|---|---|---|---|
| S1 | `lib/db/repositories/steam-import.ts`, `applyPlan` update `external_id`: `game_external_ids.external_url,updated_at` | AUTHORITATIVE | Guard existing game/provider/external ID/change predicates; T6 |
| S2 | Same update `official_link`: `game_official_links.is_official,verification_status,verification_method,updated_at` | AUTHORITATIVE | Guard canonical Steam store identity and manual exclusion; T6 |
| S3 | Same update `video`: `game_videos.title,thumbnail_url` | AUTHORITATIVE | Guard game/provider/external ID/change predicates; T6 |
| S4 | Same create arm: `games`, `game_external_ids`, `genres`, `platforms`, `companies`, `game_genres`, `game_platforms`, `game_companies`, `game_official_links`, `game_images`, `game_videos` INSERTs | AUTHORITATIVE, forbidden scheduled capability | Reject create before SQL; read/post-write identity bound to selected game. Local importer retains create; T6 |
| I1 | `igdb-enrichment.ts`, `applyPlan`: external identity-conflict assertion INSERT and actual `game_external_ids` INSERT | AUTHORITATIVE (assertion may intentionally abort) | Guard both; preserve identity uniqueness error decoder and batch rollback; T7 |
| I2 | Same: `games` fill-empty summary/description/release_date/cover_url/hero_url UPDATE | AUTHORITATIVE | Preserve null/coalesce predicates and add fence; T7 |
| I3 | Same: `genres`, `platforms`, `companies` INSERT | AUTHORITATIVE | Explicit-column guarded INSERT SELECT; T7 |
| I4 | Same: `game_genres`, `game_platforms`, `game_companies` INSERT with taxonomy lookups | AUTHORITATIVE | Guard relation inserts and retain role/lookup semantics; T7 |
| I5 | Same: `game_official_links`, `game_images`, `game_videos` INSERT | AUTHORITATIVE | Guard inserts; preserve image identity NOT EXISTS and source metadata; T7 |
| L1 | `link-verification.ts`, `writePlan`: each `game_official_links` UPDATE of verification_status/method/http_status/redirect_url/verified_at/last_checked_at/updated_at | AUTHORITATIVE | Full exact snapshot comparison/manual exclusion and start/end fence assertions in same batch; T10 |
| L2 | Link conflicts, `partially_applied`, manual/no-change skips | No additional write | Existing zero-row conflict/result calculation only; empty plans still assert authority; T10 |
| C1 | New `cron_sync_lease` acquisition UPDATE: owner/expiry/epoch+1 | AUTHORITATIVE ownership transition | Single conditional UPDATE RETURNING; no read-then-mutate, no runtime INSERT; T3 |
| C2 | New `cron_sync_lease` release UPDATE: owner=NULL,expiry=0 | AUTHORITATIVE ownership transition | Owner+epoch+live expiry; epoch preserved; T3 |
| C3 | New batch assertion `cron_sync_lease.fence_epoch=CASE...` | AUTHORITATIVE transactional assertion | Valid no-op or named CHECK rollback; never committed negative epoch; T4 |
| C4 | New `game_cron_sync_state` start INSERT/UPSERT, finish UPDATE | AUTHORITATIVE | Both UPSERT arms guarded; finish also timestamp+started match; T5 |
| C5 | Scheduler run start/finish/cursor/history/renew | No persistent write exists or is planned | Safe logs only; no tables/columns or renewal; T1/T13/T14 |
| M1 | `image-ingest.ts`, `optimisticBindImage`: `game_images` storage_url/key/hash/MIME/size/dimensions/updated_at UPDATE | AUTHORITATIVE | Complete binding + full snapshot + atomic fence; T11 |
| M2 | Same `conditionallyCreateImage`: explicit image identity/binding INSERT SELECT | AUTHORITATIVE | Game snapshot, identity NOT EXISTS, fence, row-count validation; T11 |
| M3 | Image existing/dedup/conflict/repair paths | M1/M2 if publication occurs; otherwise reads only | Never add `games.cover_url/hero_url` mutation; scheduled key validation also applies to repair; T11/T12 |
| R1 | `lib/images/r2-store.ts`, `ensureObject` conditional `bucket.put` with checksum and immutable metadata | NON-AUTHORITATIVE ARTIFACT | Guard canonical key before HEAD/PUT; retain conditional/checksum/concurrent-winner integrity; T12 |
| R2 | Same HEAD, dedupe HEAD, concurrent-winner HEAD; `head` service existing-object inspection | Read-only | Full metadata equality, no rewrite; T12 |
| R3 | Missing-object restoration PUT | NON-AUTHORITATIVE ARTIFACT | Exact recorded hash/MIME/size and canonical hash-derived key; no mutable alias restore; T12 |
| N1 | Container verification, HTTP observations, safe logs | Non-authoritative, no D1/R2 capability | Read-only narrow authenticated protocol; T8/T9/T14 |

There is no scheduled business DELETE. T4 proves guarded DELETE on an isolated test table so adding a future delete cannot accidentally rely on UPDATE-only fencing. Any new write found during implementation must be assigned an inventory row and atomic guard before production composition; an unguardable authoritative write is a STOP gate.

## File and interface ownership

`lib/scheduler/` contains runtime-neutral types/config, error/latch policy and serial orchestration. `lib/db/repositories/scheduled/` owns production fenced stores. `lib/db/repositories/*-queries.ts` contains narrow shared SQL builders extracted from the corresponding legacy repository; legacy and scheduled call the same policy builders, with distinct execution boundaries. `lib/verifiers/official-links/remote/` contains runtime-neutral protocol/MAC/client. `containers/official-link-verifier/` alone composes Node transport. `workers/cron-sync/` owns Cloudflare bindings/configuration; Image Worker owns scheduled auth and image publication.

SQL builder seam: `BuiltMutation = { sql: string; params: unknown[]; minChanges: number; maxChanges: number | null }`. Builders use existing Drizzle query construction and `.toSQL()` with an explicit `SQL` fence predicate supplied to each statement; they do not rewrite compiled strings. Legacy callers can use shared unfenced builder mode only in existing legacy factories. Scheduled factories require authority as a positional construction input and always pass the fence. No scheduled caller can omit it. Extracting the builder must preserve legacy batch query objects as well as compiled text (`BuiltDomainQuery` defined in T4); it does not replace domain planners.

Dependencies: T1 → T2 → T3 → T4 → T5/T6/T7; T1 → T8 → T9; T4+T8 → T10; T4 → T11 → T12; T5–T12 → T13 → T14 → T15. Execute tasks in numerical order to keep review and commits unambiguous. No task imports a module introduced only by a later task; production composition is deferred to T14.

## Task 1: Scheduler contracts, safe errors, configuration and monotonic latches

**Files:** Create `lib/scheduler/types.ts`, `lib/scheduler/errors.ts`, `lib/scheduler/config.ts`, `lib/scheduler/signals.ts`; Test `lib/scheduler/contracts.test.ts`. Modify: none.

**Interfaces:** Consume existing `BulkGameResult` from `lib/sync/types.ts` and `BulkSyncStages` from `lib/sync/stages.ts`. Produce the following shapes (the Spec names are canonical):

```ts
export type ScheduledMutationAuthority = Readonly<{
  ownerToken: string; fenceEpoch: number; leaseExpiresAtMs: number;
}>;
export type LeaseAuthority = ScheduledMutationAuthority;
export type LeaseHandle = LeaseAuthority;
export type LeaseAcquireResult = {status:"acquired";lease:LeaseHandle}|{status:"held"};
export type SyncCandidate = {gameId:number;appId:string};
export type CronSyncConfig = {batchSize:number;platformWallBudgetMs:900000;
  softDeadlineMs:number;gameAdmissionReserveMs:number;finishReserveMs:number;leaseDurationMs:number};
export type CronExecutionInput = {executionId:string;scheduledAt:Date};
export type CronFailureCode = "configuration_error"|"composition_failed"|"lease_acquire_failed"
  |"lease_lost"|"fence_lost"|"candidate_read_failed"|"state_write_failed"|"state_conflict"
  |"pipeline_contract_error"|"lease_release_failed";
export type SafeCronError = {code:CronFailureCode;message:string};
export type CronExecutionResult = {
  executionId:string; status:"completed"|"partial"|"skipped"|"failed";
  selected:number;attempted:number;succeeded:number;failed:number;notStarted:number;
  stopReason:"none"|"active_lease"|"soft_deadline"|"unsettled_remote_work"|"authority_lost"|"infrastructure_failure";
  games:BulkGameResult[];primaryError:SafeCronError|null;
  secondaryErrors:Array<{code:"lease_release_failed"|"lease_lost"|"fence_lost";message:string}>;
  leaseDisposition:"not_acquired"|"released"|"retained_until_expiry"|"no_longer_owned";
};
export interface LeaseRepository {
  acquire(ownerToken:string,durationMs:number):Promise<LeaseAcquireResult>;
  assertOwned(lease:LeaseHandle):Promise<{dbNowMs:number;leaseExpiresAtMs:number}>;
  release(lease:LeaseHandle):Promise<"released"|"fence_lost">;
}
export interface CandidateRepository {
  select(limit:number):Promise<SyncCandidate[]>;
  stillMatches(candidate:SyncCandidate):Promise<boolean>;
}
export type AttemptStamp = {gameId:number;attemptedAt:Date;authority:ScheduledMutationAuthority};
export interface SchedulerStateRepository {
  startAttempt(gameId:number,authority:ScheduledMutationAuthority):Promise<AttemptStamp>;
  finishAttempt(stamp:AttemptStamp,status:"succeeded"|"failed"):Promise<void>;
}
export type UnsettledImageWorkReason = "image_delivery_unknown"|"image_deadline"|"image_mutation_unknown";
export type CronSignals = {
  markAuthorityLoss(code:"lease_lost"|"fence_lost"):void;
  markUnsettled(reason:UnsettledImageWorkReason):void;
  readAuthorityLoss():"lease_lost"|"fence_lost"|null;
  readUnsettledImageWork():readonly UnsettledImageWorkReason[];
};
export type CronGameRuntime = Pick<CronSignals,"readAuthorityLoss"|"readUnsettledImageWork"> & {stages:BulkSyncStages};
export function parseCronSyncConfig(value:unknown):CronSyncConfig;
export function parseScheduledMutationAuthority(value:unknown):ScheduledMutationAuthority;
export function safeCronError(code:CronFailureCode):SafeCronError;
export class FenceLostError extends Error {readonly code:"fence_lost";}
export function createCronSignals():CronSignals;
```

- [ ] Write the contract tests, including a real runtime test:

```ts
it("keeps authority loss and image uncertainty monotonic", () => {
  const signals = createCronSignals();
  signals.markUnsettled("image_deadline");
  signals.markAuthorityLoss("lease_lost");
  signals.markAuthorityLoss("fence_lost");
  expect(signals.readUnsettledImageWork()).toEqual(["image_deadline"]);
  expect(signals.readAuthorityLoss()).toBe("fence_lost");
});
it("defaults to the approved admission inequalities", () => {
  expect(parseCronSyncConfig({})).toEqual({batchSize:25,platformWallBudgetMs:900000,
    softDeadlineMs:720000,gameAdmissionReserveMs:780000,finishReserveMs:30000,leaseDurationMs:1500000});
});
```

- [ ] RED: `npx vitest run lib/scheduler/contracts.test.ts`; expect unresolved `./signals`/`./config` modules. Record the actual failing assertions once modules exist; no skipped test counts as RED.
- [ ] Implement strict key/type/integer validation with existing Zod; UUID owner, positive safe epoch/expiry, frozen copied authority; fixed code-indexed errors without cause/raw input. Validate batch/reserve bounds, enough wall/lease room for one game+finish, and soft >0 ≤720000. Latches use closure `Set<UnsettledImageWorkReason>` and loss state; `fence_lost` dominates `lease_lost`; return copies.
- [ ] GREEN: `npx vitest run lib/scheduler/contracts.test.ts`; expect all tests PASS, including malformed authority, epoch overflow and config boundary matrix.
- [ ] Refactor only these contracts; run `npx vitest run lib/scheduler/contracts.test.ts lib/sync/types.test.ts lib/sync/stages.test.ts`, `npm run typecheck`, `npm run lint`, `git diff --check`; each exit 0.
- [ ] Commit: `git add lib/scheduler/types.ts lib/scheduler/errors.ts lib/scheduler/config.ts lib/scheduler/signals.ts lib/scheduler/contracts.test.ts` then `git commit -m "feat: define Cron sync contracts and authority signals"`.
- [ ] Independent review: Spec §§8,11,21–23; verify exact DTOs and no persistence/runtime orchestration. Record base/head, tests and findings before T2.

## Task 2: Two-table additive migration and reusable local D1 fixture

**Files:** Modify `lib/db/schema.ts`, `drizzle/meta/_journal.json`; Create `drizzle/0004_cron_sync_fencing.sql`, `drizzle/meta/0004_snapshot.json`, `lib/scheduler/test-support/local-d1.ts`; Test `lib/scheduler/migration.integration.test.ts`.

**Interfaces:** Produce Drizzle `gameCronSyncState`, `cronSyncLease`; test-only `createSchedulerD1Fixture({migrationCount?:4|5}={}):Promise<SchedulerD1Fixture>` where `SchedulerD1Fixture={binding:D1Database;db:GameHubDatabase;dispose():Promise<void>;applyV28():Promise<void>;dump():Promise<Record<string,unknown[]>>}`. `dump` returns rows ordered by PK and schema objects separately in a `__schema` array. Fixture uses existing Wrangler `getPlatformProxy` pattern, `remoteBindings:false`, `envFiles:[]`, an explicit `mkdtemp`-derived persistence root, and acquisition ledger; dispose exactly once even on later startup failure. Never use user's local state.

- [ ] Write populated migration test:

```ts
it("adds only scheduler tables and preserves all populated legacy rows", async () => {
  const f = await createSchedulerD1Fixture({migrationCount:4});
  try {
    await f.binding.prepare("INSERT INTO games(id,slug,title) VALUES(701,'seed','Seed')").run();
    const before = await f.dump();
    await f.applyV28();
    const after = await f.dump();
    for (const [table,rows] of Object.entries(before)) {
      if (table !== "__schema") expect(after[table]).toEqual(rows);
    }
    expect(await f.binding.prepare("SELECT * FROM cron_sync_lease").all()).toMatchObject({results:[
      {name:"game-sync",lease_owner_token:null,lease_expires_at:0,fence_epoch:0}
    ]});
  } finally { await f.dispose(); }
});
```

- [ ] RED: `npx vitest run lib/scheduler/migration.integration.test.ts`; expect missing fifth migration/new tables. Expand population to every old table using existing importer/IGDB/link/image fixtures before accepting GREEN.
- [ ] Implement exactly this SQL (Drizzle named CHECK declarations mirror it; use statement-breakpoint separators):

```sql
CREATE TABLE game_cron_sync_state (
  game_id integer PRIMARY KEY NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  last_attempt_at integer NOT NULL,
  last_status text NOT NULL,
  CONSTRAINT game_cron_sync_state_attempt_check CHECK(typeof(last_attempt_at)='integer' AND last_attempt_at>=0),
  CONSTRAINT game_cron_sync_state_status_check CHECK(last_status IN ('started','succeeded','failed'))
);
CREATE INDEX game_cron_sync_state_attempt_idx ON game_cron_sync_state(last_attempt_at,game_id);
CREATE TABLE cron_sync_lease (
  name text PRIMARY KEY NOT NULL,
  lease_owner_token text,
  lease_expires_at integer DEFAULT 0 NOT NULL,
  fence_epoch integer DEFAULT 0 NOT NULL,
  CONSTRAINT cron_sync_lease_name_check CHECK(name='game-sync'),
  CONSTRAINT cron_sync_lease_expiry_check CHECK(typeof(lease_expires_at)='integer' AND lease_expires_at>=0),
  CONSTRAINT cron_sync_lease_epoch_check CHECK(typeof(fence_epoch)='integer' AND fence_epoch>=0 AND fence_epoch<=9007199254740991),
  CONSTRAINT cron_sync_lease_owner_check CHECK(
    (lease_owner_token IS NULL AND lease_expires_at=0) OR
    (typeof(lease_owner_token)='text' AND length(lease_owner_token)>0 AND lease_expires_at>0))
);
INSERT INTO cron_sync_lease(name,lease_owner_token,lease_expires_at,fence_epoch)
VALUES('game-sync',NULL,0,0);
```

- [ ] Generate the snapshot/journal from the two schema declarations; rename generated migration to the fixed filename and align the journal tag; inspect emitted SQL against the exact additive design. Migration journal index is 4; do not modify old snapshots/migrations. Test invalid owner/expiry combinations, noninteger/negative/overflow epoch, invalid status, FK and cascade, new index, exact column lists, old defaults/PK/FK/indexes/check SQL preserved. Re-open the migrated fixture and recheck without re-running seed; rerunning migrations through Wrangler must not reset epoch.
- [ ] GREEN: `npx vitest run lib/scheduler/migration.integration.test.ts`; all PASS with real local D1. Run `git diff --exit-code 36f5bc17494111e65c1d3fcb93d111f631b8cd0c -- drizzle/0000_nervous_gunslinger.sql drizzle/0001_cold_mysterio.sql drizzle/0002_purple_greymalkin.sql drizzle/0003_odd_weapon_omega.sql`; expect no diff. `find drizzle -maxdepth 1 -name '*.sql' | wc -l` must be 5. `shasum lib/db/schema.ts` records new candidate hash; repeated run must agree.
- [ ] Refactor fixture cleanup; run `npx vitest run lib/scheduler/migration.integration.test.ts lib/db/validation.test.ts`, `npm run typecheck`, `npm run lint`, `git diff --check`; all exit 0. Unsupported local D1 is BLOCKED, not PASS.
- [ ] Commit: `git add lib/db/schema.ts drizzle/0004_cron_sync_fencing.sql drizzle/meta/0004_snapshot.json drizzle/meta/_journal.json lib/scheduler/test-support/local-d1.ts lib/scheduler/migration.integration.test.ts` then `git commit -m "feat: add additive Cron state and fencing lease schema"`.
- [ ] Independent review: exact two-table scope, seeded durable epoch, named assertion CHECK and populated migration preservation.

## Task 3: Atomic acquire, primary ownership read and epoch-preserving release

**Files:** Create `lib/db/repositories/scheduled/lease.ts`; Test `lib/scheduler/lease.integration.test.ts`. Modify: none.

**Interfaces:** Consume `D1Database`, `LeaseRepository`, `LeaseAuthority`; produce `createLeaseRepository(binding:D1Database):LeaseRepository`. Use primary D1 operations; if sessions are used, acquire a `first-primary` session, never a replica fence read. No renewal interface.

- [ ] Write real concurrency tests:

```ts
it("allows one winner and never reuses a released epoch", async () => {
  const f = await createSchedulerD1Fixture();
  try {
    const repo = createLeaseRepository(f.binding);
    const answers = await Promise.all(Array.from({length:8}, () => repo.acquire(crypto.randomUUID(),1500000)));
    const winners = answers.filter((r):r is Extract<LeaseAcquireResult,{status:"acquired"}> => r.status==="acquired");
    expect(winners).toHaveLength(1);
    expect(winners[0]!.lease.fenceEpoch).toBe(1);
    expect(await repo.release(winners[0]!.lease)).toBe("released");
    const next = await repo.acquire(crypto.randomUUID(),1500000);
    expect(next).toMatchObject({status:"acquired",lease:{fenceEpoch:2}});
    expect(await repo.release(winners[0]!.lease)).toBe("fence_lost");
    expect("renew" in repo).toBe(false);
  } finally { await f.dispose(); }
});
```

- [ ] RED: `npx vitest run lib/scheduler/lease.integration.test.ts`; expect missing `createLeaseRepository`.
- [ ] Implement these parameterized statements; bind normalized owner/duration, validate positive safe duration and UUID without logging. `?1` owner, `?2` duration for acquire:

```sql
UPDATE cron_sync_lease
SET lease_owner_token=?1,
    lease_expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+?2,
    fence_epoch=fence_epoch+1
WHERE name='game-sync'
  AND lease_expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
  AND fence_epoch<9007199254740991
RETURNING lease_owner_token,fence_epoch,lease_expires_at;
```

```sql
SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS db_now_ms,lease_expires_at
FROM cron_sync_lease
WHERE name='game-sync' AND lease_owner_token=?1 AND fence_epoch=?2
  AND lease_expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER);
UPDATE cron_sync_lease SET lease_owner_token=NULL,lease_expires_at=0
WHERE name='game-sync' AND lease_owner_token=?1 AND fence_epoch=?2
  AND lease_expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
RETURNING fence_epoch;
```

- [ ] Require exactly one returned acquisition row; zero rows triggers a primary diagnostic read distinguishing active-held from missing/corrupt/exhausted infrastructure failure, without retry or permission recovery. An acquire transport error is `lease_acquire_failed` with no trusted handle. `assertOwned` no row is `lease_lost`; release no row is `fence_lost`; transport errors are fixed safe errors. Returned authority is a copied frozen value; never read a newer epoch into it.
- [ ] Add expired/equal-boundary owner, stale token, stale epoch, absent singleton, corrupted-row fixture, epoch ceiling, clock-skew and lost-response tests. Test absence only through a test DB mutation, not production recovery. A valid early transaction delivered late remains legal; a subsequent write still checks live DB time.
- [ ] GREEN: `npx vitest run lib/scheduler/lease.integration.test.ts`; all PASS. Refactor only repository internals; rerun `npx vitest run lib/scheduler/contracts.test.ts lib/scheduler/migration.integration.test.ts lib/scheduler/lease.integration.test.ts`, `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0.
- [ ] Commit: `git add lib/db/repositories/scheduled/lease.ts lib/scheduler/lease.integration.test.ts` then `git commit -m "feat: add atomic epoch-preserving Cron lease"`.
- [ ] Independent review: atomic increment, one winner, primary time, strict expiry, release high-water, lost response and no renew/resurrection.

## Task 4: Guarded D1 statements and transactional fence assertions

**Files:** Create `lib/db/repositories/scheduled/fence.ts`; Test `lib/scheduler/fence.integration.test.ts`, `lib/scheduler/fence-sql.test.ts`.

**Interfaces:** Consume `D1Database`, `GameHubDatabase`, `SQL` from Drizzle, captured authority. Produce:

```ts
export type DomainBatchQuery = Parameters<GameHubDatabase["batch"]>[0][number];
export type BuiltMutation = {sql:string;params:unknown[];minChanges:number;maxChanges:number|null};
export type BuiltDomainQuery = BuiltMutation & {legacyQuery:DomainBatchQuery};
export type FencedBatchResult = {changes:number[];affectedRows:number;
  /** Mutation rows only; the two fence assertion rows are validated internally and omitted. */
  results:readonly ReadonlyArray<Record<string, unknown>>[]};
export function fencePredicate(authority:ScheduledMutationAuthority):SQL;
export function compileDomainQuery(query:DomainBatchQuery,
  expected:{minChanges:number;maxChanges:number|null}):BuiltDomainQuery;
export function executeFencedBatch(binding:D1Database,authority:ScheduledMutationAuthority,
  mutations:readonly BuiltMutation[]):Promise<FencedBatchResult>;
export function assertFence(binding:D1Database,authority:ScheduledMutationAuthority):Promise<void>;
```

`compileDomainQuery` compiles the existing Drizzle `.toSQL()` result once; no string substitution inserts a fence. The calling builder adds `fencePredicate` to its SQL AST. `executeFencedBatch` binds already-guarded compiled statements between two assertions and validates each statement separately, returning each mutation's validated `RETURNING` rows (excluding the two internal assertion rows) so repositories can recover committed timestamps or other declared values without an unfenced read. Only repository-owned builders can call it; caller/provider text never supplies SQL.

- [ ] Write the real stale-write test:

```ts
it("rejects an expired owner's guarded INSERT before it can publish", async () => {
  const f=await createSchedulerD1Fixture();
  try {
    const lease=await createLeaseRepository(f.binding).acquire(crypto.randomUUID(),1500000);
    if(lease.status!=="acquired") throw new Error("fixture lease unavailable");
    await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1 WHERE name='game-sync'").run();
    await expect(executeFencedBatch(f.binding,lease.lease,[{
      sql:"INSERT INTO genres(slug,name) SELECT ?1,?2 WHERE EXISTS (SELECT 1 FROM cron_sync_lease WHERE name='game-sync' AND lease_owner_token=?3 AND fence_epoch=?4 AND lease_expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER))",
      params:["stale","Stale",lease.lease.ownerToken,lease.lease.fenceEpoch],minChanges:0,maxChanges:1
    }])).rejects.toMatchObject({code:"fence_lost"});
    expect(await f.binding.prepare("SELECT id FROM genres WHERE slug='stale'").all()).toMatchObject({results:[]});
  } finally {await f.dispose();}
});
```

- [ ] RED: `npx vitest run lib/scheduler/fence.integration.test.ts lib/scheduler/fence-sql.test.ts`; expect missing primitive. Add the vulnerable negative control using SELECT then delayed unguarded UPDATE, prove it changes D1 after B acquisition, then assert the real guarded version rejects A.
- [ ] Implement the fixed assertion with immutable owner/epoch bound independently for each statement:

```sql
UPDATE cron_sync_lease SET fence_epoch=CASE
 WHEN lease_owner_token=?1 AND fence_epoch=?2
  AND lease_expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)
 THEN fence_epoch ELSE -1 END
WHERE name='game-sync'
RETURNING fence_epoch;
```

Execute `[assertion,...mutations,assertion]` in one real `D1Database.batch`. Named `cron_sync_lease_epoch_check` failure maps to branded `FenceLostError`; other constraint/transport failures remain safely distinguishable for native repository decoders. Validate result count `mutations.length+2`, assertions exactly one returned row matching epoch, each mutation `meta.changes` within declared bounds; exclude assertion changes from affectedRows. Missing singleton makes guarded business statements no-ops and is a hard failure; empty plans run the assertions. Never diagnose a failed assertion as success based on a later read.

- [ ] Prove UPDATE/DELETE add the fence to existing WHERE; INSERT uses explicit-column SELECT WHERE; UPSERT guards both SELECT and DO UPDATE. Exercise DELETE only against test fixture data. Force final assertion failure **inside one actual batch** by inserting a test-only lease-expiry statement between a successful guarded mutation and final assertion; named CHECK must roll back the prefix, including the test expiry change. Test a naturally expired request without B, B-before-A and legal A-before-B committed-value barriers. Failure to obtain real D1 transactional rollback stops downstream tasks.
- [ ] GREEN: `npx vitest run lib/scheduler/fence.integration.test.ts lib/scheduler/fence-sql.test.ts`; all PASS on local D1. Run refactor/regression `npx vitest run lib/scheduler/lease.integration.test.ts lib/scheduler/fence.integration.test.ts lib/scheduler/fence-sql.test.ts`, `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0.
- [ ] Commit: `git add lib/db/repositories/scheduled/fence.ts lib/scheduler/fence.integration.test.ts lib/scheduler/fence-sql.test.ts` then `git commit -m "feat: enforce atomic D1 mutation fencing"`.
- [ ] Independent review is a hard correctness gate: named CHECK decoder, INSERT/UPSERT coverage, no-op behavior, per-statement counts, rollback and primary-time proof.

## Task 5: Deterministic candidates and fenced attempt metadata

**Files:** Create `lib/db/repositories/scheduled/candidates.ts`, `lib/db/repositories/scheduled/state.ts`; Test `lib/scheduler/candidates.integration.test.ts`, `lib/scheduler/state.integration.test.ts`.

**Interfaces:** Produce `createCandidateRepository(binding:D1Database):CandidateRepository`, `createSchedulerStateRepository(binding:D1Database):SchedulerStateRepository`. Add read-only `canonicalGameExists(binding:D1Database,gameId:number):Promise<boolean>` for the absent-game exception; it never replaces the FK/fence.

- [ ] Write selection/rotation tests:

```ts
it("filters malformed mappings before LIMIT and advances failed attempts", async () => {
  const f=await createSchedulerD1Fixture();
  try {
    for(const [id,appId] of [[1,"001"],[2,"20"],[3,"30"]] as const){
      await f.binding.prepare("INSERT INTO games(id,slug,title) VALUES(?1,?2,?2)").bind(id,`g${id}`).run();
      await f.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id) VALUES(?1,'steam',?2)").bind(id,appId).run();
    }
    const repo=createCandidateRepository(f.binding);
    expect(await repo.select(1)).toEqual([{gameId:2,appId:"20"}]);
    const acquired=await createLeaseRepository(f.binding).acquire(crypto.randomUUID(),1500000);
    if(acquired.status!=="acquired") throw new Error("fixture lease unavailable");
    const state=createSchedulerStateRepository(f.binding);
    const stamp=await state.startAttempt(2,acquired.lease);
    await state.finishAttempt(stamp,"failed");
    expect(await repo.select(2)).toEqual([{gameId:3,appId:"30"},{gameId:2,appId:"20"}]);
  }finally{await f.dispose();}
});
```

- [ ] RED: `npx vitest run lib/scheduler/candidates.integration.test.ts lib/scheduler/state.integration.test.ts`; missing repositories must fail.
- [ ] Implement eligibility CTE and final LIMIT:

```sql
WITH steam AS (
 SELECT game_id,MIN(external_id) AS app_id FROM game_external_ids
 WHERE provider='steam' GROUP BY game_id HAVING COUNT(*)=1
), eligible AS (
 SELECT g.id AS game_id,s.app_id FROM games g JOIN steam s ON s.game_id=g.id
 WHERE length(s.app_id) BETWEEN 1 AND 10
   AND s.app_id NOT GLOB '*[^0-9]*' AND substr(s.app_id,1,1) BETWEEN '1' AND '9'
   AND CAST(s.app_id AS INTEGER) BETWEEN 1 AND 4294967295
   AND CAST(CAST(s.app_id AS INTEGER) AS TEXT)=s.app_id
)
SELECT e.game_id,e.app_id FROM eligible e
LEFT JOIN game_cron_sync_state s ON s.game_id=e.game_id
ORDER BY (s.last_attempt_at IS NOT NULL) ASC,s.last_attempt_at ASC,e.game_id ASC LIMIT ?1;
```

Returned IDs must also equal existing `normalizeSteamAppId` normalization. `stillMatches` repeats all eligibility conditions for expected game/App ID, not a simple external-id existence read.

- [ ] Build start using explicit-column INSERT SELECT of game ID, DB-now and `started`, WHERE game exists AND fence; `ON CONFLICT(game_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_status='started' WHERE` the same fence. Decode exactly one mutation `results` row `{game_id,last_attempt_at,last_status}` returned by `executeFencedBatch` into `AttemptStamp`; never issue a follow-up timestamp read. Add a regression that pauses delivery after the batch commits, lets another owner update metadata, and proves the stamp still equals the original returned DB value. Finish UPDATE matches game_id, original timestamp, `last_status='started'` and fence; requires exactly one changed row; valid fence zero changes → `state_conflict`. Start/delete race maps safe `state_write_failed`; the scheduler only omits metadata if the game was already absent before start.
- [ ] Add tests for zero/multiple mappings, sign/space/non-digit/uint32 overflow, stable equal-time ID, limit25, repeated finite-catalog rotation with failed/started entries, actual cascade, stale start UPSERT arm, stale finish after B stamp and valid zero-row conflict.
- [ ] GREEN: `npx vitest run lib/scheduler/candidates.integration.test.ts lib/scheduler/state.integration.test.ts`; all PASS. Refactor then run those plus `lib/scheduler/fence.integration.test.ts` and `lib/providers/steam/app-id.test.ts`; `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0.
- [ ] Commit: `git add lib/db/repositories/scheduled/candidates.ts lib/db/repositories/scheduled/state.ts lib/scheduler/candidates.integration.test.ts lib/scheduler/state.integration.test.ts` then `git commit -m "feat: select fair Cron candidates and fence attempt state"`.
- [ ] Independent review: filters-before-LIMIT, fairness on failure/crash, exact metadata schema and no stale completion.

## Task 6: Steam existing-only production store with every update fenced

**Files:** Modify `lib/db/repositories/steam-import.ts`; Create `lib/db/repositories/steam-import-queries.ts`, `lib/db/repositories/scheduled/steam.ts`; Test `lib/scheduler/steam.integration.test.ts`.

**Interfaces:** Consume `SteamImportStore`, `SteamImportPlan`, `createSteamImporter`, `createSteamStage`, fence types. Produce `buildSteamUpdateQueries(db:GameHubDatabase,plan:SteamImportPlan,guard?:SQL):BuiltDomainQuery[]` in shared builder; produce `createScheduledSteamStore(input:{binding:D1Database;db:GameHubDatabase;candidate:SyncCandidate;authority:ScheduledMutationAuthority;signals:CronSignals}):SteamImportStore`. Optional builder guard is for legacy reuse only; scheduled factory has no optional authority path.

- [ ] Write late-provider test using the existing real importer/client contract and local D1:

```ts
it("rejects Steam apply after ownership changes", async () => {
  const f=await createSchedulerD1Fixture();
  try {
    await f.binding.prepare("INSERT INTO games(id,slug,title) VALUES(7,'g7','Game')").run();
    await f.binding.prepare("INSERT INTO game_external_ids(game_id,provider,external_id,external_url) VALUES(7,'steam','70',NULL)").run();
    const acquired=await createLeaseRepository(f.binding).acquire(crypto.randomUUID(),1500000);
    if(acquired.status!=="acquired") throw new Error("fixture lease unavailable");
    const signals=createCronSignals();
    const store=createScheduledSteamStore({binding:f.binding,db:f.db,candidate:{gameId:7,appId:"70"},authority:acquired.lease,signals});
    const snapshot=await store.findSnapshotByExternalId("steam","70");
    expect(snapshot?.game.id).toBe(7);
    await f.binding.prepare("UPDATE cron_sync_lease SET lease_expires_at=1").run();
    await createLeaseRepository(f.binding).acquire(crypto.randomUUID(),1500000);
    const plan:SteamImportPlan={action:"existing",existingGameId:7,selectedSlug:"g7",resolvedCompanies:[],
      creates:[],updates:[],skips:[],warnings:[],candidate:{
        source:{provider:"steam",externalId:"70",fetchedAt:new Date(0)},
        game:{preferredSlug:"g7",title:"Game",summary:null,description:null,status:"released",releaseDate:null,coverUrl:null,heroUrl:null},
        externalIds:[{provider:"steam",externalId:"70",externalUrl:"https://store.steampowered.com/app/70/"}],
        officialLinks:[{provider:"steam",platform:null,linkType:"store",url:"https://store.steampowered.com/app/70/",isOfficial:true,verificationStatus:"verified",verificationMethod:"provider_api"}],
        genres:[],platforms:[],companies:[],images:[],videos:[]}};
    await expect(store.applyPlan(plan)).rejects.toMatchObject({code:"write_conflict"});
    expect(signals.readAuthorityLoss()).toBe("fence_lost");
  }finally{await f.dispose();}
});
```

The above exercises no-op authority directly. The integration case must also pause `SteamClient.fetchAppDetails` with a deferred promise, return the valid `SteamHttpResponse` fixture from `test/fixtures/steam/appdetails-valid.json` with its entry key and `data.steam_appid` changed to70, let B acquire, then release the response and assert actual S1/S2/S3 SQL is rejected. Construct update plans through `planSteamImport`; no cast may replace a behavior assertion in the final tests.

- [ ] RED: `npx vitest run lib/scheduler/steam.integration.test.ts`; missing scheduled store; then unsafe negative implementation demonstrates stale URL changes.
- [ ] Extract only current update query creation into shared builder. Keep create arm in legacy repository unchanged. Scheduled `applyPlan` rejects create or mismatched `existingGameId`, snapshots/post-write lookups reject missing/wrong/ambiguous selected identity, every update builder receives `fencePredicate(authority)`. Execute one fenced batch, including no-op assertion; count only S1/S2/S3 mutations. Mark loss before safe native `SteamImportError('write_conflict', fixedText)` translation; never expose DB cause.

```ts
try {
  const writes=buildSteamUpdateQueries(db,plan,fencePredicate(authority));
  return {affectedRows:(await executeFencedBatch(binding,authority,writes)).affectedRows};
} catch(error) {
  if(error instanceof FenceLostError) signals.markAuthorityLoss("fence_lost");
  throw new SteamImportError("write_conflict","Scheduled Steam write was rejected");
}
```

- [ ] Cover each inventory update kind, manual preserved, valid unchanged result, mapping deleted/moved/multiple before and after planning, create rejected with zero INSERT across all S4 tables, local create regression intact; generated SQL includes guard on each update.
- [ ] GREEN: `npx vitest run lib/scheduler/steam.integration.test.ts`; PASS. Refactor then `npx vitest run lib/scheduler/steam.integration.test.ts lib/importers/steam.test.ts lib/importers/steam-plan.test.ts lib/sync/steam-stage.test.ts`, `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0.
- [ ] Commit: `git add lib/db/repositories/steam-import.ts lib/db/repositories/steam-import-queries.ts lib/db/repositories/scheduled/steam.ts lib/scheduler/steam.integration.test.ts` then `git commit -m "feat: fence scheduled Steam updates and forbid creation"`.
- [ ] Independent review: S1–S4 inventory, identity races, no-op lost fence and unchanged local behavior.

## Task 7: Complete fenced IGDB batch without business-policy duplication

**Files:** Modify `lib/db/repositories/igdb-enrichment.ts`; Create `lib/db/repositories/igdb-enrichment-queries.ts`, `lib/db/repositories/scheduled/igdb.ts`; Test `lib/scheduler/igdb.integration.test.ts`.

**Interfaces:** Produce `buildIgdbQueries(db:GameHubDatabase,plan:IgdbEnrichmentPlan,guard?:SQL):BuiltDomainQuery[]` and `createScheduledIgdbStore(input:{binding:D1Database;db:GameHubDatabase;candidate:SyncCandidate;authority:ScheduledMutationAuthority;signals:CronSignals}):IgdbEnrichmentStore`. Reuse existing store read methods, planner/client/enricher and error identity classifier; no unfenced `applyPlan` delegation.

- [ ] Write a real batch failure test with full plan fixture:

```ts
it("rolls back taxonomy and media when the final fence assertion fails", async () => {
  const f=await createSchedulerD1Fixture();
  try {
    await f.binding.prepare("INSERT INTO games(id,slug,title) VALUES(8,'g8','Game')").run();
    const acquired=await createLeaseRepository(f.binding).acquire(crypto.randomUUID(),1500000);
    if(acquired.status!=="acquired") throw new Error("fixture lease unavailable");
    const before=await f.dump();
    const rows=buildIgdbQueries(f.db,fullIgdbPlan,fencePredicate(acquired.lease));
    const expire={sql:"UPDATE cron_sync_lease SET lease_expires_at=1 WHERE name='game-sync'",params:[],minChanges:1,maxChanges:1};
    await expect(executeFencedBatch(f.binding,acquired.lease,[...rows,expire])).rejects.toMatchObject({code:"fence_lost"});
    expect(await f.dump()).toEqual(before);
  }finally{await f.dispose();}
});
```

Define the fixture before this test, with all actual discriminated union members:

```ts
const fullIgdbPlan:IgdbEnrichmentPlan={action:"enrich",gameId:8,slug:"g8",matchedIgdbGame:{id:"800",name:"Game"},
  creates:[
    {entity:"external_id",key:"igdb:800",values:{gameId:8,provider:"igdb",externalId:"800",externalUrl:null}},
    {entity:"genre",key:"action",values:{slug:"action",name:"Action"}},
    {entity:"game_genre",key:"8:action",values:{gameId:8,genreSlug:"action"}},
    {entity:"platform",key:"pc",values:{slug:"pc",name:"PC"}},
    {entity:"game_platform",key:"8:pc",values:{gameId:8,platformSlug:"pc"}},
    {entity:"company",key:"studio",values:{slug:"studio",name:"Studio",websiteUrl:null}},
    {entity:"game_company",key:"8:studio:developer",values:{gameId:8,companySlug:"studio",role:"developer"}},
    {entity:"official_link",key:"https://example.com/",values:{gameId:8,provider:"igdb",platform:null,linkType:"official_website",url:"https://example.com/",isOfficial:true,verificationStatus:"unverified",verificationMethod:null}},
    {entity:"image",key:"https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg",values:{gameId:8,type:"cover",sourceUrl:"https://images.igdb.com/igdb/image/upload/t_cover_big/abc.jpg",width:600,height:800,sortOrder:0}},
    {entity:"video",key:"igdb:clip",values:{gameId:8,provider:"igdb",externalId:"clip",title:"Trailer",thumbnailUrl:null,sortOrder:0}}
  ],updates:[{entity:"game",key:"8",changes:{summary:"Summary"}}],skips:[],warnings:[],conflicts:[]};
```

Also exercise full plans through existing normalization/planning fixtures, asserting the same nonempty inventory coverage before performing a stale-provider interleaving.

- [ ] RED: `npx vitest run lib/scheduler/igdb.integration.test.ts`; missing builder/store; then demonstrate prefix mutations under a deliberately unfenced negative control.
- [ ] Extract all existing query assembly; convert each scheduled VALUES insert into explicit columns SELECT WHERE fence; preserve actual default expressions, NULLs and parameter budget. For external identity conflict assertion, retain its duplicate-identity SELECT and add fence before LIMIT. Keep `coalesce`, relation lookup, image NOT EXISTS and exact source-provider behavior. One `[assert,...all statements,assert]` batch; statement 0/1 expectations match existing semantics; exclude fence assertions from aggregate. Capture fence before network and mark loss before `IgdbError('write_conflict',...,{retryable:false})`; preserve `igdb_external_identity_unique` decoding for real identity conflicts.
- [ ] Cover late paused IGDB result after B acquisition, expired A without B, every I1–I5 insert/update, identity assertion rollback, empty/existing result authority validation at stage wrapper, fill-empty/additive/no company website inference and existing recovery/retry behavior. No downstream stage on loss.
- [ ] GREEN: `npx vitest run lib/scheduler/igdb.integration.test.ts`; all PASS. Refactor then `npx vitest run lib/scheduler/igdb.integration.test.ts lib/db/repositories/igdb-enrichment.test.ts lib/enrichers/igdb.test.ts lib/sync/igdb-stage.test.ts`, `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0.
- [ ] Commit: `git add lib/db/repositories/igdb-enrichment.ts lib/db/repositories/igdb-enrichment-queries.ts lib/db/repositories/scheduled/igdb.ts lib/scheduler/igdb.integration.test.ts` then `git commit -m "feat: fence every scheduled IGDB batch mutation"`.
- [ ] Independent review: full table/statement inventory, assertions/affected rows, inherited fill-empty/additive semantics and no unfenced recovery path.

## Task 8: Versioned verifier protocol, strict codec, MAC and remote transport

**Files:** Create `lib/verifiers/official-links/verification-transport.ts`, `lib/verifiers/official-links/remote/types.ts`, `codec.ts`, `mac.ts`, `errors.ts`, `client.ts` under that `remote/` directory; Test `lib/verifiers/official-links/remote/codec.test.ts`, `mac.test.ts`, `client.test.ts`. Modify `lib/sync/stages.ts`, `lib/sync/link-stage.ts`, their tests.

**Interfaces:** Consume `TerminalOutcome`, `VerificationCode`, `VerifyBoundUrl`. Produce `OfficialLinkVerificationTransport.verify(exactUrl:string,options?:{linkDeadlineMs?:number;signal?:AbortSignal}):Promise<TerminalOutcome>`; exact wire types from Spec §18, including `WireAttempt` Date→`startedAtMs/finishedAtMs`, `WireTerminalOutcome.checkedAtMs`, max12 attempts/max6 redirect records; five branded `VerifierServiceErrorCode` strings from Spec §16. No new persisted status/code. Additional concrete ports:

```ts
export type VerifierWireRequest={version:1;operation:"verify_official_link";requestId:string;exactUrl:string;budgetMs:number};
export type VerifierServiceErrorCode="verifier_service_unavailable"|"verifier_timeout"|"verifier_protocol_error"|"verifier_auth_error"|"verifier_invalid_response";
export type RemoteVerifierError={code:VerifierServiceErrorCode;message:string};
export type WireAttempt={method:"HEAD"|"GET";url:string;resolvedAddress:string|null;addressFamily:4|6|null;
  httpStatus:number|null;startedAtMs:number;finishedAtMs:number};
export type WireRedirectHop={fromUrl:string;status:301|302|303|307|308;location:string;resolvedUrl:string|null};
export type WireTerminalOutcome={code:VerificationCode;attempts:WireAttempt[];redirectChain:WireRedirectHop[];
  finalUrl:string|null;httpStatus:number|null;checkedAtMs:number};
export type VerifierWireResponse={version:1;requestId:string;status:"completed";outcome:WireTerminalOutcome}
 |{version:1;requestId:string;status:"failed";error:RemoteVerifierError};
export type PrivateVerifierBinding={start(timeoutMs:number):Promise<void>;fetch(request:Request):Promise<Response>};
export type VerifierMacHeaders={requestId:string;timestampMs:string;mac:string};
export function parseVerifierRequest(bytes:Uint8Array):VerifierWireRequest;
export function encodeVerifierOutcome(requestId:string,outcome:TerminalOutcome):Uint8Array;
export function parseVerifierResponse(bytes:Uint8Array,request:VerifierWireRequest):TerminalOutcome;
export function signVerifierRequest(secret:string,body:Uint8Array,requestId:string,timestampMs:number):Promise<VerifierMacHeaders>;
export function verifyVerifierRequest(secret:string,body:Uint8Array,headers:VerifierMacHeaders,nowMs:number):Promise<boolean>;
export function signVerifierResponse(secret:string,requestBody:Uint8Array,requestId:string,status:number,responseBody:Uint8Array):Promise<string>;
export function verifyVerifierResponse(secret:string,requestBody:Uint8Array,requestId:string,status:number,responseBody:Uint8Array,mac:string):Promise<boolean>;
export function createRemoteVerifierTransport(input:{binding:PrivateVerifierBinding;secret:string;nowMs:()=>number;newRequestId:()=>string}):OfficialLinkVerificationTransport;
```

`RemoteVerifierRequest/Response` are exported aliases of `VerifierWireRequest/Response` to preserve Spec naming. The wire types above live in `remote/types.ts`; no `unknown` outcome payload. `parseVerifierResponse` validates request correlation/layout and throws branded service errors for failed envelopes. MAC uses existing WebCrypto (`crypto.subtle`) for Worker/Node compatibility; no Node dependency in client/codec.

`remote/errors.ts` exports `class VerifierServiceError extends Error {readonly code:VerifierServiceErrorCode;constructor(code:VerifierServiceErrorCode)}` and `isVerifierServiceError(value:unknown):value is VerifierServiceError`; message comes from a complete code-indexed fixed-text map. No caller-supplied message/cause is copied. `PrivateVerifierBinding.start` is fixed-instance readiness only, not a caller-selected service/host. The client starts its link budget before `start(min(10000,remainingMs))`, recomputes remaining time after startup, then builds and signs the request using the reduced positive budget. `fetch` never starts a fresh deadline. Local conformance bindings implement `start` as an already-listening no-op. A restart before fetch yields a service failure within the original remaining budget; it cannot grant a new budget.

- [ ] Write a tamper test:

```ts
it("binds signed response to the exact request body", async () => {
  const key="a".repeat(64), id="11111111-1111-4111-8111-111111111111";
  const enc=new TextEncoder(), request=enc.encode('{"version":1}'), response=enc.encode('{"status":"completed"}');
  const mac=await signVerifierResponse(key,request,id,200,response);
  expect(await verifyVerifierResponse(key,request,id,200,response,mac)).toBe(true);
  expect(await verifyVerifierResponse(key,enc.encode('{"version":2}'),id,200,response,mac)).toBe(false);
});
```

- [ ] RED: `npx vitest run lib/verifiers/official-links/remote`; expect missing codec/MAC/client. Add strict unknown version/enum/key and impossible chain tests before parser implementation.
- [ ] Implement request MAC bytes `request-v1\n<id>\n<timestamp>\n<sha256(body)>`; response bytes `response-v1\n<id>\n<sha256(request)>\n<status>\n<sha256(response)>`; hex hashes/MAC 64 lowercase characters, constant-time decoded-byte comparison, max30s skew. Header names fixed `X-GameHub-Request-Id`, `X-GameHub-Timestamp`, `X-GameHub-Mac`; response uses `X-GameHub-Mac`. Read stream byte caps 16384/262144 before decode; reject compression, redirects, duplicate JSON keys at every nesting level using a small lexical duplicate-key detector before `JSON.parse`, strict content type and exact schema.
- [ ] Validate safe dates/statuses/address family and allowed code relationships, HEAD block then optional GET restart, exact original chain edges, accepted URL resolution, no attempted blocked destination, final executed chain only; preserve all V2.5 failure shapes. URLs >2048/empty produce local invalid_url; malformed ≤2048 reaches Node. Parent pre-aborted signal produces native timeout before RPC. Active delivery timeout is service timeout. Error matrix: unavailable/startup/5xx/busy→service_unavailable; deadline→verifier_timeout; unsupported version/method/content type/operation/missing envelope→protocol_error;401/403/bad MAC→auth_error;invalid JSON/keys/enums/bytes/layout→invalid_response. All fixed branded messages.
- [ ] Extend the exhaustive stage failure union/allowlist and `createLinkStage` to recognize only branded safe remote service errors. Existing website `TerminalOutcome` mapping remains untouched. No fabricated site result on transport failure.
- [ ] GREEN: `npx vitest run lib/verifiers/official-links/remote lib/sync/link-stage.test.ts lib/sync/stages.test.ts`; all PASS. Refactor; rerun `npx vitest run lib/verifiers/official-links/verifier.test.ts lib/verifiers/official-links/classification.test.ts lib/verifiers/official-links/remote lib/sync`, `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0.
- [ ] Commit: `git add lib/verifiers/official-links/verification-transport.ts lib/verifiers/official-links/remote lib/sync/stages.ts lib/sync/link-stage.ts lib/sync/stages.test.ts lib/sync/link-stage.test.ts` then `git commit -m "feat: define authenticated bounded verifier transport"`.
- [ ] Independent review: protocol consistency, MAC vectors, every remote error, no target-body/proxy capability, bounded parsing and legacy enum compatibility.

## Task 9: Narrow authenticated Node Container and transport conformance

**Files:** Create `containers/official-link-verifier/server.ts`, `node-transport.ts`, `main.ts`, `Dockerfile`, `.dockerignore`, `server.test.ts`, `conformance.test.ts`; Create `lib/verifiers/official-links/remote/conformance-vectors.ts` (test fixture module only). Modify: none.

**Interfaces:** Produce `createLocalNodeVerificationTransport():OfficialLinkVerificationTransport`, `createVerifierServer(input:{secret:string;transport:OfficialLinkVerificationTransport;nowMs:()=>number}):import('node:http').Server`. `main.ts` obtains only verifier secret from runtime env and binds port8080. Server single active request, no queue, no D1/R2/provider imports. Docker image builds the current shared transport modules and runs compiled Node entry as non-root; the pinned exact supported Node LTS image/digest is recorded in Dockerfile after capability verification, never `latest`.

- [ ] Write no-authority/no-network auth test:

```ts
it("rejects invalid MAC before invoking target transport", async () => {
  const verify=vi.fn();
  const server=createVerifierServer({secret:"a".repeat(64),transport:{verify},nowMs:()=>1000});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const address=server.address(); if(!address||typeof address==="string") throw new Error("missing fixture port");
    const response=await fetch(`http://127.0.0.1:${address.port}/internal/v1/official-links/verify`,{method:"POST",body:"{}"});
    expect(response.status).toBe(401);expect(verify).not.toHaveBeenCalled();
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
```

- [ ] RED: `npx vitest run containers/official-link-verifier/server.test.ts containers/official-link-verifier/conformance.test.ts`; missing server/composition.
- [ ] Node composition reuses real secure functions, following the existing local composition exactly:

```ts
import {lookup as nodeLookup} from "node:dns/promises";
const resolver=createSafeDestinationResolver({lookup:async(hostname)=>{
  const addresses=await nodeLookup(hostname,{all:true});
  return addresses.map(({address,family})=>{
    if(family!==4&&family!==6) throw new Error("Unsupported DNS family");
    return {address,family};
  });
}});
const transport:OfficialLinkVerificationTransport={verify:(url,options)=>verifyUrl(url,{
  executeChain:(target,method,chainOptions)=>executeRedirectChain(target,method,{
    resolveDestination:resolver,request:requestHeaders,now:()=>new Date()
  },chainOptions)
},options)};
```

The exported factory is `createLocalNodeVerificationTransport`; imports `createSafeDestinationResolver`, `requestHeaders`, `executeRedirectChain`, `verifyUrl` point to the existing corresponding `lib/verifiers/official-links` modules. No production unsafe fixture override is exported. Close sockets on authenticated request disconnect and budget expiry. Fixed path/method, auth before target work, bounded body, one request, fixed safe 401/400/413/503 errors; after successful auth every response/error uses signed envelope. Reject request-supplied target method, headers, body, DNS/IP/TLS overrides and path/query variants.
- [ ] Conformance fixture module exports `VERIFIER_CONFORMANCE_VECTORS:readonly {name:string;exactUrl:string;expectedCode:VerificationCode}[]`; tests reuse existing dependency-injected target fixtures, not public-network availability. Cover every §32 vector: HTTP codes, redirects/missing/malformed/duplicate Location, fallback original URL and shared budget, GET body zero, default port, downgrade, IP/ranges/mapped normalization/mixed DNS/rebinding, peer and Host/SNI/certificate, DNS/TLS/timeouts, loop/overflow. Compare local and authenticated HTTP remote outputs, normalizing only time/controlled addresses. Separate real Node socket tests from injected behavior tests.
- [ ] GREEN: `npx vitest run containers/official-link-verifier lib/verifiers/official-links/remote`; PASS. Build `docker build -f containers/official-link-verifier/Dockerfile -t gamehub-verifier:v2.8-local .`; start only the local image with dev secret and run conformance; unsupported Docker is BLOCKED for this tier. Actual Cloudflare preview peer/lookup/SNI probe remains a deployment prerequisite, not a mock PASS. If current Node APIs cannot run securely in actual Container, STOP.
- [ ] Refactor and run `npx vitest run containers/official-link-verifier lib/verifiers/official-links`, `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0. Scan Container dependency tree: no D1/R2/Twitch/Image token/scheduler authority imports or environment values.
- [ ] Commit: `git add containers/official-link-verifier lib/verifiers/official-links/remote/conformance-vectors.ts` then `git commit -m "feat: package private Node official-link verifier"`.
- [ ] Independent review: Node API/capability evidence, private verifier-specific surface, secret isolation, protocol conformance and no proxy fallback.

## Task 10: Fenced official-link apply and remote failure semantics

**Files:** Modify `lib/db/repositories/link-verification.ts`; Create `lib/db/repositories/link-verification-queries.ts`, `lib/db/repositories/scheduled/links.ts`; Test `lib/scheduler/links.integration.test.ts`.

**Interfaces:** Produce `buildLinkVerificationQueries(db:GameHubDatabase,plan:GameLinkVerificationPlan,guard?:SQL):Array<BuiltDomainQuery & {linkId:number}>`, `createScheduledLinkStore(input:{binding:D1Database;db:GameHubDatabase;authority:ScheduledMutationAuthority;signals:CronSignals}):LinkVerificationStore`. Consume existing `createLinkVerificationService`, remote `verify`, shared classifier/planner and native result types.

- [ ] Write delivery failure and stale response tests:

```ts
it("never writes observed links when a later RPC fails", async () => {
  const writePlan=vi.fn();
  const snapshots:LinkVerificationSnapshot[]=[1,2].map(id=>({id,gameId:9,url:`https://example.com/${id}`,
    updatedAt:new Date(0),verificationStatus:"unverified",verificationMethod:null,httpStatus:null,
    redirectUrl:null,verifiedAt:null,lastCheckedAt:null}));
  const verify=vi.fn().mockResolvedValueOnce({code:"invalid_url",attempts:[],redirectChain:[],finalUrl:null,httpStatus:null,checkedAt:new Date(0)})
    .mockRejectedValueOnce(new VerifierServiceError("verifier_service_unavailable"));
  const service=createLinkVerificationService({store:{readGameLinks:async()=>({gameExists:true,links:snapshots}),writePlan},verifyUrl:verify});
  await expect(service.verifyGame(9,{dryRun:false})).rejects.toMatchObject({code:"verifier_service_unavailable"});
  expect(writePlan).not.toHaveBeenCalled();
});
```

`VerifierServiceError` is the branded class produced in T8 `remote/errors.ts`; its constructor takes only `VerifierServiceErrorCode` and derives a fixed message.

- [ ] RED: `npx vitest run lib/scheduler/links.integration.test.ts`; scheduled repository missing; stale real-D1 case must fail before guard implementation.
- [ ] Extract query construction while preserving all actual snapshot fields and manual exclusion. Execute every planned update in one fenced batch, map changes1 to applied ID, changes0 to native conflict, invalid count to native write_failed. Empty/manual-only/no-change plan still validates authority. Catch branded fence first, latch before translating to `LinkVerificationError('write_failed',fixedText)`. Service uses `verifyUrl:transport.verify.bind(transport)` and shared classification/planner; any RPC throw prevents all writes for that game without persisting a service failure as website state.
- [ ] Real D1 test pauses Container response, expires A/acquires B, then delivers valid terminal; expect unchanged exact metadata and fence_lost latch. Cover manual edits during verify, full snapshot conflicts, partially_applied with valid authority, http404 domain-broken/stage-success, target unsafe/network outcomes preserving V2.7 semantics, and unknown service errors fail safe.
- [ ] GREEN: `npx vitest run lib/scheduler/links.integration.test.ts`; all PASS. Refactor then `npx vitest run lib/scheduler/links.integration.test.ts lib/db/repositories/link-verification.test.ts lib/verifiers/official-links/service.test.ts lib/sync/link-stage.test.ts`, `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0.
- [ ] Commit: `git add lib/db/repositories/link-verification.ts lib/db/repositories/link-verification-queries.ts lib/db/repositories/scheduled/links.ts lib/scheduler/links.integration.test.ts` then `git commit -m "feat: fence official-link publication after remote verification"`.
- [ ] Independent review: L1/L2 complete, remote failure never persisted, manual/conflict/partial semantics unchanged, late authority rejected.

## Task 11: Mandatory scheduled Image route, shared client and fenced publication

**Files:** Modify `scripts/sync-image-client.ts`, `lib/db/repositories/image-ingest.ts`, `lib/images/types.ts`, `lib/images/service.ts`, `workers/image-ingest/src/index.ts`; Create `lib/images/worker-client.ts`, `lib/images/scheduled-codec.ts`, `lib/images/scheduled-client.ts`, `lib/db/repositories/image-ingest-queries.ts`, `lib/db/repositories/scheduled/images.ts`, `workers/image-ingest/src/scheduled.ts`; Test `lib/images/scheduled-client.test.ts`, `lib/scheduler/images.integration.test.ts`, `workers/image-ingest/src/scheduled.test.ts`.

**Interfaces:** Extract existing `createImageWorkerClient` and `parseImageWorkerResponse` unchanged into shared `worker-client.ts`, preserving script re-exports. Produce exact Spec `ScheduledImageRequest/Response`, `parseScheduledImageRequest(bytes:Uint8Array):ScheduledImageRequest`, `parseScheduledImageResponse(bytes:Uint8Array,request:ScheduledImageRequest):ScheduledImageResponse`; `createScheduledImageClient(input:{binding:{fetch(request:Request):Promise<Response>};token:string;authority:ScheduledMutationAuthority;signals:CronSignals;newRequestId:()=>string}):ImageWorkerClient`. Produce `createScheduledImageRepository(input:{binding:D1Database;db:GameHubDatabase;authority:ScheduledMutationAuthority;signals:CronSignals}):ImageIngestRepository`. Query builders: `buildImageBindQuery(db,snapshot:Parameters<ImageIngestRepository['optimisticBindImage']>[0],binding:ImageBinding,guard?:SQL):BuiltDomainQuery`, `buildImageCreateQuery(db,input:Parameters<ImageIngestRepository['conditionallyCreateImage']>[0],guard?:SQL):BuiltDomainQuery` (db is `GameHubDatabase`). Add optional service callback `beforeImage?:()=>void` to `ImageIngestDependencies`; scheduled caller sets it to refuse known-lost authority; legacy behavior unchanged.

```ts
export type ScheduledImageRequest={version:1;mode:"scheduled";requestId:string;gameId:number;write:true;authority:ScheduledMutationAuthority};
export type ScheduledImageResponse={version:1;requestId:string;authorityStatus:"not_observed_lost"|"fence_lost";result:ImageResult};
```

- [ ] Write route trust-separation tests:

```ts
it("rejects scheduled credentials on legacy route before dependencies run", async () => {
  const request=new Request("https://image.internal/internal/images/ingest",{method:"POST",
    headers:{authorization:"Bearer scheduled-secret","content-type":"application/json"},body:JSON.stringify({gameId:1,write:true})});
  const serviceFactory=vi.fn();
  const env={DB:{},IMAGES_BUCKET:{},IMAGE_PUBLIC_BASE_URL:"https://images.example.test",IMAGE_INGEST_TOKEN:"legacy-secret",IMAGE_INGEST_SCHEDULED_TOKEN:"scheduled-secret"} as unknown as WorkerEnv;
  const context={waitUntil:vi.fn(),passThroughOnException:vi.fn()} as unknown as ExecutionContext;
  const response=await handleImageIngest(request,env,context,{serviceFactory});
  expect(response.status).toBe(401);expect(serviceFactory).not.toHaveBeenCalled();
});
```

This uses the actual `handleImageIngest` injection surface in `workers/image-ingest/src/index.ts`; `WorkerEnv` gains the scheduled token only. The scheduled handler exports `handleScheduledImageIngest(request:Request,env:WorkerEnv,context:ExecutionContext,dependencies?:ImageIngestWorkerDependencies):Promise<Response>` and uses the same narrow service factory test seam; production constructs fenced dependencies unconditionally. Add opposite route/token, equal configured tokens, missing nested authority, unknown fields/version, caller expiry fraud, legacy body with scheduled fields and scheduled body with write=false.

- [ ] RED: `npx vitest run workers/image-ingest/src/scheduled.test.ts lib/images/scheduled-client.test.ts lib/scheduler/images.integration.test.ts`; absent scheduled route must fail required behavior.
- [ ] Implement private fixed POST `/internal/v1/images/ingest-scheduled`; strict required version1/mode scheduled/write true/request UUID/positive gameId/frozen authority. Reuse legacy method/content-type/body bounds (scheduled request cap16KiB, response cap1MiB), independent constant-time route token validation, equal tokens configuration fail closed. Auth rejection occurs before D1/source/R2. Scheduled service always uses required-authority repository, request-local loss latch and envelope; no fallback.
- [ ] Shared image query extraction retains complete binding/full image snapshot/game updatedAt/identity predicates. Scheduled update and insert execute T4 batch; zero changes retain native race/conflict outcomes only under valid authority. Fence rejection latches before producing native `d1_write_failed`; before each further image refuse known-lost request. Envelope `authorityStatus` reports latch; no owner/token/epoch echo in result.
- [ ] Client signs no verifier HMAC: use distinct Bearer token through fixed service binding, required authority body, no redirects/retry,310000ms envelope and byte cap. Before returning native result, inspect **all** items and nested errors. game_deadline/deadline/image_deadline → image_deadline latch; storage_failed/d1_write_failed → image_mutation_unknown; any failure after dispatch → image_delivery_unknown; envelope fence_lost → loss latch. Preserve first native stage error and never clear latches on late settlement.
- [ ] Test paused actual D1 bind and create after R2-first, then native image deadline result through parsed scheduled response; no duplicate completion or cleared signal. Test earlier source_rejected masks later deadline in both orders, exact nonempty counts, nested errors/attempts, invalid/oversized HTTP response and missing envelope. Test old SQL eventually resumes after B acquisition and rejects even though response already completed.
- [ ] GREEN: `npx vitest run workers/image-ingest/src/scheduled.test.ts lib/images/scheduled-client.test.ts lib/scheduler/images.integration.test.ts`; all PASS. Refactor then `npx vitest run lib/images workers/image-ingest/src scripts/sync-image-client.test.ts lib/sync/image-stage.test.ts lib/db/repositories/image-ingest.test.ts lib/scheduler/images.integration.test.ts`, `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0.
- [ ] Commit: `git add scripts/sync-image-client.ts lib/db/repositories/image-ingest.ts lib/db/repositories/image-ingest-queries.ts lib/db/repositories/scheduled/images.ts lib/images/types.ts lib/images/service.ts lib/images/worker-client.ts lib/images/scheduled-codec.ts lib/images/scheduled-client.ts lib/images/scheduled-client.test.ts lib/scheduler/images.integration.test.ts workers/image-ingest/src/index.ts workers/image-ingest/src/scheduled.ts workers/image-ingest/src/scheduled.test.ts` then `git commit -m "feat: require scheduled Image authority and fence publication"`.
- [ ] Independent review: mandatory path, auth separation, unchanged native DTOs/local CLI, both M1/M2, late SQL and full-result signals.

## Task 12: Scheduled R2 key integrity and stale artifact proof

**Files:** Create `lib/images/scheduled-r2-store.ts`, `lib/images/scheduled-r2-store.test.ts`; Modify `workers/image-ingest/src/scheduled.ts`; Test `lib/scheduler/r2-fencing.integration.test.ts`.

**Interfaces:** Consume `R2ImageStore`, `buildImageStorageKey`, existing `ImageMimeType`; produce `createScheduledR2ImageStore(store:R2ImageStore):R2ImageStore`. Only scheduled Image composition receives it. The wrapper must validate hash/MIME and canonical key before delegate `ensureObject` (therefore before its HEAD/PUT); read-only HEAD may inspect a legacy key but cannot restore it.

- [ ] Write alias rejection test:

```ts
it("cannot repair a mutable stored alias", async () => {
  const head=vi.fn(),ensureObject=vi.fn();
  const store=createScheduledR2ImageStore({head,ensureObject});
  const result=await store.ensureObject({key:"covers/current.png",bytes:new Uint8Array([1]),hash:"a".repeat(64),mimeType:"image/png",size:1});
  expect(result.outcome).toBe("storage_conflict");
  expect(head).not.toHaveBeenCalled();expect(ensureObject).not.toHaveBeenCalled();
});
```

- [ ] RED: `npx vitest run lib/images/scheduled-r2-store.test.ts lib/scheduler/r2-fencing.integration.test.ts`; missing wrapper, alias restore negative control reaches PUT.
- [ ] Implement exact guard and delegate unchanged conditional storage:

```ts
const expected=buildImageStorageKey(input.hash,input.mimeType as ImageMimeType);
if(input.key!==expected) return {outcome:"storage_conflict",storageKey:input.key,storageUrl:""};
return store.ensureObject(input,context);
```

Validate supported MIME before the cast; invalid hash/MIME returns conflict without side effects. The empty storageUrl is never published on conflict. Do not change native R2 equality/checksum/cache metadata logic. `ensureObject` continues onlyIf etagDoesNotMatch `*`, supplied SHA256, no delete API, no mutation of existing object metadata.
- [ ] Real local R2+D1 harness: A epochN dispatches conditional PUT and pauses before completion; expire A, B acquires N+1 and publishes another valid current reference; resume A. Observe actual R2 PUT completion then rejected fenced D1 bind/create; B reference and current object bytes/metadata unchanged. A artifact may exist unreferenced. Cover identical concurrent winner, conflicting metadata/hash/MIME/size, checksum rejection, missing canonical-key repair with exact recorded content, alias key and key-hash mismatch fail before PUT. Spy actual service adapters with ordered events `r2.put.completed` then `d1.bind.attempted`/`d1.create.attempted`; count alone is insufficient. Assert no DELETE and nonempty concrete repeat outcomes.
- [ ] GREEN: `npx vitest run lib/images/scheduled-r2-store.test.ts lib/scheduler/r2-fencing.integration.test.ts`; all PASS with conditional local R2 behavior. Refactor then run these plus `lib/images/r2-store.test.ts lib/images/service.test.ts lib/images/storage-key.test.ts`; `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0. Actual platform checksum/conditional behavior is also preview deployment evidence; inability to maintain immutability is STOP.
- [ ] Commit: `git add lib/images/scheduled-r2-store.ts lib/images/scheduled-r2-store.test.ts workers/image-ingest/src/scheduled.ts lib/scheduler/r2-fencing.integration.test.ts` then `git commit -m "feat: enforce immutable scheduled image artifact keys"`.
- [ ] Independent review: R2 artifact versus authoritative D1, late old PUT, restoration, no stale overwrite/delete/reference corruption.

## Task 13: Deadline-aware serial scheduler and failure/finally matrix

**Files:** Create `lib/scheduler/service.ts`, `lib/scheduler/result.ts`; Test `lib/scheduler/service.test.ts`, `lib/scheduler/result.test.ts`. Modify: none.

**Interfaces:** Produce `runCronSync(input:CronExecutionInput,deps:CronSyncDependencies):Promise<CronExecutionResult>` and `assertCronResult(result:CronExecutionResult,batchSize:number):void`:

```ts
export type CronSyncDependencies={
 config:CronSyncConfig;lease:LeaseRepository;candidates:CandidateRepository;state:SchedulerStateRepository;
 gameExists(gameId:number):Promise<boolean>;
 createGameRuntime(candidate:SyncCandidate,authority:ScheduledMutationAuthority,signals:CronSignals):CronGameRuntime;
 runBatch:typeof runBulkSyncBatch;elapsedMs:()=>number;newOwnerToken:()=>string;
};
```

`elapsedMs` returns monotonic elapsed since invocation start; all D1 validity uses repository DB time. Scheduler owns one invocation signal set plus candidate closure latches; merge in finally after every singleton settles/throws. Authority-aware stage wrappers are composed in T14 but scheduler checks before candidate itself.

- [ ] Write a no-soft-cancel test using real V2.7 singleton runner:

```ts
it("finishes an admitted game but leaves the next candidate unstarted", async () => {
  let elapsed=0;const calls:string[]=[];
  const stages:BulkSyncStages={steam:{execute:async(appId)=>{calls.push(`steam:${appId}`);elapsed=800000;return {gameId:1,action:"existing",summary:"existing"};}},
    igdb:{execute:async()=>({summary:"existing"})},links:{execute:async()=>({summary:"verified"})},images:{execute:async()=>({summary:"ingested"})}};
  const result=await runCronSync({executionId:crypto.randomUUID(),scheduledAt:new Date(0)},makeSchedulerDependencies({stages,elapsedMs:()=>elapsed}));
  expect(result).toMatchObject({status:"partial",attempted:1,notStarted:1,stopReason:"soft_deadline",leaseDisposition:"released"});
  expect(result.games[0]!.stages).toHaveLength(4);expect(calls).toEqual(["steam:10"]);
});
```

Define the test-local dependency builder explicitly:

```ts
function makeSchedulerDependencies(input:{stages:BulkSyncStages;elapsedMs:()=>number}):CronSyncDependencies {
  const authority={ownerToken:"11111111-1111-4111-8111-111111111111",fenceEpoch:1,leaseExpiresAtMs:1500000};
  return {config:parseCronSyncConfig({}),elapsedMs:input.elapsedMs,newOwnerToken:()=>authority.ownerToken,
    lease:{acquire:async()=>({status:"acquired",lease:authority}),
      assertOwned:async()=>({dbNowMs:input.elapsedMs(),leaseExpiresAtMs:1500000}),release:async()=>"released"},
    candidates:{select:async()=>[{gameId:1,appId:"10"},{gameId:2,appId:"20"}],stillMatches:async()=>true},
    state:{startAttempt:async(gameId,issued)=>({gameId,attemptedAt:new Date(0),authority:issued}),finishAttempt:vi.fn(async()=>undefined)},
    gameExists:async()=>true,runBatch:runBulkSyncBatch,
    createGameRuntime:(_candidate,_authority,signals)=>({stages:input.stages,
      readAuthorityLoss:signals.readAuthorityLoss,readUnsettledImageWork:signals.readUnsettledImageWork})};
}
```

These are injected policy tests; real SQL interleavings remain T15.

- [ ] RED: `npx vitest run lib/scheduler/service.test.ts lib/scheduler/result.test.ts`; missing service/result assertions.
- [ ] Implement ordered phases: validate config/composition → acquire → fixed candidate slice → before-candidate assertOwned/admission → stillMatches → start stamp → singleton batch → validate full result/identity → finish stamp → next candidate. Admission requires elapsed <soft and wall remaining≥game+finish and DB-issued lease remaining≥game+finish. No whole-game Promise.race/AbortController. A changed mapping produces complete Steam write_conflict/later not_run result without providers; if game exists stamp+finish failed, if absent omit metadata; deletion racing stamp is infrastructure failure.
- [ ] Preserve result counts: attempted=games.length plus at most one started invalid singleton, succeeded+failed=games.length, notStarted=selected-attempted. Empty catalog completed; active lease skipped allzero; ordinary failures partial and continue; infrastructure errors failed and stop. First fatal primary retained; later authority/release error secondary. Any loss sets authority_lost stop and no_longer_owned disposition. Uncertainty alone partial/unsettled_remote_work and retained_until_expiry; it cannot clear in cleanup. No loss/uncertainty → owner-conditional release; release failure primary only if no earlier primary.
- [ ] Test every Spec §22 row: invalid config/acquire/held/query/start/finish/pipeline errors, successful and failed game rotation, deleted mapping/game, malformed singleton without fabricated result, uncertain Image masked by earlier failure, all finally paths, log failure ownership (T14), release error/expired release, latches read even when result validation throws, no later stage/candidate after loss, no metadata finish on loss. Preserve already legal results and writes; never roll back stages.
- [ ] GREEN: `npx vitest run lib/scheduler/service.test.ts lib/scheduler/result.test.ts`; all PASS. Refactor then `npx vitest run lib/scheduler/service.test.ts lib/scheduler/result.test.ts lib/sync/batch.test.ts lib/sync/game-pipeline.test.ts`, `npm run typecheck`, `npm run lint`, `git diff --check`; exit 0.
- [ ] Commit: `git add lib/scheduler/service.ts lib/scheduler/result.ts lib/scheduler/service.test.ts lib/scheduler/result.test.ts` then `git commit -m "feat: orchestrate fenced serial Cron game admission"`.
- [ ] Independent review: complete singleton boundary, result/count/precedence matrix, stage loss signals, no soft cancellation and no lease release under uncertainty.

## Task 14: Private Cloudflare Cron composition, Container facade and safe operations

**Files:** Create `workers/cron-sync/src/index.ts`, `composition.ts`, `config.ts`, `verifier-container.ts`, `logging.ts`, `workers/cron-sync/wrangler.jsonc`, `workers/cron-sync/.dev.vars.example`, `workers/cron-sync/tsconfig.json`; Test `workers/cron-sync/src/composition.test.ts`, `index.test.ts`, `logging.test.ts`; Modify `package.json`, `package-lock.json`, `workers/image-ingest/wrangler.jsonc`, `README.md`.

**Interfaces:** `CronWorkerEnv` has DB, Image service binding, Container namespace, Twitch ID/secret, verifier secret and scheduled Image token only; no R2 binding/legacy Image credential. Produce `composeCronDependencies(env:CronWorkerEnv,input:CronExecutionInput):CronSyncDependencies`, `parseCronWorkerEnvironment(env:unknown):CronWorkerConfig` where config contains Spec CronSyncConfig+validated fixed bindings/secrets, and `emitCronEvent(event:SafeCronEvent,sink:(line:string)=>void):void`. `SafeCronEvent` strict union of approved event names/allowlisted scalar fields only; never whole game result, URL or owner authority. `index.ts` default export, imported as `cronWorker` in its test, exposes `fetch(request:Request):Promise<Response>` and `scheduled(controller:ScheduledController,env:CronWorkerEnv,context:ExecutionContext):Promise<void>`.

```ts
export type CronWorkerEnv={DB:D1Database;IMAGE_INGEST:Fetcher;VERIFIER_CONTAINER:DurableObjectNamespace;
  TWITCH_CLIENT_ID:string;TWITCH_CLIENT_SECRET:string;VERIFIER_SERVICE_SECRET:string;IMAGE_INGEST_SCHEDULED_TOKEN:string;
  CRON_BATCH_SIZE?:string;CRON_SOFT_DEADLINE_MS?:string;CRON_GAME_RESERVE_MS?:string;CRON_FINISH_RESERVE_MS?:string;CRON_LEASE_MS?:string};
export type CronWorkerConfig={sync:CronSyncConfig;clientId:string;clientSecret:string;verifierSecret:string;scheduledImageToken:string};
export type SafeCronEvent={event:"cron_started"|"lease_acquired"|"lease_skipped"|"candidates_selected"|"game_finished"|"deadline_stop"|"authority_lost"|"verifier_unavailable"|"cron_finished";
  executionId:string;timestamp:number;gameId?:number;appId?:string;fenceEpoch?:number;
  stage?:"steam"|"igdb"|"links"|"images";code?:CronFailureCode|StageFailureCode;
  status?:"completed"|"partial"|"skipped"|"failed"|"succeeded";elapsedMs?:number;
  selected?:number;attempted?:number;succeeded?:number;failed?:number;notStarted?:number;
  leaseDisposition?:CronExecutionResult["leaseDisposition"]};
```

All bindings are structurally validated, strings parsed strictly and secrets never serialized. `SafeCronEvent` runtime parsing rejects extra keys and validates scalar enum/range/length; the union controls permitted fields per event. Bound `cron_finished` contains only final counts/status/disposition, not the internal game results.

- [ ] Write public-ingress and composition guard tests:

```ts
it("has no manual synchronization route", async () => {
  const response=await cronWorker.fetch(new Request("https://scheduler.invalid/sync"));
  expect(response.status).toBe(404);
});
it("swallows log sink failure without issuing work twice", () => {
  const sink=vi.fn(()=>{throw new Error("sink failed");});
  expect(()=>emitCronEvent({event:"cron_started",executionId:"run",timestamp:0},sink)).not.toThrow();
  expect(sink).toHaveBeenCalledTimes(1);
});
```

- [ ] RED: `npx vitest run workers/cron-sync/src`; missing Worker/composition.
- [ ] Compose real existing clients/auth cache and scheduled stores. Per candidate copy authority; wrap each stage with loss/unsettled check + primary `assertOwned` before native execute, plus post-stage `assertFence` for plans with no business writes; brand/latch loss before native error mapping. This postcheck does not authorize any mutation. Reuse singleton runner; no CLI imports. Container facade implements T8 `PrivateVerifierBinding.start/fetch` using supported official `Container` lifecycle with fixed instance `official-links-v1`, port8080, sleepAfter5m, concurrency1 and start timeout10s. Only facade may start Container; T8 client measures startup and signs only the remaining budget; total cold-start+request remains existing link20s and game300s. Facade receives secret via environment only and injects only that secret into Container, never authority.
- [ ] Pin supported `@cloudflare/containers` exact version after checking official package API; document version and digest evidence. No existing dependency version is changed intentionally. Add scheduler-only package scripts `cron:typecheck` (tsc for Worker config) and `cron:bundle` (Wrangler dry-run to temp output); Container build uses supported Node built-ins/shared code. Configure `workers_dev:false`, `preview_urls:false`, empty routes, production schedule disabled until rollout, paid CPU tier validation and control-plane Container DO registration only. Daily UTC expression belongs in deployment config, never domain branching. Local bindings explicit/isolated; production placeholder D1 IDs fail configuration/deployment readiness.
- [ ] Document deployment sequence: Cron disabled; apply additive migration once; scheduled Image route/tokens; scheduler+Container matching version; auth/socket/shared-D1/fencing probes; separately authorized batch1 canary and idempotency; enable daily schedule only after real budget evidence. Rollback disables triggers first, keeps fenced Image and epoch table, no reset/delete/down-migration, preserves old-operation protection. Disaster restore of lower epoch requires revoking old callers/credentials first. No automatic deploy command in tests.
- [ ] GREEN: `npx vitest run workers/cron-sync/src`; all PASS. Refactor then `npm run typecheck`, `npm run cron:typecheck`, `npm run lint`, `git diff --check`, `npm run cron:bundle`; exit0. Inspect bundle metafile for no `node:dns`, `node:http`, `node:https`, `node:net`, `child_process`, local Wrangler acquisition, scripts/sync composition or R2 writer. Container registration DO must have no candidate/lease/scheduler state. Byte/secret/log safety tests inject ownerToken and credential canaries into all error paths and assert absent from output.
- [ ] Commit: `git add workers/cron-sync package.json package-lock.json workers/image-ingest/wrangler.jsonc README.md` then `git commit -m "feat: compose private Cloudflare Cron sync Worker"`.
- [ ] Independent review: production stores cannot bypass fence, schedule/Container capabilities, auth/secret isolation, worker bundle and rollout/rollback invariants.

## Task 15: Full local integration, security and release evidence

**Files:** Create `lib/scheduler/test-support/cron-harness.ts`, `lib/scheduler/cron.integration.test.ts`, `lib/scheduler/security.test.ts`, `lib/scheduler/deployment.test.ts`, `docs/superpowers/reports/2026-09-15-gamehub-v2-8-final-verification.md`; Modify `README.md` only for verified local commands/evidence. If generated files pollute lint, fix harness temp/config ownership in this task; never silently exclude source files.

**Interfaces:** Test-only `startCronHarness(options?:{failAfter?:"d1"|"verifier"|"image"}):Promise<CronHarness>` where:

```ts
export type CronHarness={
 binding:D1Database;run(input?:Partial<CronExecutionInput>):Promise<CronExecutionResult>;
 events:Array<{kind:"steam"|"igdb"|"links"|"images"|"r2.put.completed"|"d1.bind.attempted"|"d1.create.attempted";gameId:number}>;
 pause(point:"steam_response"|"igdb_response"|"verifier_response"|"r2_put"|"d1_bind"|"d1_create"): {reached:Promise<void>;resume():void};
 dispose():Promise<void>;
};
```

Harness uses T2 real local D1, real stores/scheduler/singleton pipeline, controlled provider HTTP responses, real authenticated Node service, authenticated scheduled Image HTTP handler and local R2. Test-only provider/socket seams remain outside production composition. Start D1, then verifier, then Image resources with acquisition ledger and reverse exactly-once disposal; inject failure only after the named resource was obtained. Shared persistence root explicit; prove both Workers see the same seeded row. Track actual R2 completion/D1 dispatch ordering, not inferred PUT count.

- [ ] Write full-pipeline integration test:

```ts
it("runs the real four-stage pipeline and publishes only after R2", async () => {
  const h=await startCronHarness();
  try {
    const first=await h.run();
    expect(first.status).toBe("completed");expect(first.games).toHaveLength(1);
    expect(h.events.filter(e=>["steam","igdb","links","images"].includes(e.kind)).map(e=>e.kind)).toEqual(["steam","igdb","links","images"]);
    const put=h.events.findIndex(e=>e.kind==="r2.put.completed");
    const bind=h.events.findIndex(e=>e.kind==="d1.bind.attempted"||e.kind==="d1.create.attempted");
    expect(put).toBeGreaterThanOrEqual(0);expect(bind).toBeGreaterThan(put);
    const second=await h.run();expect(second.games).toHaveLength(1);
    expect(second.games[0]!.stages).toHaveLength(4);
  }finally{await h.dispose();}
});
```

- [ ] RED: `npx vitest run lib/scheduler/cron.integration.test.ts lib/scheduler/security.test.ts lib/scheduler/deployment.test.ts`; missing harness must fail. Baseline fixture is an existing Steam-backed game with an unbound image, not an already-ingested fixture; assert actual download/validation/hash/HEAD/PUT. Add separate already_ingested HEAD-only test.
- [ ] Implement harness and concrete assertions: canonical/image row counts unchanged on repeat; nonempty exact image outcomes captured from actual scheduled responses; first ordinary failed game then healthy success; overlap one lease winner; stale expiry/higherepoch; state started after crash; soft cutoff; metadata/release failure; Container unavailable/malformed/invalid MAC/cold restart; auth before target/R2/D1; partial startup acquired-resource cleanup; `.wrangler/tmp` absent from repository and lint reproducible after integration.
- [ ] Pause actual Steam/IGDB/Container responses independently, let B acquire, resume A; each stale real SQL fails, latches survive first-error wrappers, later stages/candidates/finish stamp/release cannot touch B. For crash, discard all A signals but keep pending mutation alive past expiry; B proceeds, late A rejected; no cancellation used to manufacture safety. Pending immutable R2 may finish without stale publication. Tests cover expired owner without B and both SQL linearization orders.
- [ ] Native Image uncertainty matrix uses real image service deadline and unresolved bind/create/PUT seams: entire parsed result enters client, both item orders and nested errors examined, no next admission/release, no duplicate completion/unhandled rejection. Validate recorded game failure status is attempt outcome, not settlement proof.
- [ ] Security assertions: no ownerToken/secret/signature/raw URL/provider body/stack in structured output; `[INVALID_URL]` sanitizer; strict duplicate-key/schema/version/size/MAC/path/method; no public endpoint/generic proxy; Container dependency/env isolation; generated SQL inventory S1–M2 all fenced; guarded UPSERT/identity assertion; no mutable R2 key/delete or unfenced production repo. Deployment tests validate required shared DB identity and distinct credentials, disabled public routes, schedule budget/Container package/image pin and absence of fallback.
- [ ] GREEN: `npx vitest run lib/scheduler/cron.integration.test.ts lib/scheduler/security.test.ts lib/scheduler/deployment.test.ts`; all PASS. Refactor then run `npx vitest run lib/scheduler containers/official-link-verifier workers/cron-sync/src workers/image-ingest/src lib/verifiers/official-links/remote lib/images/scheduled-client.test.ts lib/images/scheduled-r2-store.test.ts`; PASS.
- [ ] Fresh release verification: `npm test`, `npm run typecheck`, `npm run cron:typecheck`, `npm run lint`, `npm run build`, `npm run cron:bundle`, `git diff --check`, `npm audit --omit=dev`, `npm audit`. Record actual exit codes/counts and environment blocks; no inherited V2.7 PASS. Production audit zero required; pre-existing dev advisories classified with lock-diff evidence, never audit fix. Record `shasum lib/db/schema.ts`, five SQL migrations, old migration diff zero, populated migration/FK/index verification and clean worktree. Dependency diff permits only pinned official Container platform package and necessary transitive closure; unexplained updates fail review.
- [ ] Actual Cloudflare preview deployment remains separate authorized tier: verify private ingress/service bindings, same real D1 identity, transactional guard/rollback, conditional R2/checksum, cold-start budget, Node lookup/normalized peer/Host/SNI/TLS conformance and CPU/wall limits. If unavailable, record DEPLOYMENT_VERIFICATION_BLOCKED; never claim deployed capability PASS from local mocks. A disproved security/correctness invariant is STOP.
- [ ] Commit: `git add lib/scheduler/test-support/cron-harness.ts lib/scheduler/cron.integration.test.ts lib/scheduler/security.test.ts lib/scheduler/deployment.test.ts docs/superpowers/reports/2026-09-15-gamehub-v2-8-final-verification.md README.md` then `git commit -m "test: verify Cron fencing and complete sync integration"`.
- [ ] Independent Task15 review, then independent whole-branch review `36f5bc17494111e65c1d3fcb93d111f631b8cd0c..HEAD`; resolve findings through one scoped final fix agent with RED regression, commit and re-review. Fresh verification after final fixes; environmental blocked gates stay blocked. No push/PR/merge/deployment without separate authorization.

## Spec coverage and implementation acceptance map

| Spec section | Owning tasks | Required evidence |
|---|---|---|
| 1 Context | T13,T14 | Existing canonical four-stage singleton |
| 2 Existing architecture | T6–T11,T13 | Native interfaces/local regression, complete batch |
| 3 Worker blocker | T8,T9,T14,T15 | No Node transport in Cron; actual Container probes |
| 4 ADR | T3,T4,T9,T14 | D1 fencing + Container plumbing only |
| 5 Goals | T5,T13,T15 | Fair serial production refresh |
| 6 Non-goals | T14,T15 | No creation/manual endpoint/job platform |
| 7 Topology | T9,T11,T14,T15 | Private bindings/shared D1/no R2 in Cron |
| 8 Scheduler Worker | T1,T14 | Strict config/scheduled-only/validated budget |
| 9 Candidates | T5,T13 | Full eligibility before LIMIT/recheck |
| 10 Scheduler state | T2,T5,T13 | Start-before-game/DB timestamp/finish CAS |
| 11.1 Durable time/state | T1–T4 | Exact schema/DB time/safe integer |
| 11.2 Acquisition/release/no renew | T3,T15 | One winner/high-water/no resurrection/crash |
| 11.3 Atomic mutation | T4,T6,T7,T10,T11,T15 | Real D1 assertion rollback and all statements |
| 11.4 Inventory | T4–T7,T10–T12,T15 | Every inventory row accounted |
| 12 Soft deadline | T1,T13,T14 | Complete admitted game/no soft cancel |
| 13 V2.7 reuse | T6–T14 | Singleton complete result and independent latches |
| 14 Steam | T6,T15 | Existing-only/all three update kinds/late fetch |
| 15 IGDB | T7,T14,T15 | All inserts/identity assertions/fill-empty |
| 16 Transport | T8,T10 | Shared TerminalOutcome/branded service failures |
| 17 Node Container | T9,T14,T15 | Node socket security/concurrency/startup/idle |
| 18 Contract | T8,T9 | Bounded strict exact wire/layout/error vectors |
| 19 Authentication | T8,T9,T14 | Request+response MAC/private ingress |
| 20 Link apply | T10,T15 | Shared policy/manual/full CAS/late response |
| 21.1 Image route | T11,T14 | Mandatory authority/caller separation |
| 21.2 Image publication/R2 | T11,T12,T15 | Both D1 methods/key guard/immutable artifacts |
| 21.3 Unsettled image | T11,T13,T15 | Full-result scan/monotonic/finally/crash |
| 22 Failure semantics | T8,T13,T14,T15 | Exhaustive matrix and precedence |
| 23 Cron result | T1,T13 | Complete results/counts/errors/disposition |
| 24 Idempotency | T5,T6,T7,T10–T13,T15 | Finite rotation/repeat/no duplicates |
| 25 Schema | T2 | Exactly two additive tables |
| 26 Migration | T2,T15 | 4→5/legacy preservation/new hash/high-water |
| 27 Security | T8–T12,T14,T15 | Threat/conformance/auth/log/fence coverage |
| 28 Secrets | T8,T9,T11,T14 | Distinct runtime-only secrets/no authority leak |
| 29 Observability | T14,T15 | Safe bounded event fields/log failure swallowed |
| 30 Local development | T2,T9,T15 | Isolated shared state/real partial cleanup |
| 31 Tests | T1–T15 | Unit + real SQL + HTTP integration |
| 32 Conformance | T8,T9,T15 | Same vectors/local+remote/preview socket proof |
| 33 Deployment | T14,T15 | Disabled schedule/readiness/inventory/package |
| 34 Rollout | T14,T15 | Separate authorized batch1 canary/idempotence |
| 35 Rollback | T14,T15 | Trigger disable/fenced Image/high-water retained |
| 36 Operations | T1,T9,T14,T15 | Budget/startup/socket/platform evidence |
| 37 V2.9 compatibility | T2,T14 | Additive small state; no speculative fields |
| 38 Scope/gate | All | Stop on unguardable mutation; no scope expansion |

## Plan self-review and independent review package

Self-review before handoff must verify:

- [ ] Every Spec row above has concrete owning files, test behavior and acceptance evidence.
- [ ] Search this Plan for unresolved drafting markers and vague instructions; each finding is removed before independent review. Search terms include `TODO`, `TBD`, `implement as needed`, `handle errors`, `similar to Task`, and `placeholder` (the scan instruction itself is documentation, not an unresolved implementation instruction).
- [ ] Type/interface consistency: every function in task code is either declared under Interfaces, an existing exported function inspected in this repository, or a test-local helper with fully specified construction. Verify exact resolver/MAC/fence/client signatures and the startup-before-signing boundary.
- [ ] File-path consistency: all Modify paths exist at base or in an earlier numbered task; new files have one owner; task-local git add includes every owned file and no others.
- [ ] Dependencies: no code import from a later task; T11 service admission is generic callback, T12 installs key guard, T14 performs production composition.
- [ ] SQL inventory: S1–S4/I1–I5/L1–L2/C1–C5/M1–M3/R1–R3 all have owner/evidence; all required scheduled inserts/UPSERT arms/assertions/no-op checks covered; no authoritative run table hidden in logging.
- [ ] Fencing: actual SQL/row counts/final assertion rollback; no sampled timestamp; high-water preserved; no renewal; stale commit cannot publish despite lost latches.
- [ ] Container: real supported Node process; authenticated strict/bounded verifier-specific RPC; no D1/R2 authority; private routing; actual deployment probes required without fabricated results.
- [ ] Image: conditional immutable artifacts, canonical key guard on repair, both D1 methods guarded, live uncertainty versus crash protection distinguished, no legacy credential fallback.
- [ ] Migration/dependency/deployment: two additive tables; original SQL unchanged; new computed hash; only approved Container package; no production operation occurs in ordinary tests.
- [ ] `git diff --check` exits0; only this Plan changed during planning. Independent reviewer receives approved Spec SHA, Plan path, inventory, coverage map and current Plan diff.

Independent Plan Review must report Critical0/Important0/Minor0. Any finding is corrected in this document then re-reviewed. Commit only after clean review: `git add docs/superpowers/plans/2026-09-15-gamehub-v2-8-cloudflare-cron-sync.md` then `git commit -m "docs: plan V2.8 Cloudflare Cron sync"`. Record actual Plan SHA, approved Design SHA/base/branch/clean status. Final planning status is `PLAN-READY`; implementation remains unstarted until the next explicit user command.
