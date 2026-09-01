import { drizzle, type AnyD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export function createDatabase(binding: AnyD1Database) {
  return drizzle(binding, { schema });
}

export type GameHubDatabase = ReturnType<typeof createDatabase>;
