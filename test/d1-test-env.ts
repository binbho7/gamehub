import { readdir, readFile } from "node:fs/promises";
import type { AnyD1Database } from "drizzle-orm/d1";

export async function createD1TestBinding() {
  process.env.WRANGLER_LOG_PATH = "/tmp/gamehub-wrangler-test.log";
  const { getPlatformProxy } = await import("wrangler");
  const platform = await getPlatformProxy<{ DB: AnyD1Database }>({
    configPath: new URL("../wrangler.jsonc", import.meta.url).pathname,
    persist: false,
    remoteBindings: false,
  });
  const migrationsDirectory = new URL("../drizzle/", import.meta.url);
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    const migration = await readFile(new URL(file, migrationsDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      const sql = statement.trim();
      if (sql) await platform.env.DB.prepare(sql).run();
    }
  }
  return { binding: platform.env.DB, dispose: platform.dispose };
}
