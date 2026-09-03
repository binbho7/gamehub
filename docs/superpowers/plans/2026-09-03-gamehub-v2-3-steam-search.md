# GameHub V2.3 Steam Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only Steam Store keyword search command that returns ordered, deduplicated Steam App ID candidates and normalization warnings without accessing D1 or invoking the V2.2 importer.

**Architecture:** A query validator feeds an HTTP-only Steam Search Client. Unknown JSON crosses a permissive raw Zod boundary, a Response Adapter maps structural failure to `schema_changed`, and a pure normalizer filters Store identities, deduplicates App IDs, applies the local limit, and returns results plus warnings. A thin Search Service exposes the single API consumed by a standalone CLI.

**Tech Stack:** TypeScript, Zod 4, native Fetch/AbortController, Vitest, tsx, Next.js 16 regression build.

**Spec:** `docs/superpowers/specs/2026-09-03-gamehub-v2-3-steam-search-design.md`

## Global Constraints

- Use only `https://store.steampowered.com/api/storesearch/`; do not add HTML scraping, a fallback endpoint, SteamSpy, or another data provider.
- Send only `term`, `l=english`, and `cc=US`; do not depend on endpoint `count` or `limit` parameters.
- Search and V2.2 detail/import remain separate flows. Search code must not import `lib/importers/*`, `lib/db/*`, the V2.2 canonical candidate, or the V2.2 Steam detail client/adapter/normalizer.
- Expose an App ID only when the raw Store item type is exactly, case-sensitively `app`; filter every other Store item type with a warning.
- Never infer that a Store `app` is a canonical game. Every V2.3 result has `type: "unknown"`.
- Do not declare or consume `total` in the raw schema. `z.looseObject` must tolerate absent, numeric, string, null, object, or other future `total` values without producing `schema_changed`.
- Accept raw Store item IDs only in the inclusive Steam App ID range `1..4294967295`, matching the V2.2 identity contract.
- Optional invalid `tiny_image` URLs produce warnings, not search failure.
- Preserve provider order, deduplicate retained App IDs first-wins, and apply the validated local limit after filtering and deduplication.
- Trim query boundaries, preserve internal Unicode text, count at most 100 Unicode code points, default limit to 10, and enforce hard maximum 10.
- The CLI accepts one query plus `--limit` and `--json`; it rejects `--write`, `--remote`, environment selectors, remote database identifiers/configuration, extra positional arguments, and unknown flags.
- The CLI must not initialize Wrangler, D1, or the V2.2 importer and must not write any persistent state.
- Do not modify `lib/db/schema.ts`, `drizzle/*.sql`, `lib/mock-data.ts`, `app/**`, `components/**`, or any existing V2.2 provider/importer/planner/repository implementation file.
- Do not add a migration, database cache, search history, public API route, UI, batch import, IGDB, Epic, GOG, R2, or Cron.
- Default tests use injected fetch and local fixtures; no live Steam call belongs in `npm test` or CI.
- Every implementation task follows RED -> GREEN, runs focused tests plus typecheck, checks the Global Constraints, and ends with an independent commit.

## File Responsibility Map

| File | Responsibility |
|---|---|
| `lib/providers/steam/search/query.ts` | Validate and normalize query text and the local result limit before HTTP. |
| `lib/providers/steam/search/errors.ts` | Search-only error codes, details, and `SteamSearchError`. |
| `lib/providers/steam/search/client.ts` | Build the Store search request, enforce deadline, classify HTTP, and decode JSON only. |
| `lib/providers/steam/search/schema.ts` | Permissive raw Zod schema for only the consumed response fields. |
| `lib/providers/steam/search/response.ts` | Parse unknown JSON into the validated raw DTO and emit only `schema_changed`. |
| `lib/providers/steam/search/contracts.ts` | Provider-neutral result, warning, and normalization-result contracts. |
| `lib/providers/steam/search/normalize.ts` | Filter Store types, validate optional image URLs, deduplicate, preserve order, limit, and warn. |
| `lib/providers/steam/search/service.ts` | Compose query validation, client, adapter, and normalizer into one search API. |
| `scripts/search-steam-games.ts` | Parse CLI arguments, create only the Search Service, and format human/JSON output. |
| `test/fixtures/steam/search-*.json` | Stable Store search contract examples; never fetched from the network during tests. |
| `README.md` | Document the search/select/import operator workflow and endpoint risk. |

---

### Task 1: Search Query Validation

**Files:**
- Create: `lib/providers/steam/search/query.ts`
- Create: `lib/providers/steam/search/query.test.ts`

**Interfaces:**
- Produces: `SteamSearchInput = { query: string; limit: number }`
- Produces: `validateSteamSearchInput(query: string, limit?: number): SteamSearchInput`
- Temporarily throws a local test-visible error until Task 2 supplies `SteamSearchError`; Task 2 replaces it without changing the public function signature.

- [ ] **Step 1: Write failing query-normalization tests**

```ts
import { describe, expect, it } from "vitest";
import { validateSteamSearchInput } from "./query";

describe("validateSteamSearchInput", () => {
  it("trims query boundaries and defaults limit to ten", () => {
    expect(validateSteamSearchInput("  elden  ring  ")).toEqual({
      query: "elden  ring",
      limit: 10,
    });
  });

  it("preserves Unicode query text", () => {
    expect(validateSteamSearchInput("  黑神话：悟空  ", 5)).toEqual({
      query: "黑神话：悟空",
      limit: 5,
    });
  });

  it("counts Unicode code points rather than UTF-16 code units", () => {
    expect(validateSteamSearchInput("🎮".repeat(100))).toMatchObject({ limit: 10 });
    expect(() => validateSteamSearchInput("🎮".repeat(101))).toThrow();
  });
});
```

- [ ] **Step 2: Add failing invalid-query and limit tables**

```ts
it.each(["", "   ", "\n\t"])("rejects empty query %j", (query) => {
  expect(() => validateSteamSearchInput(query)).toThrow();
});

it.each([0, -1, 1.5, 11, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid limit %s",
  (limit) => expect(() => validateSteamSearchInput("elden ring", limit)).toThrow(),
);

it.each([1, 10])("accepts boundary limit %s", (limit) => {
  expect(validateSteamSearchInput("elden ring", limit).limit).toBe(limit);
});
```

- [ ] **Step 3: Run the focused test and confirm RED**

Run: `npm test -- lib/providers/steam/search/query.test.ts`

Expected: FAIL because `./query` does not exist.

- [ ] **Step 4: Implement the minimal validator**

```ts
export const STEAM_SEARCH_DEFAULT_LIMIT = 10;
export const STEAM_SEARCH_MAX_LIMIT = 10;
export const STEAM_SEARCH_MAX_QUERY_CODE_POINTS = 100;

export type SteamSearchInput = { query: string; limit: number };

export function validateSteamSearchInput(
  query: string,
  limit = STEAM_SEARCH_DEFAULT_LIMIT,
): SteamSearchInput {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) throw new Error("empty_query");
  if (Array.from(normalizedQuery).length > STEAM_SEARCH_MAX_QUERY_CODE_POINTS) {
    throw new Error("query_too_long");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > STEAM_SEARCH_MAX_LIMIT) {
    throw new Error("invalid_limit");
  }
  return { query: normalizedQuery, limit };
}
```

- [ ] **Step 5: Run focused tests and typecheck, then inspect boundaries**

Run: `npm test -- lib/providers/steam/search/query.test.ts && npm run typecheck`

Expected: PASS. Confirm the file imports no database, importer, detail-client, or canonical-candidate module.

- [ ] **Step 6: Commit Task 1**

```bash
git add lib/providers/steam/search/query.ts lib/providers/steam/search/query.test.ts
git commit -m "feat: validate Steam search queries"
```

---

### Task 2: Steam Search Error Contract

**Files:**
- Create: `lib/providers/steam/search/errors.ts`
- Create: `lib/providers/steam/search/errors.test.ts`
- Modify: `lib/providers/steam/search/query.ts`
- Modify: `lib/providers/steam/search/query.test.ts`

**Interfaces:**
- Produces: `SteamSearchClientErrorCode`
- Produces: `SteamSearchResponseErrorCode`
- Produces: `SteamSearchInputErrorCode`
- Produces: `SteamSearchErrorCode`
- Produces: `SteamSearchErrorDetails`
- Produces: `SteamSearchError`
- Query failures become `SteamSearchError` with `code: "invalid_search_query"` and `reason: "empty_query" | "query_too_long" | "invalid_limit"`.

- [ ] **Step 1: Write failing error-contract tests**

```ts
import { describe, expect, it } from "vitest";
import { SteamSearchError } from "./errors";

describe("SteamSearchError", () => {
  it("preserves search error metadata", () => {
    const error = new SteamSearchError("rate_limited", "Steam search rate limited", {
      retryable: true,
      status: 429,
      retryAfter: "30",
    });
    expect(error).toMatchObject({
      name: "SteamSearchError",
      code: "rate_limited",
      retryable: true,
      status: 429,
      retryAfter: "30",
    });
  });
});
```

Update query tests to assert exact structured failures:

```ts
expect(() => validateSteamSearchInput(" ")).toThrowError(
  expect.objectContaining({
    code: "invalid_search_query",
    retryable: false,
    reason: "empty_query",
  }),
);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- lib/providers/steam/search/errors.test.ts lib/providers/steam/search/query.test.ts`

Expected: FAIL because `./errors` does not exist and query validation still throws plain `Error`.

- [ ] **Step 3: Implement the search-only error contract**

```ts
export type SteamSearchClientErrorCode =
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "provider_unavailable"
  | "http_error"
  | "malformed_json";

export type SteamSearchResponseErrorCode = "schema_changed";
export type SteamSearchInputErrorCode = "invalid_search_query";
export type SteamSearchInputReason = "empty_query" | "query_too_long" | "invalid_limit";
export type SteamSearchErrorCode =
  | SteamSearchClientErrorCode
  | SteamSearchResponseErrorCode
  | SteamSearchInputErrorCode;

export type SteamSearchErrorDetails = {
  retryable: boolean;
  status?: number;
  retryAfter?: string;
  reason?: SteamSearchInputReason;
  cause?: unknown;
};

export class SteamSearchError extends Error {
  constructor(
    public readonly code: SteamSearchErrorCode,
    message: string,
    public readonly details: SteamSearchErrorDetails,
  ) {
    super(message);
    this.name = "SteamSearchError";
  }
  get retryable() { return this.details.retryable; }
  get status() { return this.details.status; }
  get retryAfter() { return this.details.retryAfter; }
  get reason() { return this.details.reason; }
  get cause() { return this.details.cause; }
}
```

Add a focused helper and replace each plain query error with it:

```ts
function invalidSearchQuery(reason: SteamSearchInputReason): SteamSearchError {
  const messages: Record<SteamSearchInputReason, string> = {
    empty_query: "Steam search query cannot be empty",
    query_too_long: "Steam search query cannot exceed 100 Unicode code points",
    invalid_limit: "Steam search limit must be an integer from 1 through 10",
  };
  return new SteamSearchError("invalid_search_query", messages[reason], {
    retryable: false,
    reason,
  });
}
```

- [ ] **Step 4: Run focused tests and typecheck, then inspect interfaces**

Run: `npm test -- lib/providers/steam/search/errors.test.ts lib/providers/steam/search/query.test.ts && npm run typecheck`

Expected: PASS. Confirm no changes to `lib/providers/steam/errors.ts`; the V2.2 error union stays unchanged.

- [ ] **Step 5: Commit Task 2**

```bash
git add lib/providers/steam/search/errors.ts lib/providers/steam/search/errors.test.ts lib/providers/steam/search/query.ts lib/providers/steam/search/query.test.ts
git commit -m "feat: define Steam search errors"
```

---

### Task 3: HTTP-Only Steam Search Client

**Files:**
- Create: `lib/providers/steam/search/client.ts`
- Create: `lib/providers/steam/search/client.test.ts`

**Interfaces:**
- Consumes: already validated query string.
- Produces: `SteamSearchHttpResponse = { body: unknown; requestUrl: string }`
- Produces: `SteamSearchClient = { search(query: string): Promise<SteamSearchHttpResponse> }`
- Produces: `SteamSearchClientOptions = { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }`
- Produces: `createSteamSearchClient(options?: SteamSearchClientOptions): SteamSearchClient`
- Emits only Task 2 client error codes.

- [ ] **Step 1: Write failing success/request tests**

```ts
const fetchMock = vi.fn().mockResolvedValue(
  new Response(JSON.stringify({ items: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }),
);
const client = createSteamSearchClient({ fetch: fetchMock });
const result = await client.search("elden ring");
const [request, init] = fetchMock.mock.calls[0];
const url = new URL(String(request));

expect(url.pathname).toBe("/api/storesearch/");
expect(url.searchParams.get("term")).toBe("elden ring");
expect(url.searchParams.get("l")).toBe("english");
expect(url.searchParams.get("cc")).toBe("US");
expect(url.searchParams.has("limit")).toBe(false);
expect(url.searchParams.has("count")).toBe(false);
expect(new Headers(init.headers).get("Accept")).toBe("application/json");
expect(result.body).toEqual({ items: [] });
```

Add a Unicode query assertion using `new URL(request).searchParams.get("term")` and assert `fetchMock` runs exactly once.

- [ ] **Step 2: Write failing HTTP/error table tests**

Cover:

```ts
it.each([
  [429, "rate_limited", true],
  [500, "provider_unavailable", true],
  [503, "provider_unavailable", true],
  [400, "http_error", false],
  [404, "http_error", false],
] as const)("maps HTTP %s to %s", async (status, code, retryable) => {
  const client = createSteamSearchClient({
    fetch: vi.fn().mockResolvedValue(new Response("", {
      status,
      headers: status === 429 ? { "Retry-After": "30" } : undefined,
    })),
  });
  await expect(client.search("elden ring")).rejects.toMatchObject({
    code,
    retryable,
    status,
    ...(status === 429 ? { retryAfter: "30" } : {}),
  });
});
```

Also test rejected fetch as `network_error`, invalid JSON as `malformed_json`, a fetch blocked until `AbortSignal` as `timeout`, and body consumption blocked until abort as `timeout`. Assert 429 preserves `Retry-After`.

- [ ] **Step 3: Run focused tests and confirm RED**

Run: `npm test -- lib/providers/steam/search/client.test.ts`

Expected: FAIL because the Search Client does not exist.

- [ ] **Step 4: Implement the minimal HTTP-only client**

```ts
export function createSteamSearchClient(
  options: SteamSearchClientOptions = {},
): SteamSearchClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://store.steampowered.com/api/storesearch/";
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async search(query) {
      const url = new URL(baseUrl);
      url.searchParams.set("term", query);
      url.searchParams.set("l", "english");
      url.searchParams.set("cc", "US");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
        } catch (cause) {
          if (controller.signal.aborted) {
            throw new SteamSearchError("timeout", "Steam search timed out", { retryable: true, cause });
          }
          throw new SteamSearchError("network_error", "Steam search request failed", { retryable: true, cause });
        }

        if (!response.ok) {
          const code = response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "provider_unavailable"
              : "http_error";
          throw new SteamSearchError(code, `Steam search returned HTTP ${response.status}`, {
            retryable: response.status === 429 || response.status >= 500,
            status: response.status,
            retryAfter: response.headers.get("Retry-After") ?? undefined,
          });
        }

        try {
          return { body: await response.json(), requestUrl: url.toString() };
        } catch (cause) {
          if (controller.signal.aborted) {
            throw new SteamSearchError("timeout", "Steam search timed out", { retryable: true, cause });
          }
          throw new SteamSearchError("malformed_json", "Steam search returned invalid JSON", {
            retryable: false,
            cause,
          });
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
```

Use the exact Task 2 status mappings. Do not import query validation, Zod schemas, Store item contracts, D1, or importer code.

- [ ] **Step 5: Run focused tests and typecheck, then inspect HTTP scope**

Run: `npm test -- lib/providers/steam/search/client.test.ts && npm run typecheck`

Expected: PASS, including body-consumption timeout and one-request assertions. Confirm the client returns `unknown` and does not inspect `items` or Store types.

- [ ] **Step 6: Commit Task 3**

```bash
git add lib/providers/steam/search/client.ts lib/providers/steam/search/client.test.ts
git commit -m "feat: add Steam search HTTP client"
```

---

### Task 4: Raw Zod Search Schema and Fixtures

**Files:**
- Create: `lib/providers/steam/search/schema.ts`
- Create: `lib/providers/steam/search/schema.test.ts`
- Create: `test/fixtures/steam/search-success.json`
- Create: `test/fixtures/steam/search-with-store-types.json`
- Create: `test/fixtures/steam/search-extra-fields.json`
- Create: `test/fixtures/steam/search-malformed.json`

**Interfaces:**
- Produces: `steamSearchRawItemSchema`
- Produces: `steamSearchRawResponseSchema`
- Produces: inferred `SteamSearchRawItem`
- Produces: inferred `SteamSearchRawResponse`
- The inferred response requires `items`; `total` is deliberately absent from the consumed schema and remains an unconstrained extra provider field.

- [ ] **Step 1: Add representative contract fixtures**

Use a success fixture with app items and optional images, a mixed Store-type fixture containing `app`, `sub`, `bundle`, and another type, an extra-fields fixture with a future non-numeric `total`, and a malformed fixture whose `items` value is not an array. Fixture IDs must be synthetic or stable public examples and must not require live network access.

- [ ] **Step 2: Write failing schema acceptance tests**

```ts
expect(steamSearchRawResponseSchema.parse({
  items: [{ id: 1245620, name: "ELDEN RING", type: "app", future_item_field: true }],
  future_top_level_field: { changed: true },
})).toMatchObject({ items: [{ id: 1245620 }] });
```

Prove that `total` is not consumed and cannot break parsing:

```ts
it.each([
  ["missing", {}],
  ["number", { total: 1 }],
  ["string", { total: "1" }],
  ["null", { total: null }],
  ["object", { total: { future: true } }],
])("accepts %s total representation", (_label, extra) => {
  expect(() => steamSearchRawResponseSchema.parse({ ...extra, items: [] })).not.toThrow();
});
```

Also assert `tiny_image: "not yet a URL"` succeeds because URL semantics belong to normalization.

- [ ] **Step 3: Add failing schema rejection tests**

Reject missing/non-array `items`, blank names, blank types, and non-string `tiny_image`. Lock the exact App ID boundary with this table:

```ts
it.each([1, 4_294_967_295])("accepts App ID boundary %s", (id) => {
  expect(() => steamSearchRawItemSchema.parse({ id, name: "Example", type: "app" })).not.toThrow();
});

it.each([0, 4_294_967_296, 1.5])("rejects invalid App ID %s", (id) => {
  expect(() => steamSearchRawItemSchema.parse({ id, name: "Example", type: "app" })).toThrow();
});
```

Do not validate or reject any `total` representation, and do not require or test unrelated price/platform/metascore fields.

- [ ] **Step 4: Run focused tests and confirm RED**

Run: `npm test -- lib/providers/steam/search/schema.test.ts`

Expected: FAIL because the raw schemas do not exist.

- [ ] **Step 5: Implement narrow loose schemas**

```ts
import { z } from "zod";

export const steamSearchRawItemSchema = z.looseObject({
  id: z.number().int().min(1).max(4_294_967_295),
  name: z.string().trim().min(1),
  type: z.string().trim().min(1),
  tiny_image: z.string().optional(),
});

export const steamSearchRawResponseSchema = z.looseObject({
  items: z.array(steamSearchRawItemSchema),
});

export type SteamSearchRawItem = z.infer<typeof steamSearchRawItemSchema>;
export type SteamSearchRawResponse = z.infer<typeof steamSearchRawResponseSchema>;
```

- [ ] **Step 6: Run focused tests and typecheck, then inspect consumed fields**

Run: `npm test -- lib/providers/steam/search/schema.test.ts && npm run typecheck`

Expected: PASS. Confirm IDs are restricted to `1..4294967295`, the schema contains no required provider fields beyond `items[].id/name/type`, `tiny_image` remains optional, and `total` is absent from the schema shape.

- [ ] **Step 7: Commit Task 4**

```bash
git add lib/providers/steam/search/schema.ts lib/providers/steam/search/schema.test.ts test/fixtures/steam/search-*.json
git commit -m "feat: validate Steam search responses"
```

---

### Task 5: Search Response Adapter

**Files:**
- Create: `lib/providers/steam/search/response.ts`
- Create: `lib/providers/steam/search/response.test.ts`

**Interfaces:**
- Consumes: unknown Search Client body.
- Produces: `parseSteamSearchResponse(body: unknown): SteamSearchRawResponse`
- Emits only `SteamSearchError` with `code: "schema_changed"`.

- [ ] **Step 1: Write failing adapter tests**

```ts
expect(parseSteamSearchResponse({ items: [] })).toEqual({ items: [] });
expect(parseSteamSearchResponse({
  items: [{ id: 10, name: "Example", type: "app", ignored: true }],
  ignored_top_level: true,
})).toMatchObject({ items: [{ id: 10, name: "Example", type: "app" }] });
```

Load the malformed fixture and assert:

```ts
expect(() => parseSteamSearchResponse(malformed)).toThrowError(
  expect.objectContaining({ code: "schema_changed", retryable: false }),
);
```

Also prove that absent, numeric, string, null, and object `total` values all succeed, and that `type: "sub"` is structurally valid; the adapter must not filter it.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- lib/providers/steam/search/response.test.ts`

Expected: FAIL because `parseSteamSearchResponse` does not exist.

- [ ] **Step 3: Implement the minimal adapter**

```ts
export function parseSteamSearchResponse(body: unknown): SteamSearchRawResponse {
  const parsed = steamSearchRawResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new SteamSearchError("schema_changed", "Steam search response schema changed", {
      retryable: false,
      cause: parsed.error,
    });
  }
  return parsed.data;
}
```

Do not add App ID semantics, Store-type filtering, canonical type checks, importer errors, or fallback parsing.

- [ ] **Step 4: Run focused tests and typecheck, then inspect adapter scope**

Run: `npm test -- lib/providers/steam/search/response.test.ts lib/providers/steam/search/schema.test.ts && npm run typecheck`

Expected: PASS. Confirm `response.ts` imports only the search schema and search error contract.

- [ ] **Step 5: Commit Task 5**

```bash
git add lib/providers/steam/search/response.ts lib/providers/steam/search/response.test.ts
git commit -m "feat: adapt Steam search responses"
```

---

### Task 6: Search Result Contracts and Normalizer

**Files:**
- Create: `lib/providers/steam/search/contracts.ts`
- Create: `lib/providers/steam/search/contracts.test.ts`
- Create: `lib/providers/steam/search/normalize.ts`
- Create: `lib/providers/steam/search/normalize.test.ts`

**Interfaces:**
- Produces: `SteamSearchResult`
- Produces: `SteamSearchWarningCode`
- Produces: `SteamSearchWarning`
- Produces: `SteamSearchNormalizationResult`
- Produces: `normalizeSteamSearch(response: SteamSearchRawResponse, limit: number): SteamSearchNormalizationResult`

```ts
export type SteamSearchResult = {
  appId: string;
  name: string;
  type: "game" | "unknown";
  imageUrl: string | null;
};

export type SteamSearchWarningCode =
  | "invalid_image_url"
  | "duplicate_app_id"
  | "unsupported_store_item_type"
  | "result_limit_applied";

export type SteamSearchWarning = {
  code: SteamSearchWarningCode;
  message: string;
  itemIndex?: number;
  storeItemType?: string;
  appId?: string;
};

export type SteamSearchNormalizationResult = {
  results: SteamSearchResult[];
  warnings: SteamSearchWarning[];
};
```

- [ ] **Step 1: Write failing contract-shape tests**

Use `satisfies` to lock exact result and warning field names, and use an exhaustive `switch` helper over `SteamSearchWarningCode` so a renamed/missing warning code fails typecheck.

- [ ] **Step 2: Write failing Store-type boundary tests**

```ts
const normalized = normalizeSteamSearch({
  items: [
    { id: 10, name: "Base app", type: "app" },
    { id: 20, name: "Package", type: "sub" },
    { id: 30, name: "Bundle", type: "bundle" },
    { id: 40, name: "Unexpected", type: "APP" },
  ],
}, 10);

expect(normalized.results).toEqual([
  { appId: "10", name: "Base app", type: "unknown", imageUrl: null },
]);
expect(normalized.warnings.filter(
  (warning) => warning.code === "unsupported_store_item_type",
)).toHaveLength(3);
```

Add named app cases for a base game, DLC, demo, soundtrack, software, and tool. Assert all are retained as `unknown`; no name heuristic promotes or filters them.

- [ ] **Step 3: Write failing image, dedupe, order, and limit tests**

Cover:

- valid HTTP and HTTPS images;
- missing image becomes null without warning;
- invalid, non-HTTP, or malformed image becomes null with `invalid_image_url`;
- duplicate retained App ID keeps the first item/image and emits `duplicate_app_id`;
- a preceding non-app item with the same numeric ID does not suppress a later app item;
- provider order remains unchanged among first retained occurrences;
- filtering and deduplication happen before limiting;
- more unique apps than the limit yields one `result_limit_applied` warning;
- exactly the limit yields no limit warning.

- [ ] **Step 4: Run focused tests and confirm RED**

Run: `npm test -- lib/providers/steam/search/contracts.test.ts lib/providers/steam/search/normalize.test.ts`

Expected: FAIL because contracts and normalizer do not exist.

- [ ] **Step 5: Implement contracts and deterministic normalization**

```ts
export function normalizeSteamSearch(
  response: SteamSearchRawResponse,
  limit: number,
): SteamSearchNormalizationResult {
  const results: SteamSearchResult[] = [];
  const warnings: SteamSearchWarning[] = [];
  const seenAppIds = new Set<string>();

  response.items.forEach((item, itemIndex) => {
    if (item.type !== "app") {
      warnings.push({
        code: "unsupported_store_item_type",
        message: `Ignored Steam Store item type: ${item.type}`,
        itemIndex,
        storeItemType: item.type,
      });
      return;
    }
    const appId = String(item.id);
    if (seenAppIds.has(appId)) {
      warnings.push({ code: "duplicate_app_id", message: `Ignored duplicate App ID: ${appId}`, itemIndex, appId });
      return;
    }
    seenAppIds.add(appId);
    let imageUrl: string | null = null;
    if (item.tiny_image !== undefined && item.tiny_image.length > 0) {
      try {
        const parsed = new URL(item.tiny_image);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new TypeError("unsupported protocol");
        imageUrl = parsed.toString();
      } catch {
        warnings.push({
          code: "invalid_image_url",
          message: `Ignored invalid image URL for App ID: ${appId}`,
          itemIndex,
          appId,
        });
      }
    }
    results.push({ appId, name: item.name.trim(), type: "unknown", imageUrl });
  });

  if (results.length > limit) {
    warnings.push({ code: "result_limit_applied", message: `Limited ${results.length} results to ${limit}` });
  }
  return { results: results.slice(0, limit), warnings };
}
```

Keep warning context bounded and never include the raw response object.

- [ ] **Step 6: Run focused tests and typecheck, then inspect deterministic behavior**

Run: `npm test -- lib/providers/steam/search/contracts.test.ts lib/providers/steam/search/normalize.test.ts && npm run typecheck`

Expected: PASS. Confirm only exact `app` values enter results, every emitted result is `unknown`, and the original provider array is not mutated.

- [ ] **Step 7: Commit Task 6**

```bash
git add lib/providers/steam/search/contracts.ts lib/providers/steam/search/contracts.test.ts lib/providers/steam/search/normalize.ts lib/providers/steam/search/normalize.test.ts
git commit -m "feat: normalize Steam search results"
```

---

### Task 7: Search Service and Dependency Boundaries

**Files:**
- Create: `lib/providers/steam/search/service.ts`
- Create: `lib/providers/steam/search/service.test.ts`
- Create: `lib/providers/steam/search/dependencies.test.ts`

**Interfaces:**
- Consumes: Task 1 validator, Task 3 `SteamSearchClient`, Task 5 adapter, Task 6 normalizer.
- Produces: `SteamSearchOptions = { limit?: number }`
- Produces: `SteamSearchResponse = { query: string; results: SteamSearchResult[]; warnings: SteamSearchWarning[] }`
- Produces: `SteamSearchService = { search(query: string, options?: SteamSearchOptions): Promise<SteamSearchResponse> }`
- Produces: `createSteamSearchService(options?: { client?: SteamSearchClient }): SteamSearchService`

- [ ] **Step 1: Write failing orchestration tests**

```ts
const client = { search: vi.fn().mockResolvedValue({ body: { items: [] }, requestUrl: "https://example.test" }) };
const service = createSteamSearchService({ client });
await expect(service.search("  黑神话：悟空  ", { limit: 5 })).resolves.toEqual({
  query: "黑神话：悟空",
  results: [],
  warnings: [],
});
expect(client.search).toHaveBeenCalledWith("黑神话：悟空");
```

Add cases proving default limit 10, warnings propagate unchanged, and empty/overlong/invalid-limit input makes zero client calls.

- [ ] **Step 2: Write a failing layer-order test**

Return a mixed raw response from the fake client. Assert the service calls the client once, returns only normalized app results, and never exposes `body`, `requestUrl`, `total`, or raw Store types.

- [ ] **Step 3: Write a failing static dependency-boundary test**

Read every non-test `.ts` file under `lib/providers/steam/search` and reject imports matching:

```ts
const forbidden = [
  /from ["'].*lib\/db\//,
  /from ["'].*lib\/importers\//,
  /from ["']\.\.\/\.\.\/\.\.\/db\//,
  /from ["']\.\.\/\.\.\/\.\.\/importers\//,
  /from ["']\.\.\/client["']/,
  /from ["']\.\.\/response["']/,
  /from ["']\.\.\/normalize["']/,
];
```

Resolve the scan root with `fileURLToPath(new URL(".", import.meta.url))`. This check must allow sibling search-module imports while rejecting parent V2.2 detail modules.

- [ ] **Step 4: Run focused tests and confirm RED**

Run: `npm test -- lib/providers/steam/search/service.test.ts lib/providers/steam/search/dependencies.test.ts`

Expected: FAIL because the Search Service does not exist.

- [ ] **Step 5: Implement the single search API**

```ts
export function createSteamSearchService(
  options: { client?: SteamSearchClient } = {},
): SteamSearchService {
  const client = options.client ?? createSteamSearchClient();
  return {
    async search(query, searchOptions = {}) {
      const input = validateSteamSearchInput(query, searchOptions.limit);
      const http = await client.search(input.query);
      const raw = parseSteamSearchResponse(http.body);
      const normalized = normalizeSteamSearch(raw, input.limit);
      return { query: input.query, ...normalized };
    },
  };
}
```

- [ ] **Step 6: Run focused tests and typecheck, then inspect all search imports**

Run: `npm test -- lib/providers/steam/search/service.test.ts lib/providers/steam/search/dependencies.test.ts && npm run typecheck`

Expected: PASS. Confirm invalid input stops before HTTP and no search production module imports V2.2 importer/detail or D1 code.

- [ ] **Step 7: Commit Task 7**

```bash
git add lib/providers/steam/search/service.ts lib/providers/steam/search/service.test.ts lib/providers/steam/search/dependencies.test.ts
git commit -m "feat: compose Steam search service"
```

---

### Task 8: Read-Only Steam Search CLI

**Files:**
- Create: `scripts/search-steam-games.ts`
- Create: `scripts/search-steam-games.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `SteamSearchCliArgs = { query: string; limit?: number; json: boolean }`
- Produces: `parseSteamSearchArgs(argv: string[]): SteamSearchCliArgs`
- Produces: `SteamSearchCliDependencies = { searchService: Pick<SteamSearchService, "search">; stdout?: (message: string) => void; stderr?: (message: string) => void }`
- Produces: `runSteamSearchCli(args: SteamSearchCliArgs, dependencies: SteamSearchCliDependencies): Promise<number>`
- Adds: `npm run steam:search -- "<query>" [--limit N] [--json]`

- [ ] **Step 1: Write failing argument-parser tests**

```ts
expect(parseSteamSearchArgs(["elden ring"])).toEqual({ query: "elden ring", limit: undefined, json: false });
expect(parseSteamSearchArgs(["elden ring", "--limit", "5", "--json"])).toEqual({ query: "elden ring", limit: 5, json: true });
```

Reject no query, two positional queries, missing `--limit` value, duplicate `--limit`, duplicate `--json`, non-numeric limit, unknown flags, `--write`, `--write=true`, `--remote`, `--remote=true`, `--env`, `--env=production`, `--config`, `--config=...`, `--database-id`, and URL-like remote flags. The service remains responsible for range validation.

- [ ] **Step 2: Write failing human and JSON output tests**

Inject a fake service result. Assert human output is numbered with names and App IDs, empty results print a no-results message, and warning output is at most a concise count/summary. Assert JSON output exactly serializes `{ query, results, warnings }` and includes all warning entries.

- [ ] **Step 3: Write failing error and no-side-effect tests**

Assert `SteamSearchError` is written to stderr as structured JSON and returns exit code 1. Assert an unexpected error is rethrown. Mock only `searchService.search` and prove the CLI runner makes one search call and no importer or database call is representable through its dependency interface.

Add a source-boundary test that reads `scripts/search-steam-games.ts` and rejects `wrangler`, `lib/db`, `lib/importers`, `createDatabase`, `createSteamImporter`, and `createSteamImportStore` imports or references.

- [ ] **Step 4: Run focused tests and confirm RED**

Run: `npm test -- scripts/search-steam-games.test.ts`

Expected: FAIL because the search CLI does not exist and `steam:search` is absent.

- [ ] **Step 5: Implement side-effect-free parsing and runner**

```ts
export function parseSteamSearchArgs(argv: string[]): SteamSearchCliArgs {
  const queries: string[] = [];
  let limit: number | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new Error("Duplicate --json option");
      json = true;
      continue;
    }
    if (argument === "--limit") {
      if (limit !== undefined) throw new Error("Duplicate --limit option");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw new Error("Missing --limit value");
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error("Invalid --limit value");
      limit = parsed;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    queries.push(argument);
  }

  if (queries.length !== 1) throw new Error("Expected exactly one Steam search query");
  return { query: queries[0], limit, json };
}

export async function runSteamSearchCli(
  args: SteamSearchCliArgs,
  dependencies: SteamSearchCliDependencies,
): Promise<number> {
  const stdout = dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));
  try {
    const response = await dependencies.searchService.search(args.query, { limit: args.limit });
    stdout(args.json ? JSON.stringify(response, null, 2) : formatHumanResults(response));
    return 0;
  } catch (error) {
    if (error instanceof SteamSearchError) {
      stderr(formatSteamSearchError(error));
      return 1;
    }
    throw error;
  }
}
```

The executable `main` constructs only `createSteamSearchService()` and passes it to the runner. It must not dynamically import Wrangler.

- [ ] **Step 6: Add the package command**

```json
"steam:search": "tsx scripts/search-steam-games.ts"
```

- [ ] **Step 7: Run focused tests, typecheck, and a deterministic CLI fixture path**

Run: `npm test -- scripts/search-steam-games.test.ts lib/providers/steam/search && npm run typecheck`

Expected: PASS. Do not invoke the real Steam endpoint as part of this verification. Inspect the source-boundary assertion to confirm no D1/importer initialization path exists.

- [ ] **Step 8: Commit Task 8**

```bash
git add scripts/search-steam-games.ts scripts/search-steam-games.test.ts package.json
git commit -m "feat: add Steam search CLI"
```

---

### Task 9: README, Full Regression, and Immutable Baseline Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents: search command, `--limit`, `--json`, selection handoff, no-write guarantee, fixed locale, and undocumented endpoint risk.
- Changes no TypeScript interface.

- [ ] **Step 1: Write a failing README contract test**

Add the assertion to `scripts/search-steam-games.test.ts` before editing README:

```ts
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
expect(readme).toContain('npm run steam:search -- "elden ring"');
expect(readme).toContain("--limit");
expect(readme).toContain("--json");
expect(readme).toContain("steam:import");
expect(readme).toMatch(/does not write|read-only/i);
expect(readme).toMatch(/undocumented/i);
```

- [ ] **Step 2: Run the README test and confirm RED**

Run: `npm test -- scripts/search-steam-games.test.ts -t "documents Steam search"`

Expected: FAIL because README has no V2.3 search instructions.

- [ ] **Step 3: Document the operator workflow**

Add a concise V2.3 section with:

```bash
npm run steam:search -- "elden ring"
npm run steam:search -- "elden ring" --limit 5
npm run steam:search -- "elden ring" --json
npm run steam:import -- 1245620
npm run steam:import -- 1245620 --write
```

State that search is read-only, never calls the importer, uses fixed English/US locale, may return non-game apps as `unknown`, relies on an undocumented Steam Store endpoint, has no HTML fallback, and requires explicit user App ID selection before the existing V2.2 import command.

- [ ] **Step 4: Run the focused README/CLI test and typecheck**

Run: `npm test -- scripts/search-steam-games.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Run the complete regression gate**

Run each command separately. Require exit code 0 from tests, typecheck, lint, build, both D1 checks, `npm audit --omit=dev`, and `git diff --check`. Run the full `npm audit` to completion and record its findings; it may exit nonzero for known development-only advisories and must not be force-fixed:

```bash
npm test
npm run typecheck
npm run lint
npm run build -- --webpack
npm run db:check:local
npm run db:verify:local
npm audit
npm audit --omit=dev
git diff --check
```

Expected:

- all V2.2 and V2.3 tests pass;
- typecheck, lint, and webpack build pass;
- local migration listing and CRUD verification pass;
- `npm audit --omit=dev` reports zero production vulnerabilities;
- any remaining full `npm audit` findings are recorded by dependency and dev/production scope rather than force-fixed;
- no whitespace errors.

- [ ] **Step 6: Verify immutable files against the V2.2 tag**

Run:

```bash
test "$(find drizzle -maxdepth 1 -name '*.sql' -type f | wc -l | tr -d ' ')" = "2"
test "$(shasum lib/db/schema.ts | cut -d ' ' -f 1)" = "52e84d7c2b52b73b95bdfb3934dabbde0e65e3d5"
test "$(shasum lib/mock-data.ts | cut -d ' ' -f 1)" = "de589f973857e8610b07f8f15291720832e2b412"
git diff --exit-code v2.2-steam-single-game -- lib/db/schema.ts 'drizzle/*.sql' lib/mock-data.ts app components
git diff --exit-code v2.2-steam-single-game -- lib/importers lib/db/repositories/steam-import.ts lib/providers/steam/app-id.ts lib/providers/steam/client.ts lib/providers/steam/errors.ts lib/providers/steam/normalize.ts lib/providers/steam/response.ts lib/providers/steam/schema.ts
```

Expected: two migrations, exact schema/mock hashes, and no differences in V1 UI or V2.2 importer/planner/repository/detail-provider files. If any command fails, stop and remove the out-of-scope change before committing.

- [ ] **Step 7: Inspect final dependency and scope boundaries**

Run:

```bash
rg -n "lib/db|lib/importers|wrangler|createDatabase|createSteamImporter|createSteamImportStore" lib/providers/steam/search scripts/search-steam-games.ts
rg -n "storesearch|search/suggest|search/results|SteamSpy|IGDB|Epic|GOG" lib/providers/steam/search scripts/search-steam-games.ts
git status --short
```

Expected: the first command finds only negative assertions inside dependency tests, not production imports or CLI initialization. The second command finds only `/api/storesearch/` in production code and test-only forbidden-source checks; no fallback provider is implemented. Before commit, only `README.md` and the README assertion in `scripts/search-steam-games.test.ts` are uncommitted.

- [ ] **Step 8: Commit Task 9**

```bash
git add README.md scripts/search-steam-games.test.ts
git commit -m "docs: document Steam search workflow"
```

- [ ] **Step 9: Verify the final worktree is clean**

Run: `git status --short`

Expected: no output.

## Final Coverage Checklist

- Task 1 covers trim, Unicode preservation, 100-code-point length, default 10, hard maximum 10, and validation before HTTP.
- Task 2 covers the independent input/client/adapter error vocabulary without changing V2.2 errors.
- Task 3 covers the HTTP-only Store endpoint, fixed locale, timeout across body consumption, 429, 5xx, 4xx, malformed JSON, and no retry.
- Task 4 covers required `items`, completely unconsumed/tolerated `total`, the exact `1..4294967295` App ID range, required item identity fields, optional raw image string, and tolerated extra fields.
- Task 5 covers the `schema_changed` adapter boundary without canonical/import semantics.
- Task 6 covers all result/warning contracts, exact `app` filtering, `unknown` semantics, non-app warnings, optional image warnings, first-wins dedupe, order, and post-dedupe limit.
- Task 7 covers the single search API, layer ordering, early validation, warning propagation, and static isolation from V2.2/D1.
- Task 8 covers human/JSON CLI modes, limit parsing, forbidden flags, no importer, and no D1/Wrangler initialization.
- Task 9 covers README, full regression, audits, D1 verification, migration count, protected hashes/diffs, provider-source scope, and clean status.
- No task modifies schema, migrations, Mock Data, V1 UI, or V2.2 import behavior.
- No task requires a schema migration or V2.2 importer modification.
