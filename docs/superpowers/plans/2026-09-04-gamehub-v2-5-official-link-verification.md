# GameHub V2.5 Official Link Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 canonical game 的 official links 提供 SSRF-safe、local-only、dry-run-first HTTP verification workflow。

**Architecture:** 单 canonical game 作为 CLI/service 范围，单 link 作为 verification 与 optimistic concurrency 单位。HTTP transport 使用 Node http/https + request-bound custom lookup，将经过 DNS/IP 安全审查的目标绑定到实际 socket；每个 redirect hop 完整重新验证。最终只更新现有 verification metadata，并通过 compare-before-update 防止 stale verification 写回。

**Tech Stack:** Next.js 16, TypeScript, Node.js http/https/dns/net, Drizzle ORM, Cloudflare D1 local, Vitest/现有 test stack

**Spec:** docs/superpowers/specs/2026-09-04-gamehub-v2-5-official-link-verification-design.md

## Global Constraints

- Local D1 only; use the repository's fixed `wrangler.jsonc`, `persist: true`, and `remoteBindings: false`.
- No remote write and no CLI route that can select a remote database, environment, config, or URL.
- No ordinary `fetch`, global fetch, Undici fetch, or DNS-preflight-then-fetch path.
- No new production dependency.
- Actual verification transport uses only Node `http`/`https`.
- DNS selection is request-bound through a custom `lookup` that returns only an already-approved address.
- Mixed public/unsafe DNS answers fail closed for the whole destination.
- Only default ports are allowed: HTTP 80 and HTTPS 443.
- Every redirect hop repeats full URL, hostname, DNS, IP, socket-binding, and transport validation.
- HTTPS to HTTP redirects are forbidden; HTTP to HTTPS is allowed.
- Redirect maximum is 5, so total hops are at most 6.
- Links per game maximum is 20 and is enforced before networking.
- DNS address maximum is 16 per hop.
- Verification concurrency is 1.
- DNS deadline is 3 seconds.
- Request-to-response-headers deadline is 8 seconds.
- Per-link total deadline is 20 seconds.
- Per-game total deadline is 5 minutes.
- Stored URL and redirect Location maximum length is 2,048 characters.
- Response headers maximum is 16 KiB.
- GET application body consumption is exactly 0 bytes.
- Manual verification metadata is preserved.
- No URL replacement, link creation, or link deletion.
- Never mutate `provider`, `platform`, `link_type`, `region`, or `is_official`.
- Dry-run performs real DNS/HTTP verification but zero D1 mutations.
- Migration count changes exactly from 2 to 3.
- `failed` remains legal for legacy compatibility but is never emitted by the V2.5 verifier.
- Every presentation URL is sanitized before human or JSON output.
- Exact URLs remain internal to transport, planning, and optimistic concurrency only.

## File and Module Decomposition

- `lib/verifiers/official-links/types.ts`: all shared internal and presentation DTOs; no runtime dependencies.
- `lib/verifiers/official-links/errors.ts`: sanitized operation-level error contract.
- `lib/verifiers/official-links/url-safety.ts`: URL parsing, hostname policy, exact internal identity, and redirect Location resolution.
- `lib/verifiers/official-links/presentation.ts`: presentation-only URL and DTO sanitization.
- `lib/verifiers/official-links/ip-safety.ts`: normalized IP representation and pinned IANA CIDR policy.
- `lib/verifiers/official-links/destination.ts`: injected DNS resolution, all-address validation, cap, deadline, and deterministic selection.
- `lib/verifiers/official-links/transport.ts`: request-bound `http`/`https` request through an approved address.
- `lib/verifiers/official-links/redirect.ts`: manual redirect state machine and per-hop safety orchestration.
- `lib/verifiers/official-links/verifier.ts`: HEAD-first and bounded GET fallback producing raw terminal outcomes.
- `lib/verifiers/official-links/classification.ts`: pure terminal-outcome-to-verification-result mapping.
- `lib/db/repositories/link-verification.ts`: bounded snapshot reads and conditional metadata-only batch writes.
- `lib/verifiers/official-links/plan.ts`: manual precedence and exact metadata plan construction.
- `lib/verifiers/official-links/service.ts`: single-game sequential orchestration and global deadlines.
- `scripts/verify-official-links.ts`: fixed-local CLI and presentation boundary.

---

### Task 1: Verification Status Schema and Migration

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/validation.ts`
- Modify: `lib/db/validation.test.ts`
- Create: `test/migrations/official-link-status.test.ts`
- Create: `drizzle/0002_<drizzle-generated-name>.sql`
- Create: `drizzle/meta/0002_snapshot.json`
- Modify: `drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: existing `gameOfficialLinks` Drizzle table and `officialLinkSchema`.
- Produces: `VerificationStatusValue` validation parity at the database and application boundaries for the exact union `"unverified" | "pending" | "verified" | "failed" | "reachable_but_unverified" | "broken" | "temporarily_unavailable" | "unsafe" | "unknown"`.

- [ ] **Step 1: Write RED validation and migration-preservation tests**

Add a table-driven validation test for all nine legal values and one illegal value. In `test/migrations/official-link-status.test.ts`, create a pre-migration local D1 database, apply only migrations 0000 and 0001, seed a game plus a link containing values in all 16 columns, then apply 0002 and assert exact equality for:

```ts
const allColumns = [
  "id", "game_id", "provider", "platform", "link_type", "url", "region",
  "is_official", "verification_status", "verification_method", "http_status",
  "redirect_url", "verified_at", "last_checked_at", "created_at", "updated_at",
] as const;

const legalStatuses = [
  "unverified", "pending", "verified", "failed",
  "reachable_but_unverified", "broken", "temporarily_unavailable", "unsafe", "unknown",
] as const;
```

Inspect `PRAGMA table_info`, `PRAGMA foreign_key_list`, `PRAGMA index_list`, `PRAGMA index_info`, the table SQL in `sqlite_schema`, and `PRAGMA foreign_key_check`. Assert the unique `(game_id,url)` index, both ordinary indexes, all defaults, PK/FK cascade, all four CHECK constraints, and migration count 3. Create a fresh fully migrated database and compare its table/index SQL behavior with the upgraded database.

- [ ] **Step 2: Run RED tests**

Run: `npx vitest run lib/db/validation.test.ts test/migrations/official-link-status.test.ts`

Expected: FAIL because the five new statuses are rejected and migration 0002 does not exist.

- [ ] **Step 3: Make the minimal schema change and generate exactly one migration**

Extend only the status enum in `lib/db/schema.ts` and `lib/db/validation.ts`. Run `npm run db:generate`. The generated migration must rebuild only `game_official_links` and copy with the explicit source and destination list:

```sql
id, game_id, provider, platform, link_type, url, region, is_official,
verification_status, verification_method, http_status, redirect_url,
verified_at, last_checked_at, created_at, updated_at
```

Use D1-compatible deferred foreign-key handling. Do not use `SELECT *`. Preserve all 16 column definitions, four CHECK constraints, one unique index, and two ordinary indexes; only expand `game_official_links_status_check`.

- [ ] **Step 4: Audit generated SQL and metadata**

Run: `git diff -- lib/db/schema.ts lib/db/validation.ts drizzle/`

Expected: one status-union change, one new migration/snapshot, one journal entry, and no other schema diff. Compare all 16 old/new definitions line by line.

- [ ] **Step 5: Run focused verification**

Run: `npx vitest run lib/db/validation.test.ts test/migrations/official-link-status.test.ts lib/db/repositories/games.test.ts`

Expected: PASS, including preserved cascade/index behavior and clean `foreign_key_check`.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Security and scope check**

Run: `git diff --check && find drizzle -maxdepth 1 -name '*.sql' | sort`

Expected: no whitespace errors and exactly three SQL migrations. Confirm no table other than `game_official_links` appears as a changed schema object.

- [ ] **Step 7: Commit**

```bash
git add lib/db/schema.ts lib/db/validation.ts lib/db/validation.test.ts test/migrations/official-link-status.test.ts drizzle
git commit -m "feat: expand official link verification statuses"
```

### Task 2: Verification Core Types and Error Contracts

**Files:**
- Create: `lib/verifiers/official-links/types.ts`
- Create: `lib/verifiers/official-links/errors.ts`
- Create: `lib/verifiers/official-links/errors.test.ts`

**Interfaces:**
- Consumes: the nine-value schema union established in Task 1.
- Produces the exact exported contracts used by Tasks 3-13:

```ts
export type VerificationStatus =
  | "unverified" | "pending" | "verified" | "failed"
  | "reachable_but_unverified" | "broken" | "temporarily_unavailable"
  | "unsafe" | "unknown";
export type VerificationClassification =
  | "verified" | "reachable_but_unverified" | "broken"
  | "temporarily_unavailable" | "unsafe" | "unknown";
export type VerificationCode =
  | "http_result" | "invalid_url" | "unsupported_scheme" | "unsafe_destination"
  | "dns_failure" | "timeout" | "network_error" | "tls_error"
  | "redirect_loop" | "too_many_redirects" | "invalid_redirect"
  | "protocol_downgrade";
export type HttpMethod = "HEAD" | "GET";
export type VerificationAttempt = {
  method: HttpMethod; url: string; resolvedAddress: string | null;
  addressFamily: 4 | 6 | null; httpStatus: number | null;
  startedAt: Date; finishedAt: Date;
};
export type RedirectHop = {
  fromUrl: string; status: 301 | 302 | 303 | 307 | 308;
  location: string; resolvedUrl: string | null;
};
export type TerminalOutcome = {
  code: VerificationCode; attempts: VerificationAttempt[]; redirectChain: RedirectHop[];
  finalUrl: string | null; httpStatus: number | null; checkedAt: Date;
};
export type LinkVerificationResult = TerminalOutcome & {
  linkId: number; gameId: number; originalUrl: string;
  classification: VerificationClassification;
};
export type LinkVerificationSnapshot = {
  id: number; gameId: number; url: string; updatedAt: Date;
  verificationStatus: VerificationStatus; verificationMethod: "manual" | "http" | "provider_api" | null;
  httpStatus: number | null; redirectUrl: string | null;
  verifiedAt: Date | null; lastCheckedAt: Date | null;
};
export type LinkVerificationUpdate = {
  verificationStatus: VerificationClassification; verificationMethod: "http";
  httpStatus: number | null; redirectUrl: string | null;
  verifiedAt: Date | null; lastCheckedAt: Date; updatedAt: Date;
};
export type LinkVerificationPlanItem =
  | { action: "update"; snapshot: LinkVerificationSnapshot; changes: LinkVerificationUpdate }
  | { action: "skip"; linkId: number; originalUrl: string;
      reason: "manual_verification_preserved" | "no_metadata_change" };
export type GameLinkVerificationPlan = {
  gameId: number; dryRun: boolean; linksRead: number;
  verificationResults: LinkVerificationResult[]; items: LinkVerificationPlanItem[];
};
export type WriteConflict = { linkId: number; code: "write_conflict" };
export type GameLinkVerificationResult = {
  gameId: number; dryRun: boolean;
  status: "planned" | "applied" | "partially_applied" | "no_changes";
  plan: GameLinkVerificationPlan; affectedRows: number; conflicts: WriteConflict[];
};
export type PresentedVerificationAttempt = Omit<VerificationAttempt, "url" | "startedAt" | "finishedAt"> & {
  url: string; startedAt: string; finishedAt: string;
};
export type PresentedRedirectHop = {
  fromUrl: string; status: 301 | 302 | 303 | 307 | 308;
  location: string; resolvedUrl: string | null;
};
export type PresentedLinkVerificationResult = {
  linkId: number; gameId: number; originalUrl: string;
  classification: VerificationClassification; code: VerificationCode;
  attempts: PresentedVerificationAttempt[]; redirectChain: PresentedRedirectHop[];
  finalUrl: string | null; httpStatus: number | null; checkedAt: string;
};
export type PresentedLinkVerificationUpdate = Omit<
  LinkVerificationUpdate,
  "redirectUrl" | "verifiedAt" | "lastCheckedAt" | "updatedAt"
> & {
  redirectUrl: string | null; verifiedAt: string | null;
  lastCheckedAt: string; updatedAt: string;
};
export type PresentedPlanItem =
  | { action: "update"; linkId: number; originalUrl: string;
      changes: PresentedLinkVerificationUpdate }
  | { action: "skip"; linkId: number; originalUrl: string;
      reason: "manual_verification_preserved" | "no_metadata_change" };
export type PresentedGameLinkVerificationResult = {
  gameId: number; dryRun: boolean;
  status: "planned" | "applied" | "partially_applied" | "no_changes";
  links: PresentedLinkVerificationResult[]; planItems: PresentedPlanItem[];
  affectedRows: number; conflicts: WriteConflict[];
};
```

`PresentedGameLinkVerificationResult` is deliberately distinct from internal DTOs and may only be created by `presentGameLinkVerificationResult()` in Task 3.

- [ ] **Step 1: Write RED error-contract tests**

Test `LinkVerificationError` with operation codes `invalid_game_id`, `game_not_found`, `link_limit_exceeded`, `database_unavailable`, `local_platform_unavailable`, `write_failed`, `cleanup_failed`, and `unexpected_error`. Assert `toJSON()` returns only `{ name, code, message }` and never serializes `cause`, stack, raw Error, socket, DNS response, HTTP response, or D1 detail.

- [ ] **Step 2: Run RED test**

Run: `npx vitest run lib/verifiers/official-links/errors.test.ts`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Define contracts and sanitized operational error**

Implement the exact types above and:

```ts
export type LinkVerificationOperationCode =
  | "invalid_game_id" | "game_not_found" | "link_limit_exceeded"
  | "database_unavailable" | "local_platform_unavailable"
  | "write_failed" | "cleanup_failed" | "unexpected_error";

export class LinkVerificationError extends Error {
  readonly code: LinkVerificationOperationCode;
  constructor(code: LinkVerificationOperationCode, message: string, options?: { cause?: unknown });
  toJSON(): { name: "LinkVerificationError"; code: LinkVerificationOperationCode; message: string };
}
```

Keep `cause` non-enumerable through the standard Error options and expose no raw operational object in public DTOs.

- [ ] **Step 4: Verify contracts**

Run: `npx vitest run lib/verifiers/official-links/errors.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Security and scope check**

Inspect exports and confirm there is no `Error`, `Socket`, `IncomingMessage`, DNS record object, response body, certificate, or D1 result field in a public DTO.

- [ ] **Step 6: Commit**

```bash
git add lib/verifiers/official-links/types.ts lib/verifiers/official-links/errors.ts lib/verifiers/official-links/errors.test.ts
git commit -m "feat: define link verification contracts"
```

### Task 3: URL Safety and Output Sanitization

**Files:**
- Create: `lib/verifiers/official-links/url-safety.ts`
- Create: `lib/verifiers/official-links/url-safety.test.ts`
- Create: `lib/verifiers/official-links/presentation.ts`
- Create: `lib/verifiers/official-links/presentation.test.ts`

**Interfaces:**
- Consumes: `LinkVerificationResult`, `GameLinkVerificationResult`, `PresentedGameLinkVerificationResult`, and `VerificationCode` from Task 2.
- Produces:

```ts
export type SafeHttpUrl = {
  exactUrl: string; requestUrl: URL; protocol: "http:" | "https:";
  hostname: string; port: 80 | 443;
};
export type UrlSafetyResult =
  | { ok: true; value: SafeHttpUrl }
  | { ok: false; code: "invalid_url" | "unsupported_scheme" | "unsafe_destination" };
export function validateHttpUrl(raw: string, maxLength?: number): UrlSafetyResult;
export function resolveRedirectLocation(currentExactUrl: string, location: string): UrlSafetyResult;
export function sanitizeUrlForPresentation(raw: string): string;
export function sanitizeTextForPresentation(raw: string): string;
export function presentGameLinkVerificationResult(
  result: GameLinkVerificationResult,
): PresentedGameLinkVerificationResult;
```

- [ ] **Step 1: Write RED URL-policy tests**

Table-test HTTP/HTTPS, lowercase ASCII/punycode, one trailing dot, empty and single-label hosts, `localhost` and subdomains, `.local`, `.localhost`, `.internal`, `.home.arpa`, `.test`, `.invalid`, `.example`, credentials, fragments, default/explicit default ports, non-default ports, malformed URL, 2,048/2,049-character boundaries, and relative Location resolution.

- [ ] **Step 2: Write RED presentation leak tests**

Construct a complete internal `GameLinkVerificationResult` whose original URL, attempts, redirect `location`, resolved redirect URL, final URL, plan snapshot, and error-facing fields contain unique secret markers under every case-insensitive sensitive key:

```ts
const sensitiveKeys = [
  "token", "access_token", "auth", "authorization", "key", "api_key", "apikey",
  "signature", "sig", "secret", "credential", "x-amz-signature", "x-amz-credential",
] as const;
```

Include repeated parameters, username/password, and fragments. Assert human-ready/JSON-ready presentation contains `[REDACTED]` but none of the marker values, credentials, or fragments. Assert malformed URL input returns a constant redacted placeholder and never raw input. Assert the internal DTO remains byte-for-byte unchanged.

- [ ] **Step 3: Run RED tests**

Run: `npx vitest run lib/verifiers/official-links/url-safety.test.ts lib/verifiers/official-links/presentation.test.ts`

Expected: FAIL because URL and presentation functions do not exist.

- [ ] **Step 4: Implement strict URL validation**

Use WHATWG `URL`; keep the unmodified input as internal `exactUrl`; create a separate `requestUrl` with its fragment cleared; normalize the policy hostname to lowercase ASCII; reject credentials, forbidden names/suffixes, unsupported schemes, overlong values, and ports other than 80/443. `resolveRedirectLocation` uses `new URL(location, currentExactUrl)` and the same validation.

- [ ] **Step 5: Implement presentation-only sanitization**

Parse each output URL, clear username/password/hash, redact every matching query value case-insensitively, preserve repeated parameters, and use the literal `"[REDACTED_URL]"` for malformed input. Build a fresh presentation object recursively and explicitly; never `JSON.stringify()` the internal result directly.

- [ ] **Step 6: Verify focused behavior and types**

Run: `npx vitest run lib/verifiers/official-links/url-safety.test.ts lib/verifiers/official-links/presentation.test.ts && npm run typecheck`

Expected: PASS with complete secret-marker absence assertions.

- [ ] **Step 7: Security and scope check**

Search the presentation module for direct internal-object spreading or serialization. Confirm exact URLs are not mutated and no request/network behavior was added.

- [ ] **Step 8: Commit**

```bash
git add lib/verifiers/official-links/url-safety.ts lib/verifiers/official-links/url-safety.test.ts lib/verifiers/official-links/presentation.ts lib/verifiers/official-links/presentation.test.ts
git commit -m "feat: validate and sanitize verification URLs"
```

### Task 4: IP Safety Classifier

**Files:**
- Create: `lib/verifiers/official-links/ip-safety.ts`
- Create: `lib/verifiers/official-links/ip-safety.test.ts`

**Interfaces:**
- Consumes: Node `net.isIP` and no network service.
- Produces:

```ts
export type NormalizedIpAddress = { address: string; family: 4 | 6 };
export type IpSafetyDecision =
  | { safe: true; value: NormalizedIpAddress }
  | { safe: false; value: NormalizedIpAddress | null; reason: "invalid" | "special_use" };
export const IANA_REGISTRY_SNAPSHOT_DATE = "2025-10-09";
export function normalizeIpAddress(input: string): NormalizedIpAddress | null;
export function classifyIpAddress(input: string): IpSafetyDecision;
export function ipAddressesEqual(left: string, right: string): boolean;
```

- [ ] **Step 1: Write RED normalization and CIDR-boundary tests**

Cover canonical IPv4, compressed/expanded/uppercase IPv6, zone-ID rejection, invalid input, IPv4-mapped IPv6 extraction, and semantic equality. For every pinned IANA IPv4/IPv6 deny CIDR, test first address, last address, and adjacent address when valid. Explicitly cover `0.0.0.0/8`, RFC1918, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, protocol/documentation/benchmark ranges, multicast, `240.0.0.0/4`, broadcast, `::`, `::1`, ULA, link-local, multicast, documentation, discard-only, benchmark, ORCHID, translation, transition, 6to4, and Teredo.

- [ ] **Step 2: Run RED test**

Run: `npx vitest run lib/verifiers/official-links/ip-safety.test.ts`

Expected: FAIL because classifier exports do not exist.

- [ ] **Step 3: Implement deterministic normalization and pinned deny tables**

Represent addresses as bytes/bigints for CIDR matching rather than string prefixes. For IPv4-mapped IPv6, extract the embedded IPv4 and return family 4 canonical form before classification. Default unknown or special-use input to unsafe. Document the IANA snapshot date beside the deny tables.

- [ ] **Step 4: Run focused verification and typecheck**

Run: `npx vitest run lib/verifiers/official-links/ip-safety.test.ts && npm run typecheck`

Expected: PASS for all boundaries and mapped forms.

- [ ] **Step 5: Security and scope check**

Confirm the allow decision cannot result from `net.isIP()` alone, no generic private-range shortcut is the sole policy, and every unparseable address fails closed.

- [ ] **Step 6: Commit**

```bash
git add lib/verifiers/official-links/ip-safety.ts lib/verifiers/official-links/ip-safety.test.ts
git commit -m "feat: classify public verification addresses"
```

### Task 5: DNS Resolution and Destination Safety

**Files:**
- Create: `lib/verifiers/official-links/destination.ts`
- Create: `lib/verifiers/official-links/destination.test.ts`

**Interfaces:**
- Consumes: `SafeHttpUrl` from Task 3 and `NormalizedIpAddress`, `classifyIpAddress()` from Task 4.
- Produces:

```ts
export type LookupAddress = { address: string; family: 4 | 6 };
export type DestinationResolver = (
  hostname: string,
  options: { all: true; order: "verbatim" },
) => Promise<LookupAddress[]>;
export type ApprovedDestination = SafeHttpUrl & { selectedAddress: NormalizedIpAddress };
export type DestinationResult =
  | { ok: true; value: ApprovedDestination }
  | { ok: false; code: "dns_failure" | "timeout" | "unsafe_destination" };
export type ResolveSafeDestination = (
  target: SafeHttpUrl,
  signal?: AbortSignal,
) => Promise<DestinationResult>;
export function createSafeDestinationResolver(dependencies: {
  lookup: DestinationResolver; dnsDeadlineMs?: number;
}): ResolveSafeDestination;
```

- [ ] **Step 1: Write RED resolver tests**

Use an injected lookup spy to assert exact `{ all: true, order: "verbatim" }`. Cover public-only, unsafe-only, mixed public/private, duplicate normalized addresses, IPv4/IPv6 mixtures, zero results, malformed records, 16 and 17 results, rejection, 3-second timeout with a controlled clock, deterministic first-safe selection, and cancellation. Assert an IP literal is classified directly and never calls lookup.

- [ ] **Step 2: Run RED test**

Run: `npx vitest run lib/verifiers/official-links/destination.test.ts`

Expected: FAIL because the resolver module does not exist.

- [ ] **Step 3: Implement bounded all-address resolution**

Deduplicate normalized semantic addresses without reordering. Reject the whole destination if any address is invalid or unsafe. Select the first safe normalized address only after every result passes. Wrap lookup with an abort-aware 3-second deadline; a late resolution result must not start transport.

- [ ] **Step 4: Verify focused behavior and types**

Run: `npx vitest run lib/verifiers/official-links/destination.test.ts lib/verifiers/official-links/ip-safety.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Security and scope check**

Confirm mixed answers never degrade to selecting the public subset, the 16-address cap occurs before selection, and no request API or retry exists.

- [ ] **Step 6: Commit**

```bash
git add lib/verifiers/official-links/destination.ts lib/verifiers/official-links/destination.test.ts
git commit -m "feat: resolve safe verification destinations"
```

### Task 6: Request-Bound HTTP/HTTPS Transport

**Files:**
- Create: `lib/verifiers/official-links/transport.ts`
- Create: `lib/verifiers/official-links/transport.test.ts`

**Interfaces:**
- Consumes: `HttpMethod`, `VerificationAttempt` from Task 2; `ApprovedDestination` from Task 5; `ipAddressesEqual()` from Task 4.
- Produces:

```ts
export type TransportResponse = {
  kind: "response"; status: number; location: string | null;
  attempt: VerificationAttempt;
};
export type TransportFailure = {
  kind: "failure";
  code: "timeout" | "network_error" | "tls_error" | "unsafe_destination";
  attempt: VerificationAttempt;
};
export type NodeRequestFactory = (
  options: import("node:http").RequestOptions,
  callback: (response: import("node:http").IncomingMessage) => void,
) => import("node:http").ClientRequest;
export type RequestHeaders = (
  destination: ApprovedDestination,
  method: HttpMethod,
  options?: { deadlineMs?: number; signal?: AbortSignal },
) => Promise<TransportResponse | TransportFailure>;
export function createRequestHeaders(dependencies: {
  httpRequest: NodeRequestFactory; httpsRequest: NodeRequestFactory; now?: () => Date;
}): RequestHeaders;
export const requestHeaders: RequestHeaders;
```

- [ ] **Step 1: Write RED option/binding tests with injected Node request adapters**

Capture the options passed to HTTP and HTTPS request factories. Assert `hostname` and Host use the original normalized hostname, custom lookup returns only the approved IP/family, `autoSelectFamily` is false, `agent` is false, `maxHeaderSize` is 16 KiB, no proxy/env path exists, HTTPS `servername` is the original ASCII hostname, and `rejectUnauthorized` is true. Make any second resolver path throw so the test proves none occurs.

- [ ] **Step 2: Write RED socket lifecycle and body tests**

Simulate `connect`/`secureConnect`. Assert normalized IPv4, IPv6, and IPv4-mapped forms compare semantically; mismatch destroys the socket and returns `unsafe_destination`. Assert 8-second timeout/abort destroys request and socket. Emit response headers followed by body data and assert response is destroyed immediately with zero application `data` consumption or buffering.

- [ ] **Step 3: Run RED test**

Run: `npx vitest run lib/verifiers/official-links/transport.test.ts`

Expected: FAIL because transport does not exist.

- [ ] **Step 4: Implement the minimal Node transport**

Use only `node:http` and `node:https`. Build a custom lookup callback returning the approved address. Keep logical hostname and HTTPS servername unchanged. Listen for the connection event before trusting the response, normalize both remote and approved addresses, and destroy on mismatch. Resolve after response headers, capture only integer status and a bounded Location string, and immediately destroy the response.

- [ ] **Step 5: Verify transport and typecheck**

Run: `npx vitest run lib/verifiers/official-links/transport.test.ts lib/verifiers/official-links/destination.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Security and scope check**

Run: `rg -n "fetch|undici|Proxy|process\.env|resume\(|\.text\(|arrayBuffer|data\W" lib/verifiers/official-links/transport.ts`

Expected: no fetch/Undici/proxy/body-consumption path. Any `data` occurrence must not be a response listener or buffer. Confirm TLS verification is never disabled.

- [ ] **Step 7: Commit**

```bash
git add lib/verifiers/official-links/transport.ts lib/verifiers/official-links/transport.test.ts
git commit -m "feat: bind verification requests to safe addresses"
```

### Task 7: Manual Redirect Engine

**Files:**
- Create: `lib/verifiers/official-links/redirect.ts`
- Create: `lib/verifiers/official-links/redirect.test.ts`

**Interfaces:**
- Consumes: `VerificationAttempt`, `RedirectHop`, `TerminalOutcome`, `HttpMethod` from Task 2; `validateHttpUrl()` and `resolveRedirectLocation()` from Task 3; `ResolveSafeDestination` from Task 5; `RequestHeaders` from Task 6.
- Produces:

```ts
export type ExecuteRedirectChain = (
  originalExactUrl: string,
  method: HttpMethod,
  dependencies: {
    resolveDestination: ResolveSafeDestination;
    request: RequestHeaders;
    now: () => Date;
  },
  options?: { maxRedirects?: number; locationMaxLength?: number; signal?: AbortSignal },
) => Promise<TerminalOutcome>;
export const executeRedirectChain: ExecuteRedirectChain;
```

- [ ] **Step 1: Write RED status and Location tests**

Table-test that only 301/302/303/307/308 follow. Missing, multiple/ambiguous, malformed, or >2,048-character Location on those statuses returns `invalid_redirect`; 300 and 304 do not follow, do not require Location, and return terminal `http_result` with their status.

- [ ] **Step 2: Write RED per-hop safety tests**

Cover relative, absolute, and cross-host redirects; HTTP to HTTPS; forbidden HTTPS to HTTP; credential, unsupported-scheme, non-default-port, private, reserved, and mixed-DNS targets; canonical loop detection; five-redirect success; sixth-redirect `too_many_redirects`; and a spy proving URL validation, DNS/IP resolution, and request-bound transport run independently for every hop.

- [ ] **Step 3: Run RED test**

Run: `npx vitest run lib/verifiers/official-links/redirect.test.ts`

Expected: FAIL because redirect engine does not exist.

- [ ] **Step 4: Implement the manual redirect state machine**

Maintain a canonical visited set and runtime chain. Never use an automatic redirect option. Treat HTTPS downgrade as `protocol_downgrade`, unsafe target as its exact safe-result code, malformed Location as `invalid_redirect`, loops as `redirect_loop`, and excess as `too_many_redirects`. Persist no redirect here; return exact runtime chain only.

- [ ] **Step 5: Verify focused behavior and types**

Run: `npx vitest run lib/verifiers/official-links/redirect.test.ts lib/verifiers/official-links/url-safety.test.ts lib/verifiers/official-links/destination.test.ts lib/verifiers/official-links/transport.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Security and scope check**

Confirm no automatic redirect, no inherited destination approval, no HTTPS downgrade, and no unsafe/unreached target is assigned as a successful final URL.

- [ ] **Step 7: Commit**

```bash
git add lib/verifiers/official-links/redirect.ts lib/verifiers/official-links/redirect.test.ts
git commit -m "feat: verify redirects hop by hop"
```

### Task 8: HEAD / GET Verification Strategy

**Files:**
- Create: `lib/verifiers/official-links/verifier.ts`
- Create: `lib/verifiers/official-links/verifier.test.ts`

**Interfaces:**
- Consumes: `TerminalOutcome` from Task 2 and `ExecuteRedirectChain` from Task 7.
- Produces:

```ts
export type VerifyUrl = (
  exactUrl: string,
  dependencies: { executeChain: ExecuteRedirectChain },
  options?: { linkDeadlineMs?: number; signal?: AbortSignal },
) => Promise<TerminalOutcome>;
export const verifyUrl: VerifyUrl;
```

- [ ] **Step 1: Write RED HEAD decision tests**

Assert HEAD is always first. Table-test fallback only for terminal 400, 403, 404, 405, and 501. Assert no fallback for 2xx, 300/304, 401, 410, 429, 5xx, timeout, DNS failure, TLS failure, connection failure, unsafe destination, downgrade, loop, excess redirects, or invalid redirect.

- [ ] **Step 2: Write RED GET independence/deadline tests**

Assert GET restarts from the exact original URL, uses an independent redirect chain, inherits no HEAD destination approval, and uses the same safe engine. With fake timers, prove the combined HEAD/GET operation cannot exceed 20 seconds and aborts outstanding work.

- [ ] **Step 3: Run RED test**

Run: `npx vitest run lib/verifiers/official-links/verifier.test.ts`

Expected: FAIL because verifier does not exist.

- [ ] **Step 4: Implement minimal HEAD-first orchestration**

Execute HEAD, inspect only the terminal code/status, and conditionally execute GET from `exactUrl`. Return GET outcome when fallback occurs; otherwise return HEAD outcome. Combine attempt evidence without copying HEAD redirect trust into GET execution. Enforce one abortable 20-second link deadline.

- [ ] **Step 5: Verify strategy and typecheck**

Run: `npx vitest run lib/verifiers/official-links/verifier.test.ts lib/verifiers/official-links/redirect.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Security and scope check**

Confirm verifier cannot issue GET for statuses outside the exact fallback set and has no body API, retry, concurrency, or direct transport bypass.

- [ ] **Step 7: Commit**

```bash
git add lib/verifiers/official-links/verifier.ts lib/verifiers/official-links/verifier.test.ts
git commit -m "feat: add bounded HEAD and GET verification"
```

### Task 9: HTTP Result Classification

**Files:**
- Create: `lib/verifiers/official-links/classification.ts`
- Create: `lib/verifiers/official-links/classification.test.ts`

**Interfaces:**
- Consumes: `TerminalOutcome`, `LinkVerificationResult`, and `VerificationClassification` from Task 2.
- Produces:

```ts
export function classifyTerminalOutcome(outcome: TerminalOutcome): VerificationClassification;
export function createLinkVerificationResult(
  snapshot: LinkVerificationSnapshot,
  outcome: TerminalOutcome,
): LinkVerificationResult;
```

- [ ] **Step 1: Write RED exhaustive classification tests**

Cover every integer status from 200-599 by range plus explicit boundaries. Lock these exact cases: 2xx `verified`; 300/304 and all non-followed 3xx `reachable_but_unverified`; 401/403 `reachable_but_unverified`; 404/410 `broken`; 408/425/429 `temporarily_unavailable`; other 4xx `reachable_but_unverified`; 5xx `temporarily_unavailable`; invalid/missing redirect, loop, and excess redirects `broken`; downgrade/invalid URL/unsupported scheme/unsafe destination `unsafe`; timeout `temporarily_unavailable`; DNS/TLS/connection/unknown network `unknown`.

- [ ] **Step 2: Assert legacy status is unreachable**

Use an exhaustive TypeScript switch and a runtime assertion that no input produces `failed`, `unverified`, or `pending`. Assert ordinary 4xx/5xx returns a result instead of throwing.

- [ ] **Step 3: Run RED test**

Run: `npx vitest run lib/verifiers/official-links/classification.test.ts`

Expected: FAIL because classification functions do not exist.

- [ ] **Step 4: Implement pure classification**

Use explicit code-first classification for non-HTTP terminal outcomes, then exact status/range mapping for `http_result`. Reject impossible missing-status combinations as a sanitized internal invariant without exposing the raw outcome.

- [ ] **Step 5: Verify exhaustive mapping and types**

Run: `npx vitest run lib/verifiers/official-links/classification.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Security and scope check**

Confirm classification is pure, creates no network/DB side effect, and cannot emit legacy `failed`.

- [ ] **Step 7: Commit**

```bash
git add lib/verifiers/official-links/classification.ts lib/verifiers/official-links/classification.test.ts
git commit -m "feat: classify official link verification results"
```

### Task 10: D1 Read Model and Verification Planner

**Files:**
- Create: `lib/db/repositories/link-verification.ts`
- Create: `lib/db/repositories/link-verification.test.ts`
- Create: `lib/verifiers/official-links/plan.ts`
- Create: `lib/verifiers/official-links/plan.test.ts`

**Interfaces:**
- Consumes: Task 2 snapshot/result/plan/update contracts and Task 9 `createLinkVerificationResult()`.
- Produces:

```ts
export type LinkVerificationStore = {
  readGameLinks(gameId: number): Promise<{
    gameExists: boolean; links: LinkVerificationSnapshot[];
  }>;
};
export function createLinkVerificationStore(db: ReturnType<typeof createDatabase>): LinkVerificationStore;
export function planGameLinkVerification(input: {
  gameId: number; dryRun: boolean; snapshots: LinkVerificationSnapshot[];
  results: LinkVerificationResult[]; now: Date;
}): GameLinkVerificationPlan;
```

- [ ] **Step 1: Write RED bounded snapshot-read tests**

Use local D1 to assert missing/existing game distinction, zero links, deterministic link order by ID, and exact loading of ID, game ID, exact URL, updated time, status, method, HTTP status, redirect URL, verified time, and checked time. Assert no write occurs.

- [ ] **Step 2: Write RED planner ownership/field tests**

For a manual row, assert runtime result remains present but plan action is `skip/manual_verification_preserved` and every metadata field is untouched. For `provider_api`, `http`, and null methods, assert update sets only status, method `http`, HTTP status, final successful safe redirect URL or null, checked time, verified time, and updated time. A verified result refreshes `verifiedAt`; all other classifications preserve the historical value. Assert no update object can carry URL/provider/platform/link type/region/official fields.

- [ ] **Step 3: Run RED tests**

Run: `npx vitest run lib/db/repositories/link-verification.test.ts lib/verifiers/official-links/plan.test.ts`

Expected: FAIL because store and planner do not exist.

- [ ] **Step 4: Implement read model and pure planner**

Read one canonical game and links in stable ID order. Build update objects from exact result mapping. Produce `no_metadata_change` only when all writable values, including timestamp policy, are intentionally unchanged. Do not enforce the 20-link network guard in the repository; Task 12 owns that pre-network decision.

- [ ] **Step 5: Verify focused behavior and types**

Run: `npx vitest run lib/db/repositories/link-verification.test.ts lib/verifiers/official-links/plan.test.ts lib/verifiers/official-links/classification.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Security and scope check**

Inspect Drizzle selections and plan update keys. Confirm exact URL stays internal, manual rows never produce updates, and no relationship/create/delete operation exists.

- [ ] **Step 7: Commit**

```bash
git add lib/db/repositories/link-verification.ts lib/db/repositories/link-verification.test.ts lib/verifiers/official-links/plan.ts lib/verifiers/official-links/plan.test.ts
git commit -m "feat: plan official link verification updates"
```

### Task 11: Optimistic Concurrency and Local D1 Write

**Files:**
- Modify: `lib/db/repositories/link-verification.ts`
- Modify: `lib/db/repositories/link-verification.test.ts`

**Interfaces:**
- Consumes: `GameLinkVerificationPlan`, `LinkVerificationSnapshot`, and `LinkVerificationUpdate` from Task 2.
- Extends `LinkVerificationStore` with:

```ts
writePlan(plan: GameLinkVerificationPlan): Promise<{
  affectedRows: number;
  appliedLinkIds: number[];
  conflicts: WriteConflict[];
}>;
```

- [ ] **Step 1: Write RED conditional-update tests**

Assert each update binds `id`, `game_id`, exact `url`, `updated_at`, `verification_status`, `verification_method`, `http_status`, `redirect_url`, `verified_at`, and `last_checked_at` using null-safe predicates. Race URL A to URL B, method to manual, each metadata field, deletion, and move to another game; every stale update must affect zero rows and leave the changed row untouched.

- [ ] **Step 2: Write RED batch-semantics tests**

Create one current and one stale snapshot in one plan. Assert the current update commits, stale update returns `write_conflict`, total status can become `partially_applied`, and no claim of rollback is made. Inject a true SQL execution failure and assert the D1 batch rejects/rolls back as `write_failed`. Assert affected rows greater than 1 becomes a sanitized invariant failure.

- [ ] **Step 3: Run RED tests**

Run: `npx vitest run lib/db/repositories/link-verification.test.ts`

Expected: FAIL because writePlan is absent.

- [ ] **Step 4: Implement one conditional-update batch**

Create one Drizzle UPDATE per `action: update`, with exactly the approved seven metadata/timestamp values and complete snapshot predicates. Submit through one D1 batch. Interpret result metadata per statement: 1 applied, 0 conflict, greater than 1 invariant failure. Only SQL execution failure is a batch failure; zero-row conditional updates are not errors and do not roll back valid siblings.

- [ ] **Step 5: Verify concurrency behavior and types**

Run: `npx vitest run lib/db/repositories/link-verification.test.ts lib/verifiers/official-links/plan.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Security and scope check**

Assert generated update values contain only `verificationStatus`, `verificationMethod`, `httpStatus`, `redirectUrl`, `verifiedAt`, `lastCheckedAt`, and `updatedAt`. Confirm D1 errors are mapped to `write_failed` without SQL text.

- [ ] **Step 7: Commit**

```bash
git add lib/db/repositories/link-verification.ts lib/db/repositories/link-verification.test.ts
git commit -m "feat: write link verification optimistically"
```

### Task 12: Verification Service and Global Deadlines

**Files:**
- Create: `lib/verifiers/official-links/service.ts`
- Create: `lib/verifiers/official-links/service.test.ts`
- Create: `lib/verifiers/official-links/input.ts`
- Create: `lib/verifiers/official-links/input.test.ts`

**Interfaces:**
- Consumes: `LinkVerificationStore` from Tasks 10-11, `VerifyUrl` from Task 8, `createLinkVerificationResult()` from Task 9, and `planGameLinkVerification()` from Task 10.
- Produces:

```ts
export function normalizeCanonicalGameId(input: string | number): number;
export type LinkVerificationService = {
  verifyGame(gameId: number, options?: { dryRun?: boolean }): Promise<GameLinkVerificationResult>;
};
export function createLinkVerificationService(dependencies: {
  store: LinkVerificationStore; verifyUrl: VerifyUrl; now?: () => Date;
}): LinkVerificationService;
```

- [ ] **Step 1: Write RED input and pre-network guard tests**

Test positive safe integers and reject zero, negative, fractional, nonnumeric, whitespace-only, and unsafe integers with `invalid_game_id`. Assert missing game yields `game_not_found`. Seed 21 links and prove `link_limit_exceeded` occurs before the verify URL spy is called; 20 proceeds.

- [ ] **Step 2: Write RED sequential/deadline/dry-run tests**

Assert links execute in stable snapshot order with maximum observed concurrency 1. Use fake timers to enforce a five-minute game deadline across all links. In dry-run, perform real injected verification and planning but never call `writePlan`; affected rows and conflicts remain zero.

- [ ] **Step 3: Write RED write-result tests**

Assert write uses the identical verification pipeline, calls `writePlan` once, and maps outcomes to `applied`, `partially_applied`, or `no_changes` using applied/conflict counts. Assert one link's unsafe/broken/unknown result does not stop later links, while operation-level database/platform errors do.

- [ ] **Step 4: Run RED tests**

Run: `npx vitest run lib/verifiers/official-links/input.test.ts lib/verifiers/official-links/service.test.ts`

Expected: FAIL because service/input modules do not exist.

- [ ] **Step 5: Implement single-game service**

Pipeline exactly: normalize ID → read game/links → existence check → 20-link guard → sequential verify/classify → plan → dry-run return or one write → result. Compose per-link 20-second behavior from Task 8 and enforce one abortable five-minute parent deadline. Do not retry.

- [ ] **Step 6: Verify service and typecheck**

Run: `npx vitest run lib/verifiers/official-links/input.test.ts lib/verifiers/official-links/service.test.ts lib/verifiers/official-links/verifier.test.ts lib/verifiers/official-links/plan.test.ts lib/db/repositories/link-verification.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Security and scope check**

Confirm link-limit rejection precedes DNS/HTTP, dry-run cannot reach writes, concurrency cannot exceed 1, and every per-link result remains non-throwing.

- [ ] **Step 8: Commit**

```bash
git add lib/verifiers/official-links/service.ts lib/verifiers/official-links/service.test.ts lib/verifiers/official-links/input.ts lib/verifiers/official-links/input.test.ts
git commit -m "feat: orchestrate single-game link verification"
```

### Task 13: Local-Only CLI and Presentation Boundary

**Files:**
- Create: `scripts/verify-official-links.ts`
- Create: `scripts/verify-official-links.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `normalizeCanonicalGameId()` and `createLinkVerificationService()` from Task 12; `createLinkVerificationStore()` from Task 10; `verifyUrl()` from Task 8; `presentGameLinkVerificationResult()` from Task 3; `LinkVerificationError` from Task 2.
- Produces:

```ts
export type VerifyOfficialLinksCliArgs = { gameId: number; write: boolean; json: boolean };
export type LinkVerificationPlatform = {
  env: { DB: AnyD1Database }; dispose(): Promise<void> | void;
};
export type VerifyOfficialLinksCliDependencies = {
  platformFactory(): Promise<LinkVerificationPlatform>;
  serviceFactory(database: AnyD1Database): LinkVerificationService;
  present(result: GameLinkVerificationResult): PresentedGameLinkVerificationResult;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
};
export function parseVerifyOfficialLinksArgs(argv: string[]): VerifyOfficialLinksCliArgs;
export function createLocalLinkVerificationPlatform<Platform>(
  getPlatformProxy: (options: GetPlatformProxyOptions) => Promise<Platform>,
): Promise<Platform>;
export function runVerifyOfficialLinksCli(
  args: VerifyOfficialLinksCliArgs,
  dependencies: VerifyOfficialLinksCliDependencies,
): Promise<number>;
```

- [ ] **Step 1: Write RED parser/local-only tests**

Test exactly one positive ID, default dry-run, `--write`, `--json`, both flag orders, duplicate flags, missing/multiple IDs, and unknown flags. Explicitly reject `--remote`, `--env`, `-e`, `--config`, `--database-id`, `--url`, and `--name=value` variants without echoing their values. Assert platform options use the fixed repository config, `persist: true`, and `remoteBindings: false`.

- [ ] **Step 2: Write RED presentation and exit-code tests**

Pass results containing unique secrets in original DB URL, attempts, redirect Location/resolved URL, final URL, and plan. Assert neither complete human nor JSON output contains secret values, username/password, fragment, raw DNS/TLS/D1 errors, certificate material, stack, or environment values. Assert the CLI never serializes internal DTO directly. Return 0 when verification completes with broken/unsafe/unknown; return 1 for operation failure, cleanup failure, write failure, or write conflict while preserving sanitized applied/conflict counts in JSON.

- [ ] **Step 3: Run RED CLI test**

Run: `npx vitest run scripts/verify-official-links.test.ts`

Expected: FAIL because CLI and script do not exist.

- [ ] **Step 4: Implement fixed-local composition and script**

Add `"links:verify": "tsx scripts/verify-official-links.ts"`. Compose Wrangler local D1, repository, Node DNS destination resolver, Node transport, redirect engine, verifier, classifier, planner, and service. Route all success output through `presentGameLinkVerificationResult`; route errors through constant sanitized messages/`LinkVerificationError.toJSON()`.

- [ ] **Step 5: Verify CLI and typecheck**

Run: `npx vitest run scripts/verify-official-links.test.ts lib/verifiers/official-links/presentation.test.ts lib/verifiers/official-links/service.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Security and scope check**

Run: `git diff -- package.json package-lock.json scripts/verify-official-links.ts`

Expected: package.json has only the new script; package-lock is unchanged; no remote/proxy/custom-config path and no direct serialization of internal DTO exists.

- [ ] **Step 7: Commit**

```bash
git add scripts/verify-official-links.ts scripts/verify-official-links.test.ts package.json
git commit -m "feat: add local official link verification CLI"
```

### Task 14: Documentation, Full Regression, Security Review, and Merge Gate

**Files:**
- Modify: `README.md`
- Create: `.superpowers/sdd/2026-09-04-gamehub-v2-5-official-link-verification/task-14-report.md`

**Interfaces:**
- Consumes: complete V2.5 CLI and all prior task verification evidence.
- Produces: operator documentation, exact final verification evidence, new schema SHA-1 baseline, and a Critical/Important merge-readiness verdict.

- [ ] **Step 1: Write RED README assertions**

Add documentation assertions to `scripts/verify-official-links.test.ts` requiring README coverage of purpose, dry-run, `--write`, fixed local D1, SSRF all-hop checks, default ports, HTTPS downgrade rejection, statuses, manual preservation, sanitized URL output, no remote/Cron/link mutation, and all four CLI examples.

- [ ] **Step 2: Run RED documentation test**

Run: `npx vitest run scripts/verify-official-links.test.ts`

Expected: FAIL because README lacks V2.5 documentation.

- [ ] **Step 3: Add bounded operator documentation**

Document exact commands, limits, classifications, dry-run/write behavior, local-only boundary, URL-output redaction, manual precedence, and that verification marks metadata without creating, deleting, replacing, or discovering links.

- [ ] **Step 4: Run focused verification**

Run: `npx vitest run lib/verifiers/official-links scripts/verify-official-links.test.ts test/migrations/official-link-status.test.ts lib/db/repositories/link-verification.test.ts`

Expected: PASS. Record exact file/test counts.

- [ ] **Step 5: Run full regression and build gates**

Run each command independently and record exit status/output summary:

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

Expected: tests/typecheck/lint/build/local D1 checks/diff check pass; migration count is 3. Record audit results exactly without running an audit fix or changing dependencies.

- [ ] **Step 6: Verify migration and immutable dependency boundaries**

Compare the V2.5 branch against base `0b1a7d21b4e327634439f04f9c4bf3ab9bd9b60f`. Record:

```bash
find drizzle -maxdepth 1 -name '*.sql' | sort
git diff --exit-code 0b1a7d21b4e327634439f04f9c4bf3ab9bd9b60f -- package-lock.json
git diff 0b1a7d21b4e327634439f04f9c4bf3ab9bd9b60f -- package.json
shasum lib/db/schema.ts
```

Expected: three migrations, package-lock unchanged, package.json dependency/devDependency blocks unchanged with only `links:verify` added, and a newly recorded V2.5 schema SHA-1. Run fresh-DB and upgraded-DB migration tests and record clean `PRAGMA foreign_key_check`.

- [ ] **Step 7: Record V2.2/V2.3/V2.4 regression evidence**

Run focused existing suites for Steam import, Steam search, and IGDB enrichment in addition to the full suite. Record exact pass counts and confirm their CLI commands and ownership behavior remain unchanged.

- [ ] **Step 8: Execute scoped final security review**

Review the branch diff against the Spec and explicitly answer all 22 gates:

1. 16-column migration preservation
2. application/SQLite status parity
3. custom lookup socket binding
4. no second DNS resolution
5. mixed public/unsafe DNS fail closed
6. normalized `remoteAddress` comparison
7. Host/SNI preservation
8. TLS verification enabled
9. every redirect hop revalidated
10. HTTPS downgrade blocked
11. 300/304 not redirects
12. GET zero body consumption
13. manual verification preserved
14. stale URL cannot receive old result
15. `partially_applied` semantics accurate
16. URL query secrets sanitized
17. malformed URL never echoed
18. no raw network/D1/stack leakage
19. no proxy path
20. no remote D1
21. no normal-fetch fallback
22. no new production dependency

Classify findings as Critical, Important, or Minor. Merge-ready requires Critical = 0 and Important = 0.

- [ ] **Step 9: Write the final report**

Populate `task-14-report.md` with commands, exact test counts, migration count 3, fresh/upgraded DB results, foreign-key check, schema SHA-1, dependency/lock diff, audits, regression evidence, 22-gate review, and the merge verdict. Do not suppress a failed gate.

- [ ] **Step 10: Commit documentation and final evidence**

```bash
git add README.md scripts/verify-official-links.test.ts .superpowers/sdd/2026-09-04-gamehub-v2-5-official-link-verification/task-14-report.md
git commit -m "docs: document V2.5 link verification"
```

- [ ] **Step 11: Confirm final clean state**

Run: `git status --short`

Expected: no output. Stop before push, PR creation, or merge unless the user separately authorizes those actions.
