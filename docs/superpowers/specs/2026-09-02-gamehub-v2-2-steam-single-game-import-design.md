# GameHub V2.2 Steam Single-Game Import Design

## Goal

Implement one reliable, idempotent import path from a single Steam App ID to the existing GameHub canonical model in Cloudflare D1. The import must fetch and validate provider data, normalize it into a provider-neutral candidate, show a dry-run plan, and write the accepted plan atomically without allowing Steam identity or raw fields to leak into canonical IDs, repositories, or UI code.

V2.2 is intentionally limited to one game per invocation. It does not add batch synchronization, scheduling, a management UI, remote production writes, IGDB, Epic, GOG, R2, media downloads, or a general multi-provider merge engine.

## Non-Negotiable Data Boundaries

- `games.id` remains GameHub's SQLite `INTEGER PRIMARY KEY` canonical ID.
- A Steam App ID is stored only as `(provider = 'steam', external_id = app_id)` in `game_external_ids`.
- Steam response types exist only under `lib/providers/steam/`.
- Repositories and UI code never receive Steam raw fields.
- The provider response is validated first, then the normalized canonical candidate is validated independently.
- V2.1 schema and migration files remain unchanged. If implementation proves that a required invariant cannot be satisfied without a schema change, implementation stops for design review instead of generating a migration.

## Architecture

The import is split into explicit boundaries:

```text
Steam App ID
  -> Steam Provider Client
  -> unknown JSON response
  -> Steam Raw Zod Schema
  -> validated Steam DTO
  -> Steam Normalizer
  -> Canonical Candidate Zod Schema
  -> Import Planner
  -> dry-run result or atomic Import Store write
  -> canonical game lookup
  -> Import Result
```

### Steam provider client

`lib/providers/steam/client.ts` owns HTTP behavior only: URL construction, timeout, response status handling, JSON parsing, and error classification. It accepts an injected `fetch` implementation and configurable base URL so tests do not depend on Steam availability and the endpoint can be replaced later.

The client returns `unknown` JSON plus request metadata. It does not normalize games or access D1.

### Steam raw schema

`lib/providers/steam/schema.ts` validates the Steam response envelope and every field consumed by the normalizer. It permits unrelated extra fields so a harmless Steam field addition does not break imports, while a changed or missing consumed field produces a `schema_changed` error.

### Steam normalizer

`lib/providers/steam/normalize.ts` is deterministic and has no database access. It converts one validated Steam DTO into a provider-neutral `CanonicalGameCandidate`. It owns release-date parsing, platform mapping, taxonomy slugs, company roles, canonical Store URL construction, and media metadata selection.

### Import planner and service

`lib/importers/steam.ts` coordinates the client, schemas, normalizer, store reads, planning, dry-run behavior, write execution, conflict recovery, and final result. Dry-run and write mode call the same planner. Write mode executes exactly the plan that dry-run exposes, subject to a final database uniqueness check.

### Import store

`lib/db/repositories/steam-import.ts` provides the bounded reads required by planning and converts an approved plan into one D1 batch. It accepts canonical DTOs and plan operations, never Steam raw DTOs.

## Steam Data Source

V2.2 uses the public Steam Store app-details endpoint for one App ID:

```text
GET https://store.steampowered.com/api/appdetails
    ?appids={appId}
    &cc=us
    &l=english
```

The fixed country and language make text and release-date handling deterministic. This Storefront endpoint exposes the required descriptions, companies, platforms, genres, images, and movies, but it does not have a stable public Steamworks API contract. V2.2 therefore treats it as a replaceable provider adapter and relies on runtime validation rather than assuming a permanent response shape.

Steam's documented [`IStoreService/GetAppList`](https://partner.steamgames.com/doc/webapi/IStoreService) is not used for detail import because it is an application-list API with limited metadata and requires a Web API key. HTML page scraping and third-party Steam datasets are out of scope.

### App ID validation

The public import API accepts a string or number, validates it as a positive unsigned 32-bit integer, and normalizes it to a base-10 string without leading zeroes. Invalid input fails before any network or database call.

### Network behavior and errors

The default request timeout is 10 seconds. The client does not perform unbounded or implicit retries. It returns a discriminated provider error with a stable code, a retryable flag, HTTP status where available, and `Retry-After` where available.

```ts
type SteamProviderErrorCode =
  | "invalid_app_id"
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "provider_unavailable"
  | "http_error"
  | "malformed_json"
  | "schema_changed"
  | "app_not_found"
  | "app_id_mismatch"
  | "unsupported_app_type";
```

- HTTP 429 maps to `rate_limited` and preserves `Retry-After`.
- HTTP 500-599 maps to retryable `provider_unavailable`.
- Other non-success statuses map to `http_error`.
- Abort caused by the client deadline maps to `timeout`; other fetch failures map to `network_error`.
- Invalid JSON maps to `malformed_json`.
- A Steam envelope with `success: false` maps to `app_not_found`.
- A valid envelope whose `steam_appid` differs from the requested ID maps to `app_id_mismatch`.
- A valid non-game application maps to `unsupported_app_type`; V2.2 does not import DLC, demos, software, video, or tools as canonical games.

## Steam Raw Schema

The response is a record keyed by the requested App ID. The selected value is a success-discriminated envelope:

```ts
type SteamAppDetailsEnvelope =
  | { success: true; data: SteamAppDetails }
  | { success: false; data?: unknown };

type SteamAppDetails = {
  type: string;
  steam_appid: number;
  name: string;
  short_description?: string;
  detailed_description?: string;
  website?: string | null;
  developers?: string[];
  publishers?: string[];
  platforms?: {
    windows: boolean;
    mac: boolean;
    linux: boolean;
  };
  genres?: Array<{ id: string; description: string }>;
  release_date?: { coming_soon: boolean; date: string };
  header_image?: string;
  capsule_image?: string;
  screenshots?: Array<{
    id: number;
    path_thumbnail: string;
    path_full: string;
  }>;
  movies?: Array<{
    id: number;
    name?: string;
    thumbnail?: string;
    webm?: { "480"?: string; max?: string };
    mp4?: { "480"?: string; max?: string };
  }>;
};
```

All persisted URLs must be valid HTTP(S) URLs. Invalid optional media or website URLs are omitted with a warning; invalid identity and required game fields reject the import.

Steam descriptions may contain provider HTML. V2.2 maps `short_description` to canonical `summary` and leaves canonical `description` null. It does not store or render raw Steam HTML.

## Canonical Candidate

The candidate is a provider-neutral DTO and is validated by a second Zod schema before planning:

```ts
type CanonicalGameCandidate = {
  source: {
    provider: "steam";
    externalId: string;
    fetchedAt: Date;
  };
  game: {
    preferredSlug: string;
    title: string;
    summary: string | null;
    description: null;
    status: "upcoming" | "released";
    releaseDate: string | null;
    coverUrl: string | null;
    heroUrl: string | null;
  };
  externalIds: Array<{
    provider: "steam";
    externalId: string;
    externalUrl: string;
  }>;
  officialLinks: Array<{
    provider: "steam";
    platform: null;
    linkType: "store" | "official_website";
    url: string;
    isOfficial: boolean;
    verificationStatus: "verified" | "unverified";
    verificationMethod: "provider_api" | null;
  }>;
  genres: Array<{ slug: string; name: string }>;
  platforms: Array<{
    slug: "windows" | "macos" | "linux";
    name: string;
  }>;
  companies: Array<{
    preferredSlug: string;
    name: string;
    role: "developer" | "publisher";
  }>;
  images: Array<{
    type: "cover" | "hero" | "screenshot";
    sourceUrl: string;
    width: number | null;
    height: number | null;
    sortOrder: number;
  }>;
  videos: Array<{
    provider: "steam";
    externalId: string;
    title: string | null;
    thumbnailUrl: string | null;
    sortOrder: number;
  }>;
};
```

Normalization caps one candidate at 50 screenshots and 20 movies. V2.2 stores Steam CDN source URLs and video metadata only; it never downloads media or writes to R2.

## Canonical Mapping Rules

### Game fields

- `title` comes from the validated Steam name.
- `summary` comes from trimmed `short_description`.
- `description` is null in V2.2.
- `status` is `upcoming` only when Steam explicitly reports `coming_soon: true`; otherwise it is `released`.
- `coverUrl` uses a validated Steam capsule image when present.
- `heroUrl` uses the validated Steam header image when present.

### Release date

`release_date` is populated only when the fixed English response contains an unambiguous, valid, complete Gregorian calendar date and it round-trips through the existing canonical `YYYY-MM-DD` validator.

Years, quarters, seasons, month-only dates, `Coming Soon`, `TBA`, localized or unknown formats, and invalid dates all normalize to null. The normalizer never invents a month or day.

### Platforms

Steam platform booleans map to GameHub lookup slugs:

| Steam field | GameHub slug | GameHub name |
|---|---|---|
| `windows` | `windows` | Windows |
| `mac` | `macos` | macOS |
| `linux` | `linux` | Linux |

Platform support is expressed exclusively through `game_platforms`. Every Steam Store official link has `platform = null`; the importer writes one canonical Steam Store URL regardless of how many platforms the game supports.

### Genres

Steam genre descriptions are normalized through the shared canonical slug algorithm and deduplicated within the candidate. If both slug and normalized name match an existing genre, it is reused. A slug/name contradiction is a `taxonomy_conflict`; the importer does not rename or overwrite canonical taxonomy.

### Companies

Steam `developers` map to `developer`; `publishers` map to `publisher`. Candidate duplicates are collapsed by normalized name plus role.

For persistence:

1. Use the normalized company-name slug when it is free.
2. Reuse an existing company when its slug and normalized name agree.
3. When the base slug belongs to a different name, append a stable short SHA-256 suffix derived from the normalized full company name.
4. If even the suffixed slug conflicts with a different name, extend the deterministic hash before failing with `company_conflict`.

Steam supplies names but no stable company identity. V2.2 may reuse an exact normalized-name match, but it does not claim that this resolves every real-world same-name company. Later manual or provider-ID reconciliation may split an ambiguous company.

### Official links

The canonical Store link is exactly:

```ts
{
  provider: "steam",
  platform: null,
  linkType: "store",
  url: `https://store.steampowered.com/app/${appId}/`,
  isOfficial: true,
  verificationStatus: "verified",
  verificationMethod: "provider_api"
}
```

One Store URL is persisted per game. Platform support never creates duplicate Store links.

A valid provider-supplied developer website may enter the candidate with `isOfficial: true`, `verificationStatus: "unverified"`, and no verification method. Merely appearing in the Steam response does not mark that site verified.

## Import Plan and Dry Run

The planner returns a complete, serializable plan:

```ts
type SteamImportPlan = {
  action: "create" | "existing" | "update";
  selectedSlug: string;
  existingGameId: number | null;
  creates: PlannedEntity[];
  updates: PlannedChange[];
  skips: PlannedSkip[];
  warnings: ImportWarning[];
};
```

`dryRun: true` performs the network request, both validation stages, normalization, database reads, collision resolution, duplicate detection, and plan generation. It never invokes a write method. Tests compare relevant table counts before and after dry-run.

A dry-run plan is a snapshot, not a lock. Formal import relies on D1 uniqueness constraints and conflict recovery to resolve changes that occur after planning.

## Idempotency and Result Semantics

Before planning any create, the importer queries `(provider = 'steam', external_id = normalizedAppId)`.

### Missing external ID

The planner creates a new canonical game and all accepted relations. Database uniqueness on `(provider, external_id)` is the final idempotency guard.

If the preferred slug is occupied, or the normalized title strongly overlaps an existing canonical title, the importer does not merge or overwrite. It follows the slug-collision strategy and adds a `possible_duplicate` warning identifying the candidate and possible existing game IDs/slugs for later review.

Title overlap is advisory only. The first implementation uses deterministic normalization and exact normalized-title equality; it does not introduce fuzzy-search infrastructure or an arbitrary similarity model in V2.2.

### Existing external ID

The associated canonical game is always reused. The importer never creates another `games` row.

Result semantics are strict:

- `updated`: at least one field allowed by the conservative policy was actually written with a value different from the stored value.
- `existing`: the database was not changed.
- A provider change that is disallowed by policy is recorded in `skips` or `warnings` and does not make the result `updated`.
- No-op SQL updates are excluded from the write plan rather than counted as changes.

### Concurrent requests

Two requests may both initially observe a missing external ID. One atomic batch can succeed; the other must fail on a unique constraint. The losing importer re-queries `(steam, appId)`:

- If the mapping now exists, it replans against that canonical game and returns `existing` or `updated` according to actual writes.
- If it does not exist and the conflict was only a slug race, it recalculates the next deterministic slug and retries a bounded number of times.
- Other conflicts return a typed import error.

## Slug Collision and Duplicate Warning Strategy

Game slug generation uses a stable algorithm: Unicode NFKD, lowercasing, diacritic removal, non-alphanumeric runs converted to one hyphen, boundary hyphens removed, and maximum canonical length enforced. An empty result falls back to `steam-{appId}`.

Selection order:

1. `{preferredSlug}`
2. `{preferredSlug}-steam-{appId}`
3. `{preferredSlug}-steam-{appId}-2`
4. Increment the suffix until a bounded retry limit is reached.

A slug collision never overwrites the occupant. A collision with a different canonical game always produces `possible_duplicate`, even when titles differ. Exact normalized-title overlap also produces the warning when the preferred slug is not occupied.

## Provider Ownership and Conservative Updates

V2.2 establishes a future precedence direction without implementing a general merge engine:

```text
Manual Override > IGDB > Steam
```

For a newly created game, the importer writes all accepted candidate data.

For an existing game, it may update only fields with unambiguous Steam ownership:

- `game_external_ids.external_url` and its `updated_at` for the matched Steam identity.
- The canonical Steam Store link's provider-verification metadata.
- Existing Steam video title or thumbnail metadata identified by `(game_id, provider, external_id)`.

It does not automatically overwrite or add existing canonical game scalars, slug, taxonomy relations, company relations, images, or non-Store website links. Those tables do not currently carry sufficient provider provenance for safe refresh ownership. Differences are exposed as skips or warnings.

An allowed field is included in `updates` only after comparison with the stored value. Identical values generate no SQL and cannot produce `updated`.

## Atomic D1 Write

All statements for one approved plan execute in one `D1Database.batch()` through the dedicated import store. [D1 documents a batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch) as sequential and transactional: a failed statement aborts or rolls back the full sequence.

The design does not use compensating deletes. It also avoids relying on Drizzle's explicit `BEGIN`/`COMMIT` transaction wrapper when D1's documented atomic primitive is batch.

Generated canonical IDs do not need to be allocated in application code. Ordered statements use unique slug or Steam external-ID subqueries to connect dependent rows:

```sql
INSERT INTO games (...);

INSERT INTO game_external_ids (game_id, provider, external_id, external_url)
SELECT id, 'steam', ?, ? FROM games WHERE slug = ?;

INSERT INTO game_images (game_id, ...)
SELECT game_id, ...
FROM game_external_ids
WHERE provider = 'steam' AND external_id = ?;
```

Lookup rows are inserted or reused before junction rows in the same batch. Planning detects taxonomy/company contradictions before constructing the batch; database constraints remain the final concurrency guard.

After a successful batch, the service resolves the canonical game through `(steam, appId)` and returns its GameHub ID. If any statement fails, no visible partial game or relation may remain.

## Local-Only CLI

V2.2 exposes a local operator command, not a UI or public API:

```bash
npm run steam:import -- 1245620
npm run steam:import -- 1245620 --write
```

The default is dry-run. `--write` may write only to Wrangler's local D1 state. The script always constructs a local platform proxy and contains no `--remote`, production database ID, remote HTTP endpoint, or option capable of selecting remote D1. Unknown flags, including `--remote`, are rejected.

Remote import and production authorization require a separate design and are explicitly unavailable in V2.2.

## Testing

### Provider client tests

- Invalid App ID fails without calling fetch.
- Timeout, network failure, 429 with `Retry-After`, 5xx, and other HTTP errors have distinct codes.
- Non-JSON data produces `malformed_json`.
- `success: false`, App ID mismatch, and unsupported app type are distinguished.

### Raw-schema tests

- Minimal and representative valid fixtures parse.
- Malformed envelopes and changed consumed field types fail.
- Unrelated additional Steam fields are tolerated.

### Normalizer tests

- Valid game normalization.
- Platform, genre, developer, and publisher mappings.
- One Steam Store link with `platform = null`.
- Developer website remains unverified.
- Cover, header, screenshot, and movie metadata.
- Only exact complete dates become `YYYY-MM-DD`; vague dates become null.
- Provider HTML does not enter canonical description.

### Import and real local-D1 tests

- New import creates the canonical game and all accepted relations.
- A second identical import returns `existing` with no writes.
- An actual permitted provider-field change returns `updated`.
- A disallowed canonical difference appears in skips/warnings and still returns `existing`.
- External-ID idempotency prevents a second canonical game.
- Slug collision selects the deterministic fallback and emits `possible_duplicate`.
- Exact normalized-title overlap emits `possible_duplicate` without merging.
- Genre, platform, company, official-link, screenshot, and movie relations are correct.
- Dry-run leaves every relevant table count unchanged.
- Concurrent imports converge to one external mapping and one canonical game.
- A test-only D1 trigger aborts a statement in the middle of the batch; assertions confirm no game, external ID, lookup, junction, image, video, or link residue.

Network tests use injected mock fetch and committed fixtures. A manually invoked live smoke test may exist but is never required for the normal test suite or CI.

## Expected Files

New files:

```text
lib/providers/steam/client.ts
lib/providers/steam/errors.ts
lib/providers/steam/schema.ts
lib/providers/steam/normalize.ts
lib/providers/steam/client.test.ts
lib/providers/steam/schema.test.ts
lib/providers/steam/normalize.test.ts

lib/importers/candidate.ts
lib/importers/slug.ts
lib/importers/steam.ts
lib/importers/steam.test.ts

lib/db/repositories/steam-import.ts

scripts/import-steam-game.ts

test/fixtures/steam/appdetails-valid.json
test/fixtures/steam/appdetails-success-false.json
test/fixtures/steam/appdetails-malformed.json
```

Expected modifications:

```text
package.json
README.md
```

No new runtime dependency is expected: Workers-compatible `fetch`, AbortController, Web Crypto, existing Zod, Drizzle, and Wrangler are sufficient.

The following remain unchanged:

```text
lib/db/schema.ts
drizzle/*.sql
V1 UI and visual design
lib/mock-data.ts
```

## Completion Gates

V2.2 is complete only when all specified client, schema, normalization, idempotency, collision, dry-run, concurrency, and rollback tests pass against the local D1 test binding; schema and migration hashes remain unchanged; the CLI cannot select remote D1; and the existing test, typecheck, lint, build, local migration check, and D1 verification commands remain green.
