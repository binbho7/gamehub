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
- Create: `drizzle/0003_<generated-name>.sql`
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/validation.ts`
- Test: `test/migrations/game-images-r2.test.ts`
- Test: `lib/db/validation.test.ts`

**Interfaces**
- Consumes: existing nine-column `game_images` schema and migration metadata.
- Produces: typed fields `sourceProvider`, `storageKey`, `contentHash`, `mimeType`, `fileSize`, `updatedAt`; migration count 4; validation schemas for provider/storage invariants.

- [ ] Step 1: Write failing migration tests that create a pre-migration database, insert rows covering nullable dimensions, ordering, FK cascade, and legacy values, then assert the post-migration table has the explicit 15 columns, copied values, defaults, checks, indexes, and `PRAGMA foreign_key_check` success. Add failing tests for `storage_url IS NOT NULL` and duplicate `(game_id,source_url)` preflight returning a hard stop without cleanup.
- [ ] Step 2: Run `npm test -- test/migrations/game-images-r2.test.ts lib/db/validation.test.ts`; expected: FAIL because migration 4 and new validation fields do not exist.
- [ ] Step 3: Add the six Drizzle fields and matching Zod rules. Generate then inspect migration SQL; replace generated table-copy SQL if needed so source/destination lists are explicitly `id, game_id, type, source_url, source_provider, storage_url, storage_key, content_hash, mime_type, file_size, width, height, sort_order, created_at, updated_at`. Preserve existing checks/indexes and add provider, all-null/all-present storage, positive size, MIME, and lowercase hash checks.
- [ ] Step 4: Implement the read-only preflight query and fail-closed migration guard; do not normalize or delete legacy rows. Update Drizzle metadata snapshots for migration 3→4.
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

- [ ] Step 1: Write failing tests for exact hosts, HTTPS/credential/fragment/length rejection, unknown provider, source URL host inference refusal, deterministic ordering, 128-image preflight, and cover/hero identity cases A/B/C from the Spec.
- [ ] Step 2: Run `npm test -- lib/images/source-policy.test.ts lib/images/candidates.test.ts`; expected: FAIL because modules do not exist.
- [ ] Step 3: Implement exact allowlists (`cdn.akamai.steamstatic.com`, `images.igdb.com`), `(game_id,source_url)` first-wins dedupe, missing cover/hero planning, and game-level `image_limit_exceeded`.
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

- [ ] Step 1: Write deterministic mock-fetch tests for manual GET redirects, redirect-body cancellation, all five redirect statuses, non-followed 3xx, malformed/missing Location, loop, cross-provider, downgrade, four-hop cap, timeout mapping, Content-Length cap, no Content-Length streaming, and no second GET/HEAD.
- [ ] Step 2: Run `npm test -- lib/images/downloader.test.ts`; expected: FAIL because the downloader is absent.
- [ ] Step 3: Implement one GET chain with `redirect:"manual"`, provider-scoped validation on every target, response-header and body deadlines, bounded streaming counter, and body cancellation on redirects.
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

- [ ] Step 1: Add fake-bucket tests for missing/matching/conflicting HEAD, conditional create success, precondition race followed by matching re-HEAD, conflicting re-HEAD, and operational PUT failure.
- [ ] Step 2: Run `npm test -- lib/images/r2-store.test.ts`; expected: FAIL.
- [ ] Step 3: Implement exact metadata comparison and `onlyIf: { etagDoesNotMatch: "*" }`, checksum, HTTP metadata, immutable cache control, and no overwrite/retry/delete behavior.
- [ ] Step 4: Run focused tests; expected: PASS for both writer race branches.
- [ ] Step 5: Commit `feat: add conditional R2 image store`.

### Task 8: Add D1 snapshot, identity, and optimistic repository

**Files**
- Create: `lib/db/repositories/image-ingest.ts`
- Test: `lib/db/repositories/image-ingest.test.ts`

**Interfaces**
- Consumes: Drizzle `GameHubDatabase`, `game_images`, `games`, candidate identity `(gameId,sourceUrl)`.
- Produces: `readImageIngestSnapshot(gameId)`, `findImageByIdentity(gameId,sourceUrl)`, `conditionallyCreateImage(input)`, `optimisticBindImage(snapshot, binding)` with changes 0/1/>1 classification.

- [ ] Step 1: Write failing D1 tests for one-game snapshot, missing game, candidate rows, all three identity cases, conditional cover/hero insert race reread, complete relevant-field compare, stale update, and partial metadata detection.
- [ ] Step 2: Run `npm test -- lib/db/repositories/image-ingest.test.ts`; expected: FAIL.
- [ ] Step 3: Implement explicit selects and updates comparing `id,game_id,type,source_provider,source_url,storage_url,storage_key,content_hash,mime_type,file_size,width,height,sort_order,created_at,updated_at`, including NULL predicates. Map 0 to `write_conflict`, 1 to applied, >1 to invariant failure.
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

- [ ] Step 1: Write failing tests for fresh ingest, already-ingested, deduplicated, restore, source_changed, inconsistent_state, skipped/manual preservation, storage conflicts, D1 failure orphan behavior, per-image failure isolation, game deadline, and game-level 128-image failure.
- [ ] Step 2: Run `npm test -- lib/images/plan.test.ts lib/images/service.test.ts`; expected: FAIL.
- [ ] Step 3: Implement deterministic planning, R2-first execution, serial processing, five-minute/30-second deadlines, explicit dry-run mutation guards, and fixed outcome enums from the Spec.
- [ ] Step 4: Run focused tests; expected: PASS, with no link-verifier vocabulary (`broken`, `reachable_but_unverified`, `verified`, `temporarily_unavailable`).
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

- [ ] Step 1: Add failing tests for every sensitive query key, credentials, fragments, malformed URLs, redirect locations, nested errors, JSON output, and human output.
- [ ] Step 2: Run `npm test -- lib/verifiers/official-links/presentation.test.ts lib/images/presentation.test.ts`; expected: FAIL for image DTO coverage.
- [ ] Step 3: Extract or reuse one shared redaction implementation so the sensitive-key list cannot drift; ensure `username/password` and fragments never appear and malformed inputs become `[REDACTED_URL]`.
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

- [ ] Step 1: Write failing tests for missing/invalid/valid Bearer token, query/body token rejection, unknown request fields, arbitrary URL/provider/storage key rejection, body hard limit, wrong method/path, and no token in logs/DTO/errors.
- [ ] Step 2: Run `npm test -- workers/image-ingest/src/auth.test.ts workers/image-ingest/src/request.test.ts workers/image-ingest/src/index.test.ts`; expected: FAIL.
- [ ] Step 3: Implement Web Crypto-compatible length-safe constant-time token comparison, strict body parser with an explicit small payload cap, route dispatch, dependency injection, and mutation guard.
- [ ] Step 4: Add isolated Worker Wrangler bindings for local/preview/production names without committed secrets, R2 `IMAGES_BUCKET`, D1 `DB`, and `IMAGE_PUBLIC_BASE_URL`; do not alter root `wrangler.jsonc`.
- [ ] Step 5: Run focused Worker tests; expected: PASS and no production resource is created.
- [ ] Step 6: Commit `feat: add authenticated image ingest worker`.

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

- [ ] Step 1: Write failing parser/client tests for default dry-run, `--write`, `--json`, duplicate/unknown flags, one-ID rule, missing endpoint/token, local default selection, explicit production opt-in, and mutation adapter absence.
- [ ] Step 2: Run `npm test -- scripts/ingest-images.test.ts`; expected: FAIL.
- [ ] Step 3: Implement strict CLI parsing and HTTP client using `fetch`, `Authorization: Bearer`, safe environment resolution, and non-leaking error formatting. The default endpoint must be local Worker only; production requires both explicit endpoint and token.
- [ ] Step 4: Add `"images:ingest": "tsx scripts/ingest-images.ts"`; ignore `.dev.vars*` and commit only `.dev.vars.example` with `IMAGE_INGEST_TOKEN=replace-me` and local endpoint placeholders.
- [ ] Step 5: Run focused tests; expected: PASS, proving the CLI has no D1/R2 client and cannot call Wrangler remote.
- [ ] Step 6: Commit `feat: add authenticated image ingest cli`.

### Task 13: Add local integration, migration preflight, and Worker resource checks

**Files**
- Create: `scripts/check-image-migration.ts`
- Create: `test/images/worker-d1-r2.integration.test.ts`
- Create: `test/images/migration-preflight.test.ts`

**Interfaces**
- Consumes: local Wrangler D1/R2 bindings, migration 4, Worker handler, repository/service.
- Produces: deterministic local end-to-end verification and a read-only target-D1 preflight report.

- [ ] Step 1: Write failing integration tests that apply local migrations, exercise FK cascade and all new checks, run dry-run with real local D1 reads/R2 HEAD, and assert zero local D1 writes/R2 PUTs.
- [ ] Step 2: Run `npm test -- test/images/worker-d1-r2.integration.test.ts test/images/migration-preflight.test.ts`; expected: FAIL until local Worker adapters exist.
- [ ] Step 3: Implement the read-only preflight script for `storage_url IS NOT NULL` and duplicate `(game_id,source_url)` counts; any non-zero result exits non-zero and never cleans data.
- [ ] Step 4: Add local-only Wrangler execution instructions/tests using non-persistent or explicitly named local state; reject remote bindings/config flags.
- [ ] Step 5: Run `npm run db:migrate:local && npm test -- test/images/worker-d1-r2.integration.test.ts test/images/migration-preflight.test.ts`; expected: PASS with migration count 4 and foreign-key checks clean.
- [ ] Step 6: Commit `test: verify local image ingest resources`.

### Task 14: Targeted security review and complete regression verification

**Files**
- Modify: `docs/superpowers/specs/2026-09-08-gamehub-v2-6-r2-image-system-design.md` only if an implementation discrepancy is discovered
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
- [ ] Step 8: Run `git diff --exit-code <V2.5-baseline> -- package-lock.json`; expected: no dependency lock change, then record migration count 4 and the new post-implementation schema SHA-1.
- [ ] Step 9: Commit `test: verify V2.6 image system merge gate`.

## Plan Self-Review

- Spec coverage: every schema, provider, redirect, bounded GET, parser, hash, R2 race, D1 snapshot, identity, idempotency, DTO, auth, CLI, environment, limit, migration preflight, and security requirement has a named task and test command.
- Placeholder scan: no `TBD`, `TODO`, `later`, vague “appropriate” handling, or unbounded “add tests” step appears in the plan.
- Interface consistency: Task 3 candidate types feed Task 9; Tasks 4–7 provide the exact downloader/format/hash/R2 contracts consumed by Task 9; Task 8 supplies the repository operations; Tasks 10–12 consume the result DTOs and service.
- Dependency consistency: each task depends only on earlier committed interfaces; every task has focused failing-test, implementation, passing-test, and commit steps.
- File-path consistency: existing paths were mapped from the repository; all new Worker/image paths are explicit creates, and root Wrangler is not repurposed.
- Command consistency: all commands use the repository’s Vitest/npm scripts; no pytest/jest or unconfigured Worker command is required.
- Enum consistency: no Official Link Verification statuses appear in image outcomes; `deadline` is present in both service behavior and the fixed per-image enum; `image_limit_exceeded` is game-level only.
- Identity consistency: all dedupe, cover/hero reuse, conditional insert, race recovery, and preflight use `(game_id,source_url)`.
- Boundary consistency: CLI has no storage/network implementation and only calls an explicitly configured Worker; dry-run/write semantics are enforced by the Worker.
- R2 consistency: HEAD metadata comparison precedes create-only conditional PUT; failed preconditions always re-HEAD and never overwrite.

