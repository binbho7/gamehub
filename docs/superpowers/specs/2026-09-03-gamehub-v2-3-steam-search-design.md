# GameHub V2.3 Steam Search Design

## Goal

Implement a reliable Steam keyword-search path that returns a small, provider-neutral list of Steam App ID candidates for explicit user selection. After selection, users continue through the existing V2.2 single-game importer; V2.3 never imports automatically and never writes to D1.

V2.3 is intentionally limited to search and selection support. It does not add a search UI, database-backed search index, result cache, batch import, remote import, Steam detail normalization, canonical merge logic, IGDB, Epic, GOG, R2, Cron, or user features.

## Non-Negotiable Boundaries

- Search and detail/import are separate provider flows.
- Search produces Steam App IDs only from Store items whose raw `type` is exactly `app`.
- A Store `app` is not assumed to be a canonical game. It can still be a game, DLC, demo, soundtrack, software, or another Steam application type.
- The existing V2.2 app-details Response Adapter remains the final authority for rejecting unsupported application types through `unsupported_app_type`.
- The search CLI does not initialize or write D1 and does not call the V2.2 importer.
- The search CLI does not expose `--write`, `--remote`, an environment selector, a remote database ID, or remote configuration.
- V2.2 detail schemas, normalizer, canonical candidate, planner, repository, idempotency, conflict recovery, and atomic write behavior remain unchanged.
- `lib/db/schema.ts`, `drizzle/*.sql`, `lib/mock-data.ts`, and the V1 UI remain unchanged.
- No migration is added.

## Provider Research and Decision

### Selected source: Steam Store structured search

V2.3 uses the Steam Store endpoint currently used for lightweight structured search:

```text
GET https://store.steampowered.com/api/storesearch/
    ?term={query}
    &l=english
    &cc=US
```

It requires no API key, returns JSON, performs server-side keyword search, and supplies Store item IDs, names, types, and optional thumbnail URLs. It avoids downloading a complete application catalog and does not require HTML parsing.

The fixed `l=english` and `cc=US` parameters make automated behavior deterministic. Unicode queries are accepted and encoded as UTF-8, but discoverability remains locale-dependent: a localized title may not match under the fixed English/US locale. V2.3 documents that limitation rather than guessing a locale. Explicit locale selection may be designed later.

The endpoint currently returns no more than approximately ten useful candidates and does not reliably honor client-provided `count` or `limit` parameters. V2.3 therefore enforces its own result limit after normalization.

### Alternatives considered

| Source | Key | Response | Keyword search | Identity/type value | Decision |
|---|---:|---|---:|---|---|
| `/api/storesearch/` | No | Structured JSON | Yes | ID, name, Store item type, image | Selected |
| `/search/suggest` | No | HTML fragment | Yes | Values embedded in markup | Rejected: HTML parsing |
| `/search/results` | No | JSON envelope containing result HTML | Yes | Values embedded in markup | Rejected: HTML parsing |
| `IStoreService/GetAppList` | Yes | Structured, paginated catalog | No | App list with category controls | Rejected for real-time search |
| Legacy `ISteamApps/GetAppList` | No | Full application list | No | ID and name, weak type data | Rejected: full-list maintenance and legacy scalability |

`IStoreService/GetAppList` is appropriate only for a future maintained catalog or search index. It requires a Web API key and is not a keyword-search endpoint. The legacy public App List likewise requires downloading and searching a broad catalog locally.

### Stability and compliance risk

`/api/storesearch/` is Steam-owned and returns structured JSON, but it is not a documented Steamworks Web API contract. Steam publishes no compatibility guarantee, schema version, SLA, or rate-limit contract for it. Steam may change the payload, access policy, result count, or endpoint without notice.

V2.3 contains that risk by:

- isolating the endpoint behind a replaceable Search Client and Response Adapter;
- validating every consumed field at runtime;
- permitting unrelated provider fields so harmless additions do not break search;
- classifying HTTP and schema failures explicitly;
- issuing one request per CLI invocation with no implicit retry;
- avoiding HTML fallback, third-party datasets, and scraping;
- treating provider failure as an error rather than returning fabricated or stale identities.

If the endpoint becomes unsuitable, implementation stops at the provider boundary. Adopting a catalog-backed search source or another endpoint requires a separate design review.

## Architecture

```text
Raw query and CLI options
  -> Query Validator
  -> validated query and limit
  -> Steam Search Client
  -> unknown JSON response
  -> Steam Search Raw Zod Schema
  -> Steam Search Response Adapter
  -> validated provider search response
  -> Steam Search Normalizer
  -> SteamSearchNormalizationResult
  -> CLI formatter
  -> user selects one App ID
  -> existing V2.2 steam:import command (separate invocation)
```

### Query validator

The query validator owns search-input validation only. It trims surrounding whitespace, measures Unicode code points, validates the local result limit, and returns stable input errors before any network request.

It does not lowercase, transliterate, normalize accents, collapse internal whitespace, infer language, or modify the user's meaningful query text.

### Steam Search Client

The Search Client is HTTP-only. It owns URL construction, timeout enforcement, HTTP status classification, `Retry-After` extraction, and JSON decoding. It accepts injected `fetch`, base URL, and timeout dependencies for deterministic tests.

The client returns `unknown`. It does not validate provider fields, inspect Store item types, normalize App IDs, deduplicate results, apply the caller's result limit, call D1, or understand canonical games.

### Raw schema and Response Adapter

The raw Zod schema validates only fields consumed by V2.3. It permits additional provider fields. The Response Adapter parses the client's `unknown` value and maps an invalid consumed structure to `schema_changed`.

The adapter does not interpret an `app` as a canonical game. Store item filtering and result normalization belong to the normalizer.

### Search normalizer

The normalizer is deterministic and has no network, database, or importer dependency. It filters non-app Store items, normalizes retained identities, validates optional image URLs, deduplicates App IDs, preserves provider order, applies the local limit, and returns both results and structured warnings.

### Search service

The Search Service composes validation, Client, Adapter, and normalizer into the public search operation. It is the only dependency required by the CLI. It never imports the V2.2 importer or database modules.

## Query Validation

The public search operation accepts a query string and an optional result limit.

- Trim surrounding Unicode whitespace.
- Reject an empty or whitespace-only query.
- Preserve internal characters and whitespace after trimming.
- Support arbitrary Unicode input.
- Count the maximum length in Unicode code points, not UTF-16 code units.
- Accept at most 100 code points.
- Default `limit` to 10.
- Require `limit` to be an integer from 1 through 10 inclusive.
- Use 10 as the hard maximum because the selected endpoint does not reliably provide more candidates.
- Fail validation before calling `fetch`.

All query and limit failures use `invalid_search_query`; structured error details distinguish `empty_query`, `query_too_long`, and `invalid_limit`.

## HTTP Request Behavior

The client constructs this request:

```text
GET https://store.steampowered.com/api/storesearch/
    ?term={UTF-8-percent-encoded-query}
    &l=english
    &cc=US
```

Required behavior:

- Send `Accept: application/json`.
- Use a default ten-second deadline covering both the fetch and response-body consumption.
- Do not send an API key or depend on cookies.
- Do not use undocumented `count` or `limit` query parameters.
- Do not retry automatically.
- Return `unknown` after successful JSON parsing.

## Error Model

Search has three explicit error boundaries:

```ts
type SteamSearchClientErrorCode =
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "provider_unavailable"
  | "http_error"
  | "malformed_json";

type SteamSearchResponseErrorCode = "schema_changed";

type SteamSearchInputErrorCode = "invalid_search_query";
```

The shared public error shape contains a stable code, message, retryable flag, HTTP status when available, `Retry-After` when available, and an underlying cause when appropriate.

- Client deadline aborts map to `timeout`.
- Other fetch failures map to `network_error`.
- HTTP 429 maps to retryable `rate_limited` and preserves `Retry-After`.
- HTTP 500-599 maps to retryable `provider_unavailable`.
- Other non-success HTTP responses map to `http_error`.
- A successful HTTP response with invalid JSON maps to `malformed_json`.
- Valid JSON whose consumed structure fails the raw schema maps to `schema_changed`.
- Invalid query or limit input maps to non-retryable `invalid_search_query` before HTTP is called.
- A valid response containing no retained results is successful and returns an empty list; it is not an error.

## Raw Response Schema

The consumed provider shape is deliberately narrow:

```ts
type SteamSearchRawResponse = {
  total?: number;
  items: SteamSearchRawItem[];
};

type SteamSearchRawItem = {
  id: number;
  name: string;
  type: string;
  tiny_image?: string;
};
```

Zod requirements:

- The top-level value must be an object.
- `items` is required and must be an array.
- Each consumed item requires a positive integer `id`, a non-empty string `name`, and a non-empty string `type`.
- `tiny_image` is optional and, when present, must be a string. URL semantics are checked by the normalizer so an invalid optional URL produces a warning rather than `schema_changed`.
- `total` is optional. If present, it must be a non-negative integer, but search logic never consumes it.
- Top-level and item objects permit unrelated extra fields.
- Missing, added, or changed fields that V2.3 does not consume must not trigger `schema_changed`.
- A missing or invalid `items` field, or invalid required fields of an item, triggers `schema_changed`.

Making `total` optional prevents an unused provider field from becoming an accidental availability dependency.

## Store Item Type Boundary

Steam Store result type and canonical game type are separate concepts.

The Store endpoint may return `type = "app"`, `type = "sub"`, or another Store item type. A `sub`, package, bundle, or other non-app identifier is not a Steam App ID and must never be handed to `steam:import`.

Filtering is exact and case-sensitive:

```text
raw type === "app"
  -> retain
  -> expose id as appId
  -> SteamSearchResult.type = "unknown"

raw type !== "app"
  -> discard from results
  -> add unsupported_store_item_type warning
```

The normalizer does not lowercase or alias raw Store types. An unexpected spelling is filtered conservatively and reported.

Retaining `type = "app"` proves only that the identifier is an App ID. It does not prove that the application is a canonical game. An app may still represent a game, DLC, demo, soundtrack, software, tool, or other application. V2.3 does not inspect names or other fields to guess among them.

After selection, the unchanged V2.2 app-details Response Adapter remains the final canonical-type check and returns `unsupported_app_type` for unsupported applications.

## Search Result DTO and Warnings

The public result contains only fields needed by a search CLI or future selection UI:

```ts
type SteamSearchResult = {
  appId: string;
  name: string;
  type: "game" | "unknown";
  imageUrl: string | null;
};
```

For the selected V2.3 provider, every retained `type = "app"` item normalizes to `type = "unknown"`. The `game` member is reserved for a future source whose semantics have been explicitly validated; V2.3 never emits it based on the generic Store `app` type.

Normalization returns results together with non-fatal data-quality information:

```ts
type SteamSearchNormalizationResult = {
  results: SteamSearchResult[];
  warnings: SteamSearchWarning[];
};

type SteamSearchWarningCode =
  | "invalid_image_url"
  | "duplicate_app_id"
  | "unsupported_store_item_type"
  | "result_limit_applied";

type SteamSearchWarning = {
  code: SteamSearchWarningCode;
  message: string;
  itemIndex?: number;
  storeItemType?: string;
  appId?: string;
};
```

Warnings contain safe, bounded context only. They do not expose the full provider response.

## Normalization, Filtering, Deduplication, and Limit

The normalizer processes provider items in their original order:

1. Filter any item whose raw type is not exactly `app`; emit one `unsupported_store_item_type` warning for each filtered item.
2. Normalize the positive integer ID to its base-10 string App ID.
3. Trim the validated name.
4. Convert a valid HTTP(S) `tiny_image` to `imageUrl`; use null and emit `invalid_image_url` when a non-empty optional value is not an acceptable URL.
5. Deduplicate retained items by normalized App ID. Keep the first occurrence and emit `duplicate_app_id` for each later occurrence.
6. Preserve provider order among retained first occurrences.
7. Apply the validated local result limit after filtering and deduplication.
8. If otherwise valid unique app results exceed the limit, truncate them and emit one `result_limit_applied` warning containing bounded count information.

Filtering before deduplication ensures a non-app Store ID cannot suppress a valid App ID with the same numeric value. Applying the limit last ensures filtered packages and duplicates do not consume visible result slots.

No stage performs name-based DLC/demo/soundtrack inference.

## CLI Design

V2.3 adds a standalone command:

```bash
npm run steam:search -- "elden ring"
npm run steam:search -- "elden ring" --limit 5
npm run steam:search -- "elden ring" --json
```

Human-readable output is numbered and contains the result name and App ID:

```text
1. ELDEN RING
   App ID: 1245620
```

A successful empty result prints a clear no-results message and exits successfully.

JSON mode emits the validated query and complete normalization contract:

```json
{
  "query": "elden ring",
  "results": [
    {
      "appId": "1245620",
      "name": "ELDEN RING",
      "type": "unknown",
      "imageUrl": "https://example.invalid/image.jpg"
    }
  ],
  "warnings": []
}
```

Normal human output may summarize warnings without printing every warning detail. JSON output includes all warnings.

The CLI accepts only one positional query plus `--limit` and `--json`. It rejects no query, extra positional arguments, unknown flags, `--write`, `--remote`, environment selectors, remote database IDs, and remote URLs/configuration. It must not import database modules or V2.2 import modules.

## V2.2 Importer Handoff

Search and import remain two explicit invocations:

```text
npm run steam:search -- "elden ring"
  -> user reviews candidates
  -> user selects an App ID from a retained type=app result
  -> npm run steam:import -- 1245620
  -> optional explicit npm run steam:import -- 1245620 --write
```

V2.3 does not create a programmatic shortcut that automatically passes the first search result to the importer. User selection is the safety boundary.

The selected App ID is still revalidated by the V2.2 input validator. V2.2 then fetches app details and performs `unsupported_app_type`, candidate normalization, planning, dry-run, idempotency, collision handling, and optional atomic local D1 writing exactly as before.

## Testing Strategy

Default automated tests use injected `fetch` and fixed fixtures. They do not depend on live Steam availability, locale ranking, or rate limits.

### Query tests

- valid ASCII query;
- surrounding whitespace trimming;
- empty and whitespace-only query rejection;
- Unicode query preservation;
- length measured in Unicode code points;
- exactly 100 code points;
- more than 100 code points;
- default limit of 10;
- limits 1 and 10;
- zero, negative, non-integer, non-numeric, and greater-than-10 limits;
- invalid input fails before fetch.

### HTTP Client tests

- correct encoded endpoint, fixed locale, and Accept header;
- valid JSON success;
- timeout during fetch;
- timeout during body consumption;
- network failure;
- HTTP 429 with `Retry-After`;
- HTTP 5xx;
- other HTTP 4xx;
- malformed JSON;
- no implicit retry.

### Raw schema and adapter tests

- valid response with `total`;
- valid response without `total`;
- extra top-level and item fields;
- changes to unused provider fields do not fail;
- missing or non-array `items`;
- required `id`, `name`, or `type` type changes;
- malformed item;
- consumed-structure failures become `schema_changed`.

### Normalizer tests

- `type = "app"` produces an App ID and `type = "unknown"`;
- `type = "sub"` is filtered with a warning;
- other Store item types are filtered with warnings;
- package/bundle IDs never enter results;
- an app named like a game is not promoted to `game`;
- apps named like DLC, demo, soundtrack, software, or tool are retained as `unknown`, not guessed or filtered;
- valid optional image URL;
- missing image produces null without warning;
- invalid optional image produces null plus `invalid_image_url`;
- duplicate App ID uses first-wins and warns;
- provider order remains stable;
- filtering occurs before deduplication;
- limit occurs after filtering and deduplication;
- truncation emits `result_limit_applied`;
- no truncation warning when the count equals the limit.

### Service and CLI tests

- layer orchestration and propagated warnings;
- normal human output;
- JSON output includes results and warnings;
- `--limit` handling;
- successful empty output;
- unknown flag rejection;
- missing and extra query rejection;
- explicit rejection of `--write` and `--remote`;
- no D1 initialization or write;
- no call or dependency on the V2.2 importer;
- no raw provider response in CLI output.

### Regression and optional provider probe

The complete V2.2 suite remains green. A separately invoked, non-default contract probe may call the real endpoint for manual maintenance checks, but it must not be part of `npm test` or CI because the endpoint is undocumented and network/locale dependent.

## Expected File Changes

Expected new focused modules:

```text
lib/providers/steam/search/query.ts
lib/providers/steam/search/errors.ts
lib/providers/steam/search/client.ts
lib/providers/steam/search/schema.ts
lib/providers/steam/search/response.ts
lib/providers/steam/search/normalize.ts
lib/providers/steam/search/service.ts

lib/providers/steam/search/query.test.ts
lib/providers/steam/search/client.test.ts
lib/providers/steam/search/schema.test.ts
lib/providers/steam/search/response.test.ts
lib/providers/steam/search/normalize.test.ts
lib/providers/steam/search/service.test.ts

scripts/search-steam-games.ts
scripts/search-steam-games.test.ts

test/fixtures/steam/search-success.json
test/fixtures/steam/search-with-store-types.json
test/fixtures/steam/search-extra-fields.json
test/fixtures/steam/search-malformed.json
```

Expected existing-file changes are limited to:

```text
package.json
README.md
```

Implementation may adjust exact test or fixture filenames to existing repository conventions, but it must preserve the module responsibilities and prohibited-file boundaries in this spec.

## Schema and Migration Impact

No schema change or migration is required. Search results and warnings are transient values; V2.3 does not persist them, cache a Steam catalog, create search history, or alter canonical game data.

If implementation discovers that search requires persistent state, it must stop for design review rather than modifying `lib/db/schema.ts` or creating a migration.

## Acceptance Criteria

V2.3 is complete when:

- a valid keyword produces ordered, deduplicated search candidates through `/api/storesearch/`;
- every exposed `appId` originates from a raw item whose Store type is exactly `app`;
- `app` remains `unknown` and is never assumed to be a canonical game;
- non-app Store items are filtered and reported as warnings;
- optional invalid image URLs warn without failing the search;
- `total` is optional and unused;
- input, HTTP, JSON, and provider-schema errors preserve their assigned boundaries;
- the result limit is locally and deterministically enforced at 1-10;
- JSON CLI output includes normalization warnings;
- the CLI neither accesses D1 nor calls the importer;
- the V2.2 importer remains the explicit next step and final type-validation boundary;
- all V2.2 regression tests remain green;
- schema and migration files are unchanged.
