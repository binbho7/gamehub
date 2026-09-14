# GameHub V2.7 Bulk Game Sync Verification Report

Date: 2026-09-13

Baseline: `122a78085b7ba8b2a01521dfc9cbcfc5ada1ec9a`

Task 12 base: `44da8b1c85e536ce139da13896e6a3a647762be2`

## Status boundaries

- Implemented: deterministic test-only local bulk harness, shared-state integration tests, and security invariants.
- Reviewed: Task 1–12 scoped review gates completed before whole-branch review. Whole-branch review returned two Important findings about temp-directory ownership and lifecycle/output test coverage; the final fix below addresses them, with independent scoped final re-review pending.
- Verified: focused tests, full test suite, typecheck, lint, local D1 migration/list/CRUD/cascade checks, schema/migration/lock baseline, and production-only audit.
- Environment-blocked: the required `npm run build` could not complete because the execution host denied Turbopack permission to bind its internal loopback port. The same failure occurred after requesting elevated execution. This is not recorded as a build pass.
- Merge status: not assessed by this task. Whole-branch review and a successful required build remain separate gates.

## Deterministic integration evidence

`npm test -- test/sync/bulk-sync.integration.test.ts`

- Exit status: 0
- Files/tests: 1 file, 8 tests passed
- A Steam write was observed by the real IGDB and official-link stores through the same local D1 binding, then by the authenticated workerd Image Worker through the same persisted D1 identity.
- The Worker response carried `x-test-runtime: workerd`; image bytes crossed the fixture HTTP boundary. At R2 PUT time, the target game had one eligible source row and zero storage-bound rows. Test-only instrumentation emitted the explicit ordered trace `r2_put_complete → d1_binding_complete`, proving the R2 operation completed before the successful D1 binding mutation. Afterward, the row contained the complete storage binding and the candidate R2 object changed from absent to present.
- Existing-game dry-run exercised Steam, Twitch/IGDB, link verification, source download, validation, hashing, and R2 HEAD while the instrumented CLI D1 mutation count remained 0, R2 PUT remained 0, all application-table rows were unchanged, and before/after R2 snapshots were identical. The fully-ingested dry-run also preserved identical R2 snapshots.
- A separately seeded fully-ingested image exercised the HEAD-only `already_ingested` path without a source GET.
- New-game dry-run persisted no canonical state and returned `canonical_game_not_persisted` for IGDB, links, and images.
- A deterministic IGDB failure for App ID 20 retained the preceding Steam write, skipped later stages for only that game, and allowed App ID 30 to complete.
- Repeating a successful write returned a non-empty image result whose outcomes were all benign, reused canonical/provider identities and image rows, and performed no additional R2 PUT.
- Provider fixtures accepted only explicitly mapped destinations and ran on `127.0.0.1`; the harness cleaned its owned Worker, fixture listener, and unique temporary persistence root. Occupied port 8787 failed closed without terminating the borrowed listener.
- An injected startup failure after the fixture listener and temporary root were acquired released that listener and removed the root. After the final review fix, Wrangler's explicit-script bundles are generated under the harness's unique temporary working directory, which is the only root removed by harness cleanup. A concurrently created unrelated entry in the shared repository `.wrangler/tmp` retains its original contents after harness close. No shared-directory snapshot or sweep is used.

`npm test -- test/sync/bulk-sync.security.test.ts`

- Exit status: 0
- Files/tests: 1 file, 5 tests passed
- Verified unchanged dependencies, devDependencies, lockfile, schema, and migrations against the V2.6 baseline.
- Verified that production `lib/sync` modules contain no Node I/O, Wrangler, process/console, global network, child-process, parallel game orchestration, or environment access.
- Verified remote/config/database/environment flags and a file-injected `--remote` token fail before platform acquisition.
- Verified public JSON/human output whitelists the bulk DTO, removes unknown provider payloads, credentials and fragments, and redacts sensitive URL query values.
- Verified no V2.8 job, scheduler, queue, durable-resume, remote-target, or retry facility was added.

## Fresh final verification

| Command | Exit | Evidence |
| --- | ---: | --- |
| `npm test` | 0 | 87 files passed; 1854 tests passed |
| `npm run typecheck` | 0 | `tsc --noEmit` completed with no diagnostics |
| `npm run lint` | 0 | ESLint completed with no warnings or errors |
| `npm run build` | 1 | Environment-blocked: Turbopack failed while creating a helper process because loopback port binding returned `Operation not permitted (os error 1)`; repeated after elevated execution with the same result |
| `npm run db:migrate:local` | 0 | Four tracked migrations applied to local `gamehub-local`; 32 + 2 + 10 + 9 commands succeeded |
| `npm run db:check:local` | 0 | `No migrations to apply` |
| `npm run db:verify:local` | 0 | Canonical CRUD and provider/link/image/video cascade verification returned `success: true` |
| `npm audit` | 1 | Fresh registry result: 7 dev-only findings: 4 moderate in `drizzle-kit -> @esbuild-kit -> esbuild`, and 3 high in `wrangler -> miniflare -> sharp` |
| `npm audit --omit=dev` | 0 | 0 production vulnerabilities |
| `git diff --exit-code 122a780... -- package-lock.json lib/db/schema.ts drizzle` | 0 | No dependency-lock, schema, or migration changes |
| `git diff --check` | 0 | No tracked whitespace errors at verification time |

One interim full-suite rerun encountered broad, simultaneous Cloudflare local-runtime timeouts across pre-existing D1/Worker tests and this integration file. A read-only process/port check found no remaining Wrangler, workerd, Vitest, or listening 8787/8796 process. The exact `npm test` command was then rerun alone from a clean process state and completed with the 87-file/1854-test pass recorded above.

The fresh audit feed differs from the previously recorded four-moderate baseline result: it now reports three additional high findings in the unchanged dev-only Wrangler/Miniflare/Sharp chain. V2.7 did not change `dependencies`, `devDependencies`, or `package-lock.json`, and the production-only audit remains zero. This report records the evidence but does not approve a new exception and does not modify packages.

## Post-review revision checks

| Command | Exit | Evidence |
| --- | ---: | --- |
| `npm test -- test/sync/bulk-sync.integration.test.ts` | 0 | 1 file; 8 tests passed, including explicit `r2_put_complete → d1_binding_complete` event order, PUT-time D1 observation, R2 dry-run snapshots, partial-startup cleanup and Wrangler-temp cleanup |
| `npm test -- test/sync/bulk-sync.security.test.ts test/images/worker-d1-r2.integration.test.ts` | 0 | 2 files; 11 tests passed; the extended test-only workerd observation preserved the native V2.6 Worker integration contract |
| `npm run typecheck` | 0 | `tsc --noEmit` completed with no diagnostics |
| `npm run lint` | 0 | Run after the integration harness and after confirming `.wrangler/tmp` contained no generated entries; ESLint completed with no warnings or errors |
| `git diff --check` | 0 | No tracked whitespace errors |

## Whole-branch final fix evidence

Final fix base: `3e4129904e467d18f1b797cf45235f3db32c119a`.

- Temp cleanup regression first failed against that base with `ENOENT`: harness close deleted an unrelated directory created while the harness was active. The fix gives the explicit-script Worker a unique owned working directory and invokes the already-installed Wrangler CLI by absolute path. The regression observes bundle files in the owned root, preservation of the unrelated shared file, removal of the owned root, idempotent close, and released ports. No application code or lint exclusions changed.
- Added 70 lifecycle/output matrix cases across human and JSON modes. They cover pre-acquisition validation, acquisition rejection, factory-owned composition cleanup, batch exceptions before the first game and after a real first-game batch completes, successful/failed-game complete results, cleanup failure, formatter failure, and synchronous/asynchronous stdout and stderr failures. Assertions require exact exit codes, one disposal attempt per acquired handle, expected ordering, a single complete result or zero stdout as appropriate, exact safe diagnostics, no retries, and no raw error/cause/stack/credential leakage. A partial result attached to the injected batch exception is never emitted.

| Command | Exit | Evidence |
| --- | ---: | --- |
| `npx vitest run test/sync/bulk-sync.integration.test.ts test/sync/bulk-sync.security.test.ts scripts/sync-games.lifecycle.test.ts` | 0 | 3 files; 83 tests passed |
| `npx vitest run lib/sync scripts/sync-games.test.ts scripts/sync-composition.test.ts scripts/sync-image-client.test.ts test/images/worker-d1-r2.integration.test.ts` | 0 | 14 files; 225 tests passed, including the original Image Worker integration |
| `npx vitest run test/sync/bulk-sync.integration.test.ts -t 'integration is local only and closes owned resources on failure'` | 0 | Final fixture-cleanup revision: 1 passed; 7 unrelated tests filtered out |
| `npx vitest run scripts/sync-games.lifecycle.test.ts` | 0 | Final test-signature revision: all 70 cases passed |
| `npm run typecheck` | 0 | No diagnostics after the final edits |
| `npm run lint` | 0 | Fresh run after integration/regression; no errors or warnings |
| `git diff --check` | 0 | No whitespace errors |
| `git diff --exit-code 122a78085b7ba8b2a01521dfc9cbcfc5ada1ec9a -- package-lock.json lib/db/schema.ts drizzle` | 0 | Baseline invariants unchanged |

The first local-listener regression attempt was blocked by the sandbox (`EPERM`); the authorized local-only rerun reproduced the ownership bug before the fix and passed afterward. One interim typecheck rejected a test's URL-typed `mkdtemp` prefix; the test now converts it explicitly to a file path. One interim lint run reported an unused test callback parameter; the final signature and clean rerun are recorded above. None of those interim runs is presented as a pass.

Build remains `BUILD_ENVIRONMENT_BLOCKED`; it was not rerun or relabeled by this final fix. The earlier full-suite count and audit evidence above are historical, not fresh results for this fix. Independent final scoped re-review and controller-owned fresh final verification remain pending.

## Stable invariants

- Migration count: 4
- Schema SHA-1: `d959b11fc297164388f3cc28708beadab2d7842f`
- `package-lock.json`, `lib/db/schema.ts`, and `drizzle/` match baseline `122a78085b7ba8b2a01521dfc9cbcfc5ada1ec9a` exactly.
- No production dependency or devDependency version changed.
- Local D1 only; no remote commands were run.
- Main remained at `122a78085b7ba8b2a01521dfc9cbcfc5ada1ec9a` during Task 12 verification.
- No push, PR, merge, schema change, dependency update, audit fix, or V2.8 work was performed.

## Remaining gates

1. Independent scoped re-review of the whole-branch final fix.
2. A real successful `npm run build` in an environment that permits Turbopack's required local process/port operation.
3. Close the two whole-branch Important findings through that scoped re-review.
4. Final fresh affected verification after review fixes, if any.
