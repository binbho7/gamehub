# GameHub V2.1 Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scalable Cloudflare D1 and Drizzle data foundation while preserving the V1 mock-data UI.

**Architecture:** A normalized SQLite schema owns canonical records and relations. An injected Drizzle D1 client and focused repository isolate persistence from Next.js UI and Wrangler, while Zod validates every external write payload.

**Tech Stack:** Next.js 16, TypeScript, Cloudflare D1/Wrangler, Drizzle ORM/Kit, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-09-01-gamehub-v2-1-data-layer-design.md`

## Global Constraints

- `games.id` is `INTEGER PRIMARY KEY` without `AUTOINCREMENT`.
- Only `(provider, external_id)` is unique for external IDs; multiple same-provider IDs per game are valid.
- Official-link uniqueness is `(game_id, url)`, never global URL uniqueness.
- `companies.slug` is unique and `companies.name` is not.
- `games.release_date` is the canonical/main `YYYY-MM-DD` date.
- Timestamps are UTC Unix milliseconds.
- SQLite uses `TEXT + CHECK` rather than PostgreSQL enums.
- V1 UI and `lib/mock-data.ts` remain unchanged.
- No remote D1, provider ingestion, R2, Cron, administration, or user features.

---

### Task 1: Tooling, schema, and generated migration

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Create: `wrangler.jsonc`
- Create: `drizzle.config.ts`
- Create: `lib/db/schema.ts`
- Create: `drizzle/0000_gamehub_v2_1.sql` and Drizzle metadata

**Interfaces:**
- Produces: exported Drizzle tables and inferred row/insert types; npm scripts `typecheck`, `db:generate`, `db:migrate:local`, and `db:check:local`.

- [ ] Install `drizzle-orm` and `zod`, plus development dependencies `drizzle-kit`, `wrangler`, and `@cloudflare/workers-types`.
- [ ] Declare all eleven tables, foreign keys, checks, indexes, composite keys, and required uniqueness rules in `lib/db/schema.ts`.
- [ ] Configure Drizzle Kit for SQLite schema generation and Wrangler binding `DB` for database `gamehub`.
- [ ] Run `npm run db:generate` and inspect generated SQL for `INTEGER PRIMARY KEY` without `AUTOINCREMENT`, correct cascading foreign keys, and the four corrected uniqueness requirements.
- [ ] Run `npm run typecheck` and fix schema/config typing errors.
- [ ] Commit the independently reviewable schema and migration.

### Task 2: Runtime input validation

**Files:**
- Create: `lib/db/validation.test.ts`
- Create: `lib/db/validation.ts`

**Interfaces:**
- Produces: `createGameSchema`, `updateGameSchema`, `externalIdSchema`, `officialLinkSchema`, `gameImageSchema`, `gameVideoSchema`, and taxonomy/company relation schemas with inferred input types.

- [ ] Write tests that expect valid canonical input to normalize, invalid slug/date/URL/enums/ranges to fail, update payloads to reject unknown protected fields, and a second same-provider external ID payload to remain individually valid.
- [ ] Run `npm test -- lib/db/validation.test.ts` and verify failure because the validation module does not exist.
- [ ] Implement strict Zod schemas with literal expected formats and bounded lengths/numbers.
- [ ] Run the focused test and full test suite until both pass.
- [ ] Commit validation and tests.

### Task 3: D1 client and game repository

**Files:**
- Create: `lib/db/client.ts`
- Create: `lib/db/repositories/games.ts`
- Create: `lib/db/repositories/games.test.ts`
- Create: `test/d1-test-env.ts`

**Interfaces:**
- Consumes: Drizzle tables and Zod input types from Tasks 1–2.
- Produces: `createDatabase(binding: D1Database)`, `createGameRepository(db)`, and repository methods `create`, `findById`, `findBySlug`, `findByExternalId`, `list`, `update`, `delete`, `addExternalId`, `addOfficialLink`, `addImage`, and `addVideo`.

- [ ] Build a test harness that applies the generated migration to an isolated local D1 binding.
- [ ] Write integration tests for canonical CRUD, slug lookup, bounded keyset listing, provider lookup, multiple same-provider IDs on one game, `(provider, external_id)` conflict, shared official URL across games, `(game_id, url)` conflict, media ordering, and cascade deletion.
- [ ] Run `npm test -- lib/db/repositories/games.test.ts` and verify the missing repository causes the expected failure.
- [ ] Implement the minimal injected Drizzle D1 client and repository using parsed inputs and bounded queries.
- [ ] Run focused and full tests; refactor only after green.
- [ ] Commit repository and integration tests.

### Task 4: Apply and verify the real local migration

**Files:**
- Create: `scripts/verify-d1.ts`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: Wrangler `DB`, generated migration, and repository.
- Produces: repeatable `db:verify:local` verification and documented local/production setup.

- [ ] Add a verification program that creates a unique fixture, reads and updates it through the repository, adds external/link/media records, then deletes it and verifies cascades.
- [ ] Run `npm run db:migrate:local` to apply the tracked migration to local D1.
- [ ] Run `npm run db:check:local` to inspect tables/migration status and `npm run db:verify:local` for CRUD evidence.
- [ ] Document local setup, placeholder versus production database ID, safe remote migration commands, and why no remote database was created.
- [ ] Commit local verification and operations documentation.

### Task 5: Final regression and requirement audit

**Files:**
- Review: all V2.1 changes and unchanged V1 UI imports

**Interfaces:**
- Produces: fresh verification evidence and the final V2.1 report.

- [ ] Confirm main has no V2.1 changes and the worktree is on `codex/v2-1-data-layer`.
- [ ] Run `npm test` and record test counts.
- [ ] Run `npm run typecheck`, `npm run lint`, and `npm run build`, fixing any failures directly.
- [ ] Inspect local SQLite schema, indexes, foreign keys, and migration tracking with Wrangler SQL queries.
- [ ] Re-read the design and user constraints line by line, correcting any uncovered gap.
- [ ] Use `verification-before-completion`, then report tables, relations, indexes, constraints, migration state, local workflow, production requirements, and the next single-game Steam import design without implementing ingestion.
