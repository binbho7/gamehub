import { describe, expect, it } from "vitest";
import externalGamesFixture from "../../../fixtures/igdb/external-games.json";
import gameFixture from "../../../fixtures/igdb/game.json";
import {
  igdbExternalGamesResponseSchema,
  igdbGamesResponseSchema,
} from "./schema";

describe("IGDB raw response schemas", () => {
  it("accepts a representative Steam mapping and unrelated provider fields", () => {
    expect(igdbExternalGamesResponseSchema.parse(externalGamesFixture)).toMatchObject([
      {
        id: 5036,
        game: 119133,
        uid: "1245620",
        external_game_source: 1,
        unconsumed_provider_field: { can_change: true },
      },
    ]);
  });

  it.each([
    [{ id: 0, game: 119133, uid: "1245620", external_game_source: 1 }],
    [{ id: 5036, game: Number.MAX_SAFE_INTEGER + 1, uid: "1245620", external_game_source: 1 }],
    [{ id: 5036, game: 119133, uid: "", external_game_source: 1 }],
    [{ id: 5036, game: 119133, uid: "1245620", external_game_source: 0 }],
    [{ id: 5036, game: 119133, uid: "1245620" }],
  ])("rejects invalid mapping core data", (body) => {
    expect(igdbExternalGamesResponseSchema.safeParse(body).success).toBe(false);
  });

  it("accepts a representative game response with no company URL field", () => {
    const parsed = igdbGamesResponseSchema.parse(gameFixture);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: 119133,
      name: "Elden Ring",
      unconsumed_provider_field: { can_change: true },
    });
    expect(gameFixture[0]?.involved_companies?.[0]?.company).not.toHaveProperty("url");
  });

  it("retains malformed optional items for later warning while accepting their array containers", () => {
    const parsed = igdbGamesResponseSchema.parse([{
      id: 123,
      name: "Example",
      screenshots: [{ image_id: "good" }, { image_id: 7 }],
      websites: [{ type: 1, trusted: true, url: "https://example.com" }, { type: "official" }],
    }]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.screenshots).toEqual([{ image_id: "good" }, { image_id: 7 }]);
    expect(parsed[0]?.websites).toEqual([
      { type: 1, trusted: true, url: "https://example.com" },
      { type: "official" },
    ]);
  });

  it.each([
    { screenshots: {} },
    { websites: "not-an-array" },
    { genres: null },
    { involved_companies: { developer: true } },
  ])("rejects a non-array optional collection container", (collection) => {
    expect(igdbGamesResponseSchema.safeParse([{
      id: 123,
      name: "Example",
      ...collection,
    }]).success).toBe(false);
  });

  it.each([
    [{ id: 0, name: "Example" }],
    [{ id: Number.MAX_SAFE_INTEGER + 1, name: "Example" }],
    [{ id: 123, name: " \t\n " }],
    [{ id: 123, name: "Example", summary: 7 }],
    [{ id: 123, name: "Example", first_release_date: "2026-01-01" }],
  ])("rejects changed consumed game core field types", (body) => {
    expect(igdbGamesResponseSchema.safeParse(body).success).toBe(false);
  });
});
