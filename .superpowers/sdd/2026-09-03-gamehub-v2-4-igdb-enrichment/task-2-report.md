# GameHub V2.4 Task 2 — Twitch OAuth Auth Client

## Status

Complete. Added the injected Twitch OAuth client-credentials token client requested by Task 2. The implementation is limited to the two requested provider files plus this report; protected schema, migrations, UI, mock data, and V2.2/V2.3 files are unchanged.

## Implementation

- Added `IgdbAuthClient` with `getAccessToken()` and `invalidateAccessToken()`, created through an options-injected factory for fetch, credentials, clock, token URL, timeout, and expiry margin.
- Sends a form-encoded Twitch client-credentials POST and validates the consumed token response with Zod.
- Keeps the access token only in process memory, applies the 60-second default expiry safety margin, supports explicit invalidation, shares concurrent token requests, and clears rejected single-flight work for later retries.
- Applies a single AbortController deadline across both token fetch and JSON parsing.
- Classifies missing credentials, invalid credentials, rate limits, provider availability, other HTTP responses, network failures, timeouts, malformed JSON, and token-schema changes as typed `IgdbError`s.
- Uses stable error messages and public metadata only; token request bodies, secrets, token values, and response bodies are not exposed through errors.

## TDD evidence

- RED: `npm test -- lib/providers/igdb/auth-client.test.ts` failed because `./auth-client` did not exist.
- GREEN: the focused suite passed with 1 file and 16 tests after the minimal implementation was added.

## Security fix round 1

- Regression coverage now recursively inspects direct `error.cause` and `error.details`, including nested fake secrets, access tokens, request URLs, and bodies from raw fetch and JSON failures.
- RED: the new focused tests failed because raw exceptions were reachable through `IgdbError.cause` and `IgdbError.details.cause`, exposing the test secret/token/request data.
- GREEN: the Auth Client now omits raw fetch and JSON causes while retaining the stable typed error code and retry metadata. The full focused suite passed with 18 tests.

## Verification

- Focused tests: `npm test -- lib/providers/igdb/auth-client.test.ts` → 1 file passed, 18 tests passed.
- Typecheck: `npm run typecheck` → exit 0.
- Whitespace: `git diff --check` → clean.
- Scope: implementation changes are limited to `lib/providers/igdb/auth-client.ts` and `lib/providers/igdb/auth-client.test.ts`; this report follows the established task-report convention. Protected paths are unchanged.

## Concerns

None.
