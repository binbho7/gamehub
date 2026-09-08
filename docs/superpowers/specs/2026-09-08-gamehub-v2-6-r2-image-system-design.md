# GameHub V2.6 R2 Image System Design

Status: design only; implementation requires human approval.

## 1. Goals and boundaries

V2.6 adds a dedicated `GameHub Image Ingest Worker` that validates canonical Steam/IGDB image URLs, downloads original bytes, content-addresses them by SHA-256, stores them in R2, and binds metadata in D1. The Next application remains the owner of game and enrichment workflows; it does not gain a direct R2 write path.

Scope is one existing game per invocation, at most 128 eligible image rows, serial image processing (`concurrency=1`), and no image creation/deletion/replacement except the explicitly planned cover/hero missing-row insert. There is no refresh, force, resize, transform, GC, bulk job, Cron, Admin UI, or remote D1 write from the CLI.

The old product-roadmap idea of `games/{game_id}/...webp` is superseded: V2.6 stores original bytes under a global content-addressed key and keeps `games.cover_url`/`hero_url` as provider URLs.

## 2. Existing model and migration

`game_images` currently has nine columns, two ordinary indexes, a cascading `game_id` foreign key, and four checks (type, width, height, sort order). Migration 3→4 rebuilds only this table using explicit source and destination column lists; it never uses `SELECT *`, reorders IDs, normalizes values, or drops historical rows.

The destination columns are:

`id, game_id, type, source_url, source_provider, storage_url, storage_key, content_hash, mime_type, file_size, width, height, sort_order, created_at, updated_at`.

Historical rows copy every old value verbatim, set `source_provider`, `storage_key`, `content_hash`, `mime_type`, and `file_size` to NULL, and set `updated_at=created_at`. New rows default `updated_at` to the same UTC-millisecond expression as `created_at`. Existing PK/FK, cascade behavior, defaults, both ordinary indexes, and all four existing checks are recreated. The type check is unchanged; the only status-like expansion is in application metadata, not this table.

New checks are: provider NULL or `steam|igdb`; storage fields all NULL or all non-NULL; complete storage has `file_size>0`, MIME `image/jpeg|image/png|image/webp`, and a lowercase 64-character hexadecimal SHA-256. `storage_key` and `content_hash` are deliberately not unique.

Before applying the migration, run a read-only target-D1 gate for non-NULL legacy `storage_url` and duplicate image identities. If any non-NULL legacy URL cannot be proven to have matching trusted metadata, stop: do not clear it, guess a hash, or invent provenance. If duplicate `(game_id,source_url,type)` rows exist, stop rather than silently deduplicate. This repository has no local `.wrangler` database, so production/preview counts remain an explicit deployment prerequisite.

The migration count changes from 3 to 4 and the schema SHA-1 changes after implementation. V2.6 merge must record a new stable hash baseline. No production dependency is added.

`lib/db/validation.ts` accepts the existing image fields plus the new optional metadata and enforces the same provider, MIME, hash, size, and all-null/all-present rules. Steam and IGDB insert paths use explicit column/value lists and set provenance for newly created rows; historical unknown provenance remains NULL.

## 3. Provider policy and candidate resolution

Only `steam` and `igdb` are accepted. The strict allowlist is:

| provider | exact HTTPS host |
|---|---|
| steam | `cdn.akamai.steamstatic.com` |
| igdb | `images.igdb.com` |

No wildcard subdomains, alternate CDN hosts, or inferred historical provider are accepted. Existing `games.cover_url`, `games.hero_url`, and exact `game_images.source_url` values are mapped only when the host matches the provider table; otherwise the candidate is `source_rejected`. A source URL does not become trusted merely because it resembles a provider URL.

Candidate order is deterministic: cover, hero, then existing images ordered by `(sort_order,id)`. A missing cover/hero row is planned only when its scalar game URL is an allowed provider URL. Existing rows are never replaced. If more than 128 eligible rows are found, return `image_limit_exceeded` before any network or R2 mutation.

## 4. Worker architecture and configuration

The Worker lives under `workers/image-ingest/` with its own Wrangler configuration. It binds `DB`, `IMAGES_BUCKET`, and non-secret `IMAGE_PUBLIC_BASE_URL`; `IMAGE_INGEST_TOKEN` is a secret binding. The root Next Wrangler file is not repurposed. Production uses a custom R2 domain only; `r2.dev` is forbidden. Local and preview configurations must bind non-production resources explicitly.

The only route is `POST /internal/images/ingest`. The JSON body is exactly `{gameId:number, write:boolean}`; unknown fields, arrays, arbitrary URLs, storage keys, provider overrides, and multiple IDs are rejected. Every request, including dry-run, requires `Authorization: Bearer <IMAGE_INGEST_TOKEN>`. The token is never placed in a query/body, logs, DTOs, or errors; comparison is length-safe and constant-time over normalized bytes.

The Worker uses Web `fetch` for outbound transport, not Node `http`, `https`, DNS, sockets, or the V2.5 resolver. It is HTTPS-only, manually follows redirects, and applies the same provider policy on every hop.

## 5. URL and redirect security

Parse each URL before use. Reject credentials, fragments, non-HTTPS schemes, malformed URLs, URL length over 2,048 characters, and hosts outside the exact provider table. Follow only 301, 302, 303, 307, and 308. Missing or malformed `Location` is `invalid_redirect` and yields `broken`; 300, 304, and every other 3xx are not followed and yield `reachable_but_unverified`. Redirects are capped at three (four total HTTP hops), loops are rejected, HTTPS downgrade is forbidden, and every hop must remain on the same provider host.

The downloader sends HEAD first. HEAD is accepted only when headers and status are sufficient for validation. Otherwise it performs one bounded GET. GET consumes the body exactly once as a stream; it never buffers an unbounded response and never performs a second GET for retry. `Content-Length > 8,388,608` is rejected before reading; the stream is aborted once the exact 8 MiB cap is exceeded.

## 6. Image validation and storage

Accepted formats are JPEG, PNG, and WebP. Normalized `Content-Type` must match magic bytes; mismatch is `mime_mismatch` and cannot reach R2. JPEG/PNG/WebP dimensions are parsed from bounded headers without full decode or resize; parsed bytes are authoritative and provider dimensions are only a warning.

SHA-256 is computed with Web Crypto and rendered as lowercase hex. The key is `images/sha256/<hash[0..1]>/<hash[2..3]>/<fullhash>.<ext>`, where the extension comes from verified MIME. R2 PUT supplies actual `Content-Type`, `Cache-Control: public, max-age=31536000, immutable`, and custom metadata `sha256` and `size`.

R2 `HEAD` runs before PUT. A missing key is PUT once. An existing key is `deduplicated` only when size, hash, MIME, and relevant metadata match exactly; otherwise return `storage_conflict` and never overwrite. R2-first/D1-second ordering is mandatory. A D1 failure after R2 success leaves a reusable orphan; no delete or GC is attempted.

## 7. Idempotency and optimistic writes

For each row: all storage fields NULL means ingest; all present plus matching R2 metadata means `already_ingested` without download; complete D1 metadata with missing R2 downloads and restores only when the source bytes hash to the recorded hash; a changed hash is `source_changed`/`storage_recovery_conflict`; partial metadata is `inconsistent_state`.

Before update, read a snapshot containing at least `id,game_id,type,source_provider,source_url,storage_url,storage_key,content_hash,mime_type,file_size,width,height,sort_order,created_at,updated_at`. Update predicates compare every relevant field and `updated_at`, treating NULL explicitly. Exactly one affected row is applied; zero is `write_conflict`; more than one is an invariant failure. Missing cover/hero creation uses an atomic conditional insert against the game snapshot and exact `(game_id,source_url,type)` identity, then rereads to classify a race; no global unique index is added.

## 8. DTOs, statuses, and errors

Runtime `ImageAttempt` contains exact internal URL, sanitized presentation URL, provider, hop status, status code, headers summary, redirect chain, final URL, selected MIME, byte count, hash, dimensions, remote address (if available), timing, and error code. `ImagePlan` contains game snapshot, candidates, reasons, and whether each action is read-only or write. `ImageResult` contains per-image outcome, sanitized attempts/chain/final URL, and a game summary (`completed`, `partial`, or `failed`). Exact URLs remain internal for transport and compare-before-update only.

Outcomes include `ingested`, `deduplicated`, `already_ingested`, `restored`, `skipped`, `inconsistent_state`, `source_rejected`, `download_failed`, `invalid_image`, `too_large`, `mime_mismatch`, `storage_conflict`, `source_changed`, `redirect_rejected`, `write_conflict`, and `image_limit_exceeded`. One image failure does not roll back earlier successes.

Presentation sanitization is mandatory for human and JSON output: redact case-insensitive query keys `token`, `access_token`, `auth`, `authorization`, `key`, `api_key`, `apikey`, `signature`, `sig`, `secret`, `credential`, `x-amz-signature`, and `x-amz-credential` as `[REDACTED]`; never output username/password or fragments. Malformed URLs are fail-closed (`[INVALID_URL]`) without echoing the input. This applies to original URL, redirect `Location`, attempts, redirectChain, finalUrl, plans, and errors.

## 9. Dry-run, write mode, and CLI

`npm run images:ingest -- 123` performs real HTTP validation, redirects, bounded download, MIME/dimension/hash work, and R2 HEAD calls while guaranteeing zero R2 PUTs and zero D1 insert/update/delete. `--write` is required for mutations; `--json` uses the same sanitizer. The CLI accepts one positive integer game ID only and rejects arbitrary source URLs, providers, keys, and remote-D1 flags. The Worker receives the same plan/write semantics; CLI writes remain local D1 only.

## 10. Limits and resource model

Implementation constants are: 8 MiB exact body cap, 2,048-character URL/Location cap, three redirects/four hops, one image at a time, and 128 eligible images per game. The 128 bound covers current Steam (up to 52) plus IGDB (up to 71) canonical candidates with a small safety margin, while preventing the repository’s otherwise unbounded generic image API from creating an unbounded Worker request.

Cloudflare documents 128 MB isolate memory, six simultaneous outgoing connections, and plan-dependent subrequest quotas; R2 `head`/`put` expose object metadata and conditional writes. The serial design intentionally uses one connection and bounded streaming, and the implementation must configure an invocation CPU limit and abort controller below the account’s plan limit. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), and [R2 platform limits](https://developers.cloudflare.com/r2/platform/limits/).

Because 128 candidates can require four fetch hops plus R2/D1 calls per image, production rollout requires a Workers Paid plan (or an explicitly increased subrequest limit); the Free 50-subrequest quota is not sufficient for worst-case single-game processing. The service still enforces a five-minute game deadline, a 30-second per-image deadline, a ten-second response-header deadline, and marks unstarted candidates `deadline`/`skipped` in a partial result. A bounded byte buffer no larger than 8 MiB is released after each image for Web Crypto hashing; no response body is retained across images.

## 11. Testing and observability

Tests cover migration preservation and foreign-key checks; legacy non-null storage preflight; provider/host rejection; HTTPS, credentials, fragments, length, redirect status/location/loop/downgrade policy; HEAD/GET fallback; streaming boundaries at cap and cap+1; MIME/magic mismatch; JPEG/PNG/WebP dimensions; hash/key determinism; R2 missing/matching/conflicting HEAD and conditional PUT; all idempotency states; D1 compare-before-update and create races; dry-run zero-mutation; auth failures; exact candidate limits; and sanitizer non-leakage across original URLs, redirect locations, attempts, chains, final URLs, JSON, and human output.

Logs contain only gameId, imageId, provider, safe hostname, outcome code, size, MIME, and hash prefix. Tokens, credentials, full URLs, response bodies, and full hashes are excluded. Metrics distinguish source rejection, download, validation, storage, and D1 conflict failures.

## 12. Expected implementation files (design only)

Expected changes are the migration and schema/validation/repository updates, provider provenance updates, pure image policy/redirect/stream/format/hash modules, D1/R2 adapters, planner/service/DTO/presentation modules, the Worker entrypoint and isolated Wrangler config, CLI script and tests, plus documentation for local configuration. No production bucket, secret, deployment, remote D1 write, or dependency addition is part of V2.6 design approval.

## 13. Final security assessment

Critical: 0. Important: 0 in this design, conditional on the target-D1 non-null `storage_url` gate passing before migration. The design fails closed on provider ambiguity, unsafe redirects, malformed URLs, size/MIME spoofing, storage conflicts, partial metadata, and optimistic races. No feasibility blocker was found; the only explicit pre-deployment stop condition is untrusted legacy `storage_url` data (and duplicate image identity rows) in the target D1.
