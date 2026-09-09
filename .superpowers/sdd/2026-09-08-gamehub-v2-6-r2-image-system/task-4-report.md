# Task 4 report: bounded image source downloader

## Delivered

- Added an injected-clock downloader with one manual-redirect GET chain and per-hop attempt records.
- Added provider-scoped redirect validation, loop and three-redirect limits, URL-length checks, downgrade/cross-provider rejection, and redirect-body cancellation.
- Added response-header and body deadlines with abort-aware handling, including transports and streams that ignore aborts.
- Added an 8 MiB `Content-Length` preflight and streaming byte cap, returning bounded bytes only for successful downloads.
- Added focused coverage for redirect statuses, failures, deadlines, size limits, cancellation, and no duplicate requests.
- Added an absolute per-image 30-second budget: each hop's header timer and the final body timer are capped by remaining time, including slow redirect chains.
- Canonicalized the initial URL before loop tracking so case/default-port variants cannot bypass self-redirect detection.

## Verification

- `npm test -- lib/images/downloader.test.ts` — passed (26 tests), including a fourth-hop header timer reduced below ten seconds.
- `git diff --check` — passed.
- `npm run typecheck` still reports unrelated existing schema/provenance fixture errors in `lib/enrichers/igdb-plan.test.ts` and `lib/importers/steam-plan.test.ts`; the Task 4 test helper typing errors were corrected.
