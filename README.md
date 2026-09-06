# GameHub

Game database with official websites, stores, downloads, demos, and launcher links. V2.1 adds a Cloudflare D1 and Drizzle data foundation; the accepted V1 UI intentionally continues to read `lib/mock-data.ts`.

## Local development

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

All human and JSON output passes through the same presentation sanitizer. URL query secrets are replaced with `[REDACTED]`; credentials and fragments are omitted, and malformed URLs become `[REDACTED_URL]`. Raw DNS, TLS, D1, environment, and stack details are not printed; JSON may include a normalized approved public address for local diagnostics.

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
