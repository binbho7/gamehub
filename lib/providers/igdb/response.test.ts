import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IgdbError } from "./errors";
import { parseIgdbGame, parseIgdbSteamMapping } from "./response";

function expectIgdbError(action: () => unknown, code: string) {
  expect(action).toThrowError(
    expect.objectContaining({ code, retryable: false }),
  );
  expect(action).toThrowError(IgdbError);
}

describe("IGDB identity response adapters", () => {
  it("returns a Steam mapping only when its source and UID exactly match the request", () => {
    expect(parseIgdbSteamMapping([
      { id: 1, game: 42, uid: "1245620", external_game_source: 1 },
    ], "1245620")).toEqual({ igdbGameId: 42 });
  });

  it("deduplicates exact Steam mapping rows by IGDB game ID", () => {
    expect(parseIgdbSteamMapping([
      { id: 1, game: 42, uid: "1245620", external_game_source: 1 },
      { id: 2, game: 42, uid: "1245620", external_game_source: 1 },
    ], "1245620")).toEqual({ igdbGameId: 42 });
  });

  it("reports a missing Steam mapping", () => {
    expectIgdbError(() => parseIgdbSteamMapping([], "1245620"), "mapping_not_found");
  });

  it("reports distinct IGDB game mappings as ambiguous", () => {
    expectIgdbError(() => parseIgdbSteamMapping([
      { id: 1, game: 42, uid: "1245620", external_game_source: 1 },
      { id: 2, game: 84, uid: "1245620", external_game_source: 1 },
    ], "1245620"), "mapping_ambiguous");
  });

  it("rejects a mapping from a non-Steam source", () => {
    expectIgdbError(() => parseIgdbSteamMapping([
      { id: 1, game: 42, uid: "1245620", external_game_source: 2 },
    ], "1245620"), "unsupported_mapping");
  });

  it("rejects a mapping whose UID does not exactly match the requested Steam app ID", () => {
    expectIgdbError(() => parseIgdbSteamMapping([
      { id: 1, game: 42, uid: "1245621", external_game_source: 1 },
    ], "1245620"), "unsupported_mapping");
  });

  it("rejects a mapping without a usable IGDB game ID", () => {
    expectIgdbError(() => parseIgdbSteamMapping([
      { id: 1, uid: "1245620", external_game_source: 1 },
    ], "1245620"), "unsupported_mapping");
  });

  it("reports malformed mapping core data as a schema change", () => {
    expectIgdbError(() => parseIgdbSteamMapping([
      { id: 1, game: "42", uid: "1245620", external_game_source: 1 },
    ], "1245620"), "schema_changed");
  });

  it("returns the exact requested IGDB game response", () => {
    const game = { id: 42, name: "Example Game", summary: "A summary" };

    expect(parseIgdbGame([game], 42)).toEqual(game);
  });

  it("reports an empty IGDB game response as not found", () => {
    expectIgdbError(() => parseIgdbGame([], 42), "igdb_game_not_found");
  });

  it("rejects an IGDB game response with a mismatched ID", () => {
    expectIgdbError(() => parseIgdbGame([
      { id: 84, name: "Another Game" },
    ], 42), "schema_changed");
  });

  it("rejects multiple IGDB game rows instead of choosing one", () => {
    expectIgdbError(() => parseIgdbGame([
      { id: 42, name: "Example Game" },
      { id: 84, name: "Another Game" },
    ], 42), "schema_changed");
  });

  it("reports malformed IGDB game core data as a schema change", () => {
    expectIgdbError(() => parseIgdbGame([
      { id: 42, name: " \t\n " },
    ], 42), "schema_changed");
  });

  it("does not couple provider response semantics to enrichment plans or the database", () => {
    const source = readFileSync(new URL("./response.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/IgdbEnrichmentPlan|identity_conflict|db\//);
  });
});
