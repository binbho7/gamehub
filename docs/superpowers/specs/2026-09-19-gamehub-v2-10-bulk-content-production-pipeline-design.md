# GameHub V2.10 Bulk Content Production Pipeline — Design Spec

Status: Proposed design only. This document authorizes no implementation, migration execution, provider access, publication, deployment, push, PR, or merge.

## 1. Context

V2.9 established a local-D1-backed, deterministic public artifact boundary. The canonical database may contain incomplete or newly imported games, while the V2.9 exporter intentionally fails closed when its selected snapshot contains an invalid row. V2.10 therefore needs a controlled production workflow that can process batches, resume interrupted work, isolate failures, and produce an explicitly reviewed publication set without silently dropping incomplete games.

The repository already has a useful four-stage domain pipeline: Steam import, IGDB enrichment, official-link verification, and image ingestion. It also has local-only CLIs and V2.8 scheduler leases/state. Those pieces are not a bulk content job system: V2.7 has no durable run checkpoint, and V2.8 scheduler state is operational scheduling metadata with different authority and retry semantics.

## 2. Goals

- Process reviewed candidate manifests in bounded batches of 50–200, with a path to 1,000 candidates through chunks.
- Preserve stable candidate identity, deterministic stage order, per-game failure isolation, resumability, and idempotent writes.
- Make retryable, permanent, blocked, and operator-review outcomes explicit.
- Keep canonical D1 inclusive of incomplete records while making publication selection explicit and reviewable.
- Reuse existing stage ports, validation, provider safety, and local-only configuration.
- Keep public artifacts deterministic, private-data-free, and fail-closed.
- Provide safe operator diagnostics without raw provider payloads or credentials.

## 3. Non-goals

V2.10 does not add an admin web CMS, public ingestion API, runtime API/D1 reads for the site, production-D1 mode, remote Wrangler mode, automatic fuzzy matching, automatic translation, automatic publication, R2 publication, a queue/DO platform, or a general-purpose job scheduler. It does not change the V2.9 public DTO to expose external IDs, provider payloads, ratings, free status, or internal verification details. It does not promise that 1,000 games complete in one provider wave.

## 4. Existing architecture inventory

| Area | Current capability | V2.10 implication |
|---|---|---|
| `lib/sync/*` | Typed stage ports, Steam → IGDB → links → images ordering, per-game continuation, safe result presentation | Reuse as the domain executor; add orchestration around it, not parallel ad-hoc CLIs |
| `scripts/sync-games.ts` | Local/manual batch CLI, normalized Steam IDs, max 100, sequential execution, no durable checkpoint | Preserve as compatibility surface; new runner owns manifest/resume semantics |
| Single-game scripts | Local D1 only, explicit `--write`, safe public errors, no `--remote` | Reuse composition and safety boundaries; do not shell out to child CLIs |
| `lib/db/schema.ts` | Canonical games, identities, relations, links, images, videos; scheduler tables | Canonical rows can remain incomplete; operational run tables must be separate and excluded from site data |
| `lib/scheduler/*` | Singleton lease, fencing, candidate selection, attempt status for scheduled sync | Do not reuse as the content-production run ledger or publication review state |
| `lib/site-data/*` | Explicit snapshot date, eligibility, deterministic DTO and serializer, strict artifact limits/checker | Export only an explicit reviewed selection; retain all gates and fail closed |
| official-link verifier | Network/DNS verification and unsafe-destination policy | Runs only in the links stage, with bounded concurrency and safe diagnostics |
| `game_images` | Approved source metadata plus R2 metadata | Public pipeline uses approved source URLs; R2 fields never enter publication output |

## 5. Architecture decision

Three approaches were considered:

### A. Single orchestrator CLI

One command runs every candidate and prints a report. It is simple and fits V2.7, but process loss loses stage progress, resume is approximate, and operator review cannot be represented durably. It is rejected as the primary architecture.

### B. Stage commands with persistent local run state

Separate commands make stage reruns clear and can checkpoint in D1. However, operators must coordinate stage ordering, selection, and failure transitions themselves; a partially repeated command can bypass policy unless every command duplicates the state machine. It is useful as an internal testing decomposition, not the operator contract.

### C. Manifest-driven state machine — selected

A canonical input manifest defines the candidate universe and review identity. A local orchestrator advances each item through typed stage states and persists transitions in dedicated operational tables. Stage ports remain reusable, while one command provides run creation, bounded execution, resume, retry, report, selection review, and export handoff. This gives deterministic scope, durable resume, explicit publication selection, and one policy owner without introducing a remote job platform.

The implementation should be a local-first hybrid: a manifest is the source of truth for what was requested; local D1 run tables are the execution ledger; canonical game tables remain the business data store; a separate reviewed selection manifest is the publication boundary.

## 6. Pipeline stages

The public stage names and order are:

1. `discover` — normalize reviewed Steam App IDs or an explicitly supplied canonical identity list; reject empty, duplicate, malformed, or out-of-scope entries.
2. `import` — execute the existing Steam importer and bind the stable canonical `gameId`.
3. `enrich` — execute IGDB enrichment with explicit mapping/conflict outcomes.
4. `verify` — verify official links using the existing safe URL/DNS/redirect policy; network access is stage-scoped.
5. `images` — execute the existing image ingestion domain/service. Source/provider processing may use network I/O; local D1 writes are idempotent. This stage does not enable production R2 publication: V2.10 public artifacts still use approved source URLs and never expose R2 internals.
6. `evaluate` — run eligibility against an explicit `snapshotDate` and policy version, without writing public artifacts.
7. `export` — only for an explicitly reviewed selection; normalize, validate, and serialize the complete selected set.
8. `preview` — build/check the artifact and static site in an isolated local output, without publication.
9. `publish-ready` — record that all review gates passed and expose the exact artifact hash/report for human approval. It does not deploy or publish.

`export`, `preview`, and `publish-ready` are run-level gates. A game with an earlier stage failure cannot be silently included. Stage results preserve the existing `not_run` semantics when a prerequisite fails.

## 7. State and data model

### 7.1 Canonical business data

Existing `games`, identity, taxonomy, company, link, image, and video tables remain the canonical source. They are allowed to contain drafts/incomplete rows. No provider raw payload or secret is persisted.

### 7.2 New operational run tables

One additive local D1 migration is recommended:

`pipeline_runs`:

- `run_id` — deterministic namespaced SHA-256 identifier over the canonical manifest bytes, for example `pipeline-v2.10:<manifest_hash>`; the manifest bytes already contain the pipeline and policy versions, so they are not encoded a second time. It is never a UUID or wall-clock value.
- `manifest_hash`, `pipeline_version`, `policy_version`, `snapshot_date`.
- `status`: `created | running | paused | failed | ready`.
- operational `created_at`/`updated_at` may exist for local operations, but are never public artifact inputs.

`pipeline_run_items`:

- `(run_id, ordinal)` as stable manifest position and uniqueness anchor.
- `steam_app_id`, nullable `game_id` after import, and a stable input identity kind.
- per-stage state: `pending | running | succeeded | retryable_failed | permanently_failed | blocked | skipped`.
- bounded `attempt_count`, stable `reason_code`, and safe short diagnostic metadata.
- unique `(run_id, steam_app_id)` and indexes for pending/retryable selection.

These tables are operational only. They must be excluded from `readSiteSnapshot`, serializer schemas, generated artifacts, and public diagnostics. Scheduler lease/fence tables remain separate and are not used for this run ledger.

### 7.3 Publication selection

Do not add a default `published` flag to `games`: it would either make existing rows ambiguous or turn a migration default into accidental publication. Use a reviewed, tracked selection manifest containing candidate identity, explicit decision (`include` or `exclude`), reviewer/policy version, and the exact snapshot date. The V2.10 exporter accepts this manifest (or an equivalent reviewed selection record) explicitly and validates every included identity against the current local D1 snapshot. Missing, duplicate, excluded, or ineligible selected rows fail closed. Unselected/incomplete rows remain in canonical D1 but are not “silently omitted”; they are outside the declared publication set and appear in the report.

## 8. Manifest contract

The input manifest is versioned and canonicalized before hashing. Its required fields are `manifestVersion`, `pipelineVersion`, `policyVersion`, `snapshotDate`, and an ordered `items` array. Each item has a stable `steamAppId` or an explicitly supported canonical identity, plus an ordinal. No title, URL, provider payload, secret, local path, or mutable display label is identity.

Validation rules:

- App IDs are positive canonical decimal strings and deduplicated before execution.
- `snapshotDate` is exact real `YYYY-MM-DD`, supplied by the operator; no current date is inferred.
- Unknown fields fail closed unless a manifest version explicitly permits them.
- Canonical JSON key order, item order, and newline encoding are fixed before SHA-256 hashing.
- The manifest hash is printed in reports and stored in `pipeline_runs`; it is not a secret.
- Batch execution chunks a larger manifest without changing the global manifest hash or item ordinals.

The reviewed publication selection is a separate versioned contract. It may include only stable identities and reviewer decisions; it must not contain raw rows or provider payloads.

## 9. Resume semantics

`resume <run-id>` loads the run by exact manifest hash and refuses a changed manifest, policy, pipeline version, or snapshot date. Successful stages are skipped only after reconciling that the expected canonical identity and required local state still exist. A crashed `running` item becomes `pending` or `retryable_failed` after an operator-safe stale-attempt recovery rule; it is never assumed successful.

Resume processes items in manifest ordinal order while allowing bounded workers. The complete item transition graph includes every stage in `discover → import → enrich → verify → images → evaluate → export → preview → publish-ready`. A stage transition is committed only after its provider operation and local write/reconciliation have reached a terminal result. The `images` stage follows the same resume rule as the other provider stages: a completed idempotent local image result is skipped after reconciliation; an interrupted or retryable result is re-run safely. A successful earlier stage is not rolled back because a later stage failed. The report distinguishes resumed, skipped-success, retried, blocked, and never-started items.

## 10. Retry semantics

Retry classes are fixed and code-based. Retryable examples are timeout, transient network/DNS failure, HTTP 429/5xx, provider-unavailable, verifier service unavailable, and image download/source-service failure. Permanent/blocked examples are invalid identity, ambiguous IGDB match, taxonomy/company conflict, unsafe URL, malformed provider result, invalid credentials, rejected image source/format, and policy rejection.

Automatic retries are capped at three attempts per stage, use bounded exponential backoff with a cap, and honor a safe numeric `Retry-After`. Manual retry requeues only retryable failures. `--refresh` is an explicit operator action that invalidates a successful provider stage and its dependent stages; default resume never refreshes successful work. Before retrying after uncertain write completion, reconcile by canonical identity and unique constraints rather than blindly applying the mutation again.

## 11. Concurrency and transactions

Default execution uses four game workers, with hard provider-specific caps (recommended: Steam 4, IGDB 2, verifier 2, image ingestion 2) and a serialized local-D1 write queue. The caps are policy, not an unbounded CLI flag. Deterministic input order controls admission and report order even when completions differ. Image ingestion may perform source/provider network work, but its local writes remain idempotent and its R2 capability is not promoted to a production publication path.

Provider fetches happen outside D1 transactions. Each game/stage has a short local write transaction with compare-before-write, unique-constraint handling, and reconciliation. Never hold a transaction across network I/O. A failed item does not abort other items; a migration, database, lease, or composition failure pauses the run and prevents new admissions.

## 12. Failure isolation

One game's invalid mapping, unsafe link, image failure, or missing metadata marks that item with a stable code and prevents dependent stages for that item. Image failure is an item-level failure unless the image service/local D1 infrastructure itself fails at run level. Other items continue within the run budget. A malformed stage contract, D1 infrastructure failure, lost authority, or invalid manifest is a run-level failure and stops admission. No result formatter may expose raw exception text, provider response bodies, URLs containing credentials, lease tokens, or local paths.

Stable report ordering is manifest ordinal, then canonical game ID, then stage order. Counts include discovered, imported, existing, enriched, verified, eligible, blocked, retryable, permanent, skipped, and failed. Reports are safe JSON/human output and are not part of the public artifact.

## 13. Publication boundary

Eligibility remains the only authority for public DTO fields and uses explicit `snapshotDate`. The exporter receives only the reviewed include set, resolves all selected rows, and fails if any selected row is missing or has diagnostics. It must not filter invalid rows and continue. It must not use `lib/mock-data.ts`, R2 storage metadata, scheduler metadata, raw payloads, or current time.

The publication sequence is:

1. freeze local D1 snapshot and reviewed selection;
2. evaluate every included identity;
3. fail if any included identity is ineligible or duplicated;
4. normalize public order while preserving media presentation order;
5. validate limits and forbidden fields;
6. serialize/check/build in a temporary output;
7. record artifact hash and report as `publish-ready`;
8. require human approval before any later release operation.

Incomplete canonical rows are visible in the operator report as excluded/blocked, not silently converted into a partial artifact.

## 14. Diagnostics and reporting

Reason codes are finite, documented, and deterministic, for example `invalid_manifest`, `duplicate_identity`, `steam_import_failed`, `igdb_ambiguous`, `link_unsafe_destination`, `image_source_rejected`, `image_ingest_failed`, `missing_required_metadata`, `unverified_official_link`, `publication_selection_missing`, and `publication_selection_ineligible`. Codes do not encode provider payloads or secrets. Stage counts use the exact enum `discover`, `import`, `enrich`, `verify`, `images`, `evaluate`, `export`, `preview`, `publish-ready`; there is no implicit image sub-stage.

Every report contains run ID/hash, versions, snapshot date, counts, per-item stage states, retry class, and artifact hash when available. It excludes raw DB rows, credentials, provider payloads, R2 keys/hashes/storage URLs, scheduler lease/fence data, filesystem paths, and wall-clock fields from deterministic report comparisons. Operational timestamps may be logged locally only outside the deterministic report payload.

## 15. Credentials and local-only boundary

V2.10 remains local-only. Operators explicitly load ignored `.env.local` in the same shell before IGDB/verifier operations and may print only `SET`/`MISSING`. The runner refuses network stages before credentials are present, never stores secrets in manifests, D1 run tables, output, or reports, and has no `--remote`, production database ID, Cloudflare binding, deploy, or R2 publication option. Provider clients receive credentials only through their existing runtime ports.

## 16. Determinism and idempotency

Provider responses and network timing are inherently variable, so determinism begins at the frozen canonical snapshot plus manifest, explicit snapshot date, exporter version, and policy version. From those inputs, eligibility diagnostics, selection resolution, artifact ordering, serialization bytes, and reports are byte-stable. No `Date.now()`, random ID, wall-clock ordering, or completion-order report is permitted.

Existing provider/game/image unique constraints and compare-before-write rules remain the idempotency foundation. Re-running a completed stage is a no-op unless `--refresh` is explicit. The run ID is the namespaced SHA-256 of canonical manifest bytes only; because those bytes include pipeline and policy versions, no duplicate version concatenation is performed. It is not a UUID.

## 17. UI scalability backlog integration

V2.10 should consume the existing V2.9 frontend backlog as a bounded presentation task, not mix it into ingestion:

- `/games` and `/search`: compact browse records, initial 24 results, load-more by 24, reset visible count when filters/sort/query change.
- genre/platform pages: initial 24 and a bounded “view more” path to `/games` using real taxonomy slugs.
- homepage upcoming/latest sections: bounded six-item slices.
- taxonomy navigation/footer: data-driven, bounded direct links, no hard-coded nonexistent taxonomy.

No virtualization, client fetching, admin UI, or new runtime data service is required in V2.10. UI tests must prove small datasets are unchanged and large datasets do not render thousands of cards.

## 18. Security and privacy

Fail closed on malformed manifests, unsafe URLs, private/special-use destinations, credentials in URLs, unknown contract fields, duplicate identities, and forbidden artifact fields. DNS/network verification remains isolated to the official-link stage; pure artifact checks never perform DNS or network access. Logs and reports are sanitized. Local run state is operational and must not be copied into tracked public output. File paths and environment contents never appear in diagnostics.

## 19. Testing matrix

| Layer | Required evidence |
|---|---|
| Pure unit | Manifest canonicalization/hash; identity dedupe; transition graph; retry classification/backoff; deterministic report; selection validation |
| Local D1 integration | Additive migration; constraints/indexes; resume after interruption; duplicate rerun; per-stage transaction boundaries; no scheduler/public-artifact leakage |
| Provider fixtures | Steam import; IGDB exact/ambiguous/conflict/rate-limit; link unsafe redirect/DNS/timeout; image source/download/format/idempotency outcomes; no production R2 publication |
| Scenario | 10 all-success; 10 with one ambiguous; unsafe link; 100 rate-limited; interruption halfway; stale running recovery; retry-only; changed manifest refusal; selected invalid row fail-closed |
| Publication | Explicit selection, all-selected eligibility, duplicate slug/identity, media order, 10 MiB/10,000 limits, no private/R2 fields, stable repeated bytes |
| UI backlog | Compact boundary, title/developer/publisher and taxonomy filtering, load-more/reset, taxonomy cap, bounded homepage, static route/404 compatibility |
| Security | No secrets/raw payloads in every output channel; no remote D1/production binding; no network in checker/serializer; no mock fallback |

The target scale matrix is: 50 candidates as the first-class happy path; 200 with bounded workers, resumable chunks, and provider rate limits; 1,000 as a manifest accepted and executed in explicit chunks (for example ten 100-item chunks), never as 1,000 concurrent operations or an unreviewed one-shot publication.

## 20. Operator workflow

1. Prepare and review a versioned candidate manifest.
2. Load credentials in the operator shell; verify presence only.
3. `discover` and create a run hash; inspect the planned scope.
4. Run bounded local stages with `--write` only after dry-run/configuration checks; `images` is the explicit image-ingestion stage and does not publish to production R2.
5. Resume or retry by run ID; inspect safe report and blocked items.
6. Create and review an explicit publication selection.
7. Run evaluate/export/preview/publish-ready with fixed snapshot date.
8. Review artifact diff, report, diagnostics, and SHA-256.
9. Stop at publish-ready for human approval; no V2.10 command deploys or publishes.

## 21. Rollback and recovery

On stage failure, preserve legal earlier canonical writes and resume from the durable state; do not destructive-rollback provider data. On export/check/build failure, leave the last reviewed `generated/site-data.json` untouched. Abort or pause the run, correct the manifest/policy/input, and start a new hash when scope changes. A migration rollback is not required; the additive operational tables can remain unused. If disaster recovery restores an older local DB snapshot, invalidate affected run IDs and regenerate selection/review rather than trusting stale checkpoints.

## 22. Migration and compatibility

Recommended V2.10 implementation requires one additive migration for `pipeline_runs` and `pipeline_run_items`; no existing table is rebuilt and V2.7/V2.8 callers continue to function. The migration must be tested against populated local D1, foreign-key checks, indexes, constraints, rerun/no-op behavior, and exact exclusion from read-model queries. No `publication_status` column is added to `games` in V2.10. Existing V2.9 export remains available, while the new reviewed-selection path is explicit and opt-in until its release gate is complete.

## 23. V2.11+ follow-ups

- Operator review UI and audit history.
- Queue/worker execution if local throughput is insufficient.
- Provider quota dashboard and resumable remote orchestration, only with a separate security design.
- Reviewed translation/rating/free-status sources and contract versioning.
- Optional R2-backed public image indirection after licensing and cache policy review.
- Incremental artifact publishing and diff-based content review.
- Database-backed publication decisions if selection manifests become operationally insufficient.

## 24. Alternatives considered and rejected

- Reusing V2.8 Cron lease/state: wrong authority model, no manifest scope, and scheduler metadata would become coupled to content production.
- One giant CLI with a JSON checkpoint: weak transactional semantics and unsafe concurrent/resume behavior.
- Queue/ Durable Objects/remote job system: violates local-only scope and adds deployment/security work before the local contract is proven.
- A `published` boolean on `games`: ambiguous migration default and unsafe accidental inclusion.
- Silent `eligible` filtering: directly violates V2.9 fail-closed publication and hides incomplete content.

## 25. Design review checklist

- [x] Chosen architecture is explicit and alternatives are compared.
- [x] Local-only boundary, credentials, no mock fallback, and no production mutation are explicit.
- [x] Manifest identity, resume, retries, isolation, concurrency, idempotency, and deterministic reporting are explicit.
- [x] Canonical D1 may contain incomplete rows without weakening publication gates.
- [x] Reviewed selection prevents partial/accidental publication.
- [x] UI scalability backlog is bounded and separate from ingestion.
- [x] Testing matrix covers 50/200/1,000 scale and security boundaries.

### Independent design review

Critical: 0  
Important: 0  
Minor: 0

No unresolved design finding was identified in this read-only pass. Before implementation, the approved plan must define, before any code is written:

1. exact input manifest JSON schema;
2. exact publication-selection JSON schema;
3. exact canonicalization and hash algorithm;
4. exact `run_id` derivation (`namespaced SHA-256(canonical manifest bytes)`);
5. exact pipeline stage enum, including `images`;
6. exact stage transition table for all stages and terminal outcomes;
7. exact retry classification table, including image outcomes;
8. exact `pipeline_runs` SQL schema;
9. exact `pipeline_run_items` SQL schema;
10. constraints, indexes, and foreign keys;
11. exact CLI command names;
12. report JSON schema and deterministic ordering;
13. ignored/tracked file policy;
14. credential loading contract;
15. image-stage semantics, including source URL publication, idempotent local writes, and explicit exclusion of production R2 publication.

These are implementation-plan prerequisites, not an authorization to create that plan in this design-only session.
