import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { is, SQL, sql } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pipelineRunItems, pipelineRuns } from "../../lib/db/schema";

const directory = new URL("../../drizzle/", import.meta.url);
const runHistory = '{"export":{"state":"pending","attemptCount":0,"reasonCode":null,"retryClass":"none"},"preview":{"state":"pending","attemptCount":0,"reasonCode":null,"retryClass":"none"},"publish-ready":{"state":"pending","attemptCount":0,"reasonCode":null,"retryClass":"none"}}';
const itemHistory = JSON.stringify(Object.fromEntries(
  ["discover", "import", "enrich", "verify", "images", "evaluate"].map((stage) => [stage, {
    state: "pending", attemptCount: 0, reasonCode: null, retryClass: "none",
 }]),
));

const dialect = new SQLiteSyncDialect();
function sqlTokens(source: string): string[] {
  // Ignore formatting/identifier quoting, but preserve string literals verbatim.
  return (source.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|[a-zA-Z_][\w]*|\d+|<>|>=|<=|!=|[^\s]/g) ?? [])
    .map((token) => token.startsWith("'") ? token : token.replace(/^["`]|["`]$/g, "").toLowerCase());
}

function normalizedSql(source: string): string {
  return sqlTokens(source).join(" ");
}

function checkExpressions(createTableSql: string): string[] {
  const tokens = sqlTokens(createTableSql);
  const checks: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "check" || tokens[index + 1] !== "(") continue;
    const start = index + 2;
    let depth = 1;
    index = start;
    for (; index < tokens.length && depth > 0; index += 1) {
      if (tokens[index] === "(") depth += 1;
      if (tokens[index] === ")") depth -= 1;
    }
    expect(depth, "balanced CHECK expression").toBe(0);
    checks.push(tokens.slice(start, index - 1).join(" "));
  }
  return checks.sort();
}

describe("pipeline SQL contract", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) db.exec(readFileSync(new URL(file, directory), "utf8"));
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name))
      .toEqual(expect.arrayContaining(["pipeline_runs", "pipeline_run_items"]));
    db.prepare(`INSERT INTO pipeline_runs
      (run_id,manifest_hash,pipeline_version,policy_version,snapshot_date,status,run_stage_states_json,created_at,updated_at)
      VALUES('run',?,'2.10','1','2026-09-19','created',?,10,10)`).run("a".repeat(64), runHistory);
    db.prepare(`INSERT INTO pipeline_run_items
      (run_id,ordinal,steam_app_id,current_stage,current_state,stage_states_json,updated_at)
      VALUES('run',1,'123','discover','pending',?,10)`).run(itemHistory);
  });
  afterEach(() => db?.close());

  it("stores canonical histories unchanged with nullable gates and default attempts", () => {
    expect(db.prepare("SELECT * FROM pipeline_runs").get()).toEqual({
      run_id: "run", manifest_hash: "a".repeat(64), pipeline_version: "2.10", policy_version: "1",
      snapshot_date: "2026-09-19", status: "created", current_stage: null,
      run_stage_states_json: runHistory, artifact_sha256: null, created_at: 10, updated_at: 10,
    });
    expect(db.prepare("SELECT * FROM pipeline_run_items").get()).toEqual({
      run_id: "run", ordinal: 1, steam_app_id: "123", game_id: null, current_stage: "discover",
      current_state: "pending", attempt_count: 0, stage_states_json: itemHistory,
      reason_code: null, retry_class: null, updated_at: 10,
    });
  });

  it.each([
    "manifest_hash='short'", "pipeline_version='2.9'", "policy_version=''",
    "policy_version='123456789012345678901234567890123'", "snapshot_date='2026-9-19'",
    "status='unknown'", "current_stage='import'", "artifact_sha256='short'",
    `artifact_sha256='${"A".repeat(64)}'`, `artifact_sha256='${"g".repeat(64)}'`,
    "updated_at=9", "run_stage_states_json=NULL", "run_id=NULL", "manifest_hash=NULL",
    "pipeline_version=NULL", "policy_version=NULL", "snapshot_date=NULL", "status=NULL",
    "created_at=NULL", "updated_at=NULL",
  ])("rejects invalid run values: %s", (assignment) => {
    expect(() => db.exec(`UPDATE pipeline_runs SET ${assignment}`)).toThrow(/constraint failed/i);
  });

  it.each([
    "ordinal=0", "ordinal=-1", "steam_app_id=''", "steam_app_id='0'", "steam_app_id='0123'",
    "steam_app_id='12a'", "steam_app_id='-1'", "steam_app_id='1.2'", "steam_app_id='１２３'",
    "current_stage='export'", "current_state='ready'", "attempt_count=-1", "attempt_count=4",
    "retry_class='unknown'", "stage_states_json=NULL", "run_id=NULL", "ordinal=NULL",
    "steam_app_id=NULL", "current_stage=NULL", "current_state=NULL", "attempt_count=NULL", "updated_at=NULL",
  ])("rejects invalid item values: %s", (assignment) => {
    expect(() => db.exec(`UPDATE pipeline_run_items SET ${assignment}`)).toThrow(/constraint failed/i);
  });

  it("accepts all planned enum values and SQL boundaries without adding application validation", () => {
    for (const status of ["created", "running", "paused", "failed", "ready"])
      db.prepare("UPDATE pipeline_runs SET status=?").run(status);
    for (const stage of [null, "export", "preview", "publish-ready"])
      db.prepare("UPDATE pipeline_runs SET current_stage=?").run(stage);
    for (const stage of ["discover", "import", "enrich", "verify", "images", "evaluate"])
      db.prepare("UPDATE pipeline_run_items SET current_stage=?").run(stage);
    for (const state of ["pending", "running", "succeeded", "retryable_failed", "permanently_failed", "blocked", "skipped"])
      db.prepare("UPDATE pipeline_run_items SET current_state=?").run(state);
    for (const retry of [null, "none", "retryable", "permanent", "blocked", "run_fatal"])
      db.prepare("UPDATE pipeline_run_items SET retry_class=?").run(retry);
    for (const attempt of [0, 1, 2, 3]) db.prepare("UPDATE pipeline_run_items SET attempt_count=?").run(attempt);
    for (const hash of [null, "0123456789abcdef".repeat(4)])
      db.prepare("UPDATE pipeline_runs SET artifact_sha256=?").run(hash);
    db.prepare("UPDATE pipeline_runs SET policy_version=?,manifest_hash=?").run("p".repeat(32), "Z".repeat(64));
    // Section 1.7 deliberately leaves identity/JSON/date semantics and integer validation to the app.
    db.exec("UPDATE pipeline_runs SET run_stage_states_json='opaque',snapshot_date='2026-99-99'");
    db.exec("UPDATE pipeline_run_items SET ordinal=1.5,attempt_count=1.5,stage_states_json='opaque'");
  });

  it("enforces identities, foreign keys, cascade and set-null without deleting a run item", () => {
    expect(() => db.exec("INSERT INTO pipeline_runs SELECT * FROM pipeline_runs")).toThrow(/UNIQUE/);
    expect(() => db.exec(`INSERT INTO pipeline_runs SELECT 'other',manifest_hash,pipeline_version,policy_version,
      snapshot_date,status,current_stage,run_stage_states_json,artifact_sha256,created_at,updated_at FROM pipeline_runs`)).toThrow(/UNIQUE/);
    expect(() => db.exec("INSERT INTO pipeline_run_items SELECT * FROM pipeline_run_items")).toThrow(/UNIQUE/);
    expect(() => db.exec(`INSERT INTO pipeline_run_items SELECT run_id,2,steam_app_id,game_id,current_stage,
      current_state,attempt_count,stage_states_json,reason_code,retry_class,updated_at FROM pipeline_run_items`)).toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE pipeline_run_items SET run_id='missing'")).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("UPDATE pipeline_run_items SET game_id=999")).toThrow(/FOREIGN KEY/);
    db.exec("INSERT INTO games(id,slug,title) VALUES(1,'seed','Seed')");
    db.exec("UPDATE pipeline_run_items SET game_id=1");
    db.exec("DELETE FROM games WHERE id=1");
    expect(db.prepare("SELECT game_id FROM pipeline_run_items").all()).toEqual([{ game_id: null }]);
    db.exec("DELETE FROM pipeline_runs WHERE run_id='run'");
    expect(db.prepare("SELECT * FROM pipeline_run_items").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("provides all four scheduling indexes in the required column order", () => {
    for (const [name, columns] of [
      ["pipeline_runs_status_idx", ["status", "updated_at", "run_id"]],
      ["pipeline_items_pending_idx", ["run_id", "current_stage", "current_state", "ordinal"]],
      ["pipeline_items_retryable_idx", ["run_id", "current_state", "ordinal"]],
      ["pipeline_items_game_idx", ["game_id"]],
    ] as const) expect(db.prepare(`PRAGMA index_info('${name}')`).all().map((row) => row.name)).toEqual(columns);
  });

  it.each([pipelineRuns, pipelineRunItems])("keeps the complete Drizzle table contract aligned with applied SQL (%#)", (table) => {
      const config = getTableConfig(table);
      const columns = db.prepare(`PRAGMA table_info('${config.name}')`).all();
      expect(columns.map((column) => ({
        name: column.name, type: String(column.type).toLowerCase(), notNull: Boolean(column.notnull),
        default: column.dflt_value === null ? null : normalizedSql(String(column.dflt_value)),
      }))).toEqual(config.columns.map((column) => ({
        name: column.name, type: column.getSQLType(), notNull: column.notNull,
        default: column.default === undefined ? null : normalizedSql(dialect.sqlToQuery(
          is(column.default, SQL) ? column.default : sql`${column.default}`.inlineParams(),
        ).sql),
      })));
      expect(columns.filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk)).map((column) => column.name))
        .toEqual([
          ...config.columns.filter((column) => column.primary).map((column) => column.name),
          ...config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
        ]);

      const tableSql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
        .get(config.name)!.sql);
      expect(checkExpressions(tableSql)).toEqual(config.checks
        .map((check) => normalizedSql(dialect.sqlToQuery(check.value).sql)).sort());

      // Compare every explicit index, including Drizzle's column/table UNIQUE declarations.
      const expectedIndexes = [
        ...config.indexes.map(({ config: index }) => ({
          name: index.name, unique: index.unique,
          columns: index.columns.map((column) => is(column, SQL)
            ? dialect.sqlToQuery(column).sql : `"${column.name}"`),
          where: index.where ? dialect.sqlToQuery(index.where).sql : undefined,
        })),
        ...config.uniqueConstraints.map((constraint) => ({
          name: constraint.getName(), unique: true,
          columns: constraint.columns.map((column) => `"${column.name}"`), where: undefined,
        })),
        ...config.columns.filter((column) => column.isUnique).map((column) => ({
          name: column.uniqueName, unique: true, columns: [`"${column.name}"`], where: undefined,
        })),
      ].map((index) => normalizedSql(`CREATE ${index.unique ? "UNIQUE " : ""}INDEX "${index.name}"
        ON "${config.name}" (${index.columns.join(",")})${index.where ? ` WHERE ${index.where}` : ""}`)).sort();
      expect(db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
        .all(config.name).map((index) => normalizedSql(String(index.sql))).sort()).toEqual(expectedIndexes);

      const sortRows = <T,>(rows: T[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      expect(sortRows(db.prepare(`PRAGMA foreign_key_list('${config.name}')`).all().map((key) => ({
        seq: key.seq, from: key.from, table: key.table, to: key.to,
        onUpdate: String(key.on_update).toLowerCase(), onDelete: String(key.on_delete).toLowerCase(),
      })))).toEqual(sortRows(config.foreignKeys.flatMap((key) => {
        const reference = key.reference();
        return reference.columns.map((column, seq) => ({
          seq, from: column.name, table: getTableConfig(reference.foreignTable).name,
          to: reference.foreignColumns[seq].name,
          onUpdate: key.onUpdate ?? "no action", onDelete: key.onDelete ?? "no action",
        }));
      })));
  });

  it("keeps migration metadata aligned and contains no existing-table rebuild", () => {
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", directory), "utf8"));
    expect(journal.entries[5]).toMatchObject({ idx: 5, tag: "0005_pipeline_runs", version: "6", breakpoints: true });
    const before = JSON.parse(readFileSync(new URL("meta/0004_snapshot.json", directory), "utf8"));
    const after = JSON.parse(readFileSync(new URL("meta/0005_snapshot.json", directory), "utf8"));
    expect(after.prevId).toBe(before.id);
    for (const [name, table] of Object.entries(before.tables)) expect(after.tables[name]).toEqual(table);
    expect(Object.keys(after.tables).filter((name) => !(name in before.tables)).sort())
      .toEqual(["pipeline_run_items", "pipeline_runs"]);
    const statements = readFileSync(new URL("0005_pipeline_runs.sql", directory), "utf8")
      .split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
    for (const statement of statements) {
      expect(statement).toMatch(/^CREATE (?:TABLE `pipeline_(?:runs|run_items)`|(?:UNIQUE )?INDEX `pipeline_[^`]+` ON `pipeline_(?:runs|run_items)`)/);
    }
    expect(statements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(2);
  });
});
