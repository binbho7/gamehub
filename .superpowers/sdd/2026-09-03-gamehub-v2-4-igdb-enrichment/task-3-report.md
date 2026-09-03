# GameHub V2.4 Task 3 — HTTP-Only IGDB Client

## Status

Complete. Added the authenticated IGDB HTTP transport only. It has no adapter, candidate, repository, database, Wrangler, or enricher dependency.

## Implementation

- Added `IgdbClient.request()` for the statically whitelisted `external_games` and `games` endpoints.
- Builds `POST https://api.igdb.com/v4/{endpoint}` requests with injected `Client-ID`, Bearer access token, `Accept: application/json`, and the untouched APICalypse body.
- Uses one timeout deadline for each IGDB request attempt, covering both `fetch` and `response.json()`.
- Returns decoded JSON strictly as `unknown` with the injected fetch timestamp.
- Classifies network, timeout, status, rate-limit, provider-availability, and malformed-JSON errors as sanitized `IgdbError`s. Status is classified before body parsing.
- On one 401, invalidates the auth client token and retries once. A second 401 returns non-retryable `authentication_failed`; all other failures make no implicit retry.

## TDD evidence

- RED: `npm test -- lib/providers/igdb/client.test.ts` failed because `./client` did not exist (`Cannot find module './client'`).
- GREEN: after the minimal implementation, `npm test -- lib/providers/igdb/client.test.ts` passed with 1 file and 11 tests.
- A test-only `AbortSignal | null` type issue found by `npm run typecheck` was corrected; the focused suite, typecheck, and boundary check then passed.

## Verification

- Focused tests: `npm test -- lib/providers/igdb/client.test.ts` → 1 file passed, 11 tests passed.
- Typecheck: `npm run typecheck` → exit 0.
- HTTP boundary: `rg -n "db/|drizzle|wrangler|enrichers" lib/providers/igdb/client.ts` → no matches.
- Full suite: `npm test` → 27 files passed, 307 tests passed.
- Whitespace: `git diff --check` → clean.

## Changed files

- `lib/providers/igdb/client.ts`
- `lib/providers/igdb/client.test.ts`
- `.superpowers/sdd/2026-09-03-gamehub-v2-4-igdb-enrichment/task-3-report.md`

## Self-review

- The transport returns only opaque decoded JSON and never imports domain or persistence layers.
- Error construction deliberately omits raw fetch/JSON causes, request bodies, authorization headers, client IDs, and access tokens.
- Tests cover exact request construction, both allowed endpoints, deadline during body parsing, 403/429/other 4xx/5xx classifications, no general retry, and the bounded 401 refresh path.

## Concerns

The first full-suite attempt was blocked by the sandbox from opening the existing local D1 test listener on `127.0.0.1` and therefore timed out 23 pre-existing D1-dependent tests. Re-running the same command with approved local-listener permission passed all 307 tests. No source change was made for that environment issue.
