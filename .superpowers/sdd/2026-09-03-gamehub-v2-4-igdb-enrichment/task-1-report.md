# GameHub V2.4 Task 1 — IGDB error and input contracts

## Status

Complete. Added the IGDB error contract and canonical GameHub game-ID normalization requested by Task 1. The implementation is limited to the four task files plus this report; protected schema, migration, UI, mock-data, and V2.2/V2.3 files are unchanged.

## Implementation

- Added `IgdbErrorCode` with every design-spec code plus the dedicated `invalid_game_id` input-validation code required by the task ruling.
- Added `IgdbError` with retry metadata, status, retry-after, cause accessors, and V2.2-style public getters.
- Kept error details out of normal JSON serialization and omitted causes from the serialized representation so provider credentials, tokens, response bodies, and other sensitive causes cannot leak through error output.
- Added `normalizeCanonicalGameId(input: unknown): number`, accepting positive safe integer numbers and decimal strings (including leading zeroes), while rejecting zero, negatives, fractions, unsafe integers, empty/whitespace values, non-decimal text, and non-string/non-number inputs.

## TDD evidence

- RED: `npm test -- lib/providers/igdb/errors.test.ts lib/enrichers/igdb-input.test.ts` failed because the two production modules did not exist.
- GREEN: the same focused command passed with 2 test files and 18 tests.

## Verification

- Focused tests: `npm test -- lib/providers/igdb/errors.test.ts lib/enrichers/igdb-input.test.ts` → 2 files passed, 18 tests passed.
- Full suite: `npm test` → 25 files passed, 278 tests passed.
- Typecheck: `npm run typecheck` → exit 0.
- Lint: `npm run lint` → exit 0.
- Whitespace: `git diff --check` → clean.
- Scope: only the requested `lib/providers/igdb/errors.ts`, `lib/providers/igdb/errors.test.ts`, `lib/enrichers/igdb-input.ts`, and `lib/enrichers/igdb-input.test.ts` are implementation changes; protected paths are unchanged.

## Concerns
None. The initial typecheck/full-suite attempts were blocked by missing installed dependencies; `npm ci` installed the locked dependencies, after which all required verification passed. The install changed no tracked files.
