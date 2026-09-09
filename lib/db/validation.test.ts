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

  it.each([
    "unverified",
    "pending",
    "verified",
    "failed",
    "reachable_but_unverified",
    "broken",
    "temporarily_unavailable",
    "unsafe",
    "unknown",
  ])("accepts the %s official-link verification status", (verificationStatus) => {
    expect(officialLinkSchema.safeParse({
      provider: "steam",
      linkType: "store",
      url: "https://example.com",
      verificationStatus,
    }).success).toBe(true);
  });

  it("rejects an unknown official-link verification status", () => {
    expect(officialLinkSchema.safeParse({
      provider: "steam",
      linkType: "store",
      url: "https://example.com",
      verificationStatus: "not-a-status",
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

  it("accepts complete image storage metadata and rejects partial storage state", () => {
    expect(gameImageSchema.parse({
      type: "cover",
      sourceUrl: "https://example.com/cover.jpg",
      sourceProvider: "steam",
      storageUrl: "https://cdn.example.com/cover.jpg",
      storageKey: "images/cover.jpg",
      contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      mimeType: "image/webp",
      fileSize: 1024,
      width: 1920,
      height: 1080,
      sortOrder: 2,
    })).toEqual({
      type: "cover",
      sourceUrl: "https://example.com/cover.jpg",
      sourceProvider: "steam",
      storageUrl: "https://cdn.example.com/cover.jpg",
      storageKey: "images/cover.jpg",
      contentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      mimeType: "image/webp",
      fileSize: 1024,
      width: 1920,
      height: 1080,
      sortOrder: 2,
    });

    expect(gameImageSchema.safeParse({
      type: "cover",
      sourceUrl: "https://example.com/cover.jpg",
      sourceProvider: "steam",
      storageUrl: "https://cdn.example.com/cover.jpg",
    }).success).toBe(false);
  });

  it("rejects unsupported image storage metadata", () => {
    expect(gameImageSchema.safeParse({
      type: "cover",
      sourceUrl: "https://example.com/cover.jpg",
      sourceProvider: "unknown",
      storageUrl: "https://cdn.example.com/cover.jpg",
      storageKey: "images/cover.jpg",
      contentHash: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      mimeType: "image/gif",
      fileSize: 0,
    }).success).toBe(false);
  });
});
