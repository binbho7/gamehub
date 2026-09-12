# GameHub V2.7 Task 2 — Input expansion, normalization and bounded validation

## Status

Complete. Added pure bulk input parsing with injected UTF-8 file reads, ordered expansion, normalization, first-wins deduplication, flag validation, and the approved maximum batch size of 100. No CLI, service, database, schema, migration, dependency, or plan/spec code was changed.

## TDD evidence

- RED: `npm test -- lib/sync/input.test.ts` failed because `./input` did not exist.
- GREEN: the focused suite passed with 1 file and 23 tests.

## Verification

- Focused tests: `npm test -- lib/sync/input.test.ts` → 1 file passed, 23 tests passed.
- Regression tests: `npm test -- lib/sync/types.test.ts lib/providers/steam/app-id.test.ts scripts/import-steam-game.test.ts` → 2 files passed, 12 tests passed; `scripts/import-steam-game.test.ts` was blocked by the existing environment because `drizzle-orm` is unavailable.
- Typecheck: blocked by the existing environment because installed packages/types are unavailable (`drizzle-orm`, `drizzle-kit`, Wrangler, and Cloudflare worker types); no Task 2-specific diagnostics were reported.
- Lint: `npm run lint` → exit 0.
- Whitespace: `git diff --check` → clean.

## Changed files

- `lib/sync/input.ts`
- `lib/sync/input.test.ts`
- `.superpowers/sdd/2026-09-10-gamehub-v2-7-bulk-game-sync/task-2-report.md`

## Scope checks

File I/O remains injected through `ReadUtf8`; file contents are trimmed and comment/blank lines are ignored without re-entering option parsing. Positional values retain `normalizeSteamAppId`'s exact numeric contract. Duplicate flags and unsupported flags fail with the stable `configuration_error` public error, and no more than 100 unique normalized IDs are accepted.
