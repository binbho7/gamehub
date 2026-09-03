# GameHub V2.4 IGDB Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich one existing canonical GameHub game from an exact Steam-to-IGDB identity mapping using dry-run planning and an optional atomic local-D1 write.

**Architecture:** Separate Twitch authentication, HTTP transport, provider schemas/adapters, normalization, persistence reads, planning, atomic persistence writes, orchestration, and CLI boundaries. Both dry-run and write mode read the same local D1 snapshot; only write mode executes the planner-approved single D1 batch.

**Tech Stack:** TypeScript, Zod 4, Drizzle ORM, Cloudflare D1/SQLite, Wrangler 4.127.1, Vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-09-03-gamehub-v2-4-igdb-enrichment-design.md`

## Global Constraints

- Work only in `.worktrees/codex-v2-4-igdb-enrichment` on `codex/v2-4-igdb-enrichment`.
- Do not modify `lib/db/schema.ts`, `drizzle/*.sql`, `lib/mock-data.ts`, V1 UI files, or V2.2/V2.3 behavior.
- Keep exactly two migrations and schema SHA-1 `52e84d7c2b52b73b95bdfb3934dabbde0e65e3d5`.
- Never create a canonical game, perform fuzzy matching, delete/reconcile relationships, overwrite non-empty canonical scalar fields, or implement remote D1 access.
- Both dry-run and `--write` initialize and read Wrangler local D1. Dry-run performs zero mutations; `--write` performs one approved atomic D1 batch.
- Reject `--remote`, remote database IDs, remote URLs/config, and environment selectors.
- Never persist or print Twitch secrets, access tokens, Authorization headers, or token request bodies.
- Never map IGDB `company.url` to `companies.website_url`; omit `company.url` from the provider query and raw DTO, and set `websiteUrl: null` for new companies.
- All candidate lookups deduplicate values, skip empty inputs, use chunks of at most 80 bind parameters per SELECT, and merge results deterministically.
- Cap normalized media before persistence planning: 20 artworks, 50 screenshots, and 20 videos.
- Each implementation task follows RED → confirm failure → minimal GREEN → focused tests → typecheck → global/scope check → independent commit.

## File Responsibility Map

- `lib/providers/igdb/errors.ts`: stable provider/auth/service error contract without secrets.
- `lib/providers/igdb/auth-client.ts`: Twitch client-credentials exchange and process-local token lifecycle.
- `lib/providers/igdb/client.ts`: authenticated HTTP-only IGDB transport.
- `lib/providers/igdb/schema.ts`: narrow loose Zod contracts for consumed mapping/game fields.
- `lib/providers/igdb/response.ts`: provider mapping and exact-game response semantics.
- `lib/providers/igdb/normalize.ts`: deterministic candidate construction, URL rules, platform mapping, media bounds, and warnings.
- `lib/enrichers/igdb-candidate.ts`: provider-neutral candidate, warning, plan, and result contracts.
- `lib/db/repositories/igdb-enrichment.ts`: local D1 read model, bounded lookups, and one-batch write.
- `lib/enrichers/igdb-plan.ts`: conservative comparison and exact action semantics.
- `lib/enrichers/igdb.ts`: end-to-end service orchestration and race recovery.
- `scripts/enrich-igdb-game.ts`: local-only CLI parsing, local D1 lifecycle, and safe formatting.
- `fixtures/igdb/*.json`: minimal provider fixtures only; no credentials or live response dependency.

---

### Task 1: IGDB Error Contract and Canonical Input Validation

**Files:**
- Create: `lib/providers/igdb/errors.ts`
- Create: `lib/providers/igdb/errors.test.ts`
- Create: `lib/enrichers/igdb-input.ts`
- Create: `lib/enrichers/igdb-input.test.ts`

**Interfaces:**
- Produces: `IgdbErrorCode`, `IgdbError`, `normalizeCanonicalGameId(input: unknown): number`.
- `IgdbError.details` is `{ retryable: boolean; status?: number; retryAfter?: string; cause?: unknown }` and public getters mirror V2.2 error style.

- [ ] **Step 1: Write failing contract tests**

Test that `normalizeCanonicalGameId` accepts `1` and a decimal string, rejects zero, unsafe integers, fractions, empty input, and non-decimal text. Test stable error codes and assert JSON/string inspection never contains supplied fake secrets.

```ts
expect(normalizeCanonicalGameId("123")).toBe(123);
expect(() => normalizeCanonicalGameId("0")).toThrowError(IgdbError);
expect(new IgdbError("rate_limited", "IGDB rate limited", {
  retryable: true, status: 429, retryAfter: "10",
}).retryable).toBe(true);
```

- [ ] **Step 2: Confirm RED**

Run: `npm test -- lib/providers/igdb/errors.test.ts lib/enrichers/igdb-input.test.ts`

Expected: FAIL because the IGDB contracts do not exist.

- [ ] **Step 3: Implement the minimal contracts**

Define the exact Spec codes. Input failures use `canonical_game_not_found` only after repository lookup; syntactic input uses a dedicated `invalid_game_id` code. Error messages contain stable context only, never raw request options.

- [ ] **Step 4: Confirm GREEN and type safety**

Run: `npm test -- lib/providers/igdb/errors.test.ts lib/enrichers/igdb-input.test.ts && npm run typecheck`

- [ ] **Step 5: Scope check and commit**

Verify protected files are unchanged. Commit: `feat: add IGDB error and input contracts`.

### Task 2: Twitch OAuth Auth Client

**Files:**
- Create: `lib/providers/igdb/auth-client.ts`
- Create: `lib/providers/igdb/auth-client.test.ts`

**Interfaces:**
- Consumes: `IgdbError`.
- Produces: `IgdbAuthClient` with `getAccessToken(): Promise<string>` and `invalidateAccessToken(): void`; `createIgdbAuthClient(options)` with injected `fetch`, credentials, clock, token URL, timeout, and expiry margin.

- [ ] **Step 1: Write failing auth tests**

Cover missing credentials, exact form-encoded client-credentials POST, token Zod validation, invalid credentials, HTTP failure classes, timeout during fetch and `response.json()`, malformed JSON, cache reuse, expiry margin, explicit invalidation, rejected single-flight cleanup, and two concurrent callers sharing one request.

```ts
const [first, second] = await Promise.all([
  auth.getAccessToken(), auth.getAccessToken(),
]);
expect(first).toBe(second);
expect(fetchMock).toHaveBeenCalledTimes(1);
```

Assert fake client secret/token strings never occur in thrown `name`, `message`, enumerable details, or formatted JSON.

- [ ] **Step 2: Confirm RED**

Run: `npm test -- lib/providers/igdb/auth-client.test.ts`

- [ ] **Step 3: Implement minimal auth lifecycle**

Use a private cache `{ accessToken, expiresAtMs }`, default 60-second safety margin, an AbortController deadline covering body parsing, and a pending Promise cleared in `finally`. Send credentials in the form body; never include the request URL/body in errors.

- [ ] **Step 4: Confirm GREEN and typecheck**

Run: `npm test -- lib/providers/igdb/auth-client.test.ts && npm run typecheck`

- [ ] **Step 5: Scope check and commit**

Commit: `feat: add Twitch OAuth token client`.

### Task 3: HTTP-Only IGDB Client

**Files:**
- Create: `lib/providers/igdb/client.ts`
- Create: `lib/providers/igdb/client.test.ts`

**Interfaces:**
- Consumes: `Pick<IgdbAuthClient, "getAccessToken" | "invalidateAccessToken">`, `IgdbError`.
- Produces: `IgdbHttpResponse = { body: unknown; fetchedAt: Date }`; `IgdbClient.request(endpoint: "external_games" | "games", query: string): Promise<IgdbHttpResponse>`.

- [ ] **Step 1: Write failing transport tests**

Assert POST URL, `Client-ID`, Bearer header, `Accept: application/json`, plain APICalypse body, timeout across body parsing, network failure, 403, 429 with `Retry-After`, other 4xx, 5xx, malformed JSON, and no general retries. Test one 401 invalidates the token and retries exactly once; a second 401 fails `authentication_failed`.

- [ ] **Step 2: Confirm RED**

Run: `npm test -- lib/providers/igdb/client.test.ts`

- [ ] **Step 3: Implement HTTP-only client**

Whitelist endpoint names, acquire tokens from the Auth Client, classify status before JSON parsing, and return `unknown`. Do not import adapters, candidates, repositories, Drizzle, or Wrangler.

- [ ] **Step 4: Confirm GREEN and boundary**

Run: `npm test -- lib/providers/igdb/client.test.ts && npm run typecheck`

Run: `rg -n "db/|drizzle|wrangler|enrichers" lib/providers/igdb/client.ts` and expect no matches.

- [ ] **Step 5: Commit**

Commit: `feat: add HTTP-only IGDB client`.

### Task 4: IGDB Raw Schemas and Fixtures

**Files:**
- Create: `fixtures/igdb/external-games.json`
- Create: `fixtures/igdb/game.json`
- Create: `lib/providers/igdb/schema.ts`
- Create: `lib/providers/igdb/schema.test.ts`

**Interfaces:**
- Produces: `igdbExternalGamesResponseSchema`, `igdbGamesResponseSchema`, `IgdbExternalGameRaw`, `IgdbGameRaw`, and raw optional-item union types used by normalization.

- [ ] **Step 1: Write failing schema tests**

Test positive safe integer core IDs, required mapping fields, required game ID/name, loose extra fields, optional collection container validation, and consumed core field type changes. Test that a valid array may retain individually malformed optional media/website entries as `unknown` so normalization can warn, while a non-array container fails.

```ts
expect(igdbGamesResponseSchema.parse([{
  id: 123, name: "Example", screenshots: [{ image_id: "good" }, { image_id: 7 }],
}])).toHaveLength(1);
expect(() => igdbGamesResponseSchema.parse([{ id: 123, name: "Example", screenshots: {} }])).toThrow();
```

Ensure `company.url` is absent from the raw company DTO and fixtures.

- [ ] **Step 2: Confirm RED**

Run: `npm test -- lib/providers/igdb/schema.test.ts`

- [ ] **Step 3: Implement narrow loose schemas**

Use strict validation for identity/core values and `z.array(z.unknown()).optional()` for optional collections whose items are parsed independently later. Define item schemas exported for the normalizer. Do not request or model unconsumed fields.

- [ ] **Step 4: Confirm GREEN and typecheck**

Run: `npm test -- lib/providers/igdb/schema.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

Commit: `feat: validate IGDB provider responses`.

### Task 5: Steam-to-IGDB Mapping and Exact Game Adapters

**Files:**
- Create: `lib/providers/igdb/response.ts`
- Create: `lib/providers/igdb/response.test.ts`

**Interfaces:**
- Consumes: raw response schemas and `IgdbError`.
- Produces: `parseIgdbSteamMapping(body, expectedSteamAppId): { igdbGameId: number }`; `parseIgdbGame(body, expectedIgdbGameId): IgdbGameRaw`.

- [ ] **Step 1: Write failing adapter tests**

Cover source `1`, exact UID, one mapping, exact duplicate rows deduped by game ID, zero results, multiple distinct IDs, wrong source, UID mismatch, missing game, malformed core schema, exact requested game, empty game result, and mismatched game ID.

```ts
expect(parseIgdbSteamMapping([
  { id: 1, game: 42, uid: "1245620", external_game_source: 1 },
  { id: 2, game: 42, uid: "1245620", external_game_source: 1 },
], "1245620")).toEqual({ igdbGameId: 42 });
```

Assert mapping failures throw `mapping_not_found`, `mapping_ambiguous`, or `unsupported_mapping`; no plan type is imported.

- [ ] **Step 2: Confirm RED**

Run: `npm test -- lib/providers/igdb/response.test.ts`

- [ ] **Step 3: Implement adapters**

Parse core envelopes first, validate each mapping against expected source/UID, dedupe exact game IDs, and enforce exact game response identity. Keep canonical DB identity out of this module.

- [ ] **Step 4: Confirm GREEN and boundary**

Run: `npm test -- lib/providers/igdb/response.test.ts && npm run typecheck`

Run: `rg -n "IgdbEnrichmentPlan|identity_conflict|db/" lib/providers/igdb/response.ts` and expect no matches.

- [ ] **Step 5: Commit**

Commit: `feat: adapt IGDB identity responses`.

### Task 6: Enrichment Candidate and IGDB Normalizer

**Files:**
- Create: `lib/enrichers/igdb-candidate.ts`
- Create: `lib/enrichers/igdb-candidate.test.ts`
- Create: `lib/providers/igdb/normalize.ts`
- Create: `lib/providers/igdb/normalize.test.ts`

**Interfaces:**
- Produces the Spec DTOs `IgdbEnrichmentCandidate`, `IgdbEnrichmentWarning`, `IgdbNormalizationResult`, `IgdbEnrichmentPlan`, and `IgdbEnrichmentResult`.
- Produces: `normalizeIgdbGame(raw, identity, fetchedAt): IgdbNormalizationResult`.

- [ ] **Step 1: Write failing candidate and normalizer tests**

Validate identity consistency and provider-neutral DTO bounds. Cover title/summary/storyline, exact UTC date conversion, normalized genres, explicit platform mappings, developer/publisher roles, stable company slugs, and `websiteUrl: null`. Prove `company.url` is never consumed.

Test official website eligibility only for `type === 1 && trusted === true`, with `provider: "igdb"`, `platform: null`, `verificationStatus: "unverified"`, and `verificationMethod: null`.

Test URLs:

```text
cover      t_cover_big_2x
artwork    t_1080p
screenshot t_screenshot_big
```

Test stable first-wins URL/ID dedupe, provider order, invalid optional item warnings, deterministic `coverUrl`, and `heroUrl` from the first valid normalized artwork only. Test caps 20/50/20 and one `media_limit_applied` warning per truncated media kind.

- [ ] **Step 2: Confirm RED**

Run: `npm test -- lib/enrichers/igdb-candidate.test.ts lib/providers/igdb/normalize.test.ts`

- [ ] **Step 3: Implement candidate schemas and normalizer**

Parse optional items independently, warn and skip invalid entries, apply dedupe then caps, and build HTTPS image URLs from narrow safe `image_id` values. Do not fall back from artwork to screenshot for `heroUrl`.

- [ ] **Step 4: Confirm GREEN and typecheck**

Run: `npm test -- lib/enrichers/igdb-candidate.test.ts lib/providers/igdb/normalize.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

Commit: `feat: normalize IGDB enrichment candidates`.

### Task 7: Enrichment Read Model and Bounded D1 Lookups

**Files:**
- Create: `lib/db/repositories/igdb-enrichment.ts`
- Create: `lib/db/repositories/igdb-enrichment.test.ts`

**Interfaces:**
- Produces: `IGDB_MAX_BIND_PARAMS_PER_LOOKUP_QUERY = 80`; `IgdbEnrichmentSnapshot`; `IgdbEnrichmentStore` read methods; `createIgdbEnrichmentStore(db)`.
- Read API includes `findSnapshotByGameId(gameId)` plus bounded candidate lookup methods for external IDs, genre slugs, platform slugs, company slugs, image source URLs, video provider/IDs, and official-link URLs.

- [ ] **Step 1: Write failing real-local-D1 read tests**

Create an existing Steam-imported game and prove the snapshot includes scalars, external IDs, relations, media, and links. Test missing game and zero/multiple usable Steam IDs without mutation.

For every candidate lookup family, test empty input executes zero SELECTs, duplicates are removed, one/multiple values work, 81 and 160+ bind values are chunked at 80, and result order follows first appearance in deduplicated input. Include composite video/external identity queries and reserve any fixed predicates within the 80-total-bind ceiling.

- [ ] **Step 2: Confirm RED**

Run: `npm test -- lib/db/repositories/igdb-enrichment.test.ts`

- [ ] **Step 3: Implement read model and shared bounded helper**

Implement a private generic chunk runner that accepts each query's fixed-bind count, uses `80 - fixedBindCount` candidate slots, rejects impossible budgets, skips empty chunks, and deterministically reconstructs results. Use indexed game ID, provider/external ID, slug, game/source URL, game/provider/external ID, and game/URL predicates; do not add full scans or an unbounded `IN`.

- [ ] **Step 4: Confirm GREEN and inspect SQL safety**

Run: `npm test -- lib/db/repositories/igdb-enrichment.test.ts && npm run typecheck`

Inspect test-captured query bind counts and assert every SELECT has `<= 80` bindings.

- [ ] **Step 5: Commit**

Commit: `feat: add bounded IGDB enrichment reads`.

### Task 8: Conservative Enrichment Planner

**Files:**
- Create: `lib/enrichers/igdb-plan.ts`
- Create: `lib/enrichers/igdb-plan.test.ts`

**Interfaces:**
- Consumes: `IgdbEnrichmentCandidate`, warnings, snapshot, and candidate lookup results.
- Produces: `planIgdbEnrichment(store, snapshot, normalization): Promise<IgdbEnrichmentPlan>`.

- [ ] **Step 1: Write failing planner tests**

Cover fill-empty scalar updates, exact scalar no-op, populated mismatch `ownership_unknown`, no title replacement, IGDB external ID create/idempotency, current-game different IGDB ID blocked, and cross-game mapped IGDB ID blocked.

Cover additive-only genre/platform/company roles, no delete/replacement/rename, no company website update, `websiteUrl: null` for planned new companies, official website rules, and capped media additions. Prove provider mapping errors are not planner inputs.

Assert actions exactly:

```ts
expect(planWithWrite.action).toBe("enrich");
expect(noAllowedChange.action).toBe("existing");
expect(identityConflict.action).toBe("blocked");
```

- [ ] **Step 2: Confirm RED**

Run: `npm test -- lib/enrichers/igdb-plan.test.ts`

- [ ] **Step 3: Implement minimal conservative planner**

Call only bounded store lookups, preserve normalization warnings, calculate deterministic creates/updates/skips/conflicts, and ensure rejected suggestions do not produce `enrich`. Do not emit delete operations.

- [ ] **Step 4: Confirm GREEN and typecheck**

Run: `npm test -- lib/enrichers/igdb-plan.test.ts && npm run typecheck`

Run: `rg -n "delete|websiteUrl.*candidate|company\.url" lib/enrichers/igdb-plan.ts` and manually confirm no prohibited write path.

- [ ] **Step 5: Commit**

Commit: `feat: plan conservative IGDB enrichment`.

### Task 9: One-Batch Atomic Local D1 Write

**Files:**
- Modify: `lib/db/repositories/igdb-enrichment.ts`
- Modify: `lib/db/repositories/igdb-enrichment.test.ts`

**Interfaces:**
- Extends `IgdbEnrichmentStore` with `applyPlan(plan): Promise<{ affectedRows: number }>`.
- `existing` returns zero mutations; `blocked` is rejected before batch construction; `enrich` executes one `db.batch`.

- [ ] **Step 1: Write failing atomic write tests**

Use real local D1 to test an approved batch containing IGDB external ID, scalar fills, new lookup rows, relations, official link, images, and videos. Verify new companies have `website_url IS NULL`.

Inject a failure late in the batch and compare before/after deltas for candidate-specific games, external IDs, lookup rows, relations, media, and links. Shared pre-existing lookup rows must remain; no record introduced by this candidate may remain.

Test `existing` executes no batch, `blocked` cannot write, and exactly one formal `db.batch` call is made.

- [ ] **Step 2: Confirm RED**

Run: `npm test -- lib/db/repositories/igdb-enrichment.test.ts`

- [ ] **Step 3: Implement one-batch persistence**

Translate only explicit plan operations. Use insert/select or deterministic IDs compatible with D1 batch semantics and current schema, conditional scalar fills (`IS NULL`), additive inserts, and no deletes. Wrap failure as sanitized `write_conflict`.

- [ ] **Step 4: Confirm GREEN and typecheck**

Run: `npm test -- lib/db/repositories/igdb-enrichment.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

Commit: `feat: write IGDB enrichment atomically`.

### Task 10: Enrichment Service, Dry Run, and Race Recovery

**Files:**
- Create: `lib/enrichers/igdb.ts`
- Create: `lib/enrichers/igdb.test.ts`

**Interfaces:**
- Consumes: `IgdbClient`, adapters, normalizer, planner, and `IgdbEnrichmentStore`.
- Produces: `createIgdbEnricher(dependencies).enrichGame(gameId, { dryRun }): Promise<IgdbEnrichmentResult>`.

- [ ] **Step 1: Write failing orchestration tests**

Assert order: local snapshot first, exactly one usable Steam external ID, mapping request, game request, normalize, plan, then optional write. Validate exact query fields and prove `company.url` is absent.

Test missing canonical game/Steam ID stops before HTTP; mapping errors stop before normalizer/planner; dry-run reads local D1 and returns the plan with zero mutations; write calls `applyPlan` only for `enrich`; blocked never writes.

Test two concurrent same-game writes converge to one IGDB identity and no duplicate relations. On unique conflict, reread: same game/ID returns idempotent existing; other game/different current binding returns blocked identity conflict. Atomic rollback behavior remains intact.

- [ ] **Step 2: Confirm RED**

Run: `npm test -- lib/enrichers/igdb.test.ts`

- [ ] **Step 3: Implement service and fixed queries**

Build constant APICalypse queries from validated IDs, preserve provider errors without planning, and recover only recognized identity uniqueness races. Do not catch unrelated write failures as success.

- [ ] **Step 4: Confirm GREEN and typecheck**

Run: `npm test -- lib/enrichers/igdb.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

Commit: `feat: orchestrate single-game IGDB enrichment`.

### Task 11: Local-Only IGDB Enrichment CLI

**Files:**
- Create: `scripts/enrich-igdb-game.ts`
- Create: `scripts/enrich-igdb-game.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseIgdbEnrichArgs(argv): { gameId: number; write: boolean; json: boolean }`; `createLocalIgdbEnrichmentPlatform`; `runIgdbEnrichCli`.
- Adds: `npm run igdb:enrich -- <gameId> [--write] [--json]`.

- [ ] **Step 1: Write failing CLI tests**

Cover default dry-run, `--write`, `--json`, duplicate flags, missing/multiple IDs, unknown flags, and explicit rejection of `--remote`, `--remote=`, `--env`, `--env=`, `-e`, `--config`, `--config=`, database ID, and URL-like configuration inputs.

Inject Wrangler platform and enricher factories. Prove both dry-run and write initialize local D1 and dispose it; dry-run calls `enrichGame(..., { dryRun: true })`, write uses false. Assert platform options use current Wrangler 4.127.1 supported local settings (`remoteBindings: false`) and cannot accept caller-supplied config/environment.

Test human/JSON output and errors with fake secret/token values; neither may appear. Prove the CLI does not import or invoke V2.2/V2.3 services.

- [ ] **Step 2: Confirm RED**

Run: `npm test -- scripts/enrich-igdb-game.test.ts`

- [ ] **Step 3: Implement local-only CLI**

Follow the existing Steam CLI's `getPlatformProxy` lifecycle, but initialize IGDB auth/client/enricher. Load credentials only in the production entrypoint. Keep parsing and execution dependency-injectable for tests.

- [ ] **Step 4: Confirm GREEN and dependency boundaries**

Run: `npm test -- scripts/enrich-igdb-game.test.ts && npm run typecheck`

Run: `rg -n "remote: true|remoteBindings: true|steam.*import|steam.*search" scripts/enrich-igdb-game.ts` and expect no prohibited path.

- [ ] **Step 5: Commit**

Commit: `feat: add local IGDB enrichment CLI`.

### Task 12: README and Operational Safety Documentation

**Files:**
- Modify: `README.md`
- Create: `README.test.ts` only if the repository already tests documentation contracts; otherwise extend `scripts/enrich-igdb-game.test.ts` with file-content assertions.

**Interfaces:**
- Documents local credentials, dry-run/write commands, output meaning, local-only boundary, token lifecycle, media behavior, and commercial-use gate.

- [ ] **Step 1: Write failing documentation assertions**

Assert README contains `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, default dry-run, explicit local-only `--write`, rejected `--remote`, no R2 download/cache, process-memory token behavior, and the requirement to confirm IGDB commercial partnership/licensing/attribution before commercial launch.

- [ ] **Step 2: Confirm RED**

Run the focused documentation/CLI test and expect missing documentation assertions to fail.

- [ ] **Step 3: Add concise usage documentation**

Include setup and commands without example secrets. State that each new CLI process may acquire a token and that batch/Cron token lifecycle requires a later design.

- [ ] **Step 4: Confirm GREEN and diff quality**

Run focused tests, `npm run typecheck`, and `git diff --check`.

- [ ] **Step 5: Commit**

Commit: `docs: document local IGDB enrichment`.

### Task 13: Full Regression, Immutable Verification, and Scoped Review

**Files:**
- Modify only test or V2.4 files if verification exposes a defect; every fix must first add a focused failing regression and receive its own commit.

**Interfaces:**
- Produces no new feature; establishes merge readiness.

- [ ] **Step 1: Run all verification commands**

Run separately and retain results:

```bash
npm test
npm run typecheck
npm run lint
npm run build -- --webpack
npm run db:check:local
npm run db:verify:local
npm audit
npm audit --omit=dev
git diff --check
```

- [ ] **Step 2: Verify immutable boundaries**

Compare against `v2.3-steam-search`:

```bash
git diff --exit-code v2.3-steam-search -- lib/db/schema.ts lib/mock-data.ts
git diff --exit-code v2.3-steam-search -- 'drizzle/*.sql'
test "$(find drizzle -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')" = "2"
shasum lib/db/schema.ts
```

Expected schema SHA-1: `52e84d7c2b52b73b95bdfb3934dabbde0e65e3d5`. Inspect diffs to confirm no V1 UI or V2.2/V2.3 implementation behavior changed.

- [ ] **Step 3: Verify architectural boundaries**

Confirm provider modules do not import D1/planner, mapping errors cannot reach planner, all candidate SELECTs enforce `<= 80` binds, no unbounded `IN` exists, company URLs are not persisted, relationships have no delete/reconcile path, dry-run opens local D1 but executes no batch, and no remote option exists.

- [ ] **Step 4: Perform scoped review**

Review only V2.4 against the Spec for credential leakage, HTTP/adapter responsibility, optional-item tolerance, deterministic media bounds, plan semantics, lookup boundedness, atomic rollback, race recovery, and protected-file changes. If Critical or Important findings exist, add a failing regression, make the smallest correction, rerun focused and full checks, and commit the fix independently.

- [ ] **Step 5: Record final state**

Require Critical = 0, Important = 0, all commands passing, and `git status --short` empty. If Task 13 required no code change, do not create an empty commit. Stop without creating a PR or merging main.
