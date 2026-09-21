import { readdir, readFile } from "node:fs/promises";
import type { AnyD1Database } from "drizzle-orm/d1";
import { afterEach, describe, expect, it } from "vitest";

const allColumns = [
  "id", "game_id", "provider", "platform", "link_type", "url", "region",
  "is_official", "verification_status", "verification_method", "http_status",
  "redirect_url", "verified_at", "last_checked_at", "created_at", "updated_at",
] as const;

const legalStatuses = [
  "unverified", "pending", "verified", "failed",
  "reachable_but_unverified", "broken", "temporarily_unavailable", "unsafe", "unknown",
] as const;

type SqlRow = Record<string, unknown>;
type TableSnapshot = {
  columns: SqlRow[];
  foreignKeys: SqlRow[];
  indexes: Array<SqlRow & { columns: string[] }>;
  schema: SqlRow[];
};

async function createBinding() {
  process.env.WRANGLER_LOG_PATH = "/tmp/gamehub-official-link-status-test.log";
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy<{ DB: AnyD1Database }>({
    configPath: new URL("../../wrangler.jsonc", import.meta.url).pathname,
    persist: false,
    remoteBindings: false,
  });
  return { binding: platform.env.DB, dispose: platform.dispose };
}

async function migrationFiles() {
  const migrationsDirectory = new URL("../../drizzle/", import.meta.url);
  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return { files, migrationsDirectory };
}

async function applyMigrations(binding: AnyD1Database, files: string[]) {
  const { migrationsDirectory } = await migrationFiles();
  for (const file of files) {
    const migration = await readFile(new URL(file, migrationsDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      const sql = statement.trim();
      if (sql) await binding.prepare(sql).run();
    }
  }
}

async function rows(binding: AnyD1Database, sql: string): Promise<SqlRow[]> {
  return (await binding.prepare(sql).all<SqlRow>()).results;
}

async function inspectTable(binding: AnyD1Database): Promise<TableSnapshot> {
  const indexes = await rows(binding, "PRAGMA index_list('game_official_links')");
  return {
    columns: await rows(binding, "PRAGMA table_info('game_official_links')"),
    foreignKeys: await rows(binding, "PRAGMA foreign_key_list('game_official_links')"),
    indexes: await Promise.all(indexes.map(async (index) => ({
      ...index,
      columns: (await rows(binding, `PRAGMA index_info('${index.name}')`)).map((column) => String(column.name)),
    }))),
    schema: await rows(binding, `
      SELECT type, name, sql
      FROM sqlite_schema
      WHERE tbl_name = 'game_official_links'
        AND type IN ('table', 'index')
      ORDER BY type, name
    `),
  };
}

function normalizedTableSql(snapshot: TableSnapshot) {
  return String(snapshot.schema.find((entry) => entry.type === "table")?.sql)
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizedIndexes(snapshot: TableSnapshot) {
  return snapshot.indexes
    .map(({ name, unique, columns }) => ({ name, unique, columns }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function withoutStatusValues(tableSql: string) {
  return tableSql
    .replace(/^create table [`"]game_official_links[`"]/, "create table game_official_links")
    .replace(
      /constraint "game_official_links_status_check" check\(.*?\)\)/,
      'constraint "game_official_links_status_check" check(<verification-status-values>)',
    );
}

describe("official link verification-status migration", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  it("preserves the complete official-link contract when upgrading an existing D1 database", async () => {
    const { files } = await migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files[2]).toMatch(/^0002_.*\.sql$/);
    expect(files[4]).toBe("0004_cron_sync_fencing.sql");

    const upgraded = await createBinding();
    disposers.push(upgraded.dispose);
    await applyMigrations(upgraded.binding, files.slice(0, 2));
    await upgraded.binding.prepare(`
      INSERT INTO games (id, slug, title, created_at, updated_at)
      VALUES (11, 'preserved-game', 'Preserved Game', 1700000000000, 1700000000001)
    `).run();
    await upgraded.binding.prepare(`
      INSERT INTO game_official_links (
        id, game_id, provider, platform, link_type, url, region, is_official,
        verification_status, verification_method, http_status, redirect_url,
        verified_at, last_checked_at, created_at, updated_at
      ) VALUES (
        17, 11, 'publisher', 'windows', 'official_website', 'https://example.com/game', 'US', 0,
        'failed', 'http', 503, 'https://status.example.com/game',
        1700000000002, 1700000000003, 1700000000004, 1700000000005
      )
    `).run();

    const before = await inspectTable(upgraded.binding);
    const migration = await readFile(new URL(files[2]!, (await migrationFiles()).migrationsDirectory), "utf8");
    const normalizedMigration = migration.replace(/\s+/g, " ").toLowerCase();
    const quotedColumns = allColumns.map((column) => `"${column}"`).join(", ");

    expect(migration.match(/create table/gi)).toHaveLength(1);
    expect(normalizedMigration).toContain("pragma defer_foreign_keys=on");
    expect(normalizedMigration).toContain("pragma defer_foreign_keys=off");
    expect(normalizedMigration).toContain(
      `insert into \`__new_game_official_links\`(${quotedColumns}) select ${quotedColumns} from \`game_official_links\``,
    );
    expect(normalizedMigration).not.toMatch(/select\s+\*/);

    await applyMigrations(upgraded.binding, [files[2]!]);
    const after = await inspectTable(upgraded.binding);

    expect(await rows(upgraded.binding, `
      SELECT ${allColumns.join(", ")}
      FROM game_official_links
      WHERE id = 17
    `)).toEqual([{
      id: 17,
      game_id: 11,
      provider: "publisher",
      platform: "windows",
      link_type: "official_website",
      url: "https://example.com/game",
      region: "US",
      is_official: 0,
      verification_status: "failed",
      verification_method: "http",
      http_status: 503,
      redirect_url: "https://status.example.com/game",
      verified_at: 1700000000002,
      last_checked_at: 1700000000003,
      created_at: 1700000000004,
      updated_at: 1700000000005,
    }]);
    expect(after.columns).toEqual(before.columns);
    expect(after.columns.map(({ name, type, notnull, dflt_value, pk }) => ({
      name,
      type,
      notnull,
      dflt_value,
      pk,
    }))).toEqual([
      { name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
      { name: "game_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "provider", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "platform", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "link_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "url", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "region", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "is_official", type: "INTEGER", notnull: 1, dflt_value: "true", pk: 0 },
      { name: "verification_status", type: "TEXT", notnull: 1, dflt_value: "'unverified'", pk: 0 },
      { name: "verification_method", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "http_status", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "redirect_url", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "verified_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "last_checked_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: "unixepoch('subsec') * 1000", pk: 0 },
      { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: "unixepoch('subsec') * 1000", pk: 0 },
    ]);
    expect(after.foreignKeys).toEqual(before.foreignKeys);
    expect(after.foreignKeys).toEqual([{
      id: 0,
      seq: 0,
      table: "games",
      from: "game_id",
      to: "id",
      on_update: "NO ACTION",
      on_delete: "CASCADE",
      match: "NONE",
    }]);
    expect(after.indexes).toEqual(before.indexes);
    expect(normalizedIndexes(after)).toEqual([
      {
        name: "game_official_links_game_id_type_idx",
        unique: 0,
        columns: ["game_id", "link_type"],
      },
      {
        name: "game_official_links_game_id_url_unique",
        unique: 1,
        columns: ["game_id", "url"],
      },
      {
        name: "game_official_links_verification_idx",
        unique: 0,
        columns: ["verification_status", "last_checked_at"],
      },
    ]);

    const tableSql = normalizedTableSql(after);
    expect(tableSql.match(/check\(/g)).toHaveLength(4);
    expect(tableSql).toContain("constraint \"game_official_links_type_check\" check");
    expect(tableSql).toContain("constraint \"game_official_links_status_check\" check");
    expect(tableSql).toContain("constraint \"game_official_links_method_check\" check");
    expect(tableSql).toContain("constraint \"game_official_links_http_status_check\" check");
    for (const status of legalStatuses) expect(tableSql).toContain(`'${status}'`);
    expect(withoutStatusValues(tableSql)).toBe(withoutStatusValues(normalizedTableSql(before)));

    for (const [index, verificationStatus] of legalStatuses.entries()) {
      await upgraded.binding.prepare(`
        INSERT INTO game_official_links (
          id, game_id, provider, link_type, url, verification_status
        ) VALUES (?, 11, 'publisher', 'store', ?, ?)
      `).bind(100 + index, `https://example.com/status/${verificationStatus}`, verificationStatus).run();
    }
    expect((await rows(upgraded.binding, `
      SELECT verification_status
      FROM game_official_links
      WHERE id >= 100
      ORDER BY id
    `)).map((row) => row.verification_status)).toEqual(legalStatuses);
    await expect(upgraded.binding.prepare(`
      INSERT INTO game_official_links (
        id, game_id, provider, link_type, url, verification_status
      ) VALUES (999, 11, 'publisher', 'store', 'https://example.com/status/illegal', 'not-a-status')
    `).run()).rejects.toThrow();

    expect(await rows(upgraded.binding, "PRAGMA foreign_key_check")).toEqual([]);
    await upgraded.binding.prepare("DELETE FROM games WHERE id = 11").run();
    expect(await rows(upgraded.binding, "SELECT id FROM game_official_links WHERE game_id = 11")).toEqual([]);
  });

  it("has the same official-link table and index SQL for fresh and upgraded D1 databases", async () => {
    const { files } = await migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);

    const fresh = await createBinding();
    const upgraded = await createBinding();
    disposers.push(fresh.dispose, upgraded.dispose);
    await applyMigrations(fresh.binding, files);
    await applyMigrations(upgraded.binding, files.slice(0, 2));
    await applyMigrations(upgraded.binding, [files[2]!]);

    expect(await inspectTable(fresh.binding)).toEqual(await inspectTable(upgraded.binding));
    expect(await rows(fresh.binding, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await rows(upgraded.binding, "PRAGMA foreign_key_check")).toEqual([]);
  });
});
