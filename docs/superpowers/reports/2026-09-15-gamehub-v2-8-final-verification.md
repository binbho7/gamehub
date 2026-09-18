# V2.8 final local verification

Execution date: 2026-09-18. Plan: `docs/superpowers/plans/2026-09-15-gamehub-v2-8-cloudflare-cron-sync.md`, Task 15. Approved design: `533bfd2d016f006f412d92ceb2cb9e50dd8a332f`. Branch base: `36f5bc17494111e65c1d3fcb93d111f631b8cd0c`. Task 15 starts at `6861384` on `codex/v2-8-cloudflare-cron-sync`.

Status: local implementation verified subject to the recorded environment gates. **DEPLOYMENT_VERIFICATION_BLOCKED**. No deployment, remote migration, production request, push, PR, or merge was performed. Independent Task 15 and whole-branch reviews are subsequent gates; this report does not claim their completion.

## What the new harness actually runs

`lib/scheduler/test-support/cron-harness.ts` calls the production `composeCronDependencies`, scheduler and complete singleton bulk pipeline. It does not replace the domain stores, planners, fence SQL, provider clients, signed verifier client/server, image client, default authenticated Image route, image validation/hash logic, immutable R2 store, or D1 publication logic.

The D1 fixture applies all five migrations with local Wrangler. Cron and Image acquire separate real local D1 bindings using the same explicit `mkdtemp` persistence root and database identity. Seeding through Cron must immediately be visible through Image. The Image binding has a real local R2 bucket. All HTTP listeners use ephemeral loopback ports. Startup owns D1, provider HTTP, verifier HTTP, Image bindings, Image HTTP, and temporary global network/log adapters; an acquisition ledger disposes them in reverse order exactly once. The partial-startup tests inject failure only after D1, verifier, or Image resources have been acquired, verify reverse disposal, and prove the root was removed.

The platform Container base class is a test substitute because the Cloudflare-only base class cannot load in Node. The real lifecycle binding adapter forwards to the real authenticated Node HTTP server. Steam/Twitch/IGDB and image source responses are fixture HTTP endpoints. Verifier target observations are controlled complete native DTOs returned after a local HTTP request; they are **not** evidence of actual production DNS/peer/TLS behavior. The Image handler runs in Node over HTTP with real workerd-backed storage bindings; this is not a deployed Worker ingress test. Only deadline tests substitute the native image clock via the existing service factory seam; they continue to execute the native service, real R2 and fenced D1.

## Integration and security evidence

- Full production composition executes Steam → IGDB → Links → Images. The initial image is unbound. Its actual response proves download, 29-byte JPEG validation, 48×32 dimensions and a SHA-256 hash. Instrumentation records R2 PUT completion before the actual D1 image batch dispatch. The repeat returns `already_ingested`, performs HEAD, makes no new download/PUT, and leaves table row counts unchanged.
- Independent pauses at Steam, IGDB and authenticated verifier responses, pending R2 PUT, D1 bind, and D1 create permit B to acquire a higher epoch before A resumes. A cannot mutate the captured database snapshot, finish its started attempt, or release B. Real SQL, not a latch or cancellation, rejects stale publication.
- Overlapping invocations skip while the lease is live. After expiry a newer invocation completes while an old Steam response remains pending; late A preserves all B state. Expiry without any replacement owner also rejects a late IGDB mutation.
- Native image deadline tests hold real PUT/bind/create operations. Cron returns one failed attempt, leaves the next candidate untouched, and retains the live lease. After expiry/takeover, pending D1 writes lose the fence; a pending immutable R2 artifact may complete without D1 publication. Completion is emitted once. An attempt's `failed` status is not used as settlement proof.
- Actual native mixed image results exercise both `[mime_mismatch, deadline]` and `[deadline, mime_mismatch]`, including nested `image_deadline` errors. The complete result reaches the real scheduled client, so first-error stage mapping cannot hide uncertainty or allow release/admission.
- Ordinary first-game failure permits the next game to succeed. Soft cutoff finishes the already admitted complete game. Injected metadata-finish and lease-release transport failures preserve completed business writes and expose only fixed safe error codes.
- Verifier startup unavailability, invalid response MAC and malformed response stop Images and publish no raw provider body, URL token, credential, owner token, signature or stack. An in-process verifier HTTP-server restart is followed by another authenticated successful run. This closes and recreates the server inside the same Node process; process/container cold-start remains blocked and unverified.
- Image authentication rejects missing, legacy and incorrect credentials before parsing the malformed payload or performing target/R2/D1 work. Authenticated verifier duplicate keys, unknown fields, wrong version, oversized body, wrong path/method and invalid MAC are rejected before target transport.
- Deployment tests exercise the actual readiness validator and CLI against private disabled checked-in configurations, reject production placeholders, mismatched D1 identity, missing paid-tier confirmation, public routing and unsafe schedule/CPU settings. They verify the official package pin and identical digest-pinned Node build/runtime images. These are configuration gates, not platform entitlement probes.

Existing stage-level tests are rerun rather than replaced by the final harness. In particular:

| Inventory / invariant | Executed evidence |
| --- | --- |
| S1–S3 update predicates, S4 create prohibition | `steam.integration.test.ts`: all three real mutations, manual exclusions, all compiled fences, stale fetch and negative cases |
| I1–I5 including identity assertion and auxiliary inserts | `igdb.integration.test.ts`: full real mutation inventory, stale individual queries, identity conflict decoding, final-assertion rollback, fill-empty preservation |
| L1–L2 exact snapshot/manual/no-op policy | `links.integration.test.ts`: authenticated late result, standalone guarded updates, empty/manual/unchanged authority checks, partial apply and rollback |
| C1–C4 epoch and metadata | lease/state/fence integration tests: single winner, strict DB expiry, ignored caller expiry, primary DB time, no missing-row recovery/resurrection, guarded UPSERT arms, started/finish CAS |
| Both SQL linearization orders and transactional atomicity | `fence.integration.test.ts`: A commits first versus B acquires first; guarded INSERT/UPDATE/UPSERT/DELETE; named CHECK final assertion rolls back the entire successful prefix |
| M1–M2 and R1–R3 | images/R2 fencing integration tests: bind/create, immutable conditional/checksum storage, repair canonical keys, no stale publication or artifact deletion |
| Native uncertainty and no hidden authority | scheduled-client, scheduler-service and production-composition suites: whole-result/nested-error scan, malformed/throwing pipeline, late no-op/provider error, later metadata failure |
| Node transport and wire protocol | Container conformance/server and remote client/codec/MAC tests: host-local socket/lookup/Host probes, protocol bounds, request/response authentication, SSRF and redirect conformance vectors |

The shared presentation tests verify `[INVALID_URL]`, credential/query/fragment sanitization, nested image diagnostics and safe output. Container runtime tests verify only the verifier secret enters its start environment and that proxy failures do not log raw errors. Production Worker entrypoint tests enforce public 404 behavior. The Cron bundle's 280 input modules contain no local Node verifier transport, R2 writer, CLI composition or Wrangler acquisition, and output imports contain no Node DNS/HTTP/HTTPS/net/child-process capability.

## Fresh command results

Results below belong to this Task 15 run, not inherited V2.7 evidence. Local fixture commands require loopback/process permission. The first restricted attempt failed with `listen EPERM`; the approved retry ran the real tests.

| Command | Exit / evidence |
| --- | --- |
| Initial new integration test RED | 1: missing `cron-harness` module, before harness implementation |
| Initial full `npm test` | 1: 2,396 passed, one obsolete legacy dependency assertion failed |
| Final `npm test` | 0: 119 files, 2,397 tests passed (83.35 seconds) |
| Focused scheduler/Container/Cron/Image/remote suite plus legacy dependency regression | 0: 35 files, 509 tests passed (89.35 seconds) |
| `npm run typecheck` | 0 |
| `npm run cron:typecheck` | 0 |
| `npm run lint` | 0, no added generated-source exclusions |
| `git diff --check` | 0 |
| `npm run build` | 1, environment blocked: Turbopack CSS/PostCSS subprocess cannot bind a local port (`Operation not permitted`); escalated retry has the same failure |
| `WRANGLER_LOG_PATH=/tmp/gamehub-v28-cron-bundle.log npm run cron:bundle` | 0, Worker dry run: 1,219.42 KiB / gzip 211.92 KiB, Container rollout disabled |
| Bundle metafile inspection | 0, 280 inputs, zero forbidden runtime modules/imports |
| `npm audit --omit=dev` | 0, zero vulnerabilities |
| `npm audit` | 1, seven existing development advisories: four moderate, three high |
| `docker --version` | 127, Docker unavailable; no image execution claimed |
| Production readiness CLI under the checked-in configuration | 1 as required: real shared D1 IDs are not configured |

The only failure requiring a source-test correction was the old V2.7 lockfile assertion. Its focused RED showed the sole unexpected dependency was `@cloudflare/containers: 0.3.7`. The corrected test allows precisely that approved dependency, verifies it has no transitive dependencies, removes only its root declaration/package entry from an in-memory lockfile copy, and compares the entire remainder with the original baseline. No application code or packages were changed in Task 15.

## Migration and dependency evidence

- Computed `shasum lib/db/schema.ts`: `f0133d569a777f72b9a74af48059cf61b7d946c0`; original schema SHA-1 was `d959b11fc297164388f3cc28708beadab2d7842f`.
- Exactly five SQL migrations: `0000_nervous_gunslinger.sql`, `0001_cold_mysterio.sql`, `0002_purple_greymalkin.sql`, `0003_odd_weapon_omega.sql`, `0004_cron_sync_fencing.sql`.
- `git diff 36f5bc1 -- drizzle/0000* drizzle/0001* drizzle/0002* drizzle/0003*` has zero output. The migration integration suite verifies populated legacy rows/schema objects, exactly two added tables, named checks, FK cascade, index structure and durable epoch preservation when reopening/rerunning migrations.
- `git diff --numstat 36f5bc1 -- package-lock.json`: seven insertions, zero deletions. Those lines add only pinned `@cloudflare/containers@0.3.7`, resolved npm tarball/integrity/license, and the root dependency entry. No transitive closure was required; existing versions/entries are unchanged.
- Full-audit development advisories are esbuild `GHSA-67mh-4wv8-2f99` through the existing drizzle-kit/esm-loader/core-utils chain (four moderate packages) and sharp `GHSA-rgj7-g3m4-5g8c` through the existing Wrangler/Miniflare chain (three high packages). The whole-lock comparison above proves these versions predate V2.8. No `npm audit fix` or unrelated upgrade was run.
- Harness configuration, migrations, state and logs live under its owned temporary root. Integration disposal removes it. Wrangler dry-run and the wider legacy integration suite can leave an empty repository `.wrangler/tmp`; it contained no generated files, lint passed after integration, and only the empty directory was removed with `rmdir` after verification. No source files were excluded from lint.

## Unmet deployment/build gates

`DEPLOYMENT_VERIFICATION_BLOCKED`: Docker is absent, actual Cloudflare preview deployment is separately authorized, and production database placeholders remain unresolved. Process/container cold-start remains blocked; the in-process verifier HTTP-server restart test does not prove it. Actual Container image execution, private platform ingress/service bindings, shared real D1 visibility, deployed transactional rollback and R2 conditional/checksum behavior, cold-start/idle restart timing, actual Node lookup/normalized connected peer/Host/SNI/certificate behavior, and CPU/wall budgets must be proved in the authorized target before enabling Cron. Local fixtures and a Worker bundle are not substitutes.

`BUILD_VERIFICATION_BLOCKED`: the Next.js production build cannot finish in this host's Turbopack port-binding environment. Typechecks and Cron bundling passing do not convert this into a production-build PASS.

Task 15 commits only the harness/tests, the narrow legacy dependency assertion update, this report and README guidance. Post-commit clean-worktree status and independent reviews must be recorded by the final coordinator. All remaining blocked gates stay blocked until supported by actual evidence.
