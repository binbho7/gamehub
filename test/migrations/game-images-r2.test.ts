import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../lib/db/client";
import * as validation from "../../lib/db/validation";

const imageColumns = [
  "id", "game_id", "type", "source_url", "source_provider", "storage_url",
  "storage_key", "content_hash", "mime_type", "file_size", "width", "height",
  "sort_order", "created_at", "updated_at",
] as const;

type SqlRow = Record<string, unknown>;
type LocalStatement = {
  bind(...params: unknown[]): LocalStatement;
  run(...params: unknown[]): Promise<unknown>;
  all<T = SqlRow>(...params: unknown[]): Promise<{ results: T[] }>;
  get<T = SqlRow>(...params: unknown[]): Promise<T | undefined>;
  raw(...params: unknown[]): Promise<unknown[][]>;
};

type LocalBinding = {
  prepare(sql: string): LocalStatement;
};

type AnyD1Database = LocalBinding;

type TableSnapshot = {
  columns: SqlRow[];
  foreignKeys: SqlRow[];
  indexes: Array<SqlRow & { columns: string[] }>;
  schema: SqlRow[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createLocalTestBinding() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");

  const wrapStatement = (sql: string, bound: unknown[] | Record<string, unknown> | undefined): LocalStatement => {
    const statement = database.prepare(sql);
    const execute = <T>(method: "run" | "all" | "get", params: unknown[]): T => {
      const actualParams = params.length > 0
        ? params
        : bound === undefined
          ? []
          : Array.isArray(bound)
            ? bound
            : [bound];
      if (method === "run") return statement.run(...(actualParams as never[])) as T;
      if (method === "get") return statement.get(...(actualParams as never[])) as T;
      return statement.all(...(actualParams as never[])) as T;
    };

    return {
      bind(...params: unknown[]) {
        return wrapStatement(sql, params.length === 1 && isPlainObject(params[0]) ? params[0] : params);
      },
      run(...params: unknown[]) {
        return Promise.resolve(execute("run", params));
      },
      all<T = SqlRow>(...params: unknown[]) {
        return Promise.resolve({ results: execute<T[]>("all", params) });
      },
      get<T = SqlRow>(...params: unknown[]) {
        return Promise.resolve(execute<T | undefined>("get", params));
      },
      raw(...params: unknown[]) {
        const rows = execute<SqlRow[]>("all", params);
        const columns = statement.columns().map((column) => column.name);
        return Promise.resolve(rows.map((row) => columns.map((column) => row[column as keyof SqlRow])));
      },
    };
  };

  return {
    binding: {
      prepare(sql: string) {
        return wrapStatement(sql, undefined);
      },
    } satisfies LocalBinding,
    dispose: async () => {
      database.close();
    },
  };
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
  const indexes = await rows(binding, "PRAGMA index_list('game_images')");
  return {
    columns: await rows(binding, "PRAGMA table_info('game_images')"),
    foreignKeys: await rows(binding, "PRAGMA foreign_key_list('game_images')"),
    indexes: await Promise.all(indexes.map(async (index) => ({
      ...index,
      columns: (await rows(binding, `PRAGMA index_info('${index.name}')`)).map((column) => String(column.name)),
    }))),
    schema: await rows(binding, `
      SELECT type, name, sql
      FROM sqlite_schema
      WHERE tbl_name = 'game_images'
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

describe("game image migration r2", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  it("rebuilds the image table with explicit metadata columns and preserves legacy rows", async () => {
    const { files, migrationsDirectory } = await migrationFiles();
    expect(files).toHaveLength(5);
    expect(files[3]).toMatch(/^0003_.*\.sql$/);
    expect(files[4]).toBe("0004_cron_sync_fencing.sql");

    const binding = createLocalTestBinding();
    disposers.push(binding.dispose);
    await applyMigrations(binding.binding as unknown as AnyD1Database, files.slice(0, 3));

    await binding.binding.prepare(`
      INSERT INTO games (id, slug, title, created_at, updated_at)
      VALUES (31, 'image-game', 'Image Game', 1700000000100, 1700000000101)
    `).run();
    await binding.binding.prepare(`
      INSERT INTO game_images (
        id, game_id, type, source_url, storage_url, width, height, sort_order, created_at
      ) VALUES (
        71, 31, 'cover', 'https://img.example.com/cover.jpg', NULL,
        NULL, 900, 1, 1700000000200
      )
    `).run();
    await binding.binding.prepare(`
      INSERT INTO game_images (
        id, game_id, type, source_url, storage_url, width, height, sort_order, created_at
      ) VALUES (
        72, 31, 'screenshot', 'https://img.example.com/shot-1.jpg', NULL,
        1920, NULL, 0, 1700000000201
      )
    `).run();

    const before = await inspectTable(binding.binding as unknown as AnyD1Database);
    const migration = await readFile(new URL(files[3]!, migrationsDirectory), "utf8");
    const normalizedMigration = migration.replace(/\s+/g, " ").toLowerCase();
    const insertColumns = imageColumns.map((column) => `"${column}"`).join(", ");
    const selectColumns = [
      `"id"`,
      `"game_id"`,
      `"type"`,
      `"source_url"`,
      "null",
      `"storage_url"`,
      "null",
      "null",
      "null",
      "null",
      `"width"`,
      `"height"`,
      `"sort_order"`,
      `"created_at"`,
      `"created_at"`,
    ].join(", ");

    expect(migration.match(/create table/gi)).toHaveLength(1);
    expect(normalizedMigration).toContain("pragma defer_foreign_keys=on");
    expect(normalizedMigration).toContain("pragma defer_foreign_keys=off");
    expect(normalizedMigration).toContain(
      `insert into \`__new_game_images\`(${insertColumns}) select ${selectColumns} from \`game_images\``,
    );
    expect(normalizedMigration).not.toMatch(/select\s+\*/);

    await applyMigrations(binding.binding as unknown as AnyD1Database, [files[3]!]);
    const after = await inspectTable(binding.binding as unknown as AnyD1Database);

    expect(await rows(binding.binding as unknown as AnyD1Database, `
      SELECT ${imageColumns.join(", ")}
      FROM game_images
      ORDER BY sort_order, id
    `)).toEqual([
      {
        id: 72,
        game_id: 31,
        type: "screenshot",
        source_url: "https://img.example.com/shot-1.jpg",
        source_provider: null,
        storage_url: null,
        storage_key: null,
        content_hash: null,
        mime_type: null,
        file_size: null,
        width: 1920,
        height: null,
        sort_order: 0,
        created_at: 1700000000201,
        updated_at: 1700000000201,
      },
      {
        id: 71,
        game_id: 31,
        type: "cover",
        source_url: "https://img.example.com/cover.jpg",
        source_provider: null,
        storage_url: null,
        storage_key: null,
        content_hash: null,
        mime_type: null,
        file_size: null,
        width: null,
        height: 900,
        sort_order: 1,
        created_at: 1700000000200,
        updated_at: 1700000000200,
      },
    ]);

    expect(after.columns.map(({ name, type, notnull, dflt_value, pk }) => ({
      name,
      type,
      notnull,
      dflt_value,
      pk,
    }))).toEqual([
      { name: "id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
      { name: "game_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { name: "type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "source_url", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { name: "source_provider", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "storage_url", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "storage_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "content_hash", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "mime_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { name: "file_size", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "width", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "height", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      { name: "sort_order", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
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
        name: "game_images_game_order_idx",
        unique: 0,
        columns: ["game_id", "type", "sort_order", "id"],
      },
      {
        name: "game_images_game_sort_order_idx",
        unique: 0,
        columns: ["game_id", "sort_order", "id"],
      },
    ]);

    const tableSql = normalizedTableSql(after);
    expect(tableSql.match(/check\(/g)).toHaveLength(9);
    expect(tableSql).toContain("constraint \"game_images_type_check\" check");
    expect(tableSql).toContain("constraint \"game_images_width_check\" check");
    expect(tableSql).toContain("constraint \"game_images_height_check\" check");
    expect(tableSql).toContain("constraint \"game_images_sort_order_check\" check");
    expect(tableSql).toContain("constraint \"game_images_source_provider_check\" check");
    expect(tableSql).toContain("constraint \"game_images_storage_check\" check");
    expect(tableSql).toContain("constraint \"game_images_storage_size_check\" check");
    expect(tableSql).toContain("constraint \"game_images_storage_mime_check\" check");
    expect(tableSql).toContain("constraint \"game_images_storage_hash_check\" check");

    expect(await rows(binding.binding as unknown as AnyD1Database, "PRAGMA foreign_key_check")).toEqual([]);
    await binding.binding.prepare("DELETE FROM games WHERE id = 31").run();
    expect(await rows(binding.binding as unknown as AnyD1Database, "SELECT id FROM game_images WHERE game_id = 31")).toEqual([]);
  });

  it("reports legacy storage URLs and duplicate identities without mutating data", async () => {
    const { files } = await migrationFiles();
    const binding = createLocalTestBinding();
    disposers.push(binding.dispose);
    await applyMigrations(binding.binding as unknown as AnyD1Database, files.slice(0, 3));

    await binding.binding.prepare(`
      INSERT INTO games (id, slug, title, created_at, updated_at)
      VALUES (41, 'preflight-game', 'Preflight Game', 1700000000300, 1700000000301)
    `).run();
    await binding.binding.prepare(`
      INSERT INTO game_images (
        id, game_id, type, source_url, storage_url, width, height, sort_order, created_at
      ) VALUES (
        81, 41, 'cover', 'https://img.example.com/duplicate.jpg', 'https://cdn.example.com/legacy.jpg',
        1200, 800, 0, 1700000000302
      )
    `).run();
    await binding.binding.prepare(`
      INSERT INTO game_images (
        id, game_id, type, source_url, storage_url, width, height, sort_order, created_at
      ) VALUES (
        82, 41, 'hero', 'https://img.example.com/duplicate.jpg', NULL,
        NULL, NULL, 1, 1700000000303
      )
    `).run();

    const before = await rows(binding.binding as unknown as AnyD1Database, `
      SELECT id, game_id, type, source_url, storage_url
      FROM game_images
      ORDER BY id
    `);

    const database = createDatabase(binding.binding as never);
    await expect(validation.readImageMigrationPreflight(database)).resolves.toEqual({
      legacyStorageUrlCount: 1,
      duplicateIdentityCount: 1,
    });

    expect(await rows(binding.binding as unknown as AnyD1Database, `
      SELECT id, game_id, type, source_url, storage_url
      FROM game_images
      ORDER BY id
    `)).toEqual(before);
  });
});
