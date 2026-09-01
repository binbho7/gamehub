import { describe, expect, it } from "vitest";
import {
  createGameSchema,
  externalIdSchema,
  gameImageSchema,
  officialLinkSchema,
  updateGameSchema,
} from "./validation";

describe("database input validation", () => {
  it("normalizes a valid canonical game write", () => {
    expect(createGameSchema.parse({
      slug: "black-myth-wukong",
      title: "  Black Myth: Wukong  ",
      status: "released",
      releaseDate: "2024-08-20",
      coverUrl: "https://cdn.example.com/cover.jpg",
    })).toEqual({
      slug: "black-myth-wukong",
      title: "Black Myth: Wukong",
      status: "released",
      releaseDate: "2024-08-20",
      coverUrl: "https://cdn.example.com/cover.jpg",
    });
  });

  it.each([
    { field: "slug", payload: { slug: "Black Myth", title: "Game" } },
    { field: "releaseDate", payload: { slug: "game", title: "Game", releaseDate: "2025-02-30" } },
    { field: "coverUrl", payload: { slug: "game", title: "Game", coverUrl: "javascript:alert(1)" } },
    { field: "status", payload: { slug: "game", title: "Game", status: "published" } },
  ])("rejects an invalid $field", ({ payload }) => {
    expect(createGameSchema.safeParse(payload).success).toBe(false);
  });

  it("keeps update payloads strict and requires an actual change", () => {
    expect(updateGameSchema.safeParse({}).success).toBe(false);
    expect(updateGameSchema.safeParse({ id: 12, title: "Changed" }).success).toBe(false);
    expect(updateGameSchema.parse({ title: "  Changed  " })).toEqual({ title: "Changed" });
  });

  it("allows multiple same-provider external ID inputs while normalizing provider", () => {
    expect(externalIdSchema.parse({ provider: " Steam ", externalId: "2358720" })).toEqual({
      provider: "steam",
      externalId: "2358720",
    });
    expect(externalIdSchema.safeParse({ provider: "steam", externalId: "2358721" }).success).toBe(true);
  });

  it("rejects unsupported official-link metadata", () => {
    expect(officialLinkSchema.safeParse({
      provider: "steam",
      linkType: "mirror",
      url: "https://example.com",
    }).success).toBe(false);
    expect(officialLinkSchema.safeParse({
      provider: "steam",
      linkType: "store",
      url: "https://example.com",
      httpStatus: 700,
    }).success).toBe(false);
  });

  it("rejects invalid image dimensions and ordering", () => {
    expect(gameImageSchema.safeParse({
      type: "cover",
      sourceUrl: "https://example.com/cover.jpg",
      width: 0,
      sortOrder: -1,
    }).success).toBe(false);
  });
});
