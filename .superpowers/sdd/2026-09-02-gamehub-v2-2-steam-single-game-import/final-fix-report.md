# V2.2 Steam single-game import — final fix report

## Status and constraints

Status: complete. All eight final-review findings were reproduced with focused regressions, fixed without a schema or migration change, and verified against the real local D1 binding where persistence/concurrency mattered.

The final wave did not modify `lib/db/schema.ts`, `drizzle/*.sql`, `app`, or `lib/mock-data.ts`. Writes remain local-CLI-only and each approved plan is still executed through one `D1Database.batch()` call. No remote-import path, UI, mock-data change, or provider-raw leakage was added.

## Finding resolutions

1. **Concurrent lookup slug/name race**
   - `lib/db/repositories/steam-import.ts:47` normalizes lookup names consistently for SQL agreement checks. Junction subqueries at `:303`, `:314`, and `:325` now require both slug and normalized name; a concurrent contradictory lookup therefore yields a NOT NULL constraint failure and rolls back the whole batch instead of linking the wrong row.
   - `lib/importers/steam.ts:11` recognizes only the bounded lookup-integrity constraint shapes in addition to the existing game/external-ID races, then replans. Replanning revalidates taxonomy agreement or selects a deterministic company collision slug.
   - Real D1 concurrency regressions: `lib/importers/steam.test.ts:528` (genre contradiction rejects with `taxonomy_conflict`) and `:584` (company contradiction replans and links both games to their correct companies).

2. **Manual Store verification precedence**
   - Planner: `lib/importers/steam-plan.ts:263` converts every incoming verification delta into a manual-precedence skip when the stored method is `manual`.
   - Persistence: `lib/db/repositories/steam-import.ts:211` includes a `verification_method is not 'manual'` predicate, so even an already-approved stale plan cannot overwrite a row that became manual.
   - Regressions: `lib/importers/steam-plan.test.ts:481`, `lib/importers/steam.test.ts:702`, and stale-plan persistence at `:722`.

3. **Existing Steam video whitelist**
   - Planner compares only `title` and `thumbnailUrl`; `sortOrder` differences become explicit conservative skips at `lib/importers/steam-plan.ts:378`.
   - Store update values are restricted to title/thumbnail at `lib/db/repositories/steam-import.ts:223`; a crafted plan containing only `sortOrder` produces no query.
   - Regressions: `lib/importers/steam-plan.test.ts:508` and real D1 planner/store coverage at `lib/importers/steam.test.ts:746`.

4. **Actual `updated` outcome**
   - `SteamImportStore.applyPlan` now returns `{ affectedRows }` (`lib/db/repositories/steam-import.ts:40`) from D1 batch `meta.changes` (`:143`). Update statements use null-safe incoming-value predicates, so missing targets and concurrent same-value writes affect zero rows.
   - `lib/importers/steam.ts:66` consumes that outcome; zero-row update attempts are replanned and reported as `existing`, while `updated` requires at least one affected row.
   - Regressions: zero-row store outcome at `lib/importers/steam.test.ts:768`, target deletion between plan/apply at `:781`, and concurrent same-value application at `:803`.

5. **Timeout covers body consumption**
   - `lib/providers/steam/client.ts:35-79` keeps the timer alive through `response.json()`, classifies a deadline-triggered body abort as retryable `timeout`, and clears the timer only after all response handling.
   - Streaming-body regression: `lib/providers/steam/client.test.ts:52`.

6. **Bounded deterministic collisions**
   - Game slug selection is capped at 100 candidates (`lib/importers/steam-plan.ts:20`, `:152`) and rebuilds every suffix from the preferred base, preserving the complete `steam-{appId}` suffix under the 160-character limit.
   - Company collisions precompute the bounded 8, 12, …, 64 hex-character SHA-256 suffixes (`lib/importers/steam-plan.ts:21`, `:103`) and select the first free/name-agreeing candidate before `company_conflict`.
   - Regressions: max-length suffix `lib/importers/steam-plan.test.ts:180`, bounded game candidates `:197`, progressive company hash `:248`, and full-hash exhaustion `:265`.

7. **Whitespace-only raw name**
   - `lib/providers/steam/schema.ts:41` trims before the non-empty refinement, so the response adapter maps whitespace-only names to `schema_changed`.
   - Regressions: `lib/providers/steam/schema.test.ts:30` and `lib/providers/steam/response.test.ts:35`.

8. **Exactly one canonical external ID**
   - `lib/importers/candidate.ts:68` now requires exactly one external ID; the existing source-match refinement still requires that sole row to be the matching Steam identity.
   - Regression: `lib/importers/candidate.test.ts:92`.

## RED/GREEN evidence

- Finding 1 RED: `npm test -- lib/importers/steam.test.ts -t "concurrent genre|concurrent company"` → 1 file failed, 2 tests failed (both imports silently fulfilled for genre; company beta linked to the alpha name).
- Finding 1 GREEN: same command → 1 file passed, 2 tests passed, 18 skipped.
- Findings 2–4 RED: `npm test -- lib/importers/steam-plan.test.ts lib/importers/steam.test.ts -t "manually verified|sort-order|manual Steam|became manual|video order|zero-row|target disappears|concurrent writer"` → 2 files failed, 8 tests failed, 32 skipped.
- Findings 2–4 GREEN: same command → 2 files passed, 8 tests passed, 32 skipped.
- Findings 5–8 RED: `npm test -- lib/providers/steam/client.test.ts lib/providers/steam/schema.test.ts lib/providers/steam/response.test.ts lib/importers/candidate.test.ts lib/importers/steam-plan.test.ts -t "streaming JSON|whitespace-only|second external ID|full Steam App ID|bounded number|progressively extends|full SHA-256"` → 5 files failed, 8 tests failed, 43 skipped.
- Findings 5–8 GREEN: same command → 5 files passed, 8 tests passed, 43 skipped.

## Final verification

- Focused Steam suites: `npm test -- lib/providers/steam/client.test.ts lib/providers/steam/schema.test.ts lib/providers/steam/response.test.ts lib/importers/candidate.test.ts lib/importers/slug.test.ts lib/importers/steam-plan.test.ts lib/importers/steam.test.ts` → 7 files passed, 83 tests passed.
- Full suite: `npm test` → 13 files passed, 149 tests passed.
- `npm run typecheck` → exit 0.
- `npm run lint` → exit 0.
- `npm run build -- --webpack` → compiled, typechecked, and generated 41/41 static pages; exit 0.
- `npm run db:check:local` → `No migrations to apply!`.
- `npm run db:verify:local` → `success: true`; canonical ID remained numeric and all verified child rows cascaded to zero.
- `npm audit --omit=dev` → 0 vulnerabilities. Full `npm audit` retains the already documented four moderate, development-only Drizzle Kit/esbuild-chain advisories; no high or production finding.
- `git diff --check` → clean. `lib/db/schema.ts` SHA-1 remains `52e84d7c2b52b73b95bdfb3934dabbde0e65e3d5`; exactly two migration SQL files remain.

The initial sandbox-only D1 runs could not bind `127.0.0.1` and Wrangler could not write its user log (`EPERM`). Every D1 command listed above was rerun with the required local permission and passed. No functional concern remains.

## Files in the final fix

- `lib/db/repositories/steam-import.ts`
- `lib/importers/candidate.ts`
- `lib/importers/candidate.test.ts`
- `lib/importers/steam-plan.ts`
- `lib/importers/steam-plan.test.ts`
- `lib/importers/steam.ts`
- `lib/importers/steam.test.ts`
- `lib/providers/steam/client.ts`
- `lib/providers/steam/client.test.ts`
- `lib/providers/steam/schema.ts`
- `lib/providers/steam/schema.test.ts`
- `lib/providers/steam/response.test.ts`
- `.superpowers/sdd/2026-09-02-gamehub-v2-2-steam-single-game-import/final-fix-report.md`
