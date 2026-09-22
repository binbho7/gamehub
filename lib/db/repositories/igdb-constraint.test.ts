import { describe, expect, it } from "vitest";
import { isIgdbSharedEntityUniqueConflict } from "./igdb-enrichment";

describe("IGDB shared unique constraint classification", () => {
  it.each(["genres.slug","genres.name","platforms.slug","platforms.name","companies.slug"])("recognizes only the known shared key %s", key => {
    expect(isIgdbSharedEntityUniqueConflict(new Error("query failed",{cause:new Error(`D1_ERROR: UNIQUE constraint failed: ${key}: SQLITE_CONSTRAINT`)}))).toBe(true);
  });
  it.each([
    "FOREIGN KEY constraint failed",
    "NOT NULL constraint failed: genres.name",
    "CHECK constraint failed: genres.name",
    "UNIQUE constraint failed: game_external_ids.provider, game_external_ids.external_id",
    "UNIQUE constraint failed: game_genres.game_id, game_genres.genre_id",
    "UNIQUE constraint failed: genres.name_extra",
    "UNIQUE constraint failed: genres.name, genres.slug",
    "SQLITE_BUSY",
    "no such table: genres",
  ])("leaves non-allowlisted error terminal: %s", message => {
    expect(isIgdbSharedEntityUniqueConflict(new Error(message))).toBe(false);
  });
  it("handles circular cause chains without admitting a race", () => {
    const error: {message:string;cause?:unknown}={message:"unknown"};error.cause=error;
    expect(isIgdbSharedEntityUniqueConflict(error)).toBe(false);
  });
});
