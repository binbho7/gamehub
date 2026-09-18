# Task 2 implementation report

## Scope

Added pure validation in `lib/site-data/validation.ts` and focused tests in `lib/site-data/validation.test.ts`. The implementation validates exact real UTC calendar snapshot dates, HTTPS public URLs with separate image and official-link host policies, YouTube IDs, artifact schema/version, deterministic ordering, forbidden private fields, published-game count, and UTF-8 artifact size.

The validator has no D1, filesystem, network, mock-data, or current-time dependency.

## TDD evidence

- RED: `npx vitest run lib/site-data/validation.test.ts` failed before implementation because `./validation` did not exist.
- RED regression: the added relation-order test failed after the first implementation because official-link ordering was not yet enforced.
- GREEN: focused validation tests pass with 26 tests.

## Verification

- `npx vitest run lib/site-data/contracts.test.ts lib/site-data/validation.test.ts` — 29/29 passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.

## Policy details

- Image URLs allow only HTTPS `cdn.akamai.steamstatic.com` and `images.igdb.com`.
- Official-link URLs allow only HTTPS Steam/IGDB public hosts used by the published contract.
- URLs reject credentials, fragments, explicit ports, malformed/non-HTTPS input, unapproved hosts, and lengths over 2,048 characters.
- Artifact games and public relations must be strictly deterministic and ordered; private operational/provider/storage keys are rejected recursively.

## Commit

Pending commit: `feat: add public site data validation`.
