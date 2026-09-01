# GameHub V2.1 Data Foundation Design

## Goal

Build the first production-shaped data foundation for GameHub on Cloudflare D1 and Drizzle ORM without replacing the accepted V1 mock-data UI. The schema must remain efficient for hundreds of thousands to low millions of games while avoiding speculative subsystems.

## Scope

V2.1 includes D1 configuration, Drizzle schema and migrations, canonical game storage, provider ID mapping, official-link metadata, taxonomy/company relations, image/video metadata, runtime validation, and a small repository/query layer. It excludes Steam or IGDB ingestion, R2, Cron, remote database creation, authentication, administration, and UI migration.

## Identity and Time

`games.id` is GameHub's canonical identifier. It is a SQLite `INTEGER PRIMARY KEY` and deliberately omits `AUTOINCREMENT`; GameHub does not require a strict never-reuse guarantee and avoids the `sqlite_sequence` overhead. Steam, IGDB, Epic, GOG, PlayStation, Xbox, Nintendo, and future identifiers exist only in `game_external_ids`.

All event timestamps are UTC Unix milliseconds stored as SQLite integers. `games.release_date` is the canonical/main release date stored as nullable `YYYY-MM-DD` text. V2.1 does not model platform- or region-specific releases; a future demonstrated need may add `game_releases`.

## Schema

### Canonical content

- `games`: slug, title, summary, description, lifecycle status, canonical release date, cover URL, hero URL, and audit timestamps.
- `game_external_ids`: provider identifiers and optional source URLs. `(provider, external_id)` is the only identity uniqueness rule. `game_id` is indexed but a game may have multiple identifiers from the same provider.
- `game_official_links`: provider/platform/link type, URL, region, official flag, verification fields, HTTP/redirect metadata, and timestamps. `(game_id, url)` is unique; URLs are not globally unique.

### Taxonomy and companies

- `genres` and `platforms`: normalized lookup tables with unique slug and unique name.
- `game_genres` and `game_platforms`: composite-primary-key junctions.
- `companies`: unique slug but non-unique name to support namesakes and renames.
- `game_companies`: composite key `(game_id, company_id, role)` so one company may act as developer, publisher, or another supported role.

### Media metadata

- `game_images`: typed source/storage URLs, dimensions, ordering, and creation timestamp.
- `game_videos`: provider/external ID, title, thumbnail, ordering, and creation timestamp. `(game_id, provider, external_id)` prevents duplicates within one game while allowing a shared official video to be attached to multiple games.

Every child or junction `game_id` foreign key uses `ON DELETE CASCADE`. Lookup deletion cascades only its junction rows. No binary media is stored in D1.

## Constraints and Indexes

SQLite `TEXT` columns use `CHECK` constraints for finite V2.1 vocabularies such as game status, link type, verification status/method, media type, and company role. Boolean values are integer-backed. URL, slug, date, range, and enum validation also occurs at the Zod boundary.

Indexes target real access paths: unique game slug; game status and release ordering; child-table `game_id`; external lookup by `(provider, external_id)`; official links by game and verification recency; junction reverse lookups; image/video ordering by game; and unique lookup slugs/names as specified above. Redundant indexes already covered by a composite primary key or unique constraint are avoided.

## Runtime Boundaries

`lib/db/client.ts` constructs a Drizzle D1 client from an injected `D1Database`. UI modules do not import Wrangler globals. `lib/db/repositories/games.ts` exposes bounded canonical CRUD and lookup methods. Related writes are explicit methods, keeping provider import policy outside the repository.

`lib/db/validation.ts` contains Zod schemas for repository inputs. Create operations parse full payloads; update operations accept a strict partial payload while protecting IDs and audit fields. Pagination is bounded and cursor/keyset-oriented so consumers cannot issue unbounded reads.

## Migration and Local Development

Drizzle Kit generates SQLite-compatible SQL into `drizzle/`. Wrangler tracks and applies those migrations to local D1 with `wrangler d1 migrations apply gamehub --local`. `wrangler.jsonc` declares binding `DB`, database name `gamehub`, a clearly documented local placeholder ID, and the Drizzle migration directory. Production requires creating D1 remotely and replacing the placeholder ID before any remote deployment.

## Testing

TDD covers Zod rejection/normalization and repository behavior. Integration verification applies the actual migration to local D1, exercises create/read/update/external-ID/link/delete behavior against a real D1 binding, and confirms cascade deletion. Final gates are tests, typecheck, lint, and production build. V1 pages continue importing `lib/mock-data.ts`, which provides the UI regression boundary.
