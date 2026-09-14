# GameHub V2.7 Task 3 — Shared stage ports, outputs and rejection contracts

## Status

Complete. Added shared stage ports, native DTO-compatible outputs, exhaustive stage failure codes, and validated fixed-shape stage errors. No adapter factory or implementation ownership was added.

## TDD evidence

- RED: `npm test -- lib/sync/stages.test.ts` failed because `./stages` did not exist.
- GREEN: the focused suite passed with 1 file and 2 tests.

## Verification

- Focused tests: `npm test -- lib/sync/stages.test.ts` → 1 file passed, 2 tests passed.
- Regression tests: `npm test -- lib/sync/types.test.ts lib/sync/input.test.ts lib/providers/igdb/errors.test.ts` → 3 files passed, 28 tests passed.
- Typecheck: blocked by the existing environment because installed packages/types are unavailable (`drizzle-orm`, `drizzle-kit`, Wrangler, and Cloudflare worker types); no Task 3-specific diagnostics were reported.
- Lint: `npm run lint` → exit 0.
- Whitespace: `git diff --check` → clean.

## Changed files

- `lib/sync/stages.ts`
- `lib/sync/stages.test.ts`
- `.superpowers/sdd/2026-09-10-gamehub-v2-7-bulk-game-sync/task-3-report.md`

## Scope checks

Contracts consume native Steam, IGDB, official-link, and image DTOs without redefining them. Stage errors accept only exhaustive known codes and the canonical generated message; caller-controlled messages, extra fields, and native error details are rejected. Adapter factory exports remain absent.
