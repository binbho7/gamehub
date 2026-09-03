# GameHub V2.4 Task 4 — IGDB Raw Schemas and Fixtures

## Status

Complete. Added the narrow IGDB response contracts between opaque HTTP JSON and later mapping/normalization.

## Implementation

- Added loose response envelopes for `external_games` and `games`: they retain unrelated provider fields while enforcing positive safe core IDs, mapping fields, game ID, and non-blank game name.
- Added strict, independently exported validators and raw types for named entities, companies, involved companies, images, videos, and websites. The normalizer can use these validators per item.
- Optional game collections validate their containers as arrays while retaining their entries as `unknown`; malformed optional media and website entries therefore reach normalization for warnings instead of rejecting an otherwise valid game.
- Added representative external-game and game fixtures. The game company includes only `id`, `name`, and `slug`; `company.url` is absent from both the raw DTO and fixture in accordance with the binding ruling.

## TDD Evidence

- RED: `npm test -- lib/providers/igdb/schema.test.ts` failed because `./schema` did not exist (`Cannot find module './schema'`).
- GREEN: after the minimal schema implementation, `npm test -- lib/providers/igdb/schema.test.ts && npm run typecheck` passed: 1 file / 17 tests passed; typecheck exited 0.

## Verification

- Focused tests: `npm test -- lib/providers/igdb/schema.test.ts` → 1 file passed, 17 tests passed.
- Typecheck: `npm run typecheck` → exit 0.
- Full suite: the sandboxed `npm test` initially failed because existing D1 tests could not open their required `127.0.0.1` listener (`EPERM`), causing 23 hook timeouts. Re-running the identical command with approved local-listener access passed: 28 files / 325 tests passed.
- Whitespace: `git diff --check` → clean.

## Changed Files

- `fixtures/igdb/external-games.json`
- `fixtures/igdb/game.json`
- `lib/providers/igdb/schema.ts`
- `lib/providers/igdb/schema.test.ts`
- `.superpowers/sdd/2026-09-03-gamehub-v2-4-igdb-enrichment/task-4-report.md`

## Self-Review

- Required mapping and game identity values cannot be zero, unsafe, or blank.
- Consumed scalar type changes fail at the raw boundary; optional collection container changes fail as well.
- Array elements remain deliberately opaque until the normalizer applies the exported item schemas, preserving per-item warning behavior.
- No protected schema, migration, mock, UI, V2.2, or V2.3 file changed.

## Concerns

None. The local D1 listener permission is required only to run the pre-existing integration tests in this sandbox; the approved full suite is green.
