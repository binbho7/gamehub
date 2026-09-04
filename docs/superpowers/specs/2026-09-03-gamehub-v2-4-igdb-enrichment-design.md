# GameHub V2.4 IGDB Enrichment Design

## Goal

Add a reliable, local-only workflow that enriches one existing canonical GameHub game with IGDB metadata. The workflow resolves identity through the game's Steam external ID, validates and normalizes provider data, produces a dry-run plan, and atomically writes only changes that are safe without field or relationship provenance.

V2.4 never creates a canonical game. It does not implement batch enrichment, fuzzy identity matching, remote D1 writes, R2, Cron, an admin UI, or full `Manual > IGDB > Steam` reconciliation.

## Non-Negotiable Boundaries

- Input identifies one existing canonical game. A missing game fails before provider access.
- The game must have exactly one usable Steam external ID for automatic Steam-to-IGDB mapping.
- IGDB identity is resolved only through IGDB `external_games`; title similarity is never an automatic identity signal.
- `games.id`, Steam App ID, and IGDB game ID remain independent identities.
- Scalar canonical fields are fill-empty only. IGDB does not overwrite a non-null or otherwise populated value.
- Taxonomy and company relationships are additive only. V2.4 never deletes or replaces a relationship.
- Media and links are provider-scoped additions where the current schema permits this safely.
- Default execution is dry-run. `--write` targets Wrangler local D1 only.
- Secrets and access tokens are never stored in D1, committed, logged, or returned.
- `lib/db/schema.ts`, `drizzle/*.sql`, `lib/mock-data.ts`, the V1 UI, and V2.2/V2.3 behavior remain unchanged.
- No migration is added.

## Official API Research and Constraints

### Authentication

IGDB v4 uses a Twitch confidential application and an OAuth 2.0 client-credentials app token. Local configuration supplies `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`. The Auth Client sends a form-encoded `POST` to `https://id.twitch.tv/oauth2/token` with `grant_type=client_credentials` and consumes `access_token`, `expires_in`, and `token_type`.

IGDB requests use `POST https://api.igdb.com/v4/{endpoint}` with `Client-ID`, `Authorization: Bearer <token>`, and an APICalypse query body. IGDB documents a limit of four requests per second and at most eight concurrent open requests. V2.4 performs a small, sequential request set for one game and does not retry broadly.

### Commercial use

IGDB documents its API as free for non-commercial use and directs commercial users to its partnership process. The README must state that GameHub must confirm IGDB commercial partnership, licensing, and attribution requirements before a commercial production launch. This does not block low-frequency local V2.4 development.

## Identity Resolution

The canonical game is loaded first, including its external IDs. The service requires one valid Steam App ID and queries IGDB's `external_games` endpoint:

```apicalypse
fields id,game,uid,external_game_source;
where external_game_source = 1 & uid = "<steam-app-id>";
limit 2;
```

`external_game_source = 1` is the Steam source. The deprecated `category` field is not consumed. `limit 2` is deliberate: zero results means no mapping, one valid result establishes identity, and two results are enough to detect ambiguity without fetching a large set.

The Response Adapter verifies that the returned source and UID match the request and that `game` is a valid IGDB game ID. It deduplicates exact duplicate mapping rows by IGDB game ID before deciding cardinality; multiple distinct game IDs are ambiguous.

Provider mapping failures are typed `IgdbError`s and stop before the planner:

- `mapping_not_found`: no mapping exists.
- `mapping_ambiguous`: more than one distinct IGDB game ID is mapped.
- `unsupported_mapping`: a row lacks a usable game ID, has the wrong source, or does not preserve the requested Steam UID.

After mapping, the client obtains one game from `/v4/games` by exact IGDB ID. An empty result is `igdb_game_not_found`; multiple or mismatched IDs are `schema_changed` or `unsupported_mapping` as appropriate. No title search or fuzzy fallback is attempted.

## Provider Requests

### Mapping request

```text
POST https://api.igdb.com/v4/external_games
```

Only `id`, `game`, `uid`, and `external_game_source` are requested and consumed.

### Game request

```text
POST https://api.igdb.com/v4/games
```

The query selects only fields used by normalization:

```apicalypse
fields
  id,name,summary,storyline,first_release_date,
  genres.id,genres.name,genres.slug,
  platforms.id,platforms.name,platforms.slug,
  involved_companies.developer,
  involved_companies.publisher,
  involved_companies.company.id,
  involved_companies.company.name,
  involved_companies.company.slug,
  involved_companies.company.url,
  cover.image_id,cover.width,cover.height,
  artworks.image_id,artworks.width,artworks.height,
  screenshots.image_id,screenshots.width,screenshots.height,
  videos.video_id,videos.name,
  websites.type,websites.trusted,websites.url;
where id = <igdb-game-id>;
limit 1;
```

The implementation must not use `fields *`. Queries are constant templates with validated numeric identities interpolated through a dedicated query builder, not arbitrary user APICalypse input.

## Architecture and Data Flow

```text
Canonical game ID
  -> Input validation
  -> Enrichment Store read
  -> existing canonical game + Steam external ID
  -> IGDB Auth Client
  -> process-memory access token
  -> IGDB HTTP Client: external_games
  -> Mapping Raw Schema and Response Adapter
  -> unique IGDB game ID
  -> IGDB HTTP Client: games
  -> Game Raw Schema and Response Adapter
  -> IGDB Normalizer
  -> IgdbNormalizationResult
  -> Enrichment Planner
  -> IgdbEnrichmentPlan
  -> dry-run result, or local D1 atomic batch
  -> final enrichment result
```

### Auth Client

The Auth Client owns credential validation, the token HTTP request, token-response decoding, error classification, process-memory caching, expiry handling, and single-flight coordination. It exposes an access-token getter to the IGDB Client but never exposes the client secret beyond its private token request.

The cache stores `{ accessToken, expiresAtMs }` and considers a token expired before its real deadline using a fixed safety margin. Concurrent callers share one pending token request. A rejected request clears the pending promise.

Each new CLI process may request a new token because the cache is process-local. V2.4 accepts this for a low-frequency, single-game local CLI. Tokens are not persisted to D1 or disk. A batch, Cron, Worker, or long-lived production phase must redesign token lifecycle, refresh coordination, rate limiting, and observability.

### IGDB HTTP Client

The IGDB Client is HTTP-only. It acquires a token, builds authenticated POST requests, enforces a timeout that covers fetch and body consumption, classifies HTTP failures, and decodes JSON to `unknown`.

It does not understand Steam mapping cardinality, canonical games, candidate fields, normalization, planning, or D1. On an authentication response it may invalidate the cached token and retry authentication once; it must not perform general automatic retries that amplify rate-limit or availability failures.

### Raw Schemas and Response Adapters

Zod raw schemas validate only consumed provider fields and allow unrelated extra fields. Required identity and game fields fail as `schema_changed`. Optional collections default to empty only after their container type has been validated.

The Mapping Adapter owns provider response meaning: empty, ambiguous, mismatched, or unsupported mapping. The Game Adapter owns exact IGDB game response identity. Neither adapter owns canonical DB conflicts or write policy.

Malformed optional website or media entries should be isolated when possible and converted into normalization warnings rather than failing otherwise valid core game data. A changed type for a consumed core field remains `schema_changed`.

### Normalizer

The normalizer is deterministic and has no HTTP or D1 dependency. It returns:

```ts
type IgdbNormalizationResult = {
  candidate: IgdbEnrichmentCandidate;
  warnings: IgdbEnrichmentWarning[];
};
```

It validates URLs, converts exact provider identities to strings, maps known fields into provider-neutral DTOs, applies deterministic media ordering and caps, and preserves all non-fatal omissions as warnings.

### Planner

The planner compares a normalized candidate with one indexed canonical snapshot. It is the sole owner of write eligibility, creates, updates, skips, warnings, and canonical identity conflicts. Dry-run and write use the same plan.

### Enrichment Store

The D1 store reads games by canonical ID and indexed external identity, resolves existing relations/media/links, and executes an approved plan. It must not reinterpret provider data or widen planner permissions.

## Raw Provider Contracts

The consumed mapping contract is:

```ts
type IgdbExternalGameRaw = {
  id: number;
  game: number;
  uid: string;
  external_game_source: number;
};
```

The consumed game contract is:

```ts
type IgdbGameRaw = {
  id: number;
  name: string;
  summary?: string | null;
  storyline?: string | null;
  first_release_date?: number | null;
  genres?: IgdbNamedEntityRaw[];
  platforms?: IgdbNamedEntityRaw[];
  involved_companies?: IgdbInvolvedCompanyRaw[];
  cover?: IgdbImageRaw | null;
  artworks?: IgdbImageRaw[];
  screenshots?: IgdbImageRaw[];
  videos?: IgdbVideoRaw[];
  websites?: IgdbWebsiteRaw[];
};
```

All IGDB numeric IDs must be positive safe integers. Names and provider IDs must be non-empty after validation. `first_release_date` is accepted only when it can be converted to a real UTC calendar date. Invalid or imprecise data produces `null` or a warning; normalization never invents a date.

## Enrichment Candidate

The provider-neutral candidate contains suggestions for one known game rather than instructions to create a game:

```ts
type IgdbEnrichmentCandidate = {
  source: {
    provider: "igdb";
    externalId: string;
    fetchedAt: Date;
  };
  identity: {
    canonicalGameId: number;
    steamAppId: string;
    igdbGameId: string;
  };
  game: {
    title: string | null;
    summary: string | null;
    description: string | null;
    releaseDate: string | null;
    coverUrl: string | null;
    heroUrl: string | null;
  };
  externalIds: IgdbExternalIdCandidate[];
  genres: TaxonomyCandidate[];
  platforms: TaxonomyCandidate[];
  companies: CompanyCandidate[];
  officialLinks: OfficialLinkCandidate[];
  images: ImageCandidate[];
  videos: VideoCandidate[];
};
```

The IGDB external ID is included exactly once as `provider = "igdb"`; it never becomes `games.id`.

## Canonical Scalar Ownership

The intended long-term precedence is:

```text
Manual Override > IGDB > Steam
```

The current schema cannot identify which provider or person owns an existing scalar value. V2.4 therefore does not implement precedence-based replacement. It applies this safe subset:

- If a nullable canonical field is empty and IGDB supplies a valid value, plan a fill.
- If an existing value equals the candidate, plan no change.
- If an existing value differs, preserve it and record `ownership_unknown` in skips or conflicts.
- `title` is required and therefore never automatically replaced by IGDB in V2.4; a difference is a suggestion only.
- `updated_at` changes only when at least one permitted database change is written.

The fill-empty set is `summary`, `description`, `release_date`, `cover_url`, and `hero_url`. A provider change that cannot be written does not make the result `updated`.

## Relationship Provenance Boundary

`game_genres`, `game_platforms`, and `game_companies` have no provider ownership. V2.4 may use IGDB to add an exact relationship that is not already present, but it must:

- add only missing relationships;
- never remove a relationship;
- never replace one relationship with another;
- never claim the resulting relation has IGDB provenance;
- leave conflicts or uncertain mappings as warnings/skips;
- keep shared lookup rows intact and avoid renaming them based on provider data.

The future scalar `game_field_provenance` concept cannot solve relationship ownership. Full `Manual > IGDB > Steam` relationship reconciliation needs a separate relationship-provenance design, likely provider assertions attached to game-to-entity relations. It is explicitly outside V2.4.

Genres use normalized, deterministic slugs and reuse compatible existing rows. Platforms map only through an explicit GameHub platform mapping table in code; unknown IGDB platforms are skipped with warnings rather than creating arbitrary platform semantics. Companies use deterministic name/slug collision handling consistent with the D1-safe V2.2 rules and add only `developer` or `publisher` roles explicitly supplied by IGDB.

## Official Website Policy

Only an IGDB website satisfying both conditions is automatically planned:

```text
website.type === 1
website.trusted === true
```

It is normalized as:

```text
provider = igdb
platform = null
link_type = official_website
is_official = true
verification_status = unverified
verification_method = null
```

IGDB trust establishes eligibility to add the provider assertion; it does not establish GameHub verification. Other website types, untrusted websites, invalid URLs, and duplicate URLs become suggestions/skips or warnings. Existing GameHub verification metadata is never downgraded or overwritten.

## Media Policy and Bounds

V2.4 stores IGDB source URL and metadata only. It does not download, proxy, cache, transform, or upload media.

HTTPS URLs are constructed from `image_id`, never copied from a protocol-relative provider URL:

```text
cover:     https://images.igdb.com/igdb/image/upload/t_cover_big_2x/{image_id}.jpg
artwork:   https://images.igdb.com/igdb/image/upload/t_1080p/{image_id}.jpg
screenshot:https://images.igdb.com/igdb/image/upload/t_screenshot_big/{image_id}.jpg
```

Only safe image IDs matching a narrow provider identifier contract are accepted. Ordering is deterministic: preserve provider order after stable first-wins deduplication by final source URL. Apply caps before D1 lookup and write planning:

- artworks: maximum 20;
- screenshots: maximum 50;
- videos: maximum 20.

If any collection exceeds its cap after validity filtering and deduplication, keep the first capped items and emit `media_limit_applied`. Cover is a singular item and does not count against artwork or screenshot caps. These bounds keep planning reads and the single-game write batch bounded.

IGDB video metadata supplies a YouTube `video_id`; V2.4 stores metadata only and does not download video. Invalid IDs or URLs are warned and skipped.

## Field and Entity Write Matrix

| Data | Allowed create/fill | Allowed update | Preserved or skipped |
|---|---|---|---|
| IGDB external ID | Add to current game | Provider-owned URL only if explicitly modeled and proven | Cross-game or different current binding blocks |
| `title` | No | No | Different value is suggestion |
| Nullable canonical scalars | Fill only when empty | No replacement | Non-empty differences use `ownership_unknown` |
| Genre relations | Add missing exact relation | No | Never remove/replace |
| Platform relations | Add missing explicitly mapped relation | No | Unknown mapping skipped |
| Company relations | Add missing developer/publisher relation | No | Never remove/replace/rename shared company |
| Official website | Add eligible missing URL | No | Existing verification is preserved |
| Images | Add missing capped IGDB source URLs | No | Duplicate or invalid media skipped |
| Videos | Add missing capped provider identity | No | Existing metadata differences are preserved |
| Steam-owned records | No | No | Always unchanged |

## Enrichment Plan and Result Semantics

```ts
type IgdbEnrichmentPlan = {
  action: "enrich" | "existing" | "blocked";
  gameId: number;
  slug: string;
  matchedIgdbGame: { id: string; name: string } | null;
  creates: PlannedCreate[];
  updates: PlannedUpdate[];
  skips: PlannedSkip[];
  warnings: IgdbEnrichmentWarning[];
  conflicts: EnrichmentConflict[];
};
```

- `enrich`: at least one permitted write would produce an actual database change.
- `existing`: identity and safe additions already exist, with no permitted change.
- `blocked`: a canonical database identity conflict prevents the whole write.

Provider mapping failures never produce a blocked plan because they stop as typed `IgdbError`s before planning. `blocked / identity_conflict` is reserved for canonical DB facts:

- the mapped IGDB external ID already belongs to another canonical game; or
- the current canonical game already has a different IGDB external ID.

Changes that IGDB suggests but conservative ownership rules reject go to `skips`, `warnings`, or `conflicts` and do not turn `existing` into `enrich`.

## Dry Run and Atomic Write

`enrichIgdbGame(gameId, { dryRun: true })` performs canonical lookup, Steam identity lookup, IGDB mapping and fetch, runtime validation, normalization, database comparison, and plan generation. It executes no mutation.

Write mode executes exactly the approved creates and fills in one D1 `batch`. The IGDB external ID, scalar fills, new lookup rows, new relations, official link, images, and videos must succeed or fail together. Failure cannot leave candidate-specific rows or relationships behind. Rollback tests compare pre/post deltas so reusable shared lookup rows are not incorrectly expected to be empty.

The existing unique `(provider, external_id)` constraint is the final concurrent identity guard. After a unique conflict, the service rereads canonical bindings and returns idempotent `existing` only when the winner bound the same IGDB ID to the same game; otherwise it returns a blocked identity conflict. Formal write batches are not split.

## Local-Only CLI

```bash
npm run igdb:enrich -- 123
npm run igdb:enrich -- 123 --write
npm run igdb:enrich -- 123 --json
```

The positional input is a positive canonical GameHub integer ID. Default mode is dry-run. `--write` may initialize only Wrangler local D1. The CLI rejects `--remote`, environment selectors, remote database IDs, remote URLs/configuration, unknown flags, and missing or invalid IDs.

The CLI never creates a canonical game and does not alter V2.2 or V2.3 command behavior. Human-readable output summarizes matched identity and plan sections. JSON output contains the typed result but never credentials, access tokens, Authorization headers, or raw request configuration.

## Secrets Management

Local credentials are supplied as `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` through the process environment or an explicitly documented gitignored local mechanism. They are not committed or placed in application data.

Future Workers deployment must use Cloudflare Workers secrets. V2.4 neither implements a remote enrichment path nor accepts remote configuration.

Error messages must be constructed from stable codes and sanitized context. They must not include the token request body, a URL containing the client secret, response authorization headers, or serialized environment values.

## Error Contract

```ts
type IgdbErrorCode =
  | "missing_credentials"
  | "invalid_credentials"
  | "authentication_failed"
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "provider_unavailable"
  | "http_error"
  | "malformed_json"
  | "schema_changed"
  | "canonical_game_not_found"
  | "steam_external_id_missing"
  | "mapping_not_found"
  | "mapping_ambiguous"
  | "unsupported_mapping"
  | "igdb_game_not_found"
  | "write_conflict";
```

Auth owns credential and token failures. The HTTP Client owns transport, HTTP status, and JSON decoding. Adapters own provider schema and mapping semantics. The service owns missing canonical/Steam prerequisites. The planner owns canonical `identity_conflict` as a blocked plan rather than an exception. The store owns write conflicts.

HTTP 429 and 5xx errors are retryable metadata, but V2.4 performs no general implicit retry. Invalid credentials, schema changes, identity failures, and canonical prerequisites are non-retryable without changed input or configuration.

## Test Strategy

Automated tests use injected fetch and recorded minimal fixtures; they never make live IGDB requests.

### Auth Client

- missing credentials and sanitized errors;
- valid token response and required form body;
- invalid credentials, timeout, network failure, malformed JSON, and changed token schema;
- cache hit, expiry safety margin, rejected-promise cleanup, and concurrent single-flight;
- no token or secret in errors/results.

### IGDB Client

- endpoint, headers, APICalypse body, timeout covering body consumption;
- 401/403, 429 with retry metadata, 4xx, 5xx, network failure, malformed JSON;
- at most one authentication refresh retry;
- HTTP-only dependency boundary.

### Schemas and Adapters

- valid mapping and game fixtures, extra provider fields, consumed field changes;
- exact Steam source/UID and exact IGDB game ID;
- missing, ambiguous, duplicate-identical, and unsupported mappings;
- optional invalid media/website entries do not invalidate core game data when they can be warned safely.

### Normalizer

- canonical candidate fields and exact date conversion;
- genre, explicit platform mapping, and developer/publisher company roles;
- official website requires `type === 1 && trusted === true` and remains unverified with null verification method;
- image URL construction uses the required HTTPS sizes;
- stable media dedupe/order and caps of 20 artworks, 50 screenshots, and 20 videos;
- `media_limit_applied` and invalid optional-data warnings.

### Planner

- existing-game-only and Steam external ID prerequisites;
- scalar fill-empty, equal-value no-op, and non-empty ownership skip;
- additive-only relations with no removal or replacement;
- IGDB external ID idempotency;
- provider mapping errors never enter the planner;
- cross-game/current-game IGDB identity conflicts produce `blocked`;
- strict `enrich`, `existing`, and `blocked` semantics.

### Real Local D1

- dry-run causes zero writes;
- a new enrichment writes all approved entities atomically;
- repeated enrichment is idempotent;
- injected batch failure leaves no candidate-specific delta;
- concurrent same-game enrichment converges without duplicate identity or relation records;
- conflicting IGDB identity never partially writes;
- shared lookup rows remain intact;
- the formal write remains one atomic D1 batch.

### CLI and Regression

- default dry-run, local `--write`, JSON and human formats;
- invalid ID, missing game, unknown flag, `--remote`, and environment-selector rejection;
- no remote configuration, secret output, game creation, or V2.2/V2.3 invocation changes;
- all existing tests, typecheck, lint, webpack build, local D1 checks, audit, and diff checks pass;
- schema hash and both existing migrations remain unchanged.

## Expected Files

Expected additions:

```text
lib/providers/igdb/errors.ts
lib/providers/igdb/auth-client.ts
lib/providers/igdb/schema.ts
lib/providers/igdb/response.ts
lib/providers/igdb/client.ts
lib/providers/igdb/normalize.ts
lib/enrichers/igdb-candidate.ts
lib/enrichers/igdb-plan.ts
lib/enrichers/igdb.ts
lib/db/repositories/igdb-enrichment.ts
scripts/enrich-igdb-game.ts
fixtures/igdb/*
corresponding *.test.ts files
```

Expected modifications are limited to `package.json` and `README.md` plus implementation-driven test configuration if necessary. No production UI file is expected to change.

## Schema Decision and Future Provenance

The existing schema is sufficient for V2.4's constrained behavior: existing-only enrichment, Steam-to-IGDB identity mapping, an IGDB external ID, fill-empty scalar metadata, additive-only relationships, provider-scoped media/link additions, dry-run, and a local atomic write.

No migration is required or permitted in V2.4.

The schema is not sufficient for full `Manual > IGDB > Steam` reconciliation. A future provenance phase must separately address:

1. scalar provenance and manual locks, potentially through a field-provenance structure; and
2. relationship assertions/provenance for genres, platforms, companies, and any future reconciled relation.

Neither model is introduced implicitly by V2.4. Until both are designed, non-empty scalar replacement and relationship removal/reconciliation remain prohibited.

## Acceptance Criteria

V2.4 is design-complete for implementation when it can demonstrate that:

- one existing canonical game maps from its Steam App ID to exactly one IGDB game through official identity data;
- provider mapping failures stop before planning with typed errors;
- canonical IGDB identity conflicts produce a blocked plan;
- dry-run reports every safe change, skip, warning, and conflict without writes;
- write mode changes only fill-empty scalars and additive entities in one local D1 batch;
- website trust, media caps, relationship provenance boundaries, and token lifecycle rules are enforced;
- repeated or concurrent execution does not create duplicate canonical identities or partial enrichment;
- secrets never leave the Auth/HTTP boundary;
- schema, migrations, V1 UI, and V2.2/V2.3 behavior remain unchanged.
