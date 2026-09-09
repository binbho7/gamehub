import { describe, expect, it } from "vitest";
import { planImageIngest } from "./plan";
import type { ImageIngestSnapshot } from "../db/repositories/image-ingest";

const source = "https://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg";

function snapshot(images: ImageIngestSnapshot["images"] = []): ImageIngestSnapshot {
  return {
    game: { id: 10, coverUrl: source, heroUrl: null, updatedAt: new Date(1000) },
    images,
  };
}

describe("planImageIngest", () => {
  it("plans canonical scalar and existing candidates deterministically", () => {
    expect(planImageIngest(snapshot([{
      id: 20, gameId: 10, type: "screenshot", sourceUrl: `${source}?n=2`, sourceProvider: "steam",
      storageUrl: null, storageKey: null, contentHash: null, mimeType: null, fileSize: null,
      width: null, height: null, sortOrder: 1, createdAt: new Date(1), updatedAt: new Date(1),
    }]), true)).toMatchObject({
      gameId: 10,
      dryRun: true,
      preflight: "ok",
      candidates: [
        expect.objectContaining({ type: "cover", sourceUrl: source, existingId: null }),
        expect.objectContaining({ type: "screenshot", existingId: 20 }),
      ],
    });
  });

  it("returns a game-not-found preflight for a missing snapshot", () => {
    expect(planImageIngest(null, false)).toEqual({ gameId: 0, gameSnapshot: null, candidates: [], rejected: [], preflight: "game_not_found", dryRun: false });
  });

  it("fails the game preflight above 128 eligible assets", () => {
    const images = Array.from({ length: 129 }, (_, index) => ({
      id: index + 1, gameId: 10, type: "screenshot", sourceUrl: `https://cdn.akamai.steamstatic.com/steam/apps/10/${index}.jpg`, sourceProvider: "steam" as const,
      storageUrl: null, storageKey: null, contentHash: null, mimeType: null, fileSize: null,
      width: null, height: null, sortOrder: index, createdAt: new Date(1), updatedAt: new Date(1),
    }));
    expect(planImageIngest(snapshot(images), true).preflight).toBe("image_limit_exceeded");
  });
});
