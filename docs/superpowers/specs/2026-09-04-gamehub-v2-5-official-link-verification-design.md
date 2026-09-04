# GameHub V2.5 Official Link Verification Design

## Goal

Add a safe, repeatable, local-only HTTP verification workflow for links that already exist in `game_official_links`. V2.5 verifies one existing canonical game's bounded link set, classifies each result, produces a dry-run plan, and optionally updates only the verification metadata supported by the schema.

V2.5 does not discover, create, delete, replace, or rewrite links. It does not change `provider`, `platform`, `link_type`, `url`, `region`, or `is_official`. It does not implement remote D1 writes, Cron, whole-database scans, an Admin UI, browser automation, HTML scraping, R2, or provider-specific network verification.

## Non-Negotiable Boundaries

- Input identifies exactly one existing canonical game.
- Only links already stored for that game are verified.
- Default execution is dry-run. Dry-run performs real DNS and HTTP requests but zero D1 mutations.
- `--write` targets the fixed local D1 configuration only.
- At most 20 links are accepted for one run, and links are verified sequentially with concurrency 1.
- The transport uses `node:http` and `node:https`, never ordinary `fetch`.
- Every request hop binds the socket to an IP that was classified as safe for that exact hop.
- Every redirect hop repeats URL, hostname, DNS, and IP validation before a connection is opened.
- A DNS answer containing any unsafe address is rejected even if it also contains public addresses.
- Only default ports are allowed: 80 for HTTP and 443 for HTTPS.
- HTTP to HTTPS redirects are allowed. HTTPS to HTTP redirects are forbidden.
- GET fallback consumes zero application body bytes.
- Manual verification metadata is never overwritten.
- Optimistic compare-before-update prevents a result for URL A from being written to a row that has changed to URL B.
- Exact URLs remain internal for requests and concurrency checks. All CLI human and JSON output passes through URL sanitization.
- No production dependency is added.

## Current Schema and Required Migration

`game_official_links` currently has 16 columns:

1. `id`
2. `game_id`
3. `provider`
4. `platform`
5. `link_type`
6. `url`
7. `region`
8. `is_official`
9. `verification_status`
10. `verification_method`
11. `http_status`
12. `redirect_url`
13. `verified_at`
14. `last_checked_at`
15. `created_at`
16. `updated_at`

The current verification fields are `verification_status`, `verification_method`, `http_status`, `redirect_url`, `verified_at`, and `last_checked_at`. The existing CHECK constraints allow:

- `verification_status`: `unverified`, `pending`, `verified`, `failed`
- `verification_method`: `NULL`, `manual`, `http`, `provider_api`
- `http_status`: `NULL` or an integer from 100 through 599
- `link_type`: `official_website`, `store`, `purchase`, `download`, `demo`, `launcher`

The status constraint must add:

- `reachable_but_unverified`
- `broken`
- `temporarily_unavailable`
- `unsafe`
- `unknown`

`failed` remains legal only for legacy compatibility. The V2.5 verifier should not produce it.

`lib/db/schema.ts` and `lib/db/validation.ts` must accept the same nine status values. Updating only the SQLite CHECK constraint is incomplete.

### Migration Procedure

SQLite cannot directly alter an existing CHECK constraint, so the migration rebuilds only `game_official_links`:

1. Defer foreign-key enforcement for the migration transaction using the D1-supported pragma.
2. Create a temporary replacement table with the same 16 columns, types, nullability, defaults, primary key, foreign key, and four CHECK constraints. Only the status CHECK changes.
3. Copy data using this explicit 16-column list on both the destination and source sides: `id, game_id, provider, platform, link_type, url, region, is_official, verification_status, verification_method, http_status, redirect_url, verified_at, last_checked_at, created_at, updated_at`. `SELECT *` is forbidden.
4. Drop the old table and rename the replacement.
5. Recreate the unique index on `(game_id, url)`.
6. Recreate the ordinary indexes on `(game_id, link_type)` and `(verification_status, last_checked_at)`.
7. Run foreign-key and row-count/data-preservation checks.
8. Restore deferred foreign-key behavior.

Migration verification must prove that all 16 columns and their values are preserved; defaults, primary key, foreign key, unique index, ordinary indexes, and all four CHECK constraints remain present; and only the status CHECK is expanded. Existing verification metadata, including legacy `failed` rows, must survive unchanged.

The migration count changes from 2 to 3. The schema SHA-1 is expected to change and the merged V2.5 tree will establish a new stable schema hash baseline. No other schema object may change.

## Verification Scope

The public workflow is one canonical game per invocation. Internally, each link is an independent verification and classification unit.

```text
canonical game ID
  -> load existing game and link snapshot from local D1
  -> reject before networking if link count exceeds 20
  -> verify each link sequentially
  -> classify per-link outcomes
  -> build one game-level plan
  -> return dry-run result, or execute one local D1 batch
  -> report applied and conflicted rows per link
```

A single-link verifier remains an internal interface for isolation and tests. V2.5 does not expose a link-ID CLI because the canonical game is the established operator-facing scope and provides a bounded, reviewable unit.

## SSRF Threat Model

The workflow must prevent connections to local or non-public services through direct input, alternate address encodings, DNS, redirects, or races. Threats include:

- loopback, RFC1918, link-local, CGNAT, multicast, unspecified, reserved, benchmark, documentation, and other special-use IPv4 ranges;
- IPv6 loopback, unspecified, ULA, link-local, multicast, transition, translation, documentation, benchmark, and other special-use ranges;
- IPv4-mapped IPv6 addresses that embed a blocked IPv4 address;
- cloud and container metadata endpoints, including addresses within link-local and CGNAT space;
- `localhost`, local-name suffixes, hostname case/trailing-dot variants, and IDN/punycode variants;
- DNS answers containing both public and unsafe destinations;
- DNS rebinding between a preflight lookup and socket connection;
- a safe initial URL redirecting to an unsafe destination;
- protocol downgrade, redirect loops, malformed redirects, and unbounded chains;
- non-default ports that could expose arbitrary services;
- response header/body resource exhaustion;
- sensitive URL material leaking through logs or serialized results;
- a database row changing while its old URL is being verified.

The policy is fail closed: a destination is connectable only when every observed address is explicitly classified as public and safe.

## URL and Hostname Safety

URLs are parsed with the WHATWG `URL` implementation. Internal parsing and request execution preserve the exact stored URL semantics required for HTTP and optimistic concurrency, while safety decisions use a canonical representation.

- Allow only `http:` and `https:`.
- Reject username or password components.
- Lowercase and convert hostnames to their ASCII/IDN representation.
- Remove one terminal root-label dot before policy checks.
- Reject an empty hostname, a single-label hostname, `localhost`, and subdomains of `localhost`.
- Reject local/special suffixes including `.local`, `.internal`, and `.home.arpa`.
- Reject non-public reserved-name suffixes such as `.test`, `.invalid`, and `.example`.
- Permit only an absent/default port, 80 for HTTP, or 443 for HTTPS.
- Never send or emit fragments.
- Limit stored/request URLs and redirect `Location` values to 2,048 characters.

An IP literal bypasses DNS but goes through the same IP classifier. URL normalization must not rewrite the database `url` column.

## IP Classifier and DNS Strategy

The IP classifier is pure and deterministic. It normalizes textual representations before applying CIDR policy and before comparing the selected address with `socket.remoteAddress`.

### IPv4

The deny table includes every IPv4 special-purpose block from the implementation's pinned IANA registry snapshot, plus multicast and any reserved/unallocated ranges required to enforce public-only reachability. It necessarily covers:

- unspecified/current-network space;
- loopback;
- RFC1918;
- link-local;
- CGNAT/shared address space;
- protocol assignments;
- documentation and benchmarking ranges;
- multicast;
- reserved/future-use space;
- limited broadcast;
- metadata endpoints contained by those ranges.

The implementation must not rely only on a generic `PRIVATE_RANGES` list.

### IPv6

The deny table includes the IANA IPv6 special-purpose registry and explicitly covers loopback, unspecified, ULA, link-local, multicast, documentation, discard-only, benchmarking, ORCHID, and transition/translation mechanisms. The conservative allow policy is global-unicast space that is not covered by any denied special-use block.

IPv4-mapped IPv6 is normalized, its embedded 32-bit IPv4 value is extracted, and the full IPv4 policy is applied. This rule also applies when comparing the connected socket address with the selected address.

### DNS

For a hostname, resolve all addresses with `dns.lookup(hostname, { all: true, order: "verbatim" })`, normalize and deduplicate them, and enforce a maximum of 16 results.

- No results produce `dns_failure`.
- Any malformed or unclassifiable result fails closed.
- Any unsafe result makes the entire destination unsafe.
- A mixture of public and unsafe addresses is unsafe.
- If all results are safe, select the first normalized address in resolver order deterministically.

The DNS operation has a 3-second deadline. A timed-out resolution is ignored if it later completes; it cannot trigger a request.

## Request-Bound HTTP Transport

The actual request uses `node:http` or `node:https`; ordinary `fetch` is forbidden. Each request hop supplies a custom `lookup` callback that returns only the already-resolved and approved address. The socket therefore cannot perform a second uncontrolled DNS resolution.

Request options include:

- the normalized original hostname as `hostname` and Host authority;
- the selected safe address and family through custom `lookup`;
- `autoSelectFamily: false`;
- `agent: false` so every hop has an independent connection;
- `maxHeaderSize: 16 KiB`;
- no request body;
- `rejectUnauthorized: true` for HTTPS;
- the original normalized ASCII hostname as HTTPS `servername` for DNS hostnames.

For an HTTPS IP literal, no DNS SNI name is invented; normal certificate validation applies to the IP identity. Custom lookup changes only the destination address. It must not replace the logical hostname used by Host, SNI, or TLS hostname validation.

On `connect` or `secureConnect`, both `socket.remoteAddress` and the selected address are passed through the same IP normalization routine. The normalized values must match exactly, including equivalent IPv4-mapped IPv6 forms. A mismatch destroys the socket before the response is trusted and produces `unsafe_destination`.

No proxy environment variables are honored. Requests, responses, sockets, timers, and one-use agents are destroyed or released on every terminal path.

## Redirect Safety

Only status codes 301, 302, 303, 307, and 308 enter redirect handling. Each such response must contain exactly one usable `Location` value. Relative locations resolve against the current exact URL.

For every redirect target, the workflow repeats URL parsing, hostname policy, DNS resolution, all-address classification, address selection, request-bound lookup, socket-address assertion, and request execution. A previous safe hop grants no trust to the next hop.

- Permit same-protocol redirects.
- Permit HTTP to HTTPS upgrades.
- Forbid HTTPS to HTTP downgrade and classify it as `unsafe`.
- Permit cross-host redirects only after the complete new-hop safety check.
- Detect loops using canonical URL identity.
- Permit at most five redirects, for no more than six total hops.
- Missing or malformed `Location` on 301/302/303/307/308 produces `invalid_redirect` and classification `broken`.
- A redirect to an unsupported scheme, credential-bearing URL, blocked port, or unsafe address produces `unsafe`.

Other 3xx responses, including 300 and 304, do not enter redirect handling, do not require `Location`, are not followed, and classify as `reachable_but_unverified`.

The complete redirect chain remains runtime-only. `redirect_url` stores only a successfully reached final safe URL when at least one redirect occurred. Unsafe or unresolved redirect targets are never persisted as `redirect_url`.

## HEAD and Bounded GET Strategy

Verification starts with HEAD. HEAD follows only the explicitly supported redirect statuses under the full redirect policy.

Fallback to GET when the terminal HEAD status is 400, 403, 404, 405, or 501. These statuses are common false negatives for sites that block or do not implement HEAD. GET starts again from the exact original stored URL and builds an independent redirect chain; it does not begin at or inherit trust from the terminal HEAD URL. Do not fallback after HEAD 2xx, 401, 410, 429, 5xx, a network failure, a timeout, a TLS failure, or any unsafe/invalid redirect outcome.

GET uses the same redirect and SSRF pipeline. It waits only until response headers arrive, records the status and allowed headers, and immediately destroys the response. It never calls a body-consuming API and consumes zero application body bytes. It does not use Range by default because Range changes semantics on some store and download endpoints.

Installer, store, purchase, and download URLs receive the same bounded behavior; their payloads are never downloaded.

## Classification and Database Mapping

| Terminal result | Runtime/DB status |
| --- | --- |
| Final 2xx, including 204 and 206 | `verified` |
| 301/302/303/307/308 with missing or malformed `Location` | `broken` (`invalid_redirect`) |
| Other 3xx, including 300 and 304 | `reachable_but_unverified`; do not follow |
| 401 or 403 after any allowed fallback | `reachable_but_unverified` |
| 404 or 410 after any allowed fallback | `broken` |
| 408, 425, or 429 | `temporarily_unavailable` |
| Other 4xx | `reachable_but_unverified` |
| 5xx | `temporarily_unavailable` |
| Timeout | `temporarily_unavailable` |
| Invalid URL, unsupported scheme, credentials, blocked port, unsafe IP, mixed DNS, or HTTPS downgrade | `unsafe` |
| Redirect loop or redirect limit exceeded | `broken` |
| DNS, TLS, connection, or unclassified network failure | `unknown` |

Ordinary HTTP statuses and expected per-link failures are results, not exceptions, and do not stop verification of the remaining links.

For an approved non-manual update:

- `verification_status` receives the classification above.
- `verification_method` becomes `http`.
- `http_status` receives the terminal response status, or `NULL` when no valid response was reached.
- `redirect_url` receives the final successfully reached safe URL after a redirect, otherwise `NULL`.
- `last_checked_at` receives the completion time.
- `verified_at` receives the completion time only for `verified`; a non-verified outcome preserves any historical successful timestamp.
- `updated_at` changes only when verification metadata changes.

The verifier never writes legacy `failed`.

### Verification Ownership

`provider_api` is a provider assertion; it does not imply current HTTP reachability. A completed HTTP check may replace non-manual provider verification metadata with method `http` because the fields describe the latest stored verification result.

`manual` has precedence. A manual row may still be checked during dry-run or write execution so the operator can see its runtime result, but its plan item is `skip: manual_verification_preserved`, and none of its verification metadata is written.

## Dry-Run, Write, and Concurrency

Dry-run and write share the same read, safety, network, classification, and planning pipeline. The only difference is whether the approved plan reaches the persistence boundary.

The local D1 snapshot records each link's `id`, `game_id`, exact `url`, `updated_at`, and all six writable verification fields. Each UPDATE binds at least:

- link ID;
- game ID;
- exact original URL;
- snapshot `updated_at`;
- snapshot verification status, method, HTTP status, redirect URL, verified time, and checked time.

If the link is deleted, moved, changed from URL A to URL B, manually verified, or otherwise updated during network verification, the conditional UPDATE affects zero rows and becomes `write_conflict`. A stale result is never applied to the changed row.

All approved link updates are submitted in one local D1 batch. Each link remains an independent outcome: valid conditional updates may apply while a conflicted link remains unchanged. The result must distinguish `applied`, `partially_applied`, `no_changes`, and per-link conflicts rather than claiming all-or-nothing success.

No URL, ownership, identity, or relationship field is included in the update values.

## Resource Limits

- Links per game: 20 maximum; enforce before DNS or HTTP.
- Concurrency: 1.
- DNS result count: 16 maximum per hop.
- DNS deadline: 3 seconds.
- Request-to-headers deadline: 8 seconds per attempt.
- Total deadline: 20 seconds per link across HEAD, redirect handling, and optional GET.
- Total game deadline: 5 minutes.
- Redirects: 5 maximum.
- Response headers: 16 KiB maximum.
- GET body consumption: 0 application bytes.
- Request body: none.
- URL and Location: 2,048 characters maximum.
- Automatic retries: none.

## Runtime DTOs

```ts
type VerificationStatus =
  | "unverified"
  | "pending"
  | "verified"
  | "failed"
  | "reachable_but_unverified"
  | "broken"
  | "temporarily_unavailable"
  | "unsafe"
  | "unknown";

type NewVerificationClassification = Exclude<
  VerificationStatus,
  "unverified" | "pending" | "failed"
>;

type VerificationCode =
  | "http_result"
  | "invalid_url"
  | "unsupported_scheme"
  | "unsafe_destination"
  | "dns_failure"
  | "timeout"
  | "network_error"
  | "tls_error"
  | "redirect_loop"
  | "too_many_redirects"
  | "invalid_redirect"
  | "protocol_downgrade";

type VerificationAttempt = {
  method: "HEAD" | "GET";
  url: string;
  resolvedAddress: string | null;
  addressFamily: 4 | 6 | null;
  httpStatus: number | null;
  startedAt: Date;
  finishedAt: Date;
};

type RedirectHop = {
  fromUrl: string;
  status: 301 | 302 | 303 | 307 | 308;
  location: string;
  resolvedUrl: string | null;
};

type LinkVerificationResult = {
  linkId: number;
  gameId: number;
  originalUrl: string;
  classification: NewVerificationClassification;
  code: VerificationCode;
  attempts: VerificationAttempt[];
  redirectChain: RedirectHop[];
  finalUrl: string | null;
  httpStatus: number | null;
  checkedAt: Date;
};
```

These internal DTOs preserve exact URLs for request execution, diagnostics, plan construction, and compare-before-update. They never contain response bodies, URL passwords, raw TLS certificate data, environment values, raw DNS/D1 errors, or stacks.

## Plan and Operation Result

```ts
type LinkVerificationPlanItem =
  | {
      action: "update";
      linkId: number;
      gameId: number;
      originalUrl: string;
      expectedUpdatedAt: Date;
      expectedVerification: VerificationSnapshot;
      changes: {
        verificationStatus: NewVerificationClassification;
        verificationMethod: "http";
        httpStatus: number | null;
        redirectUrl: string | null;
        lastCheckedAt: Date;
        verifiedAt?: Date;
      };
    }
  | {
      action: "skip";
      linkId: number;
      originalUrl: string;
      reason: "manual_verification_preserved" | "no_metadata_change";
    };

type GameLinkVerificationPlan = {
  gameId: number;
  dryRun: boolean;
  linksRead: number;
  verificationResults: LinkVerificationResult[];
  items: LinkVerificationPlanItem[];
};

type GameLinkVerificationResult = {
  gameId: number;
  dryRun: boolean;
  status: "planned" | "applied" | "partially_applied" | "no_changes";
  plan: GameLinkVerificationPlan;
  affectedRows: number;
  conflicts: Array<{ linkId: number; code: "write_conflict" }>;
};
```

## Presentation-Boundary URL Sanitization

Internal transport, verifier, planner, and persistence objects retain exact URLs. Sanitization occurs only when constructing CLI human or JSON presentation objects.

The sanitizer reparses every emitted URL, removes username/password and fragment, and replaces the value of sensitive query keys with `[REDACTED]`. Key matching is ASCII case-insensitive and includes at least:

- `token`
- `access_token`
- `auth`
- `authorization`
- `key`
- `api_key`
- `apikey`
- `signature`
- `sig`
- `secret`
- `credential`
- `x-amz-signature`
- `x-amz-credential`

The sanitizer applies recursively and explicitly to:

- original DB URL;
- each attempt URL;
- redirect `Location` and resolved URL;
- `redirectChain`;
- `finalUrl`;
- plan item URL fields;
- human output;
- JSON output;
- error presentation that includes a URL.

Malformed URLs must use a conservative redaction fallback rather than returning the original string. No presentation path may serialize the internal DTO directly. The literal secret values must be absent from the entire rendered output, not merely from known object properties.

Resolved IPs are operational data rather than credentials, but human output should omit them by default. JSON may include normalized public resolved addresses for local diagnostics; unsafe addresses should be represented by classification/code rather than echoed unless a later explicit diagnostic design permits them.

## Error Model

Expected per-link outcomes do not abort the game:

- invalid URL or scheme;
- unsafe destination or downgrade;
- DNS, timeout, TLS, connection, or generic network failure;
- invalid redirect, loop, or limit;
- any ordinary HTTP response.

Typed operation-level errors may abort the run:

- `invalid_game_id`
- `game_not_found`
- `link_limit_exceeded`
- `database_unavailable`
- `local_platform_unavailable`
- `write_failed`
- `cleanup_failed`
- `unexpected_error`

`write_conflict` is a sanitized per-link persistence outcome. `provider_unavailable` is not used because V2.5 does not call provider APIs. Raw network, TLS, DNS, D1, filesystem, or cleanup errors must not be copied into user-visible messages or JSON.

## CLI

```text
npm run links:verify -- 123
npm run links:verify -- 123 --write
npm run links:verify -- 123 --json
npm run links:verify -- 123 --write --json
```

- Exactly one positive canonical game ID is required.
- Dry-run is the default.
- Duplicate or unknown flags fail.
- `--remote`, `--env`, `-e`, `--config`, `--database-id`, `--url`, and equivalent assignment forms fail before platform creation.
- The platform uses the repository's fixed `wrangler.jsonc`, persistent local state, and `remoteBindings: false`.
- The CLI does not accept proxy, custom resolver, timeout, port, concurrency, or link-selection overrides in V2.5.
- Completion with broken, unsafe, temporarily unavailable, or unknown links returns success because verification completed.
- Invalid input, platform/database failure, cleanup failure, or incomplete requested write returns failure.

The existing `steam:search`, `steam:import`, and `igdb:enrich` scripts remain unchanged.

## Testing Strategy

### Schema and Migration

- All nine status values pass both application validation and SQLite CHECK enforcement.
- Invalid status values fail both layers.
- Legacy `failed` remains readable and writable for compatibility, while verifier planning never emits it.
- Seed pre-migration rows that populate all 16 columns, including nullable and verification fields.
- Apply the migration and compare every column value exactly.
- Verify column count, order, types, nullability, defaults, PK, FK, unique index, ordinary indexes, and all four CHECK constraints.
- Confirm only the status CHECK changed.
- Verify cascade behavior and `PRAGMA foreign_key_check`.
- Compare fresh-schema and upgraded-schema behavior.
- Confirm migration count is exactly 3 and record the new schema SHA-1 baseline.

### URL, IP, and DNS Safety

- Test the lower/upper boundaries and adjacent public addresses for every denied IPv4 and IPv6 CIDR.
- Test compressed, expanded, uppercase, and IPv4-mapped IPv6 forms.
- Test metadata addresses, localhost variants, trailing dots, single-label hosts, IDN/punycode, credentials, fragments, blocked ports, and overlong values.
- Test public-only, unsafe-only, mixed public/unsafe, empty, malformed, duplicate, timed-out, and over-cap DNS answers.

### Transport and TLS

- Prove custom lookup returns only the selected safe address and no second resolution occurs.
- Assert `agent: false`, `autoSelectFamily: false`, header limit, empty request body, and timer cleanup.
- Assert Host, HTTPS `servername`, `rejectUnauthorized`, and certificate hostname identity use the original normalized hostname.
- Normalize selected IP and `remoteAddress` before equality checks, including IPv4-mapped IPv6 equivalence.
- Destroy the socket on normalized mismatch.
- Verify response body consumption remains zero, including large/download responses.

### Redirect and HEAD/GET

- Follow only 301, 302, 303, 307, and 308.
- Test absolute, relative, and cross-host redirect targets.
- Test HTTP-to-HTTPS success and HTTPS-to-HTTP rejection.
- Test redirect to private/reserved/mixed-DNS destination.
- Test missing and malformed `Location`, loops, and redirect limit boundaries.
- Assert 300 and 304 do not follow and classify `reachable_but_unverified` without requiring `Location`.
- Verify HEAD fallback only for 400, 403, 404, 405, and 501.
- Verify GET uses the same full-hop safety checks and consumes no body.

### Classification, Ownership, and Concurrency

- Cover every classification row and persisted-field mapping.
- Preserve historical `verified_at` for non-verified results.
- Preserve all manual metadata while still returning the runtime check result.
- Allow a non-manual provider assertion to be superseded by HTTP verification.
- Prove dry-run has zero D1 mutations.
- Prove writes cannot alter fields outside the six verification metadata fields plus `updated_at`.
- Race URL replacement, row deletion, game reassignment, manual verification, and other metadata updates against verification.
- Prove stale conditional updates affect zero rows and never land on the changed row.
- Cover one valid update alongside one conflict in the same batch and report partial application accurately.

### Output Sanitization

Use distinct recognizable secret values in:

- an original DB URL query;
- a redirect `Location` query;
- attempt URLs;
- redirect-chain source, raw location, and resolved URL;
- final URL;
- plan fields;
- formatted errors.

For each required sensitive key, test case-insensitive matching and repeated query parameters. Assert that username, password, fragments, and every secret value are absent from both complete human output and complete JSON output, while internal DTOs still preserve exact URLs for transport and optimistic concurrency.

### CLI and Regression

- Test argument parsing, default dry-run, write, JSON, local-only enforcement, platform cleanup, exit codes, and sanitized unexpected errors.
- Use injected resolvers and request adapters for deterministic unit tests; do not use the public internet.
- A loopback test server may verify lifecycle mechanics only through a controlled adapter. A user-provided loopback URL must be rejected before any socket opens.
- Run focused tests, the complete existing suite, typecheck, lint, webpack build, local D1 migration check, and local D1 CRUD/cascade verification.

## Expected Files

```text
lib/db/schema.ts
lib/db/validation.ts
drizzle/0002_<generated-name>.sql
drizzle/meta/0002_snapshot.json
drizzle/meta/_journal.json

lib/verifiers/official-links/types.ts
lib/verifiers/official-links/ip-safety.ts
lib/verifiers/official-links/ip-safety.test.ts
lib/verifiers/official-links/url-safety.ts
lib/verifiers/official-links/url-safety.test.ts
lib/verifiers/official-links/transport.ts
lib/verifiers/official-links/transport.test.ts
lib/verifiers/official-links/classification.ts
lib/verifiers/official-links/classification.test.ts
lib/verifiers/official-links/presentation.ts
lib/verifiers/official-links/presentation.test.ts
lib/verifiers/official-links/plan.ts
lib/verifiers/official-links/plan.test.ts
lib/verifiers/official-links/index.ts
lib/verifiers/official-links/index.test.ts

lib/db/repositories/link-verification.ts
lib/db/repositories/link-verification.test.ts
scripts/verify-official-links.ts
scripts/verify-official-links.test.ts
package.json
README.md
```

No new production dependency is expected.

## Security and Feasibility Assessment

The selected design is feasible without weakening the SSRF boundary:

- request-bound lookup removes the preflight-DNS-to-fetch rebinding window;
- the actual socket is restricted to a selected, normalized, already-approved address;
- mixed DNS answers fail closed;
- original hostname semantics preserve Host, SNI, and TLS certificate validation;
- every redirect hop receives the same complete validation;
- default-port policy and HTTPS downgrade rejection reduce reachable service surface;
- sequential execution, explicit deadlines, header limits, and zero body consumption bound resource use;
- presentation-only URL sanitization protects secrets without corrupting request or concurrency identity;
- exact snapshot predicates prevent stale verification writes;
- the limited table rebuild can preserve all existing table data and semantics while changing only one CHECK constraint.

Residual risk remains that a public destination may itself proxy or fetch private resources, but the GameHub verifier does not control that remote server-side behavior and never directly connects to the private target. The implementation must document the pinned IANA registry snapshot date and treat future registry review as maintenance of the security boundary.

No new feasibility blocker was found during design. Implementation remains gated on a separate Implementation Plan and explicit approval.
