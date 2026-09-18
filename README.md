# GameHub

Game database with official websites, stores, downloads, demos, and launcher links. V2.1 adds a Cloudflare D1 and Drizzle data foundation; the accepted V1 UI intentionally continues to read `lib/mock-data.ts`.

## Local development

For an existing V2.5 database, complete the V2.6 image migration preflight below **before** running `db:migrate:local`. A new empty local database can apply all migrations directly.

```bash
npm install
npm run db:migrate:local
npm run db:check:local
npm run db:verify:local
npm run dev
```

Wrangler persists the local-only D1 database under `.wrangler/state`. `db:migrate:local` applies every tracked SQL file in `drizzle/`; `db:verify:local` performs canonical CRUD, provider/link/media writes, lookup, update, and cascade deletion through the Drizzle repository.

The D1 binding is named `DB` and the local database name is `gamehub`. The all-zero `database_id` in `wrangler.jsonc` is an intentional local placeholder and must not be deployed.

## V2.2 local Steam game import

Apply the tracked migrations before importing:

```bash
npm run db:migrate:local
```

Then import exactly one Steam App ID with either mode:

```bash
npm run steam:import -- 1245620
npm run steam:import -- 1245620 --write
```

The first command is the default dry-run: it fetches and validates Steam metadata, prints the proposed database plan, and makes no changes. The second command applies that plan only to the local D1 database persisted under `.wrangler/state`.

This V2.2 tool is local-only. It rejects `--remote`, and production import is unavailable. Steam availability is an external dependency, so network, HTTP, malformed-response, unavailable-game, and import conflicts are reported to stderr with a typed error code and exit status 1. The importer stores approved Steam metadata and media URLs; it does not download media files. The accepted V1 UI remains backed by `lib/mock-data.ts`.

## V2.3 Steam search and selection

Search Steam by name before importing a game:

```bash
npm run steam:search -- "elden ring"
npm run steam:search -- "elden ring" --limit 5
npm run steam:search -- "elden ring" --json
npm run steam:import -- 1245620
npm run steam:import -- 1245620 --write
```

The search command is read-only: it does not write to D1 and never calls the importer. It uses a fixed English/US locale and can return non-game apps with type `unknown`; review the results and explicitly select an App ID before running the existing V2.2 `steam:import` command. Search relies on an undocumented Steam Store endpoint, has no HTML fallback, and may be unavailable if that endpoint changes.

## V2.4 local IGDB enrichment

Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` in your local shell or secret manager before running the command. Do not put credential values in Git, scripts, or command examples.

Enrich exactly one canonical GameHub game ID:

```bash
npm run igdb:enrich -- 42
npm run igdb:enrich -- 42 --write
```

The first command is the default dry-run: it fetches IGDB metadata, prints the matched identity and planned creates, updates, skips, warnings, conflicts, and affected-row count, and makes no database changes. `--write` explicitly applies that plan only to the local D1 database under `.wrangler/state`. This tool is local-only and rejects `--remote`; remote enrichment is unavailable.

The Twitch access token is cached only in process memory for one CLI run. Each new CLI process may acquire a token; a batch or Cron implementation requires a later token lifecycle design. The CLI records IGDB metadata and remote media URLs, does not download media files, and does not cache them in R2.

For commercial use, confirm the required IGDB commercial partnership, licensing terms, and attribution requirements before launch.

## V2.5 local official-link verification

V2.5 verifies the existing official links for exactly one canonical GameHub game and marks only their verification metadata. It does not discover, create, delete, replace, or rewrite links, and it never changes link ownership, URL, provider, platform, type, region, or official status.

Pass one positive canonical game ID and choose one of the four supported forms:

```bash
npm run links:verify -- 123
npm run links:verify -- 123 --write
npm run links:verify -- 123 --json
npm run links:verify -- 123 --write --json
```

The default dry-run performs the real DNS and HTTP checks and prints the proposed metadata plan, but makes zero D1 mutations. `--write` runs the same verification pipeline and conditionally applies approved metadata changes. `--json` selects sanitized machine-readable output and may be combined with `--write`.

This command is local-only: it uses the repository's fixed `wrangler.jsonc`, the persistent D1 state under `.wrangler/state`, and `remoteBindings: false`. There is no remote D1 mode and no Cron, batch, whole-database scan, URL-selection, alternate-config, or environment-selection mode in V2.5. Remote/configuration flags such as `--remote`, `--env`, `-e`, `--config`, `--database-id`, and `--url` are rejected before the local platform is created.

### Verification safety and limits

The verifier accepts only HTTP and HTTPS URLs on their default ports: HTTP port 80 and HTTPS port 443. It rejects credentials, local or reserved hostnames, non-default ports, special-use IP ranges, and overlong input; URL fragments are never sent or emitted. Its public-address deny policy is pinned to the IANA registry snapshot dated 2025-10-09; updating that snapshot and its boundary tests is security maintenance.

For each hostname, the verifier resolves all DNS addresses, rejects malformed or special-use results, and fails closed on mixed public and unsafe answers. A custom request lookup binds the connection to one already-approved address and the connected socket address is checked before response headers are trusted. The verifier uses direct Node HTTP/HTTPS requests rather than ordinary `fetch`, does not honor proxy settings, and repeats the complete URL, DNS, address, and socket validation on every redirect hop. HTTP-to-HTTPS upgrades are allowed; HTTPS-to-HTTP downgrades are rejected. GET fallback starts again from the original URL, uses the same checks, and consumes zero application body bytes.

The hard limits are:

- 20 links per game, processed sequentially at concurrency 1.
- 16 DNS results per hop and a 3-second DNS deadline.
- An 8-second request-to-headers deadline, a 20-second total deadline per link, and a 5-minute total deadline per game.
- 5 redirects (6 total hops).
- 16 KiB response headers and 2,048-character URLs and redirect locations.
- No request body, zero application body bytes from GET, and no automatic retries.

### Results, writes, and output

| Outcome | Stored classification |
| --- | --- |
| Final 2xx | `verified` |
| Non-followed 3xx, 401, 403, and 4xx other than 404, 408, 410, 425, and 429 | `reachable_but_unverified` |
| 404, 410, invalid redirect, redirect loop, or redirect limit | `broken` |
| 408, 425, 429, other 5xx, or timeout | `temporarily_unavailable` |
| Invalid URL/scheme, credentials, blocked port/address, mixed DNS, or HTTPS downgrade | `unsafe` |
| DNS, TLS, connection, or otherwise unclassified network failure | `unknown` |

The legacy `failed` value remains schema-compatible but is never emitted by this verifier. A completed run can therefore succeed while individual links are broken, unsafe, temporarily unavailable, or unknown; operation failures and incomplete requested writes return failure.

Manual verification metadata is preserved even though the link is still checked for runtime visibility. For non-manual rows, write mode can update only verification status/method, HTTP status, safe final redirect URL, checked/verified timestamps, and `updated_at`. Exact snapshot predicates prevent a stale result for URL A or older metadata from being written after the row changes, and mixed current/conflicted updates are reported as `partially_applied` rather than as an all-or-nothing success.

Successful human and JSON result output is rendered only from the presented DTO produced by the shared presentation sanitizer. URL query secrets are replaced with `[REDACTED]`; credentials and fragments are omitted, and malformed URLs become `[INVALID_URL]`. Operation failures use fixed public code and message mappings instead of serializing internal errors. Raw DNS, TLS, D1, environment, and stack details are not printed; successful JSON results may include a normalized approved public address for local diagnostics.

## Schema changes

1. Update `lib/db/schema.ts`.
2. Run `npm run db:generate`.
3. Review the generated SQLite SQL, especially table rebuilds and constraints.
4. Run `npm run db:migrate:local` and `npm run db:verify:local`.
5. Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build`.

Never use `drizzle-kit push` against production. Production schema changes are reviewed migrations applied with Wrangler.

## Production D1 setup

Production is deliberately not provisioned in V2.1. Before deploying:

1. Authenticate Wrangler with the intended Cloudflare account.
2. Create the production database: `npx wrangler d1 create gamehub`.
3. Replace the placeholder `database_id` in `wrangler.jsonc` with the returned UUID. Configure a separate preview database ID if preview deployments need isolated data.
4. Confirm the Worker/vinext deployment exposes the `DB` binding to server-side code.
5. Inspect pending migrations with `npx wrangler d1 migrations list gamehub --remote`.
6. Apply them explicitly with `npx wrangler d1 migrations apply gamehub --remote`.
7. Deploy only after remote migration success and a backup/change-window decision appropriate to the environment.

Cloudflare account IDs, API tokens, and secrets must stay outside Git and should be supplied by the deployment environment.

## V2.6 local image ingest Worker

The image ingest Worker has its own configuration at `workers/image-ingest/wrangler.jsonc`. It downloads original Steam/IGDB image bytes and writes content-addressed objects through its local R2 binding; the CLI only sends an authenticated HTTP request. The Next app remains unchanged.

Before upgrading an existing V2.5 local D1 database, run the read-only gate from the repository root:

```bash
npx tsx scripts/check-image-migration.ts
```

Both `legacyStorageUrlCount` and `duplicateIdentityCount` must be exactly **0**, and the command must exit successfully. Any nonzero count or query failure is a STOP: inspect the target database without clearing storage URLs, guessing metadata, or deduplicating rows. Only then apply migration 4:

```bash
npm run db:migrate:local
npm run db:check:local
```

Migration count is now **4**. This gate is a pre-upgrade check against the actual V2.5 target; rerunning it after legitimate V2.6 image writes will report non-null storage URLs. The script uses local D1 only. Preview/production rollout requires a separately authorized read-only check of that exact target, the same two zero counts, and a reviewed migration; none of these local commands accesses a remote database.

Copy `workers/image-ingest/.dev.vars.example` to the ignored `workers/image-ingest/.dev.vars` and replace its token placeholder with a local token. Use the same token for the CLI's `IMAGE_INGEST_TOKEN` environment variable. Start the local Worker from the repository root with the same persisted state used by the importers and migration gate:

```bash
npx wrangler dev --config workers/image-ingest/wrangler.jsonc --local --persist-to "$PWD/.wrangler/state" --port 8787
```

In another terminal, set `IMAGE_INGEST_TOKEN` to that local token and run against an existing canonical game ID:

```bash
export IMAGE_INGEST_WORKER_URL=http://127.0.0.1:8787
npm run images:ingest -- 123
npm run images:ingest -- 123 --json
npm run images:ingest -- 123 --write
```

Dry-run performs real HTTP, image validation/hash, and R2 HEAD, with **zero R2 PUT and zero D1 writes**. Write mode performs create-only R2 PUT before optimistic D1 binding. Each image's outcome, source identity, redirects, HTTP status, validation/hash/dimension diagnostics, timing, and stage-specific error are returned in sanitized human/JSON output. Credentials, fragments, and sensitive query values never appear in presentation; malformed URLs become `[INVALID_URL]`.

The default endpoint is local; a remote Worker requires an explicitly supplied endpoint and token. Do not deploy the committed placeholder IDs, example domains, or token. Preview and production require separate approved bindings, a custom image domain (no `r2.dev`), and a Workers Paid plan or explicitly sufficient subrequest quota. The configured invocation CPU limit is 30,000 ms; confirm it is below the target account's allowed CPU limit. This is separate from the enforced 5-minute game, 30-second image, and 10-second response-header wall-clock deadlines. V2.6 processes at most 128 images serially and consumes at most 8 MiB per image.

Local verification (requires localhost/process access):

```bash
npm test -- test/images/worker-d1-r2.integration.test.ts test/images/migration-preflight.test.ts
npx wrangler deploy --dry-run --config workers/image-ingest/wrangler.jsonc
```

The integration suite uses local D1/R2 and a test-only workerd entrypoint for fixture HTTP. Its fixture transport and diagnostic headers are not bundled into the production Worker. The dry-run command bundles only; it does not provision or deploy resources.

## Website static deployment

The public website is a native Next.js static export. Build it with `npm run build` (or `npx next build --webpack` in environments where Turbopack cannot start worker processes); the generated `out/` directory contains the deployable site. `/games` and `/search` are static shells that restore query parameters in the browser, while game data remains local mock data. This launch does not enable D1, R2, Cron, Workers, Containers, API routes, or server actions.

## V2.7 local bulk game sync

Bulk sync runs the Steam import, IGDB enrichment, official-link verification, and image ingest stages serially for up to 100 Steam App IDs. Start the image Worker from the repository root, using the repository's shared local state:

```bash
npx wrangler dev --config workers/image-ingest/wrangler.jsonc --local --persist-to .wrangler/state --port 8787
npm run games:sync -- 1245620 1091500 292030
npm run games:sync -- --file games.txt --json
npm run games:sync -- --file games.txt --write
```

The UTF-8 input file contains one Steam App ID per line; blank lines and lines beginning with `#` are ignored. Positional and file inputs expand left-to-right, with first-wins deduplication and a maximum of 100 distinct IDs. The default is dry-run. `--write` is the only mode that mutates local D1 or asks the image Worker to write R2/D1 state.

Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `IMAGE_INGEST_TOKEN` out-of-band. The Worker's `IMAGE_INGEST_TOKEN` must equal the CLI token through local secret configuration. The Worker and CLI must use the same repository `.wrangler/state/v3` and local `gamehub` D1 identity. The CLI cannot introspect the Worker binding; shared state is an operator precondition. There is no remote bulk target.

For an existing canonical game, dry-run executes all four stages. If Steam instead plans a new canonical game, later stages report `canonical_game_not_persisted`; dry-run never temporarily writes D1. A stage failure stops later stages for that game, while the next game continues. Completed earlier stages are not rolled back, and V2.7 has no automatic retry engine. Human and `--json` output identify failed App IDs; rerun those IDs explicitly after resolving the cause.

## V2.8 private Cloudflare Cron sync

The separate `workers/cron-sync` Worker refreshes existing canonical games through Steam, IGDB, private official-link verification, and the scheduled Image service. Every public request returns 404. There is no manual sync route, retry service, R2 binding, or Durable Object scheduler. The registered `OfficialLinkVerifier` Durable Object owns only the official Container lifecycle; the Node server admits one verification at a time. D1 remains the sole scheduler and mutation authority.

`workers/cron-sync/wrangler.jsonc` ships with **no active Cron triggers**, no routes, and disabled workers.dev/preview URLs. The intended daily expression (`0 3 * * *`, 03:00 UTC) is documented in the deployment configuration. Scheduler defaults are batch 25, 900-second platform wall budget, 720-second soft deadline, 780-second game admission reserve, 30-second finish reserve, and a 1,500-second lease. Initial deployment explicitly selects batch 1. These conservative reserves can stop a batch before all selected games start; they must not be reduced without measured worst-case evidence.

Each stage checks the primary D1 lease before execution. All business writes use the scheduled fenced stores; a final fence assertion also catches late provider errors and IGDB existing/blocked paths that make no business writes. Authority loss prevents later stages and lease release. Ambiguous Image delivery retains the lease until expiry. There is no automatic replay of an uncertain mutation.

Local checks from the repository root:

```bash
npx vitest run workers/cron-sync/src
npx vitest run lib/scheduler/cron.integration.test.ts lib/scheduler/security.test.ts lib/scheduler/deployment.test.ts
npm run typecheck
npm run cron:typecheck
npm run lint
WRANGLER_LOG_PATH=/tmp/gamehub-cron-wrangler.log npm run cron:bundle
```

`cron:bundle` is strictly a dry run, writes the Worker and esbuild metafile to `/tmp/gamehub-cron-bundle`, and uses `--containers-rollout=none`. It verifies the Worker bundle without Docker; it does **not** build, execute, deploy, or update the Container image. The metafile must contain no Node DNS/HTTP/HTTPS/net transport, child process, local Wrangler acquisition, CLI sync composition, or R2 writer. TypeScript follows some shared type-only Node imports; they are absent from the Worker runtime bundle.

Bindings are generated with `wrangler types --config workers/cron-sync/wrangler.jsonc --include-runtime false workers/cron-sync/worker-configuration.d.ts`. Copy the Cron `.dev.vars.example` only for local testing, and use the Image Worker's `cron-local` environment for the same isolated `gamehub-cron-isolated` D1 identity. Give both local Workers the same explicitly chosen temporary persistence directory, separate from the existing `.wrangler/state`; the Image environment uses a distinct local R2 bucket. Local D1 fixtures create their own temporary migration/state directories and need loopback/process access. Running the actual Container requires Docker. No test invokes a deploy or remote database mutation.

Deployment is a separately authorized operation, in this order:

1. Keep Cron disabled. Confirm a Workers Paid account with Containers and the configured 300,000 ms CPU limit, plus the 900-second scheduled wall budget. Replace both production D1 placeholders with the **same real database UUID**, and verify the Cron Image service points to the corresponding private Image Worker. `CRON_PAID_PLAN_CONFIRMED=true npm run cron:readiness` fails closed on placeholders, mismatched database/service identities, public routing, or wrong CPU limits. This confirmation is an operator assertion after account verification, not an entitlement probe.
2. Apply only the additive `0004_cron_sync_fencing.sql` migration once to the reviewed target (five total migrations). Never reset its epoch singleton. Configure the Image Worker's scheduled route and a new `IMAGE_INGEST_SCHEDULED_TOKEN`, distinct from its legacy token. Configure the same scheduled token on Cron. Set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `VERIFIER_SERVICE_SECRET` through secret storage; Cron has no legacy Image credential. Only `VERIFIER_SERVICE_SECRET` enters the Container environment, never Twitch credentials, Image tokens, D1 authority, or bindings.
3. Build and deploy the matching Cron/Container protocol version with Docker and the official Container registration. The SDK is pinned to `@cloudflare/containers` **0.3.7**, verified from the npm registry on 2026-09-18; its package integrity is `sha512-DM9dm3FnIBSyiSJ1FLavKwl/lk3oAmTaynCzZQ9pZR0ncRPquSxkxd8Nu2MFILxmDDsPkxKsSNEh9mHHMty4Fw==` and is recorded in the lockfile. The Node 24.20.0 OCI digest is pinned in `containers/official-link-verifier/Dockerfile` (registry evidence documented there). The fixed instance `official-links-v1` listens on port 8080 and sleeps after five idle minutes; startup has a ten-second ceiling and consumes the existing twenty-second link budget. The full Links stage retains its 300-second deadline.
4. Prove authenticated protocol behavior, actual Container DNS lookup/connected peer/Host/SNI/certificate checks, shared D1 visibility, stale-owner fencing through Image and R2 completion, and bounded cold-start/request timing in the real target. Unit tests and a Worker dry run are not evidence of these platform properties.
5. Run a separately authorized batch-1 canary and an idempotency check. Review approved scalar event logs and D1 attempt state. Logs reject unknown keys and never serialize complete game results, URLs, authority tokens, credentials, or exception objects. A log sink failure is ignored once and never retries work.
6. Enable the daily trigger only after actual CPU/wall-budget evidence and the preceding gates pass. Increase the batch size only within the validated 1–25 range and measured admission budget.

Rollback first disables triggers. Keep the fenced Image endpoint and epoch table, allowing old in-flight operations to remain fenced; do not delete/reset lease rows, clear epochs, or apply a down migration. Revert compatible application versions only after accounting for retained/uncertain work. A disaster restore that lowers epochs requires revoking old callers and their credentials **before** restored state becomes writable.

The SDK lifecycle and binding API were checked against the [official Containers documentation](https://developers.cloudflare.com/containers/get-started/) and installed versioned declarations. Actual Docker execution and Cloudflare canary evidence remain release gates; the repository does not imply that those operations have been performed.

The Cron integration harness runs the production Cron composition against real isolated local D1/R2, separate bindings sharing one temporary persistence root, a real authenticated Node HTTP verifier, and the authenticated Image handler served over loopback HTTP. Provider responses and the verifier's target observation are controlled fixtures; the Cloudflare Container base class is substituted because Node cannot instantiate that platform class. Tests cover repeat ingestion, stale responses, native image deadlines with pending writes, takeover, resource cleanup, and safe failures. These tests do not replace actual Docker/Cloudflare socket, ingress, cold-start, or budget verification. See the [V2.8 final verification report](docs/superpowers/reports/2026-09-15-gamehub-v2-8-final-verification.md) for command results and blocked gates.
