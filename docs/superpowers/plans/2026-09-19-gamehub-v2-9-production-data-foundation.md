# GameHub V2.9 Production Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace production website fixture data with a reviewed, deterministic, tracked public dataset exported read-only from local D1 while preserving Cloudflare Pages static hosting.

**Architecture:** A local-only exporter reads a consistent D1 snapshot, validates publication eligibility, and writes the tracked `generated/site-data.json` public DTO. `site:data:check` validates that committed artifact without D1 or network access, and the canonical `npm run build` runs that check before `next build`; Pages continues to build `out` with its existing command.

**Tech Stack:** TypeScript, Zod, Drizzle D1, Next.js static export, Vitest, Node filesystem/CLI APIs, existing `lib/db` repositories.

**Spec:** `docs/superpowers/specs/2026-09-18-gamehub-v2-9-production-data-foundation-design.md` (authority commit `cd252e6c3acbca3b7d220139eb7463b230cc8a8c`)

## Global Constraints

- `npm run build` is the only canonical production build command and must execute `site:data:check` before `next build`.
- Cloudflare Pages keeps Build command `npm run build` and output `out`; no dashboard change is required.
- Production has no runtime D1, production D1, R2, Worker, Container, Cron, API, secret, or provider-call dependency.
- `generated/site-data.json` is tracked; only explicitly named reports/temp files are ignored.
- `npm run site:data:export -- --snapshot-date YYYY-MM-DD` requires an explicit real calendar date and never uses wall clock/current date/`Date.now()`.
- Eligibility uses `releaseDate <= snapshotDate` for `released` and `releaseDate > snapshotDate` for `upcoming`.
- The public artifact contains no canonical numeric IDs, scheduler/lease/fence metadata, secrets, raw provider payloads, verification internals, private diagnostics, R2 storage metadata, database-only timestamps, local paths, or Cloudflare IDs.
- V2.9 uses approved remote Steam/IGDB source URLs only; R2 rows are ignored and no image bytes are downloaded or uploaded.
- Only official links with `verificationStatus = verified` and method `manual`, `http`, or `provider_api` are publishable.
- Production limits are 10 MiB UTF-8 artifact bytes and 10,000 published games; Pages cannot raise them.
- Missing/invalid artifact, schema/version, snapshot date, forbidden field, ordering, publication shape, or size fails closed; no implicit `lib/mock-data.ts` fallback.
- No production dependency is added.

## File Map

- `lib/site-data/contracts.ts`: versioned artifact and published DTO types/constants.
- `lib/site-data/validation.ts`: pure date, URL, slug, provider, forbidden-field, and artifact validation.
- `lib/site-data/read-model.ts`: read-only D1 snapshot queries and stable relation ordering.
- `lib/site-data/eligibility.ts`: deterministic gate evaluation and reason codes.
- `lib/site-data/serialize.ts`: stable pretty JSON serialization and size/count guards.
- `scripts/export-site-data.ts`: local-only operator CLI and ignored report output.
- `scripts/check-site-data.ts`: no-D1/no-network tracked artifact checker.
- `generated/site-data.json`: tracked first-party public artifact; never hand-copied from fixtures.
- `lib/site-data/source.ts`: production generated-data loader and explicit fixture-only loader.
- `types/game.ts`, `components/game/*`, `components/home/*`, `app/*`: presentation contract and route migration.
- `package.json`: `site:data:export`, `site:data:check`, and canonical build composition.
- `README.md`: operator and Pages workflow.
- `test/site-data/*`, `lib/site-data/*.test.ts`: unit, integration, security, determinism, and clean-checkout coverage.

## Bootstrap Dataset Decision

The first tracked `generated/site-data.json` must be produced by `site:data:export` from a real reviewed local D1 snapshot using an explicit `--snapshot-date`. It must not be converted from `lib/mock-data.ts` and must not contain fabricated values. The exporter writes no D1 data. If the local snapshot has zero or insufficient eligible games, export fails closed with deterministic reason codes; the operator must populate local D1 through the already-reviewed Steam/IGDB/local workflows and rerun export. There is no fixture bootstrap mode for production artifacts. The first artifact is committed only after its operator report, `site:data:check`, and diff review pass.

### Task 1: Published DTO contracts and policy constants

**Files:**
- Create: `lib/site-data/contracts.ts`
- Test: `lib/site-data/contracts.test.ts`

**Interfaces:**
- Produce `SITE_DATA_VERSION = 1`, `PUBLICATION_POLICY_VERSION = 1`, `MAX_ARTIFACT_BYTES = 10 * 1024 * 1024`, `MAX_PUBLISHED_GAMES = 10_000`.
- Produce `PublishedGame`, `PublishedOfficialLink`, `PublishedVideo`, `PublishedArtifact`, `UnavailableFields`, and `EligibilityDiagnostic` types.
- `PublishedArtifact` must contain `{ version: number; snapshotDate: string; games: PublishedGame[] }` and no canonical numeric ID.

- [ ] Write failing Zod/type-level tests for valid artifact shape, null optional fields, and rejection of extra private fields.
- [ ] Run `npx vitest run lib/site-data/contracts.test.ts`; verify RED before implementation.
- [ ] Implement contracts and policy constants without importing database schema or mock data.
- [ ] Run focused tests and `npm run typecheck`; verify GREEN.
- [ ] Commit `feat: add V2.9 published site data contracts`.

### Task 2: Pure validation and snapshot-date parser

**Files:**
- Create: `lib/site-data/validation.ts`
- Test: `lib/site-data/validation.test.ts`

**Interfaces:**
- `parseSnapshotDate(value: string): string` accepts only exact `YYYY-MM-DD` real UTC calendar dates; rejects missing, timestamps, offsets, whitespace variants, and impossible dates.
- `validatePublicUrl(url: string): string` permits only approved Steam/IGDB HTTPS hosts and rejects credentials, fragments, non-HTTP(S), oversized, or malformed URLs.
- `validateYoutubeId(id: string): string` enforces the approved YouTube ID grammar.
- `validateArtifact(value: unknown): PublishedArtifact` validates version, snapshotDate, ordering, limits, and forbidden keys without current-time access.

- [ ] Add RED tests for missing/malformed/impossible/timezone snapshot dates, URL hosts, YouTube IDs, forbidden keys, ordering, and limits.
- [ ] Run focused tests and confirm RED.
- [ ] Implement pure validators; do not import `Date.now`, filesystem, D1, network, or `lib/mock-data`.
- [ ] Run focused tests, typecheck, and diff-check.
- [ ] Commit `feat: add public site data validation`.

### Task 3: Deterministic D1 export read model

**Files:**
- Create: `lib/site-data/read-model.ts`
- Test: `lib/site-data/read-model.test.ts`
- Reuse: `lib/db/schema.ts`, `lib/db/client.ts`, reviewed repository query patterns

**Interfaces:**
- `readSiteSnapshot(db): Promise<SiteSnapshot>` reads only games, Steam identity, companies, genres, platforms, source images, official links, and videos.
- Every query has explicit ordering; scheduler/fence tables are never queried.
- The read model is read-only and accepts no remote binding/configuration flag.

- [ ] Write RED tests with a local D1 fixture proving all public relations are loaded, scheduler rows are absent, and no write methods execute.
- [ ] Run focused integration tests and confirm RED.
- [ ] Implement stable queries ordered by slug/ID, taxonomy name/ID, role, link policy order, image order, and video order.
- [ ] Run focused tests and inspect SQL/query logs for absence of mutation and provider calls.
- [ ] Commit `feat: add deterministic site data read model`.

### Task 4: Publication eligibility engine

**Files:**
- Create: `lib/site-data/eligibility.ts`
- Test: `lib/site-data/eligibility.test.ts`

**Interfaces:**
- `evaluateGame(snapshotGame, snapshotDate): { published: PublishedGame | null; diagnostics: EligibilityDiagnostic[] }`.
- Gates: exactly one valid Steam identity; slug uniqueness; title/description/developer/publisher/release date; released/upcoming date comparison against explicit snapshotDate; non-empty genre/platform; approved cover/hero/all images; verified official link with allowed method; resolved relations; no duplicate public identity.
- Optional fields are `null`/unavailable, never filled from mock data.

- [ ] Write one RED test per gate, including equality boundary and upcoming next-day boundary.
- [ ] Run focused tests and confirm RED.
- [ ] Implement fail-closed gate evaluation with stable reason codes sorted by slug/code.
- [ ] Run focused tests, typecheck, and diff-check.
- [ ] Commit `feat: enforce V2.9 publication eligibility`.

### Task 5: Stable serializer and artifact guards

**Files:**
- Create: `lib/site-data/serialize.ts`
- Test: `lib/site-data/serialize.test.ts`

**Interfaces:**
- `serializeArtifact(artifact): string` emits stable pretty JSON, deterministic key order, one game per readable block, UTF-8-compatible text, and final newline.
- `assertArtifactLimits(serialized, gameCount)` enforces the fixed production ceilings.

- [ ] Add RED tests for repeated byte identity, relation/game ordering, final newline, forbidden timestamp fields, 10 MiB boundary, and 10,000-game boundary.
- [ ] Run focused tests and confirm RED.
- [ ] Implement serialization with no current time/randomness and no minification.
- [ ] Run focused tests and verify two equal inputs produce identical bytes.
- [ ] Commit `feat: add deterministic site data serialization`.

### Task 6: Local export CLI and operator report

**Files:**
- Create: `scripts/export-site-data.ts`
- Create: `scripts/site-data-report.ts`
- Test: `scripts/export-site-data.test.ts`
- Modify: `package.json`

**Interfaces:**
- CLI accepts exactly `--snapshot-date YYYY-MM-DD` plus no remote/config/provider flags; reject `--remote`, alternate production configs, provider credentials, and unknown flags.
- `npm run site:data:export -- --snapshot-date YYYY-MM-DD` writes tracked `generated/site-data.json` and ignored deterministic report; it never writes D1 or calls providers.
- Insufficient eligible data exits nonzero with bootstrap guidance; it never writes a fake artifact.

- [ ] Add RED CLI tests for missing/invalid date, forbidden remote flags, read-only D1, deterministic report, and insufficient-data failure.
- [ ] Run focused tests and confirm RED.
- [ ] Implement composition over Tasks 2–5 and the existing local D1 test support.
- [ ] Run focused tests, typecheck, lint, and diff-check.
- [ ] Commit `feat: add local site data export command`.

### Task 7: Tracked artifact checker

**Files:**
- Create: `scripts/check-site-data.ts`
- Test: `scripts/check-site-data.test.ts`
- Modify: `.gitignore` only for explicitly named `generated/export-report.json` and `generated/tmp-*` patterns; never ignore `generated/site-data.json`.

**Interfaces:**
- `npm run site:data:check` reads only tracked artifact bytes and pure validators; it has no D1, network, credentials, current-date, or provider imports.
- It fails for missing artifact, version/date/schema/order/private fields/limits/publication shape and succeeds for the committed artifact.

- [ ] Add RED tests using subprocess spies that fail if D1/network/current-date APIs are touched.
- [ ] Run focused tests and confirm RED.
- [ ] Implement checker with stable diagnostics and nonzero exit codes.
- [ ] Run focused tests, including malformed and forbidden artifacts.
- [ ] Commit `feat: add tracked site data checker`.

### Task 8: Production data-source adapter

**Files:**
- Create: `lib/site-data/source.ts`
- Test: `lib/site-data/source.test.ts`
- Modify: `tsconfig` path/import boundary only if needed

**Interfaces:**
- `loadPublishedArtifact()` imports only `generated/site-data.json`, validates it, and throws on absence/invalid data.
- `loadFixtureArtifact()` is explicit test/local-fixture mode and is the only path allowed to use `lib/mock-data.ts`.
- Production source must not import mock data transitively.

- [ ] Write RED tests for missing artifact, invalid artifact, explicit fixture mode, and mock-import guard.
- [ ] Run focused tests and confirm RED.
- [ ] Implement separate generated/fixture modules with no implicit fallback.
- [ ] Run focused tests, typecheck, and lint.
- [ ] Commit `feat: add generated production data source`.

### Task 9: Frontend contract migration

**Files:**
- Modify: `types/game.ts`, `components/game/game-card.tsx`, `game-hero.tsx`, `game-info.tsx`, `official-links.tsx`, `system-requirements.tsx`, `game-gallery.tsx`, `home/*`, filters/search components
- Test: `components/game/*.test.tsx` or existing component/query tests

**Interfaces:**
- Components consume `PublishedGame`; unavailable values render `暂无数据` or hide sections.
- No title translation, fabricated rating/free flag, copied requirements, inferred modes/controller support, or R2 fallback is introduced.

- [ ] Add RED component tests for null optional fields, absent videos, verified links, and source URLs.
- [ ] Run focused tests and confirm RED.
- [ ] Migrate props/rendering while preserving static client filters and accessible empty states.
- [ ] Run focused tests, typecheck, lint, and diff-check.
- [ ] Commit `refactor: migrate frontend to published site data`.

### Task 10: Route and static-parameter migration

**Files:**
- Modify: `app/page.tsx`, `app/games/page.tsx`, `app/search/page.tsx`, `app/games/[slug]/page.tsx`, `app/genres/[slug]/page.tsx`, `app/platforms/[slug]/page.tsx`, `app/releases/page.tsx`, `app/upcoming/page.tsx` if present
- Test: `test/site-data/routes.test.ts`

**Interfaces:**
- All route consumers load the generated source; no page imports `lib/mock-data.ts` in production path.
- `generateStaticParams` uses only eligible generated games/genres/platforms.
- Search/filter query behavior remains client-side; direct query restoration and real 404 behavior remain intact.

- [ ] Add RED route tests for representative game/genre/platform slugs, `/games`, `/search`, releases/upcoming, and nonexistent paths.
- [ ] Run focused tests and confirm RED.
- [ ] Migrate route data imports and derive static params from generated artifact.
- [ ] Run route tests, typecheck, lint, and diff-check.
- [ ] Commit `refactor: use published data for static routes`.

### Task 11: Canonical build gate

**Files:**
- Modify: `package.json`
- Test: `test/site-data/build-contract.test.ts`

**Interfaces:**
- `build` executes `site:data:check && next build`.
- Optional `site:build` is an exact alias/shared implementation, never an alternate validation path.

- [ ] Add RED script-contract tests proving `npm run build` invokes checker first and missing artifact prevents Next.
- [ ] Run tests and confirm RED.
- [ ] Update scripts without changing Cloudflare Pages dashboard expectations: command remains `npm run build`, output `out`.
- [ ] Run `npm run site:data:check`, `npm run build`, and static route inspection.
- [ ] Commit `build: gate static export on tracked site data`.

### Task 12: First tracked publication artifact

**Files:**
- Create: `generated/site-data.json`
- Create/modify: ignored operator report path only
- Test: `test/site-data/bootstrap-artifact.test.ts`

**Interfaces:**
- Artifact is produced by the real local D1 export command with an explicit chosen snapshot date; it is never copied from `lib/mock-data.ts`.
- If local D1 lacks eligible rows, stop with fail-closed bootstrap guidance, run approved local import/enrichment, then rerun export.

- [ ] Run local preflight read-only and record eligible/excluded counts.
- [ ] Choose and record an operator snapshot date explicitly.
- [ ] Run export, inspect deterministic report and JSON diff, and run `site:data:check`.
- [ ] Verify artifact contains only public DTO fields, stable ordering, snapshotDate, and no forbidden data.
- [ ] Commit `data: add reviewed V2.9 public site dataset` only after review.

### Task 13: Clean-checkout and security integration

**Files:**
- Create: `test/site-data/clean-checkout.integration.test.ts`
- Create: `test/site-data/security.integration.test.ts`

**Interfaces:**
- A repository-only temporary checkout with no `.wrangler`, D1, credentials, or network runs the canonical `npm run build` successfully using tracked artifact.
- Tests prove checker has no D1/network/current-date dependencies, production source cannot import mock data, and forbidden fields/storage internals never serialize.

- [ ] Write RED subprocess/integration tests and run them in an isolated clean checkout.
- [ ] Implement only test harness code; do not add runtime fallback.
- [ ] Run canonical build and security tests, then typecheck/lint/diff-check.
- [ ] Commit `test: verify clean checkout production build`.

### Task 14: Documentation and final verification

**Files:**
- Modify: `README.md`
- Test: `test/site-data/final-verification.test.ts`

**Interfaces:**
- README states local D1 export with explicit snapshot date, tracked artifact review, `site:data:check`, `npm run build`, Pages command `npm run build`, and output `out`.
- It states no runtime D1/R2/Worker/Container/Cron/provider calls and no automatic push/deploy.

- [ ] Add documentation regression assertions for canonical command and forbidden alternate workflow.
- [ ] Run full `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run site:data:check`, and `git diff --check`.
- [ ] Inspect static routes and 404 output; verify worktree clean and no generated noise beyond tracked artifact.
- [ ] Commit `docs: document V2.9 site data workflow`.

## Plan Self-Review

- Spec coverage: all approved constraints map to Tasks 1–14, including tracked artifact, explicit snapshotDate, eligibility, URL/link/image policy, DTO migration, clean checkout, build gate, security, rollback, and Pages compatibility.
- Bootstrap coverage: Task 12 requires a real local D1 export and fail-closed handling when eligible data is unavailable; mock-data conversion is prohibited.
- Placeholder scan: no TODO/TBD/placeholder instructions are used; every task names files, interfaces, tests, commands, and commit boundaries.
- Type/interface consistency: Tasks 1–8 define `PublishedArtifact`, validators, read snapshot, eligibility, serializer, exporter/checker, and source before Tasks 9–10 consume them.
- Dependency consistency: Task 11 makes `npm run build` the sole production gate; Tasks 13–14 verify that exact command.
- Privacy/determinism: Tasks 2, 5, 7, 12, and 13 cover forbidden fields, explicit date, stable bytes, size limits, and no runtime/local-machine dependency.

## Known implementation risks

- Existing local D1 may not contain enough eligible real rows for the first tracked artifact; Task 12 must stop rather than fabricate data.
- Existing components assume non-null fixture fields; Task 9 requires explicit unavailable rendering before route migration.
- Static build failures caused by the environment must be reported as blockers, never recorded as false passes.
