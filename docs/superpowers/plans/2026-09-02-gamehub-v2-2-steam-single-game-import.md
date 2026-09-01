# GameHub V2.2 Steam Single-Game Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one local-only, dry-run-first command and service that imports a single Steam App ID into GameHub D1 through validated, provider-isolated, idempotent, atomic writes.

**Architecture:** An HTTP-only Steam client returns unknown JSON to a response adapter backed by raw Zod schemas. A pure normalizer returns a validated canonical candidate plus warnings; a planner compares that candidate with indexed D1 lookups, and a dedicated import store executes approved changes in one atomic D1 batch. The CLI injects only Wrangler local D1 and cannot select a remote database.

**Tech Stack:** TypeScript, Zod 4, Drizzle ORM D1 driver, Cloudflare D1/Wrangler, native Fetch/AbortController/Web Crypto, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-gamehub-v2-2-steam-single-game-import-design.md`

## Global Constraints

- Import exactly one Steam App ID per invocation; do not add batching, Cron, queues, a management UI, or a public import route.
- Keep Steam App IDs exclusively in `game_external_ids`; never use one as `games.id`.
- Do not modify `lib/db/schema.ts`, any `drizzle/*.sql`, V1 UI files, or `lib/mock-data.ts`.
- Do not add IGDB, Epic, GOG, R2, remote D1 access, media downloads, prices, languages, or age-rating storage.
- Keep Steam raw fields inside `lib/providers/steam/`; repositories consume only canonical candidates and import plans.
- Keep Steam Client HTTP-only. It may emit only `timeout`, `network_error`, `rate_limited`, `provider_unavailable`, `http_error`, and `malformed_json`.
- Let the response adapter alone emit `schema_changed`, `app_not_found`, `app_id_mismatch`, and `unsupported_app_type`.
- Use two Zod boundaries: raw Steam response and normalized canonical candidate.
- Dry-run and write mode use the same planner. Dry-run must never call a store write method.
- Execute each approved write plan in one D1 `batch()`; do not use compensating deletes or split one game across batches.
- Return `updated` only when an allowed value actually changes and is written; disallowed provider differences become skips/warnings.
- Generate `possible_duplicate` only from the indexed preferred-slug collision lookup. Never scan games by normalized title.
- Store one Steam Store link with `platform = null`; platform support belongs in `game_platforms`.
- Parse only an explicit, complete, valid English calendar date into canonical `YYYY-MM-DD`; every vague date becomes null.
- Cap local imports at 50 screenshots and 20 movies and report omitted items as warnings.
- The CLI defaults to dry-run. `--write` targets only Wrangler local D1; reject `--remote` and every unknown flag.
- Every task follows red-green TDD and ends with its own commit.

## File Responsibility Map

| File | Responsibility |
|---|---|
| `lib/providers/steam/app-id.ts` | Validate and normalize one Steam App ID before network access. |
| `lib/providers/steam/errors.ts` | Stable error codes and `SteamProviderError`. |
| `lib/providers/steam/client.ts` | HTTP request, timeout, HTTP status, and JSON parsing only. |
| `lib/providers/steam/schema.ts` | Raw Steam Zod schemas and inferred raw DTOs. |
| `lib/providers/steam/response.ts` | Convert unknown JSON into one semantic Steam game DTO. |
| `lib/providers/steam/normalize.ts` | Convert validated Steam DTO into candidate plus warnings. |
| `lib/importers/candidate.ts` | Provider-neutral candidate, plan, warning, skip, and result schemas/types. |
| `lib/importers/errors.ts` | Typed database-planning and write-conflict errors. |
| `lib/importers/slug.ts` | Canonical slug generation and deterministic company collision suffix. |
| `lib/importers/steam-plan.ts` | Perform indexed comparisons and produce create/existing/update plans. |
| `lib/importers/steam.ts` | Orchestrate fetch, parse, normalize, dry-run, write, and conflict recovery. |
| `lib/db/repositories/steam-import.ts` | Indexed planning reads and one-batch create/update writes. |
| `scripts/import-steam-game.ts` | Parse local CLI arguments and inject local Wrangler D1. |
| `test/fixtures/steam/*.json` | Stable representative provider responses. |

---

### Task 1: Steam App ID Validation and Provider Error Contract

**Files:**
- Create: `lib/providers/steam/app-id.ts`
- Create: `lib/providers/steam/errors.ts`
- Create: `lib/providers/steam/app-id.test.ts`

**Interfaces:**
- Produces: `normalizeSteamAppId(input: string | number): string`
- Produces: `SteamClientErrorCode`, `SteamResponseErrorCode`, `SteamImportInputErrorCode`, `SteamProviderError`
- `SteamProviderError` fields: `code`, `retryable`, optional `status`, optional `retryAfter`, and optional `cause`

- [ ] **Step 1: Write failing App ID and error-contract tests**

```ts
import { describe, expect, it } from "vitest";
import { normalizeSteamAppId } from "./app-id";
import { SteamProviderError } from "./errors";

describe("Steam App ID", () => {
  it.each([[1245620, "1245620"], ["001245620", "1245620"]])(
    "normalizes %s",
    (input, expected) => expect(normalizeSteamAppId(input)).toBe(expected),
  );

  it.each(["", "abc", "1.5", "-1", "0", "4294967296", Number.NaN])(
    "rejects %s",
    (input) => expect(() => normalizeSteamAppId(input)).toThrowError(
      expect.objectContaining({ code: "invalid_app_id", retryable: false }),
    ),
  );

  it("preserves structured error metadata", () => {
    const error = new SteamProviderError("rate_limited", "Steam rate limited", {
      retryable: true,
      status: 429,
      retryAfter: "30",
    });
    expect(error).toMatchObject({ code: "rate_limited", retryable: true, status: 429, retryAfter: "30" });
  });
});
```

- [ ] **Step 2: Run the test and confirm red**

Run: `npm test -- lib/providers/steam/app-id.test.ts`

Expected: FAIL because `./app-id` and `./errors` do not exist.

- [ ] **Step 3: Implement the minimal contracts**

```ts
// errors.ts
export type SteamClientErrorCode =
  | "timeout" | "network_error" | "rate_limited"
  | "provider_unavailable" | "http_error" | "malformed_json";
export type SteamResponseErrorCode =
  | "schema_changed" | "app_not_found" | "app_id_mismatch" | "unsupported_app_type";
export type SteamImportInputErrorCode = "invalid_app_id";
export type SteamProviderErrorCode =
  | SteamClientErrorCode | SteamResponseErrorCode | SteamImportInputErrorCode;

export class SteamProviderError extends Error {
  constructor(
    public readonly code: SteamProviderErrorCode,
    message: string,
    public readonly details: {
      retryable: boolean;
      status?: number;
      retryAfter?: string;
      cause?: unknown;
    },
  ) { super(message); this.name = "SteamProviderError"; }
  get retryable() { return this.details.retryable; }
  get status() { return this.details.status; }
  get retryAfter() { return this.details.retryAfter; }
}
```

Use a Zod union of integer number and decimal string, enforce `1..4294967295`, and return `String(parsedNumber)`. Convert every failure into `new SteamProviderError("invalid_app_id", "Invalid Steam App ID", { retryable: false })`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- lib/providers/steam/app-id.test.ts && npm run typecheck`

Expected: PASS with all App ID cases green.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/steam/app-id.ts lib/providers/steam/errors.ts lib/providers/steam/app-id.test.ts
git commit -m "feat: validate Steam App IDs"
```

---

### Task 2: HTTP-Only Steam Client

**Files:**
- Create: `lib/providers/steam/client.ts`
- Create: `lib/providers/steam/client.test.ts`

**Interfaces:**
- Consumes: normalized App ID string from Task 1
- Produces: `SteamHttpResponse = { body: unknown; fetchedAt: Date; requestUrl: string }`
- Produces: `SteamClient = { fetchAppDetails(appId: string): Promise<SteamHttpResponse> }`
- Produces: `createSteamClient(options?: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number; now?: () => Date }): SteamClient`

- [ ] **Step 1: Write failing HTTP behavior tests**

Use injected fetch stubs and assert:

```ts
const client = createSteamClient({
  fetch: vi.fn().mockResolvedValue(new Response('{"1245620":{"success":false}}', { status: 200 })),
  now: () => new Date("2026-09-02T00:00:00Z"),
});
const result = await client.fetchAppDetails("1245620");
expect(result.body).toEqual({ "1245620": { success: false } });
```

Add cases for URL query parameters `appids`, `cc=us`, `l=english`; timeout via an abort-aware fetch stub; rejected fetch; 429 with `Retry-After`; 503; 404; and invalid JSON. Assert exact codes and retryability. Assert the `success:false` body is returned without semantic interpretation.

- [ ] **Step 2: Run the client test and confirm red**

Run: `npm test -- lib/providers/steam/client.test.ts`

Expected: FAIL because `createSteamClient` does not exist.

- [ ] **Step 3: Implement the minimal HTTP client**

Construct the URL with `URL`/`searchParams`, create an `AbortController`, clear the timeout in `finally`, classify status before JSON parsing, and wrap only fetch/JSON failures. Never import Steam raw schemas or candidate types in this file.

```ts
export type SteamHttpResponse = { body: unknown; fetchedAt: Date; requestUrl: string };

export function createSteamClient(options: SteamClientOptions = {}): SteamClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://store.steampowered.com/api/appdetails";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());
  return {
    async fetchAppDetails(appId) {
      const url = new URL(baseUrl);
      url.searchParams.set("appids", appId);
      url.searchParams.set("cc", "us");
      url.searchParams.set("l", "english");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, { signal: controller.signal });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new SteamProviderError("timeout", "Steam request timed out", { retryable: true, cause });
        }
        throw new SteamProviderError("network_error", "Steam request failed", { retryable: true, cause });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        const code = response.status === 429
          ? "rate_limited"
          : response.status >= 500
            ? "provider_unavailable"
            : "http_error";
        throw new SteamProviderError(code, `Steam returned HTTP ${response.status}`, {
          retryable: response.status === 429 || response.status >= 500,
          status: response.status,
          retryAfter: response.headers.get("Retry-After") ?? undefined,
        });
      }
      try {
        return { body: await response.json(), fetchedAt: now(), requestUrl: url.toString() };
      } catch (cause) {
        throw new SteamProviderError("malformed_json", "Steam returned invalid JSON", { retryable: false, cause });
      }
    },
  };
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- lib/providers/steam/client.test.ts && npm run typecheck`

Expected: PASS; the semantic `success:false` case remains a successful client response.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/steam/client.ts lib/providers/steam/client.test.ts
git commit -m "feat: add Steam HTTP client"
```

---

### Task 3: Raw Zod Schema and Steam Response Adapter

**Files:**
- Create: `lib/providers/steam/schema.ts`
- Create: `lib/providers/steam/response.ts`
- Create: `lib/providers/steam/schema.test.ts`
- Create: `lib/providers/steam/response.test.ts`
- Create: `test/fixtures/steam/appdetails-valid.json`
- Create: `test/fixtures/steam/appdetails-success-false.json`
- Create: `test/fixtures/steam/appdetails-malformed.json`

**Interfaces:**
- Consumes: `unknown` HTTP body and normalized requested App ID
- Produces: `SteamAppDetails` inferred from `steamAppDetailsSchema`
- Produces: `parseSteamAppDetails(body: unknown, requestedAppId: string): SteamAppDetails`

- [ ] **Step 1: Add representative fixtures and failing schema tests**

The valid fixture must contain one game with App ID `1245620`, name, short/detailed descriptions, website, developers, publishers, all three platform booleans, two genres, release date, capsule/header URLs, two screenshots, and one movie. The success-false fixture is `{ "999999999": { "success": false } }`. The malformed fixture changes `platforms.windows` to a string.

Test that extra unconsumed fields are accepted, while a changed consumed field fails.

- [ ] **Step 2: Run raw-schema tests and confirm red**

Run: `npm test -- lib/providers/steam/schema.test.ts`

Expected: FAIL because the schemas do not exist.

- [ ] **Step 3: Implement raw schemas**

Use `z.looseObject` for provider objects, `z.discriminatedUnion("success", ...)` for the envelope, and `z.record(z.string(), steamEnvelopeSchema)` for the top-level body. Required identity fields are `type`, positive integer `steam_appid`, and non-empty `name`; optional consumed arrays and objects retain their raw optionality.

- [ ] **Step 4: Run schema tests and confirm green**

Run: `npm test -- lib/providers/steam/schema.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing response-adapter tests**

```ts
expect(parseSteamAppDetails(validFixture, "1245620")).toMatchObject({
  type: "game", steam_appid: 1245620,
});
expect(() => parseSteamAppDetails(successFalse, "999999999")).toThrowError(
  expect.objectContaining({ code: "app_not_found" }),
);
```

Add exact cases for `schema_changed`, `app_id_mismatch`, and `unsupported_app_type`. Assert `response.ts` imports only the raw schemas/types and shared error class; it must not import the HTTP client module.

- [ ] **Step 6: Run adapter tests and confirm red**

Run: `npm test -- lib/providers/steam/response.test.ts`

Expected: FAIL because `parseSteamAppDetails` does not exist.

- [ ] **Step 7: Implement the response adapter**

Parse the record, select exactly `body[requestedAppId]`, map missing/malformed data to `schema_changed`, map `success:false` to `app_not_found`, compare `steam_appid`, and require `type === "game"`. Emit only Task 1 response-error codes.

- [ ] **Step 8: Run focused tests and typecheck**

Run: `npm test -- lib/providers/steam/schema.test.ts lib/providers/steam/response.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/providers/steam/schema.ts lib/providers/steam/response.ts lib/providers/steam/schema.test.ts lib/providers/steam/response.test.ts test/fixtures/steam
git commit -m "feat: validate Steam provider responses"
```

---

### Task 4: Canonical Candidate, Plan Types, and Stable Slugs

**Files:**
- Create: `lib/importers/candidate.ts`
- Create: `lib/importers/errors.ts`
- Create: `lib/importers/slug.ts`
- Create: `lib/importers/candidate.test.ts`
- Create: `lib/importers/slug.test.ts`

**Interfaces:**
- Produces: `ImportWarning`, `PlannedSkip`, `PlannedUpdate`, `CanonicalGameCandidate`, `NormalizationResult`, `SteamImportPlan`, `SteamImportResult`
- Produces: `SteamImportErrorCode = "taxonomy_conflict" | "company_conflict" | "write_conflict" | "write_incomplete"` and `SteamImportError`
- Produces: `canonicalCandidateSchema`, `normalizationResultSchema`
- Produces: `toCanonicalSlug(value: string, fallback: string): string`
- Produces: `companyCollisionSlug(baseSlug: string, normalizedName: string, hashLength?: number): Promise<string>`

- [ ] **Step 1: Write failing candidate-validation tests**

Test a complete candidate and reject: non-Steam source, Store link with non-null platform, invalid canonical date, unsafe URL, duplicate candidate external IDs, more than 50 screenshots, and more than 20 videos. Test `NormalizationResult` warning preservation.

Use these stable plan/result shapes:

```ts
type ImportWarning = { code: string; message: string; path?: string };
type PlannedSkip = { field: string; reason: string; incoming: unknown; stored: unknown };
type PlannedUpdate = { entity: "external_id" | "official_link" | "video"; key: string; changes: Record<string, unknown> };
type SteamImportPlan = {
  action: "create" | "existing" | "update";
  selectedSlug: string;
  existingGameId: number | null;
  candidate: CanonicalGameCandidate;
  resolvedCompanies: Array<{ slug: string; name: string; role: "developer" | "publisher" }>;
  creates: Array<{ entity: string; key: string }>;
  updates: PlannedUpdate[];
  skips: PlannedSkip[];
  warnings: ImportWarning[];
};
type SteamImportResult = {
  status: "created" | "existing" | "updated";
  gameId: number | null;
  appId: string;
  dryRun: boolean;
  plan: SteamImportPlan;
};
```

- [ ] **Step 2: Run candidate tests and confirm red**

Run: `npm test -- lib/importers/candidate.test.ts`

Expected: FAIL because candidate types/schemas do not exist.

- [ ] **Step 3: Implement candidate schemas and inferred types**

Compose existing enums and limits without importing Steam raw schemas. Add a schema refinement requiring exactly one canonical Steam Store URL and requiring that link's `platform` be null.

Implement `SteamImportError` as a separate class from HTTP/provider response errors:

```ts
export type SteamImportErrorCode =
  | "taxonomy_conflict" | "company_conflict" | "write_conflict" | "write_incomplete";
export class SteamImportError extends Error {
  constructor(public readonly code: SteamImportErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SteamImportError";
  }
}
```

- [ ] **Step 4: Write failing slug tests**

Cover `Élden Ring™ -> elden-ring`, repeated punctuation, boundary hyphens, 160-character limit, and a non-Latin title falling back to `steam-1245620`. Assert the same normalized company name always produces the same hash suffix.

- [ ] **Step 5: Implement slug helpers**

Use Unicode NFKD, remove combining marks, lowercase, collapse non-ASCII alphanumeric runs, and trim hyphens. Use `crypto.subtle.digest("SHA-256", TextEncoder.encode(normalizedName))` and the first requested hex characters for company collision slugs.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test -- lib/importers/candidate.test.ts lib/importers/slug.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/importers/candidate.ts lib/importers/candidate.test.ts lib/importers/errors.ts lib/importers/slug.ts lib/importers/slug.test.ts
git commit -m "feat: define Steam import candidate contracts"
```

---

### Task 5: Steam Normalizer and Warning Propagation

**Files:**
- Create: `lib/providers/steam/normalize.ts`
- Create: `lib/providers/steam/normalize.test.ts`

**Interfaces:**
- Consumes: `SteamAppDetails`, normalized App ID, and fetched time
- Produces: `normalizeSteamGame(details: SteamAppDetails, appId: string, fetchedAt: Date): NormalizationResult`

- [ ] **Step 1: Write failing core-mapping tests**

Assert the valid fixture maps title/summary, leaves description null, emits one Steam external ID, maps Steam developers/publishers to roles, converts `windows/mac/linux` to `windows/macos/linux`, normalizes genre slugs, and maps exact `Aug 20, 2024` to `2024-08-20`.

Use table tests proving `2025`, `Q4 2025`, `Coming Soon`, `TBA`, `March 2025`, empty text, and invalid calendar dates all map to null.

- [ ] **Step 2: Run normalizer tests and confirm red**

Run: `npm test -- lib/providers/steam/normalize.test.ts`

Expected: FAIL because `normalizeSteamGame` does not exist.

- [ ] **Step 3: Implement core normalization**

Create the canonical Store URL from the App ID, set Store link `platform: null`, map `coming_soon` only to `upcoming`, and pass the result through `normalizationResultSchema.parse` before returning.

- [ ] **Step 4: Add failing link/media/warning tests**

Assert capsule/header become cover/hero records, full screenshot URLs are ordered after cover/hero, movie IDs are strings with Steam provider metadata, and a valid website is official but unverified with null verification method. Add invalid optional website/image/movie URLs and arrays above the caps; assert omissions produce warning codes and warning paths.

- [ ] **Step 5: Implement media selection and warnings**

Validate optional HTTP(S) URLs individually, deduplicate by URL or `(provider, externalId)`, cap screenshots/movies, and append warnings rather than silently dropping invalid, duplicate, capped, or unused optional values. Do not store raw detailed-description HTML.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test -- lib/providers/steam/normalize.test.ts && npm run typecheck`

Expected: PASS for mappings, exact dates, media, and warnings.

- [ ] **Step 7: Commit**

```bash
git add lib/providers/steam/normalize.ts lib/providers/steam/normalize.test.ts
git commit -m "feat: normalize Steam games"
```

---

### Task 6: Indexed Import Planning, Slug Collision, and Dry Run

**Files:**
- Create: `lib/db/repositories/steam-import.ts`
- Create: `lib/importers/steam-plan.ts`
- Create: `lib/importers/steam-plan.test.ts`
- Create: `lib/importers/steam.ts`
- Create: `lib/importers/steam.test.ts`

**Interfaces:**
- Produces store reads: `findSnapshotByExternalId`, `findGameBySlug`, `findGenresBySlugs`, `findPlatformsBySlugs`, `findCompaniesBySlugs`
- Produces: `SteamImportStore` with `applyPlan(plan): Promise<void>`; write implementation initially throws until Task 7
- Produces: `planSteamImport(store: SteamImportStore, normalized: NormalizationResult): Promise<SteamImportPlan>`
- Produces: `createSteamImporter({ client, store })`
- Produces: `importGame(input: string | number, options?: { dryRun?: boolean }): Promise<SteamImportResult>`

- [ ] **Step 1: Write failing planner tests with a fake store**

In `steam-plan.test.ts`, build a fake store that records reads/writes. Test a missing external ID produces a `create` plan and carries every normalization warning.

Add a preferred-slug occupant returned by `findGameBySlug`; expect fallback `elden-ring-steam-1245620` and one `possible_duplicate` warning containing the occupant ID/slug. Return an occupant for the first fallback too and expect `-2`.

In `steam.test.ts`, inject the fake client/store into `createSteamImporter`, request dry-run, and assert a null `gameId` and zero `applyPlan` calls.

- [ ] **Step 2: Run planner tests and confirm red**

Run: `npm test -- lib/importers/steam-plan.test.ts lib/importers/steam.test.ts`

Expected: FAIL because the importer/store interfaces do not exist.

- [ ] **Step 3: Implement indexed read methods and planner orchestration**

Use equality/in-list queries only. `findGameBySlug` must use `games.slug`; do not add a title query or list all games. Resolve taxonomy by slug and reject genre/platform contradictions. Resolve company base-slug agreement or call `companyCollisionSlug` for different-name occupants.

The import sequence is exactly:

```ts
const appId = normalizeSteamAppId(input);
const http = await client.fetchAppDetails(appId);
const raw = parseSteamAppDetails(http.body, appId);
const normalized = normalizeSteamGame(raw, appId, http.fetchedAt);
const plan = await planSteamImport(store, normalized);
if (options.dryRun ?? true) return { status: plan.action === "create" ? "created" : plan.action, gameId: plan.existingGameId, appId, dryRun: true, plan };
await store.applyPlan(plan);
```

For dry-run create, use `status: "created"` as the predicted outcome while keeping `gameId: null` and `dryRun: true`.

- [ ] **Step 4: Add a no-full-scan assertion**

The fake store exposes no title/list method. In `steam-plan.test.ts`, assert planning calls only external-ID, slug, genre, platform, and company lookups. This makes an unindexed title scan impossible through the interface.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `npm test -- lib/importers/steam-plan.test.ts lib/importers/steam.test.ts && npm run typecheck`

Expected: PASS for dry-run, warning propagation, slug collision, and indexed-read boundaries.

- [ ] **Step 6: Commit**

```bash
git add lib/db/repositories/steam-import.ts lib/importers/steam-plan.ts lib/importers/steam-plan.test.ts lib/importers/steam.ts lib/importers/steam.test.ts
git commit -m "feat: plan dry-run Steam imports"
```

---

### Task 7: Atomic D1 Batch for New Canonical Games

**Files:**
- Modify: `lib/db/repositories/steam-import.ts`
- Modify: `lib/importers/steam.test.ts`

**Interfaces:**
- Consumes: create `SteamImportPlan`
- Implements: `applyPlan(plan): Promise<void>` with one `db.batch(nonEmptyQueries)` call
- Produces: full new-game write across existing V2.1 tables

- [ ] **Step 1: Write a failing real-D1 creation test**

Use `createD1TestBinding()` and the valid fixture. Import with `dryRun: false`, then query through the import store and existing Drizzle schema. Assert:

- one `games` row with integer canonical ID, selected slug, canonical fields, cover, and hero;
- one `(steam, appId)` mapping;
- exactly one Steam Store link with `platform === null`, official/verified/provider-api metadata;
- developer website unverified;
- expected genre/platform/company junctions and roles;
- source-only cover/hero/screenshots;
- Steam movie metadata and no downloaded binary/storage URL.

- [ ] **Step 2: Write the failing mid-batch fault-injection test**

Before import, create a test-only trigger on `game_images`:

```sql
CREATE TRIGGER fail_steam_image_insert
BEFORE INSERT ON game_images
BEGIN
  SELECT RAISE(ABORT, 'injected steam image failure');
END;
```

Run a valid write import and expect rejection. Query all affected tables and assert zero game, external ID, official link, genre/platform/company lookup created by this candidate, junction, image, and video residue. Drop the trigger in `finally`.

- [ ] **Step 3: Run both atomic-write tests and confirm red**

Run: `npm test -- lib/importers/steam.test.ts -t "creates a new canonical game atomically|rolls back the entire D1 batch"`

Expected: FAIL because `applyPlan` is not implemented; neither successful creation nor rollback behavior exists yet.

- [ ] **Step 4: Implement one ordered Drizzle D1 batch**

Build a non-empty array of Drizzle insert statements in this order:

1. `games`
2. `game_external_ids` using `SELECT games.id WHERE games.slug = selectedSlug`
3. genres, platforms, companies with conflict-safe inserts after planner agreement
4. `game_genres`, `game_platforms`, `game_companies` using scalar subqueries
5. `game_official_links`
6. `game_images`
7. `game_videos`

Execute exactly once:

```ts
if (queries.length === 0) return;
await db.batch(queries as [typeof queries[number], ...typeof queries[number][]]);
```

Every game-child insert resolves `game_id` via the unique Steam external mapping or selected game slug inside the same ordered batch. Do not preallocate `games.id`, call `db.transaction`, or issue per-row awaits.

- [ ] **Step 5: Return the persisted canonical game**

After `applyPlan`, re-read `(steam, appId)`. If absent, throw a typed `write_incomplete` import error. Return `status: "created"`, the canonical numeric ID, and the executed plan.

- [ ] **Step 6: Run focused and repository tests**

Run: `npm test -- lib/importers/steam.test.ts lib/db/repositories/games.test.ts && npm run typecheck`

Expected: PASS with all mapped tables populated, the injected failure leaving no residue, and existing repository tests green.

- [ ] **Step 7: Commit**

```bash
git add lib/db/repositories/steam-import.ts lib/importers/steam.ts lib/importers/steam.test.ts
git commit -m "feat: atomically create Steam games"
```

---

### Task 8: Strict Existing and Updated Semantics

**Files:**
- Modify: `lib/db/repositories/steam-import.ts`
- Modify: `lib/importers/steam-plan.ts`
- Modify: `lib/importers/steam-plan.test.ts`
- Modify: `lib/importers/steam.ts`
- Modify: `lib/importers/steam.test.ts`

**Interfaces:**
- Extends the existing snapshot with the canonical game, Steam external row, official links, Steam videos, images, genre/platform junctions, and company-role junctions required for exact update/skip comparisons
- `applyPlan` executes only non-empty permitted changes in one batch

- [ ] **Step 1: Write failing idempotency and no-op tests**

Import the same fixture twice. Assert the first result is `created`, the second is `existing`, the same `gameId` is returned, `updates` is empty, and counts for games/external IDs/links/media/junctions do not increase.

- [ ] **Step 2: Write failing permitted-update tests**

Seed/import a game, change only the Steam external URL, Store verification metadata, and an existing Steam video's title/thumbnail. Expect `updated`, exact `PlannedUpdate` entries, and persisted changed values.

- [ ] **Step 3: Write failing conservative-skip tests**

Change incoming title, summary, release date, cover/hero, genres, companies, platforms, images, and website. Expect `existing`, zero updates, unchanged rows, and explicit skips/warnings for every disallowed difference.

- [ ] **Step 4: Run focused tests and confirm red**

Run: `npm test -- lib/importers/steam-plan.test.ts lib/importers/steam.test.ts -t "existing|updated|conservative"`

Expected: FAIL because existing snapshots and update comparison are incomplete.

- [ ] **Step 5: Implement exact comparison and update batching**

Compare normalized stored/incoming values before adding an update. Never update `updated_at` alone. Build `plan.action` as:

```ts
const action = updates.length > 0 ? "update" : "existing";
```

Convert disallowed differences into `PlannedSkip`; identical disallowed values need no skip. Apply only permitted update statements in one `db.batch()`. If there are no updates, do not call batch.

- [ ] **Step 6: Run focused tests and typecheck**

Run: `npm test -- lib/importers/steam-plan.test.ts lib/importers/steam.test.ts && npm run typecheck`

Expected: PASS; only actual writes produce `updated`.

- [ ] **Step 7: Commit**

```bash
git add lib/db/repositories/steam-import.ts lib/importers/steam-plan.ts lib/importers/steam-plan.test.ts lib/importers/steam.ts lib/importers/steam.test.ts
git commit -m "feat: refresh Steam-owned metadata conservatively"
```

---

### Task 9: External-ID Race Recovery and Concurrent Idempotency

**Files:**
- Modify: `lib/importers/steam.ts`
- Modify: `lib/importers/steam.test.ts`

**Interfaces:**
- Adds bounded conflict recovery around create-plan application
- Produces one canonical game and mapping under concurrent same-App-ID imports

- [ ] **Step 1: Write a failing deterministic conflict-recovery test**

Use a store wrapper whose first `applyPlan(create)` throws a D1 unique-constraint-shaped error after another store instance has inserted the same App ID. Assert the importer re-queries the external ID, replans, and returns the winning game as `existing` or `updated` based on actual permitted changes.

- [ ] **Step 2: Write a failing concurrent real-D1 test**

Run two `importGame("1245620", { dryRun: false })` promises against the same test binding. Assert both fulfill, result IDs match, `games` count is one, and `(steam, 1245620)` count is one.

- [ ] **Step 3: Write a failing slug-race retry test**

Simulate a slug unique conflict with no external mapping appearing. On replan, occupy the previous slug and assert the next deterministic fallback is selected. Assert retry count is capped at three and a fourth unresolved conflict returns a typed `write_conflict` error.

- [ ] **Step 4: Run tests and confirm red**

Run: `npm test -- lib/importers/steam.test.ts -t "conflict|concurrent|race"`

Expected: FAIL because create conflicts are not recovered.

- [ ] **Step 5: Implement bounded recovery**

Catch only recognized SQLite/D1 unique-constraint failures. Re-query external ID first; if found, replan existing. Otherwise re-run indexed slug planning and retry a maximum of three create batches. Re-throw non-unique errors unchanged.

- [ ] **Step 6: Run focused tests and full test suite**

Run: `npm test -- lib/importers/steam.test.ts && npm test`

Expected: PASS with one canonical record after concurrency.

- [ ] **Step 7: Commit**

```bash
git add lib/importers/steam.ts lib/importers/steam.test.ts
git commit -m "feat: recover concurrent Steam imports"
```

---

### Task 10: Local-Only Dry-Run-First CLI

**Files:**
- Create: `scripts/import-steam-game.ts`
- Create: `scripts/import-steam-game.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseSteamImportArgs(argv: string[]): { appId: string; write: boolean }`
- Produces: `runSteamImportCli(args, dependencies?): Promise<number>` for test injection
- Adds: `npm run steam:import -- <appId> [--write]`

- [ ] **Step 1: Write failing CLI parser tests**

```ts
expect(parseSteamImportArgs(["1245620"])).toEqual({ appId: "1245620", write: false });
expect(parseSteamImportArgs(["1245620", "--write"])).toEqual({ appId: "1245620", write: true });
expect(() => parseSteamImportArgs(["1245620", "--remote"])).toThrow(/--remote/);
expect(() => parseSteamImportArgs(["1245620", "--unknown"])).toThrow(/unknown/i);
```

Also reject zero/multiple App IDs, duplicate `--write`, and option-only invocation.

- [ ] **Step 2: Run CLI tests and confirm red**

Run: `npm test -- scripts/import-steam-game.test.ts`

Expected: FAIL because the CLI module does not exist.

- [ ] **Step 3: Implement argument parsing and injectable runner**

Keep parsing side-effect free. Print the serialized `SteamImportResult`; return exit code 0 on success and 1 on typed/import errors. Default `dryRun` to `!write`.

- [ ] **Step 4: Enforce local D1 construction**

In the executable-only `main`, call Wrangler `getPlatformProxy` with the repository's `wrangler.jsonc`, `persist: true`, and `remoteBindings: false`. Construct `createDatabase(platform.env.DB)`, the import store, client, and importer. Dispose in `finally`. Do not accept a config path, remote binding, database ID, URL, or environment selector from CLI arguments.

- [ ] **Step 5: Add the package script and run CLI tests**

```json
"steam:import": "tsx scripts/import-steam-game.ts"
```

Run: `npm test -- scripts/import-steam-game.test.ts && npm run typecheck`

Expected: PASS, including explicit `--remote` rejection.

- [ ] **Step 6: Run a mocked/manual dry-run path without writing**

Use the injectable runner in a test with a fake client/store, call dry-run, and assert the store write spy has zero calls. Do not require live Steam access in automated verification.

- [ ] **Step 7: Commit**

```bash
git add scripts/import-steam-game.ts scripts/import-steam-game.test.ts package.json
git commit -m "feat: add local Steam import CLI"
```

---

### Task 11: Documentation, Regression, and Immutable Schema Verification

**Files:**
- Modify: `README.md`
- Verify unchanged: `lib/db/schema.ts`
- Verify unchanged: `drizzle/0000_nervous_gunslinger.sql`
- Verify unchanged: `drizzle/0001_cold_mysterio.sql`
- Verify unchanged: `lib/mock-data.ts`

**Interfaces:**
- Documents local dry-run/write commands, error behavior, local-only restriction, and V2.2 scope
- Produces final evidence for tests, build, D1, audit, and immutable database/UI files

- [ ] **Step 1: Add failing documentation assertions**

Create a small test in `scripts/import-steam-game.test.ts` that reads `README.md` and expects all four strings: `steam:import`, `--write`, `dry-run`, and `local D1`. Run it before editing README.

Run: `npm test -- scripts/import-steam-game.test.ts -t "documents the local Steam import command"`

Expected: FAIL because the usage section is absent.

- [ ] **Step 2: Document operator usage and boundaries**

Add a V2.2 section containing:

```bash
npm run steam:import -- 1245620
npm run steam:import -- 1245620 --write
```

State that the first command is dry-run, the second writes only local D1, `--remote` is rejected, Steam availability is external, no media is downloaded, and production import is unavailable.

- [ ] **Step 3: Run documentation and complete tests**

Run: `npm test`

Expected: all existing and new tests PASS.

- [ ] **Step 4: Run static and production checks**

Run the validation commands separately:

```bash
npm run typecheck
npm run lint
npm run build -- --webpack
npm run db:check:local
npm run db:verify:local
npm audit
npm audit --omit=dev
```

Expected: tests, typecheck, lint, webpack production build, D1 checks, and `npm audit --omit=dev` exit 0. The full `npm audit` may exit 1 only for the already documented four moderate development-only findings in the Drizzle Kit/esbuild chain; it must contain no high or production vulnerability. Any different audit result requires investigation before completion.

If default `npm run build` is available without the known Codex Turbopack port restriction, run it too. Do not modify the build script to work around the execution sandbox.

- [ ] **Step 5: Prove schema, migration, and V1 data immutability**

Run:

```bash
test "$(find drizzle -type f -name '*.sql' | wc -l | tr -d ' ')" = "2"
test "$(shasum lib/db/schema.ts | cut -d ' ' -f 1)" = "52e84d7c2b52b73b95bdfb3934dabbde0e65e3d5"
git diff 489c0aa -- lib/db/schema.ts 'drizzle/*.sql' lib/mock-data.ts app
git diff --check
```

Expected: count/hash checks succeed and the protected-file diff is empty. Inspect `git diff --name-only 489c0aa` and confirm only the approved provider/importer/store/test/CLI/package/README/spec/plan files changed.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md scripts/import-steam-game.test.ts
git commit -m "docs: explain local Steam game imports"
```

- [ ] **Step 7: Record final branch evidence without creating another commit**

Run:

```bash
git status --short --branch
git log --oneline 489c0aa..HEAD
```

Expected: clean worktree and one focused implementation commit per completed task after the spec/plan commits.

## Spec Coverage Matrix

| Spec area | Plan task(s) |
|---|---|
| App ID validation and provider/import errors | 1 |
| HTTP-only client, timeout, network/HTTP/JSON classification | 2 |
| Raw Zod schema and semantic response adapter | 3 |
| Candidate Zod schema, result/plan interfaces, slug utilities | 4 |
| `NormalizationResult`, warnings, release/platform/genre/company/link/media mapping | 5 |
| Indexed planner, slug collision, `possible_duplicate`, dry-run | 6 |
| New-game canonical relations and one D1 atomic batch | 7 |
| Strict existing/updated semantics and conservative ownership | 8 |
| External-ID idempotency and concurrent race recovery | 9 |
| Mid-batch failure rollback proof | 7 |
| Local-only CLI, default dry-run, `--write`, forbidden `--remote` | 10 |
| README, full regression, audit, Schema/migration/V1 immutability | 11 |

## Execution Order and Review Gates

Execute Tasks 1 through 11 in order. After each task's green test and commit, review that task only against its Interfaces and the Global Constraints before beginning the next task. If any task requires a new table, column, index, check constraint, or migration to pass, stop immediately and report the exact invariant that cannot be met with the V2.1 schema.
