# GameHub V2.6 R2 Image System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a dedicated, authenticated Worker that ingests existing Steam/IGDB canonical image sources into content-addressed R2 objects and binds complete, optimistic-concurrency-protected metadata in D1.

**Architecture:** `workers/image-ingest/` is an isolated Cloudflare Worker holding `DB`, `IMAGES_BUCKET`, `IMAGE_PUBLIC_BASE_URL`, and secret `IMAGE_INGEST_TOKEN`. The Next app remains unchanged as the application host; `game_images` is the canonical metadata table and R2 stores original bytes under SHA-256 keys. The CLI is only an authenticated Worker HTTP client: it never opens D1/R2 or fetches image sources itself.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, R2, Wrangler, Drizzle ORM, Zod, Vitest, Web Fetch API, Web Crypto, existing Node/tsx CLI tooling.

**Spec:** `docs/superpowers/specs/2026-09-08-gamehub-v2-6-r2-image-system-design.md`

## Global Constraints

- Worker transport uses `fetch(..., { redirect: "manual" })`; no Node `http`, `https`, DNS, socket, automatic redirect, or source HEAD request.
- Every source hop is HTTPS, credential-free, no longer than 2,048 characters, and inside the originating provider’s explicit allowlist: Steam `cdn.akamai.steamstatic.com`; IGDB `images.igdb.com`.
- Follow only 301/302/303/307/308, maximum three redirects/four total hops; malformed/missing Location, loops, provider changes, and HTTPS downgrade produce `redirect_rejected`.
- Final source response uses one bounded GET stream; reject `Content-Length > 8,388,608` before reading and abort once the byte counter exceeds 8 MiB.
- Accepted bytes are JPEG, PNG, or WebP with matching normalized MIME and magic bytes; dimensions come from bounded header parsers; SHA-256 is lowercase 64-hex Web Crypto output.
- Storage key is `images/sha256/<hash[0:2]>/<hash[2:4]>/<fullhash>.<ext>`; R2 metadata is actual MIME, immutable cache control, and `sha256`/`size` custom metadata.
- R2 is R2-first/D1-second. Existing objects are never overwritten. Missing objects use `onlyIf: { etagDoesNotMatch: "*" }`; failed preconditions re-HEAD and classify match as `concurrent_dedup` or mismatch as `storage_conflict`.
- `game_images` asset identity is `(game_id, source_url)`, matching V2.4. Cover/hero reuse, candidate dedupe, duplicate preflight, conditional insert, and race recovery all use that identity; no new unique index is added.
- Migration 3→4 rebuilds only `game_images` with an explicit 15-column projection, preserves all existing values/constraints/indexes, sets historical provenance/storage fields NULL and `updated_at=created_at`, and fails closed on non-zero legacy `storage_url IS NOT NULL` or duplicate identity preflight.
- Per-image outcomes are exactly: `ingested`, `deduplicated`, `concurrent_dedup`, `already_ingested`, `restored`, `skipped`, `inconsistent_state`, `source_rejected`, `redirect_rejected`, `download_failed`, `deadline`, `invalid_image`, `mime_mismatch`, `too_large`, `storage_conflict`, `storage_failed`, `source_changed`, `write_conflict`, `d1_write_failed`.
- Game-level failures include `invalid_request`, `unauthorized`, `configuration_error`, `game_not_found`, `image_limit_exceeded`, and `game_deadline`; `image_limit_exceeded` is never per-image.
- One canonical game per request, maximum 128 deduplicated eligible assets, serial image concurrency 1, five-minute game deadline, 30-second image deadline, and ten-second response-header deadline.
- Dry-run performs Worker-side D1 reads, real GET/redirect/validation/hash work, and R2 HEAD only; it performs zero R2 PUT and zero D1 INSERT/UPDATE/DELETE. `--write` authorizes the selected Worker’s bound resources.
- Local CLI targets an explicitly configured local `wrangler dev` Worker; preview uses non-production bindings; production endpoint/token must be explicitly supplied and are never committed or defaulted.
- No `--force`, refresh, replace, delete, GC, batch, Cron, Admin UI, R2 public `r2.dev`, production resource creation, or new production dependency.
- Full 128-image production support requires Workers Paid (or an explicitly increased subrequest limit); do not redesign for the Free 50-subrequest quota.

## Fixed TypeScript Contracts

These shapes are implementation contracts, not suggestions. Later tasks must import these definitions rather than inventing alternatives.

```ts
export type ImageProvider = "steam" | "igdb";
export type SourcePolicyResult =
  | { ok: true; provider: ImageProvider; url: string }
  | { ok: false; reason: "malformed_url" | "unsupported_scheme" | "credentials" | "fragment" | "too_long" | "unknown_host" | "provider_mismatch" };
export type ImageCandidate = { gameId: number; type: "cover" | "hero" | "screenshot" | "artwork" | "logo"; sourceUrl: string; provider: ImageProvider; width: number | null; height: number | null; sortOrder: number; existingId: number | null };
export type DownloadRequest = { candidate: ImageCandidate; fetchImpl: typeof fetch; signal: AbortSignal; now: () => number; maxRedirects?: 3; maxUrlLength?: 2048 };
export type DownloadResult = { outcome: "downloaded" | "redirect_rejected" | "download_failed" | "deadline" | "too_large"; attempts: Array<{ url: string; status: number | null; location: string | null }>; finalUrl: string | null; httpStatus: number | null; contentType: string | null; bytes: Uint8Array | null; errorCode: string | null };
export type ImageDimensions = { width: number; height: number };
export type ImageValidation = { ok: true; mimeType: "image/jpeg" | "image/png" | "image/webp"; dimensions: ImageDimensions } | { ok: false; outcome: "mime_mismatch" | "invalid_image" };
export type R2EnsureResult = { outcome: "deduplicated" | "concurrent_dedup" | "created" | "storage_conflict" | "storage_failed"; storageKey: string; storageUrl: string };
export type R2ImageStore = { head(key: string): Promise<R2MetadataResult>; ensureObject(input: { key: string; bytes: Uint8Array; hash: string; mimeType: string; size: number }): Promise<R2EnsureResult> };
export type ImageBinding = { storageKey: string; storageUrl: string; contentHash: string; mimeType: string; fileSize: number; width: number; height: number };
export type ImageIngestSnapshot = { game: { id: number; coverUrl: string | null; heroUrl: string | null; updatedAt: Date }; images: Array<{ id: number; gameId: number; type: string; sourceUrl: string; sourceProvider: ImageProvider | null; storageUrl: string | null; storageKey: string | null; contentHash: string | null; mimeType: string | null; fileSize: number | null; width: number | null; height: number | null; sortOrder: number; createdAt: Date; updatedAt: Date }> };
export type ImagePlan = { gameId: number; candidates: ImageCandidate[]; preflight: "ok" | "game_not_found" | "image_limit_exceeded"; dryRun: boolean };
export type ImageResult = { gameId: number; status: "completed" | "partial" | "failed"; preflightError: "invalid_request" | "game_not_found" | "image_limit_exceeded" | "game_deadline" | null; images: Array<{ imageId: number | null; outcome: "ingested" | "deduplicated" | "concurrent_dedup" | "already_ingested" | "restored" | "skipped" | "inconsistent_state" | "source_rejected" | "redirect_rejected" | "download_failed" | "deadline" | "invalid_image" | "mime_mismatch" | "too_large" | "storage_conflict" | "storage_failed" | "source_changed" | "write_conflict" | "d1_write_failed" }> }>;
export type WorkerEnv = { DB: D1Database; IMAGES_BUCKET: R2Bucket; IMAGE_PUBLIC_BASE_URL: string; IMAGE_INGEST_TOKEN: string };
export type WorkerRequestDto = { gameId: number; write: boolean };
export type CliOptions = { gameId: number; write: boolean; json: boolean; workerUrl: string; token: string };
```

`R2MetadataResult` is `{ exists:false }` or `{ exists:true; size:number; hash:string|null; mimeType:string|null; cacheControl:string|null; sha256Metadata:string|null }`. `readImageIngestSnapshot`, `conditionallyCreateImage`, and `optimisticBindImage` use the exact field names above. Malformed presentation URLs always render as `[REDACTED_URL]`, matching `lib/verifiers/official-links/presentation.ts`.

## Repository Mapping

Current implementation points that the tasks below must preserve:

- `lib/db/schema.ts` owns Drizzle table definitions; `lib/db/client.ts` creates the D1 Drizzle client.
- `lib/db/validation.ts` and `lib/db/repositories/games.ts` expose the generic image validation/add path; `lib/db/repositories/steam-import.ts` creates Steam images; `lib/db/repositories/igdb-enrichment.ts` uses a conditional `game_id + source_url` image insert.
- `lib/enrichers/igdb-plan.ts` deduplicates images by `sourceUrl`; `lib/importers/steam.ts` and `lib/importers/steam-plan.ts` carry Steam image candidates.
- `lib/verifiers/official-links/presentation.ts` and `types.ts` define the existing URL sanitizer, DTO presentation pattern, and sensitive-key set; `link-verification.ts` demonstrates complete snapshot compare-before-update.
- `scripts/verify-official-links.ts`, `scripts/enrich-igdb-game.ts`, and `scripts/import-steam-game.ts` show strict argument parsing, local platform proxy setup, and safe error output.
- Root `wrangler.jsonc` contains only the existing D1 binding; the new Worker must have a separate config. `package.json` currently has `test`, `typecheck`, `lint`, `build`, and local migration scripts but no image-ingest script.

### Task 1: Extend game image schema and migration

**Files**
- Create: `drizzle/0003_r2_image_metadata.sql`
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/validation.ts`
- Test: `test/migrations/game-images-r2.test.ts`
- Test: `lib/db/validation.test.ts`

**Interfaces**
- Consumes: existing nine-column `game_images` schema and migration metadata.
- Produces: typed fields `sourceProvider`, `storageKey`, `contentHash`, `mimeType`, `fileSize`, `updatedAt`; migration count 4; validation schemas for provider/storage invariants.

```ts
export function readImageMigrationPreflight(db: GameHubDatabase): Promise<{ legacyStorageUrlCount: number; duplicateIdentityCount: number }>;
```

- [ ] Step 1: Write failing migration tests that create a pre-migration database, insert rows covering nullable dimensions, ordering, FK cascade, and legacy values, then assert the post-migration table has the explicit 15 columns, copied values, defaults, checks, indexes, and `PRAGMA foreign_key_check` success. Add failing tests for `storage_url IS NOT NULL` and duplicate `(game_id,source_url)` preflight returning a hard stop without cleanup.
- [ ] Step 2: Run `npm test -- test/migrations/game-images-r2.test.ts lib/db/validation.test.ts`; expected: FAIL because migration 4 and new validation fields do not exist.
- [ ] Step 3: Add the six Drizzle fields and matching Zod rules. Generate then inspect migration SQL; replace generated table-copy SQL if needed with this exact mapping (the implementation must preserve `storage_url` verbatim):
  ```sql
  INSERT INTO new_game_images (id,game_id,type,source_url,source_provider,storage_url,storage_key,content_hash,mime_type,file_size,width,height,sort_order,created_at,updated_at)
  SELECT id,game_id,type,source_url,NULL,storage_url,NULL,NULL,NULL,NULL,width,height,sort_order,created_at,created_at FROM game_images;
  ```
  Preserve existing checks/indexes and add provider, all-null/all-present storage, positive size, MIME, and lowercase hash checks.
- [ ] Step 4: Define the pure read-only `readImageMigrationPreflight(db): Promise<{ legacyStorageUrlCount:number; duplicateIdentityCount:number }>` helper. The migration itself does not call this helper and does not clean data. Update Drizzle metadata snapshots for migration 3→4.
- [ ] Step 5: Run `npm test -- test/migrations/game-images-r2.test.ts lib/db/validation.test.ts`; expected: PASS, including cascade and rejected partial metadata.
- [ ] Step 6: Commit with `git add drizzle lib/db/schema.ts lib/db/validation.ts test/migrations/game-images-r2.test.ts lib/db/validation.test.ts && git commit -m "feat: add R2 image metadata schema"`.

### Task 2: Preserve provider provenance at image creation

**Files**
- Modify: `lib/db/repositories/steam-import.ts`
- Modify: `lib/db/repositories/igdb-enrichment.ts`
- Modify: `lib/importers/steam.test.ts`
- Modify: `lib/db/repositories/igdb-enrichment.test.ts`

**Interfaces**
- Consumes: Steam/IGDB image candidates and explicit schema columns from Task 1.
- Produces: new rows with `sourceProvider="steam"` or `sourceProvider="igdb"`, `storageUrl/storageKey/contentHash/mimeType/fileSize=NULL`, and explicit column inserts.

```ts
type ImageInsertContext = { gameId: number; type: string; sourceUrl: string; width: number | null; height: number | null; sortOrder: number };
function insertSteamImage(ctx: ImageInsertContext): Promise<void>;
function insertIgdbImage(ctx: ImageInsertContext): Promise<void>;
```

- [ ] Step 1: Add failing assertions for provenance and explicit insert values while preserving existing source URLs, type, dimensions, and sort order.
- [ ] Step 2: Run `npm test -- lib/importers/steam.test.ts lib/db/repositories/igdb-enrichment.test.ts`; expected: FAIL on missing provenance/column mapping.
- [ ] Step 3: Change only the two image write paths to explicit field lists and provider values; leave historical rows and V2.4 first-wins sourceUrl behavior unchanged.
- [ ] Step 4: Run the same focused command; expected: PASS with no unrelated importer/enricher behavior changes.
- [ ] Step 5: Commit `feat: record image source provenance`.

### Task 3: Implement provider URL policy and canonical candidate resolution

**Files**
- Create: `lib/images/source-policy.ts`
- Create: `lib/images/candidates.ts`
- Test: `lib/images/source-policy.test.ts`
- Test: `lib/images/candidates.test.ts`

**Interfaces**
- Consumes: `GameRow`, `gameImages` rows, `sourceProvider` context, `coverUrl`, `heroUrl`.
- Produces: `type ImageProvider = "steam" | "igdb"`; `validateImageSource(url: string, provider: ImageProvider): SourcePolicyResult`; `resolveImageCandidates(snapshot: ImageGameSnapshot): CandidateResolution`.

```ts
export function resolveImageProviderFromUrl(url: string): { ok: true; provider: ImageProvider } | { ok: false; reason: "unknown_host" | "malformed_url" };
```

- [ ] Step 1: Write failing tests for exact hosts, HTTPS/credential/fragment/length rejection, unknown provider, source URL host inference refusal, deterministic ordering, 128-image preflight, and cover/hero identity cases A/B/C from the Spec.
- [ ] Step 2: Run `npm test -- lib/images/source-policy.test.ts lib/images/candidates.test.ts`; expected: FAIL because modules do not exist.
- [ ] Step 3: Implement `resolveImageProviderFromUrl(url): {ok:true;provider:ImageProvider}|{ok:false;reason:"unknown_host"|"malformed_url"}` and `validateImageSource(url, provider): SourcePolicyResult`. Map only exact hosts; historical NULL provenance may be filled on a successful optimistic binding, while unmappable rows produce `source_rejected`. Implement `(game_id,source_url)` first-wins dedupe and cover/hero planning.
- [ ] Step 4: Run focused tests; expected: PASS, with no wildcard or alternate CDN accepted.
- [ ] Step 5: Commit `feat: add canonical image source policy`.

### Task 4: Build bounded GET redirect downloader

**Files**
- Create: `lib/images/downloader.ts`
- Create: `lib/images/clock.ts`
- Test: `lib/images/downloader.test.ts`

**Interfaces**
- Consumes: `SourcePolicyResult`, injected `fetch(input, init)`, `AbortSignal`, clock/deadline options.
- Produces: `downloadImageSource(input: DownloadRequest): Promise<DownloadResult>` with per-hop records, final response headers, bounded bytes, and the fixed image outcome/error codes.

```ts
export function downloadImageSource(request: DownloadRequest): Promise<DownloadResult>;
```

- [ ] Step 1: Write deterministic mock-fetch tests for manual GET redirects, redirect-body cancellation, all five redirect statuses, non-followed 3xx, malformed/missing Location, loop, cross-provider, downgrade, four-hop cap, timeout mapping, Content-Length cap, no Content-Length streaming, and no second GET/HEAD.
- [ ] Step 2: Run `npm test -- lib/images/downloader.test.ts`; expected: FAIL because the downloader is absent.
- [ ] Step 3: Implement `downloadImageSource(request: DownloadRequest): Promise<DownloadResult>` with one GET chain, `redirect:"manual"`, provider-scoped validation on every target, response-header/body deadlines, bounded streaming counter, and body cancellation on redirects.
- [ ] Step 4: Run focused tests; expected: PASS with exact `redirect_rejected`, `download_failed`, `deadline`, and `too_large` results.
- [ ] Step 5: Commit `feat: add bounded image source downloader`.

### Task 5: Validate image MIME, magic bytes, and dimensions

**Files**
- Create: `lib/images/formats.ts`
- Create: `lib/images/dimensions.ts`
- Test: `lib/images/formats.test.ts`
- Test: `lib/images/dimensions.test.ts`

**Interfaces**
- Consumes: bounded final GET bytes and normalized Content-Type.
- Produces: `validateImageBytes(bytes, contentType): ImageValidation`; `parseImageDimensions(bytes, mimeType): ImageDimensions` for JPEG/PNG/WebP.

```ts
export function validateImageBytes(bytes: Uint8Array, contentType: string | null): ImageValidation;
export function parseImageDimensions(bytes: Uint8Array, mimeType: "image/jpeg" | "image/png" | "image/webp"): ImageDimensions;
```

- [ ] Step 1: Add fixture bytes and failing tests for valid JPEG/PNG/WebP, MIME mismatch, truncated/malformed headers, invalid dimensions, and out-of-bounds parser reads.
- [ ] Step 2: Run `npm test -- lib/images/formats.test.ts lib/images/dimensions.test.ts`; expected: FAIL.
- [ ] Step 3: Implement marker traversal for JPEG, IHDR parsing for PNG, and VP8/VP8L/VP8X parsing for WebP using bounds checks and no image library.
- [ ] Step 4: Run focused tests; expected: PASS and no `sharp` or other production dependency added.
- [ ] Step 5: Commit `feat: validate image formats and dimensions`.

### Task 6: Hash bytes and build content-addressed keys

**Files**
- Create: `lib/images/hash.ts`
- Create: `lib/images/storage-key.ts`
- Test: `lib/images/hash.test.ts`
- Test: `lib/images/storage-key.test.ts`

**Interfaces**
- Consumes: validated bounded bytes and authoritative MIME.
- Produces: `sha256Hex(bytes): Promise<string>` and `buildImageStorageKey(hash, mime): string`.

```ts
export function sha256Hex(bytes: Uint8Array): Promise<string>;
export function buildImageStorageKey(hash: string, mimeType: "image/jpeg" | "image/png" | "image/webp"): string;
```

- [ ] Step 1: Write failing known-vector tests for lowercase 64-hex SHA-256, MIME extension mapping, key sharding, and rejection of invalid hash/MIME.
- [ ] Step 2: Run `npm test -- lib/images/hash.test.ts lib/images/storage-key.test.ts`; expected: FAIL.
- [ ] Step 3: Implement Web Crypto hashing and `images/sha256/ab/cd/<hash>.<ext>` construction; release the per-image byte buffer after use.
- [ ] Step 4: Run focused tests; expected: PASS.
- [ ] Step 5: Commit `feat: add content addressed image keys`.

### Task 7: Isolate R2 object operations and conditional creation

**Files**
- Create: `lib/images/r2-store.ts`
- Test: `lib/images/r2-store.test.ts`

**Interfaces**
- Consumes: injected `R2Bucket`, storage key/hash/MIME/size, `IMAGE_PUBLIC_BASE_URL`.
- Produces: `R2ImageStore.head(key): Promise<R2MetadataResult>` and `R2ImageStore.ensureObject(input): Promise<R2EnsureResult>`; business code never calls `bucket.head/put` directly.

```ts
export function createR2ImageStore(bucket: R2Bucket, publicBaseUrl: string): R2ImageStore;
```

- [ ] Step 1: Add fake-bucket tests for missing/matching/conflicting HEAD, conditional create success, precondition race followed by matching re-HEAD, conflicting re-HEAD, and operational PUT failure.
- [ ] Step 2: Run `npm test -- lib/images/r2-store.test.ts`; expected: FAIL.
- [ ] Step 3: Implement `createR2ImageStore(bucket, publicBaseUrl): R2ImageStore`, exact metadata comparison, `onlyIf: { etagDoesNotMatch: "*" }`, checksum, HTTP metadata, immutable cache control, and no overwrite/retry/delete behavior.
- [ ] Step 4: Run focused tests; expected: PASS for both writer race branches.
- [ ] Step 5: Commit `feat: add conditional R2 image store`.

### Task 8: Add D1 snapshot, identity, and optimistic repository

**Files**
- Create: `lib/db/repositories/image-ingest.ts`
- Test: `lib/db/repositories/image-ingest.test.ts`

**Interfaces**
- Consumes: Drizzle `GameHubDatabase`, `game_images`, `games`, candidate identity `(gameId,sourceUrl)`.
- Produces: `readImageIngestSnapshot(gameId)`, `findImageByIdentity(gameId,sourceUrl)`, `conditionallyCreateImage(input)`, `optimisticBindImage(snapshot, binding)` with changes 0/1/>1 classification.

```ts
export function createImageIngestRepository(db: GameHubDatabase): {
  readImageIngestSnapshot(gameId: number): Promise<ImageIngestSnapshot | null>;
  findImageByIdentity(gameId: number, sourceUrl: string): Promise<ImageIngestSnapshot["images"][number] | null>;
  conditionallyCreateImage(input: ImageBinding & { gameId: number; type: string; sourceUrl: string }): Promise<"created" | "race">;
  optimisticBindImage(snapshot: ImageIngestSnapshot["images"][number], binding: ImageBinding): Promise<"applied" | "write_conflict" | "invariant_failure">;
};
```

- [ ] Step 1: Write failing D1 tests for one-game snapshot, missing game, candidate rows, all three identity cases, conditional cover/hero insert race reread, complete relevant-field compare, stale update, and partial metadata detection.
- [ ] Step 2: Run `npm test -- lib/db/repositories/image-ingest.test.ts`; expected: FAIL.
- [ ] Step 3: Implement `readImageIngestSnapshot(gameId): Promise<ImageIngestSnapshot>`, `findImageByIdentity(gameId,sourceUrl)`, `conditionallyCreateImage(input): Promise<"created"|"race">`, and `optimisticBindImage(snapshot,binding:ImageBinding): Promise<"applied"|"write_conflict"|"invariant_failure">`. Use explicit selects/updates comparing every listed field, including NULL predicates. Map 0 to `write_conflict`, 1 to applied, >1 to invariant failure.
- [ ] Step 4: Run focused tests; expected: PASS with no new unique index and no silent dedupe.
- [ ] Step 5: Commit `feat: add optimistic image ingest repository`.

### Task 9: Compose planner and execution/idempotency service

**Files**
- Create: `lib/images/types.ts`
- Create: `lib/images/plan.ts`
- Create: `lib/images/service.ts`
- Test: `lib/images/plan.test.ts`
- Test: `lib/images/service.test.ts`

**Interfaces**
- Consumes: candidate resolver, downloader, formats, hash/key, R2 store, image-ingest repository, clock.
- Produces: `planImageIngest(snapshot): ImagePlan`; `createImageIngestService(deps).ingest(gameId,{write,signal}): Promise<ImageResult>`.

```ts
export function planImageIngest(snapshot: ImageIngestSnapshot, dryRun: boolean): ImagePlan;
export function createImageIngestService(deps: ImageIngestDependencies): { ingest(gameId: number, options: { write: boolean; signal?: AbortSignal }): Promise<ImageResult> };
```

- [ ] Step 1: Write failing tests for fresh ingest, already-ingested, deduplicated, restore, source_changed, inconsistent_state, skipped for non-actionable candidates, storage conflicts, D1 failure orphan behavior, per-image failure isolation, game deadline, and game-level 128-image failure.
- [ ] Step 2: Run `npm test -- lib/images/plan.test.ts lib/images/service.test.ts`; expected: FAIL.
- [ ] Step 3: Implement `planImageIngest(snapshot, dryRun): ImagePlan` and `createImageIngestService(deps).ingest(gameId, options): Promise<ImageResult>` with deterministic planning, R2-first execution, serial processing, five-minute/30-second deadlines, explicit dry-run mutation guards, and fixed outcome enums from the Spec.
- [ ] Step 4: Run focused tests; expected: PASS, with only the fixed V2.6 image outcome enum emitted.
- [ ] Step 5: Commit `feat: add image ingest planning and service`.

### Task 10: Reuse and extend safe presentation redaction

**Files**
- Modify: `lib/verifiers/official-links/presentation.ts`
- Create: `lib/images/presentation.ts`
- Test: `lib/verifiers/official-links/presentation.test.ts`
- Test: `lib/images/presentation.test.ts`

**Interfaces**
- Consumes: runtime ImagePlan/ImageResult and existing sanitizer utility.
- Produces: sanitized JSON DTO and human formatter covering original URL, Location, redirectChain, final URL, attempts, plan, and errors.

```ts
export function presentImageResult(result: ImageResult): PresentedImageResult;
export function formatImageResultHuman(result: PresentedImageResult): string;
```

- [ ] Step 1: Add failing tests for every sensitive query key, credentials, fragments, malformed URLs, redirect locations, nested errors, JSON output, and human output.
- [ ] Step 2: Run `npm test -- lib/verifiers/official-links/presentation.test.ts lib/images/presentation.test.ts`; expected: FAIL for image DTO coverage.
- [ ] Step 3: Reuse `sanitizeUrlForPresentation(raw): string` from `lib/verifiers/official-links/presentation.ts` (malformed sentinel `[REDACTED_URL]`) through one shared presentation adapter; ensure `username/password` and fragments never appear and the sensitive-key list cannot drift.
- [ ] Step 4: Run focused tests; expected: PASS with no exact internal URL exposed outside transport/concurrency code.
- [ ] Step 5: Commit `feat: add safe image result presentation`.

### Task 11: Implement Worker authentication, parser, handler, and config

**Files**
- Create: `workers/image-ingest/src/auth.ts`
- Create: `workers/image-ingest/src/request.ts`
- Create: `workers/image-ingest/src/index.ts`
- Create: `workers/image-ingest/wrangler.jsonc`
- Test: `workers/image-ingest/src/auth.test.ts`
- Test: `workers/image-ingest/src/request.test.ts`
- Test: `workers/image-ingest/src/index.test.ts`

**Interfaces**
- Consumes: `Env { DB:D1Database; IMAGES_BUCKET:R2Bucket; IMAGE_PUBLIC_BASE_URL:string; IMAGE_INGEST_TOKEN:string }`, `POST /internal/images/ingest`.
- Produces: `authenticateBearer(request,expected): Promise<boolean>`; strict `{gameId:number,write:boolean}` parser; sanitized JSON HTTP response from the ingest service.

```ts
export function authenticateBearer(request: Request, expected: string): Promise<boolean>;
export function parseWorkerRequest(request: Request): Promise<WorkerRequestDto>;
export function handleImageIngest(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response>;
```

- [ ] Step 1: Write failing tests for missing/invalid/valid Bearer token, query/body token rejection, unknown request fields, arbitrary URL/provider/storage key rejection, body hard limit, wrong method/path, and no token in logs/DTO/errors.
- [ ] Step 2: Run `npm test -- workers/image-ingest/src/auth.test.ts workers/image-ingest/src/request.test.ts workers/image-ingest/src/index.test.ts`; expected: FAIL.
- [ ] Step 3: Implement `authenticateBearer(request, expected): Promise<boolean>`, `parseWorkerRequest(request): Promise<WorkerRequestDto>`, and `handleImageIngest(request, env:WorkerEnv, ctx): Promise<Response>`. Reject `Content-Length > 1024` before parse; for absent Content-Length stream/read at most 1,025 bytes and reject if more than 1,024; accept exact 1,024 only when JSON is valid. Use Web Crypto-compatible length-safe constant-time comparison, strict schema, route dispatch, dependency injection, and mutation guard.
- [ ] Step 4: Add isolated Worker Wrangler bindings for local/preview/production names without committed secrets, R2 `IMAGES_BUCKET`, D1 `DB`, and `IMAGE_PUBLIC_BASE_URL`; do not alter root `wrangler.jsonc`.
- [ ] Step 5: Run `npx wrangler deploy --dry-run --config workers/image-ingest/wrangler.jsonc`; expected: exit 0 after bundle/binding validation and no Worker, bucket, secret, or deployment is created.
- [ ] Step 6: Run focused Worker tests; expected: PASS and no production resource is created.
- [ ] Step 7: Commit `feat: add authenticated image ingest worker`.

### Task 12: Add authenticated CLI client and local environment safety

**Files**
- Create: `scripts/ingest-images.ts`
- Create: `scripts/ingest-images.test.ts`
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `.dev.vars.example`

**Interfaces**
- Consumes: one positive game ID, `--write`, `--json`, explicit Worker endpoint/token environment.
- Produces: authenticated HTTP request to the Worker and sanitized human/JSON output; no D1/R2/download implementation.

```ts
export function parseImageIngestArgs(argv: string[], env: NodeJS.ProcessEnv): CliOptions;
export function runImageIngestCli(options: CliOptions, fetchImpl?: typeof fetch): Promise<void>;
```

- [ ] Step 1: Write failing parser/client tests for default dry-run, `--write`, `--json`, duplicate/unknown flags, one-ID rule, missing endpoint/token, local default selection, explicit production opt-in, and mutation adapter absence.
- [ ] Step 2: Run `npm test -- scripts/ingest-images.test.ts`; expected: FAIL.
- [ ] Step 3: Implement `parseImageIngestArgs(argv, env): CliOptions` and `runImageIngestCli(options): Promise<void>` using `fetch`, `Authorization: Bearer`, safe environment resolution, and non-leaking error formatting. The default endpoint is local Worker only; production requires both explicit endpoint and token.
- [ ] Step 4: Add `"images:ingest": "tsx scripts/ingest-images.ts"`; add these exact ignore rules:
  ```gitignore
  workers/image-ingest/.dev.vars
  workers/image-ingest/.dev.vars.*
  !workers/image-ingest/.dev.vars.example
  ```
  Commit only `workers/image-ingest/.dev.vars.example` containing `IMAGE_INGEST_TOKEN=replace-me` and non-production local placeholders.
- [ ] Step 5: Run focused tests; expected: PASS, proving the CLI has no D1/R2 client and cannot call Wrangler remote.
- [ ] Step 6: Commit `feat: add authenticated image ingest cli`.

### Task 13: Add local integration, migration preflight, and Worker resource checks

**Files**
- Create: `scripts/check-image-migration.ts`
- Create: `test/helpers/local-image-worker.ts`
- Create: `test/images/worker-d1-r2.integration.test.ts`
- Create: `test/images/migration-preflight.test.ts`

**Interfaces**
- Consumes: local Wrangler D1/R2 bindings, migration 4, Worker handler, repository/service.
- Produces: deterministic local end-to-end verification and a read-only target-D1 preflight report.

```ts
export function runImageMigrationPreflight(): Promise<{ legacyStorageUrlCount: number; duplicateIdentityCount: number }>;
```

- [ ] Step 1: Write failing integration tests that apply local migrations, exercise FK cascade and all new checks, run dry-run with real local D1 reads/R2 HEAD, and assert zero local D1 writes/R2 PUTs.
- [ ] Step 2: Run `npm test -- test/images/worker-d1-r2.integration.test.ts test/images/migration-preflight.test.ts`; expected: FAIL until local Worker adapters exist.
- [ ] Step 3: Implement `scripts/check-image-migration.ts` as the sole operator-facing preflight owner; it calls `readImageMigrationPreflight`, prints both counts, exits non-zero on either non-zero result, and never cleans/dedupes data. Deployment order is preflight → both counts exactly zero → apply migration 4; any non-zero result is STOP.
- [ ] Step 4: Implement `test/helpers/local-image-worker.ts` to spawn `npx wrangler dev --config workers/image-ingest/wrangler.jsonc --local --persist-to /private/tmp/gamehub-v26-worker-test-state --port 8796`, poll `http://127.0.0.1:8796/` until a non-connection response, seed local D1 through the Worker’s test-only injected seed adapter, invoke HTTP, inspect local state through a read-only test adapter, and terminate the child in `finally`; failed startup also kills the child and removes only `/private/tmp/gamehub-v26-worker-test-state`.
- [ ] Step 5: Add integration tests using that helper: seed D1/R2 fixtures, invoke dry-run/write over localhost, assert result and state, and assert no remote bindings. Run `npm run db:migrate:local && npm test -- test/images/worker-d1-r2.integration.test.ts test/images/migration-preflight.test.ts`; expected: PASS with migration count 4 and foreign-key checks clean.
- [ ] Step 6: Commit `test: verify local image ingest resources`.

### Task 14: Targeted security review and complete regression verification

**Files**
- Create: `test/images/security-review.test.ts`
- Modify: `README.md` only for verified local CLI/Worker usage and non-production warnings

**Interfaces**
- Consumes: all V2.6 modules and test fixtures from Tasks 1–13.
- Produces: security review evidence and a merge-gate report.

- [ ] Step 1: Add targeted tests for arbitrary URL injection, allowlist/redirect bypass, credentials, URL length, Content-Length and stream cap bypass, MIME spoof, parser bounds, R2 overwrite/TOCTOU, stale D1 overwrite, identity race, dry-run mutation, production endpoint selection, token/signed-URL leakage, partial metadata, source_changed restore, and deadline cleanup.
- [ ] Step 2: Run `npm test -- test/images/security-review.test.ts`; expected: PASS with no Critical or Important findings.
- [ ] Step 3: Run `npm test`; expected: all existing and new tests pass.
- [ ] Step 4: Run `npm run typecheck`; expected: exit 0 for Next app, shared libraries, and Worker types.
- [ ] Step 5: Run `npm run lint`; expected: exit 0 with no new warnings requiring suppression.
- [ ] Step 6: Run `npm run build`; expected: exit 0 without changing Next/vinext architecture.
- [ ] Step 7: Run `npm audit` and `npm audit --omit=dev`; expected: preserve the accepted pre-existing dev-only drizzle-kit → @esbuild-kit → esbuild exception and production audit 0; do not modify dependencies or lockfile.
- [ ] Step 8: Run `git diff --exit-code 61930617f966f8a3c1f1134f932162b5211349a9 -- package-lock.json`; expected: no dependency lock change, then record migration count 4 and the new post-implementation schema SHA-1.
- [ ] Step 9: If implementation reveals a required Design change, STOP and report the discrepancy, affected Spec section, recommended design change, and implementation impact. Do not modify the approved Design or Plan autonomously; resume only after a separately approved Spec commit.
- [ ] Step 10: Commit `test: verify V2.6 image system merge gate`.

## Plan Self-Review

- Spec coverage: every schema, provider, redirect, bounded GET, parser, hash, R2 race, D1 snapshot, identity, idempotency, DTO, auth, CLI, environment, limit, migration preflight, and security requirement has a named task and test command.
- Placeholder scan: no unresolved marker, vague handling instruction, or unbounded testing instruction appears in the plan.
- Interface consistency: Task 3 candidate types feed Task 9; Tasks 4–7 provide the exact downloader/format/hash/R2 contracts consumed by Task 9; Task 8 supplies the repository operations; Tasks 10–12 consume the result DTOs and service.
- Dependency consistency: each task depends only on earlier committed interfaces; every task has focused failing-test, implementation, passing-test, and commit steps.
- File-path consistency: existing paths were mapped from the repository; all new Worker/image paths are explicit creates, and root Wrangler is not repurposed.
- Command consistency: all commands use the repository’s Vitest/npm scripts; no pytest/jest or unconfigured Worker command is required.
- Enum consistency: no Official Link Verification statuses appear in image outcomes; `deadline` is present in both service behavior and the fixed per-image enum; `image_limit_exceeded` is game-level only.
- Identity consistency: all dedupe, cover/hero reuse, conditional insert, race recovery, and preflight use `(game_id,source_url)`.
- Boundary consistency: CLI has no storage/network implementation and only calls an explicitly configured Worker; dry-run/write semantics are enforced by the Worker.
- R2 consistency: HEAD metadata comparison precedes create-only conditional PUT; failed preconditions always re-HEAD and never overwrite.
