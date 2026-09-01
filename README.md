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
