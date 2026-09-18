# GameHub V2.9 Production Data Foundation Design

## Context

GameHub currently serves a static Next.js export from `lib/mock-data.ts`. The repository also has a reviewed local D1 model and import/enrichment pipelines from V2.2–V2.8. V2.9 connects those capabilities at build time only:

```text
local D1 snapshot → validated public dataset → Next.js static export → Cloudflare Pages
```

Cloudflare Pages remains the runtime. The website has no runtime D1, Worker, R2, Container, Cron, API, authentication, or production Cloudflare dependency.

## Goals

- Export an explicit public presentation dataset from a local D1 snapshot.
- Build every current static route from that dataset, including game, genre, and platform paths.
- Make publication eligibility deterministic and fail closed.
- Preserve static client-side search and filtering.
- Keep generated data separate from `lib/mock-data.ts` fixtures.
- Make repeated exports from the same snapshot byte-for-byte stable where practical.
- Provide an operator workflow that validates the local snapshot before building.

## Non-goals

V2.9 does not add an Admin UI, Workers Paid, Containers, production D1, production R2, runtime APIs, authentication, users, comments, reviews, automatic Pages deployment, Cron, or a generic CMS. It does not migrate or delete existing D1 data and does not change the V2.8 deployment path.

## Current data model

The canonical `games` table provides `id`, stable `slug`, `title`, nullable `summary`/`description`, status, nullable release date, and nullable `cover_url`/`hero_url`. Related tables provide Steam/IGDB external identities, genres and platforms, developer/publisher companies, official links with verification metadata, image source metadata plus optional R2 binding metadata, and provider videos. The schema also contains scheduler tables, which are operational data and are never exported.

Repositories already expose complete per-game snapshots through the Steam import and IGDB enrichment stores. Their reads are ordered by stable IDs/order columns and can be composed into an export read model without invoking provider APIs or mutating D1.

## Frontend data requirements

The current `Game` type is a presentation fixture, not a one-to-one canonical row:

| Frontend field | D1 source | V2.9 rule |
| --- | --- | --- |
| `id` | none | Existing UI keys use the stable slug; the canonical numeric ID is not exposed in the public DTO. |
| `slug`, `title`, `description`, `releaseDate` | `games` | Direct mapping; nullable values are gated before publication. |
| `developer`, `publisher` | `game_companies` + `companies`, role | Deterministic first role match by company ID/name; missing roles are ineligible. |
| `genres`, `platforms` | relation tables | Ordered by taxonomy name, then ID; empty sets are ineligible. |
| `cover`, `hero`, `screenshots` | `game_images` source/storage fields and game cover/hero URLs | Prefer complete R2 binding only if present; otherwise approved remote source URLs. Every emitted URL is HTTP(S). |
| `officialLinks` | `game_official_links` | Emit only `is_official = true` links that satisfy the link policy and publication checks. |
| `status`, `isFree` | status is canonical; free is not modeled | Map canonical `released`/`upcoming` to UI status. `isFree` is not inferable and must be represented as unavailable until a reviewed source exists; it must not default to true. |
| `rating` | none | Not publishable as a real rating. Use an explicit unavailable presentation value and update UI contracts before real-data launch. |
| `titleCn` | none | Omit or render no secondary title; never copy or translate automatically. |
| `systemRequirements` | none | Render an explicit “暂无系统配置” state; never use mock requirements. |
| `modes`, `controllerSupport` | none | Render “暂无数据”/unknown states; do not infer support. |
| `trailerId` | `game_videos` provider/external ID | Emit only an allowlisted provider and valid ID; absent videos hide the trailer section. |

The generated DTO therefore must either introduce nullable/unknown presentation fields and update consumers, or define a separate `PublishedGame` contract with explicit unavailable values. It must not cast the D1 row to the fixture `Game` type.

## D1-to-site mapping

The exporter reads one local D1 snapshot in a read-only transaction or equivalent consistent read boundary. It loads games in canonical ID order and joins all public relations. It excludes `game_cron_sync_state`, `cron_sync_lease`, fence epochs, timestamps used only for operations, provider raw payloads, and internal storage diagnostics.

Relations are normalized into deterministic arrays:

- genres/platforms: name ascending, ID ascending;
- companies: role order `developer`, `publisher`, then name/ID;
- official links: link type policy order, provider, URL, ID;
- images: type order `cover`, `hero`, `artwork`, `screenshot`, then `sort_order`, ID;
- videos: provider, `sort_order`, ID.

The mapping keeps source URLs when no R2 binding is available. Complete storage metadata may be used only as a public storage URL after validating that the URL belongs to an approved public image origin; storage keys, hashes, MIME diagnostics, and R2 internals are never emitted.

## Public presentation DTO

The generated artifact contains a versioned DTO, for example:

```ts
type PublishedGame = {
  slug: string;
  title: string;
  description: string;
  releaseDate: string;
  status: "released" | "upcoming";
  developer: string;
  publisher: string;
  genres: string[];
  platforms: string[];
  cover: string;
  hero: string;
  screenshots: string[];
  officialLinks: PublishedOfficialLink[];
  videos: PublishedVideo[];
  optional: {
    titleCn: string | null;
    rating: number | null;
    systemRequirements: RequirementSet | null;
    modes: string[] | null;
    controllerSupport: boolean | null;
    isFree: boolean | null;
  };
};
```

The exact schema is implementation work, but its boundary is mandatory: no canonical numeric ID is required by the browser, and no scheduler, provider, secret, raw payload, verification internals, or storage metadata crosses it. A top-level artifact version and sorted game list make compatibility and reproducibility explicit.

## Publication eligibility

A game is published only when every gate passes:

1. canonical identity exists exactly once and has a valid Steam external identity;
2. slug matches the canonical slug grammar and is unique in the snapshot;
3. title, developer, publisher, release date, and at least one genre and platform are present;
4. status is `released` or `upcoming`, with a valid date consistent with that status policy;
5. a cover and hero URL are available from an approved source, and every emitted image URL passes HTTP(S), length, and host policy;
6. at least one official store or website link is official, valid, and not classified as unsafe/broken; provider-verified Steam store links are acceptable;
7. all relation references resolve and no duplicate public identity exists.

Missing optional metadata does not block publication, but emits an explicit unavailable value. Any gate failure excludes the game and records a deterministic diagnostic in the operator report, never in the public artifact. The exporter must fail the command if the snapshot contains invalid rows or duplicate slugs rather than silently publishing a partial result. An empty eligible set is a valid output only when the operator explicitly requests an empty publication; the default command fails closed.

## Missing-field behavior

The frontend must distinguish unavailable data from false/empty data. No mock default, fabricated rating, guessed free status, translated title, copied system requirements, or inferred controller support is permitted. Components should hide optional sections or render a stable “暂无数据” state. The build must type-check against the published DTO so future fields cannot accidentally reintroduce fixture-only assumptions.

## Image strategy

V2.9 does not deploy R2. The selected strategy is approved remote Steam/IGDB source URLs at build time. The exporter does not download bytes, create image bindings, or write R2. Next image configuration remains `unoptimized` with explicit approved remote patterns. A future R2 migration can replace URLs behind the DTO without changing page route contracts. Build-time downloading and checked-in binary manifests are rejected for V2.9 because they add licensing/cache complexity and unnecessary repository state.

## Official-link strategy

Only canonical `game_official_links` rows marked official are candidates. The exporter includes verified provider links and links whose status is explicitly publishable by policy; `unsafe`, `broken`, and `temporarily_unavailable` links are excluded. URLs are normalized deterministically, remain exact internally, and are presentation-safe for HTML. The exporter never performs live verification, changes verification metadata, or writes links.

## Slug stability

The D1 slug is the sole public identity. The exporter rejects missing, malformed, or duplicate slugs and never recomputes a replacement from title during export. Existing `toCanonicalSlug` rules remain the creation-time policy; collision suffixes are preserved. A slug change is a deliberate content migration and must be reviewed as a route change, not an automatic export behavior.

## Generated artifact

The planned artifact is `generated/site-data.json` plus a generated type/schema module under `generated/`. The directory is generated and ignored by Git. JSON is emitted with stable key ordering, stable array ordering, UTF-8 encoding, and a final newline. The artifact includes only the version, build snapshot marker chosen by the operator, and public DTO data. It must not include database timestamps unless they are explicitly part of a public contract.

## Determinism

Two exports from the same D1 snapshot and exporter version produce byte-identical output. Determinism requires explicit ordering for every query and relation, stable JSON serialization, no current-time fields, no random IDs, and no network/provider calls. The validation report is separately stable and sorted by canonical slug/reason.

## Build integration

The implementation will add `npm run site:data:export` and `npm run site:build`. The first command requires the local D1 binding/state, applies no migrations and performs no writes, exports and validates the DTO, and fails if generated data is absent or ineligible by default. The second command requires the generated artifact, runs the static Next.js build with `output: "export"`, and fails closed rather than importing `lib/mock-data.ts` in production mode. CI/build scripts must make the generated-data requirement explicit; fixture mode remains opt-in for tests and local UI development.

The generated dataset becomes the source for home, library, search, detail, genre, and platform pages. `generateStaticParams` derives only from eligible generated games, genres, and platforms. Client-side query filtering remains unchanged in behavior but consumes the generated dataset.

## Mock-data transition

`lib/mock-data.ts` remains a fixture/reference module for unit tests and fixture development. It is not a production fallback. A small data-source adapter selects generated data for site builds and mock data only under an explicit fixture/test mode. Missing generated data in production mode is a hard error with an actionable message. Migration is gradual: first the DTO adapter and pages, then fixture-only tests are separated, and finally unused mock fields can be retired after a reviewed compatibility window.

## Security/privacy

The export process is local-only and read-only. It must reject remote D1 flags and alternate configs unless a future design explicitly adds them. The artifact excludes internal IDs unless a route contract requires them, scheduler metadata, lease/fence values, secrets, provider raw payloads, private diagnostics, verification attempts, R2 keys/hashes, and database timestamps. URL host policy prevents arbitrary private or credential-bearing URLs from becoming public assets. Logs contain counts and stable public slugs/reason codes, never full rows or credentials.

## Testing

Tests must cover: DTO schema validation; every publication gate; duplicate/malformed slug rejection; status/date policy; official-link filtering; approved image host and URL validation; deterministic ordering and byte-identical repeat export; exclusion of scheduler/private fields; missing generated artifact failure; explicit fixture mode; route params for game/genre/platform; search/filter behavior against generated data; and static build output for `/`, `/games`, `/search`, representative detail/taxonomy routes, and real 404 behavior. A local D1 fixture must verify export is read-only and preserves the database byte/state snapshot.

## Operator workflow

1. Prepare or refresh the isolated local D1 snapshot through already-reviewed local import/enrichment commands.
2. Run the read-only local D1 preflight and inspect counts and exclusion reasons.
3. Run `npm run site:data:export` and review the deterministic report and generated artifact diff.
4. Run `npm run site:build`; verify static route artifacts and 404 output.
5. Serve/deploy the resulting `out/` through the separately approved Cloudflare Pages workflow. V2.9 itself does not automate Pages deployment.

No step contacts production D1/R2 or enables V2.8 services.

## Rollback

Rollback is a Pages artifact rollback: redeploy the previously reviewed `out/` artifact. Local D1 remains unchanged because export is read-only. If a dataset is rejected, remove the generated artifact and rerun from a corrected snapshot; never fall back silently to stale mock data. A route/slug rollback requires restoring the prior artifact and Pages version together.

## V2.10 compatibility

The versioned public DTO and data-source adapter leave room for a future remote API, authenticated editorial workflow, or R2-backed image URLs without exposing canonical schema types to UI components. V2.10 may add reviewed fields such as rating, requirements, or localized titles by extending the DTO version and eligibility policy, not by making pages read D1 at runtime.

## Alternatives

### A — Local D1 to generated dataset (selected)

This preserves static hosting, has no runtime credentials or Cloudflare paid requirements, is reproducible and reviewable, and allows publication gates. The trade-off is build-time freshness and an explicit export step.

### B — Pages frontend to remote API/D1

This provides fresher data but adds runtime availability, authentication, CORS/SSRF and caching concerns, production bindings, and a new operational surface. It violates the V2.9 static/no-runtime-D1 constraints.

### C — Checked-in manually maintained dataset

This is simple to deploy but makes synchronization and provenance manual, increases drift risk, and cannot reliably enforce canonical D1 eligibility. It remains suitable only for fixtures or emergency rollback artifacts.

## Out-of-scope

Admin UI, Workers Paid, Containers, production D1, production R2, runtime API, authentication, user accounts, comments/reviews, automatic Pages deployment, Cron, queues, durable jobs, and generic CMS behavior remain out of scope.
