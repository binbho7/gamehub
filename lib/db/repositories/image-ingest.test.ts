import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createD1TestBinding } from "../../../test/d1-test-env";
import { createDatabase, type GameHubDatabase } from "../client";
import { gameImages, games } from "../schema";
import {
  createImageIngestRepository,
  type ImageBinding,
  type ImageIngestSnapshot,
} from "./image-ingest";

const IMAGE_SOURCE = "https://cdn.akamai.steamstatic.com/steam/apps/10/header.jpg";
const IMAGE_SOURCE_2 = "https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg";
const HASH = "a".repeat(64);

const binding: ImageBinding = {
  storageKey: `images/sha256/aa/aa/${HASH}.jpg`,
  storageUrl: `https://images.example.test/${HASH}.jpg`,
  contentHash: HASH,
  mimeType: "image/jpeg",
  fileSize: 1024,
  width: 640,
  height: 360,
};

describe("image ingest repository", () => {
  const disposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  });

  async function setup() {
    const platform = await createD1TestBinding();
    disposers.push(platform.dispose);
    const db = createDatabase(platform.binding);
    await db.insert(games).values({
      id: 901,
      slug: "image-repository-game",
      title: "Image Repository Game",
      coverUrl: IMAGE_SOURCE,
      heroUrl: IMAGE_SOURCE_2,
      createdAt: new Date(1700000000000),
      updatedAt: new Date(1700000001000),
    }).run();
    return { db, repo: createImageIngestRepository(db) };
  }

  it("reads one game's explicit snapshot and candidate image rows", async () => {
    const { db, repo } = await setup();
    await db.insert(gameImages).values({
      id: 902,
      gameId: 901,
      type: "screenshot",
      sourceUrl: IMAGE_SOURCE,
      sourceProvider: "steam",
      width: 640,
      height: 360,
      sortOrder: 2,
      createdAt: new Date(1700000002000),
      updatedAt: new Date(1700000003000),
    }).run();

    await expect(repo.readImageIngestSnapshot(901)).resolves.toMatchObject({
      game: {
        id: 901,
        coverUrl: IMAGE_SOURCE,
        heroUrl: IMAGE_SOURCE_2,
        updatedAt: new Date(1700000001000),
      },
      images: [{
        id: 902,
        gameId: 901,
        type: "screenshot",
        sourceUrl: IMAGE_SOURCE,
        sourceProvider: "steam",
        storageUrl: null,
        storageKey: null,
        contentHash: null,
        mimeType: null,
        fileSize: null,
        width: 640,
        height: 360,
        sortOrder: 2,
        createdAt: new Date(1700000002000),
        updatedAt: new Date(1700000003000),
      }],
    });
  });

  it("returns null for a missing game and identity miss", async () => {
    const { repo } = await setup();
    await expect(repo.readImageIngestSnapshot(9999)).resolves.toBeNull();
    await expect(repo.findImageByIdentity(901, IMAGE_SOURCE)).resolves.toBeNull();
  });

  it("finds an image by the exact game and source identity", async () => {
    const { db, repo } = await setup();
    await db.insert(gameImages).values({
      id: 903,
      gameId: 901,
      type: "cover",
      sourceUrl: IMAGE_SOURCE,
      sourceProvider: "steam",
      sortOrder: 0,
    }).run();

    await expect(repo.findImageByIdentity(901, IMAGE_SOURCE)).resolves.toMatchObject({
      id: 903,
      gameId: 901,
      sourceUrl: IMAGE_SOURCE,
      type: "cover",
    });
    await expect(repo.findImageByIdentity(901, IMAGE_SOURCE_2)).resolves.toBeNull();
    await expect(repo.findImageByIdentity(902, IMAGE_SOURCE)).resolves.toBeNull();
  });

  it("conditionally creates a missing image and rereads an existing identity as a race", async () => {
    const { db, repo } = await setup();
    await expect(repo.conditionallyCreateImage({
      gameId: 901,
      type: "cover",
      sourceUrl: IMAGE_SOURCE,
      sourceProvider: "steam",
      gameUpdatedAt: new Date(1700000001000),
      ...binding,
    })).resolves.toBe("created");

    await expect(repo.conditionallyCreateImage({
      gameId: 901,
      type: "cover",
      sourceUrl: IMAGE_SOURCE,
      sourceProvider: "steam",
      gameUpdatedAt: new Date(1700000001000),
      sortOrder: 1,
      ...binding,
    })).resolves.toBe("race");

    const rows = await db.select().from(gameImages);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "cover", sourceUrl: IMAGE_SOURCE });
  });

  it("does not create an image when the applicable game snapshot is stale", async () => {
    const { db, repo } = await setup();
    const snapshot = await repo.readImageIngestSnapshot(901);
    expect(snapshot).not.toBeNull();
    await db.run(sql`update games set updated_at = ${1700000009000} where id = ${901}`);

    await expect(repo.conditionallyCreateImage({
      gameId: 901,
      type: "hero",
      sourceUrl: "https://cdn.akamai.steamstatic.com/steam/apps/10/capsule.jpg",
      sourceProvider: "steam",
      gameUpdatedAt: snapshot!.game.updatedAt,
      ...binding,
    })).resolves.toBe("write_conflict");
    await expect(repo.findImageByIdentity(
      901,
      "https://cdn.akamai.steamstatic.com/steam/apps/10/capsule.jpg",
    )).resolves.toBeNull();
  });

  it("classifies a zero-change insert with no reread row as a write conflict", async () => {
    const { repo } = await setup();
    await expect(repo.conditionallyCreateImage({
      gameId: 9999,
      type: "cover",
      sourceUrl: IMAGE_SOURCE,
      sourceProvider: "steam",
      gameUpdatedAt: new Date(1700000001000),
      ...binding,
    })).resolves.toBe("write_conflict");
  });

  it("classifies duplicate identity rows after a zero-change insert as inconsistent state", async () => {
    const { db, repo } = await setup();
    await db.insert(gameImages).values([
      { id: 906, gameId: 901, type: "cover", sourceUrl: IMAGE_SOURCE, sourceProvider: "steam" },
      { id: 907, gameId: 901, type: "hero", sourceUrl: IMAGE_SOURCE, sourceProvider: "steam" },
    ]).run();

    await expect(repo.conditionallyCreateImage({
      gameId: 901,
      type: "cover",
      sourceUrl: IMAGE_SOURCE,
      sourceProvider: "steam",
      gameUpdatedAt: new Date(1700000001000),
      ...binding,
    })).resolves.toBe("inconsistent_state");
  });

  it("applies a complete optimistic binding and rejects a stale snapshot", async () => {
    const { repo } = await setup();
    await repo.conditionallyCreateImage({
      gameId: 901,
      type: "cover",
      sourceUrl: IMAGE_SOURCE,
      sourceProvider: "steam",
      gameUpdatedAt: new Date(1700000001000),
      ...binding,
    });
    const snapshot = await repo.findImageByIdentity(901, IMAGE_SOURCE);
    expect(snapshot).not.toBeNull();

    await expect(repo.optimisticBindImage(snapshot!, binding)).resolves.toBe("applied");
    await expect(repo.optimisticBindImage(snapshot!, binding)).resolves.toBe("write_conflict");
    await expect(repo.findImageByIdentity(901, IMAGE_SOURCE)).resolves.toMatchObject(binding);
  });

  it("detects partial storage metadata as an invariant failure", async () => {
    const { repo } = await setup();
    const partial = {
      id: 904,
      gameId: 901,
      type: "cover",
      sourceUrl: IMAGE_SOURCE,
      sourceProvider: "steam" as const,
      storageUrl: "https://images.example.test/partial.jpg",
      storageKey: null,
      contentHash: null,
      mimeType: null,
      fileSize: null,
      width: null,
      height: null,
      sortOrder: 0,
      createdAt: new Date(1700000004000),
      updatedAt: new Date(1700000004000),
    } satisfies ImageIngestSnapshot["images"][number];

    await expect(repo.optimisticBindImage(partial, binding)).resolves.toBe("invariant_failure");
  });

  it("classifies an impossible multi-row optimistic update as an invariant failure", async () => {
    const fakeDb = {
      update: () => ({
        set: () => ({
          where: () => ({
            run: async () => ({ meta: { changes: 2 } }),
          }),
        }),
      }),
    } as unknown as GameHubDatabase;
    const repo = createImageIngestRepository(fakeDb);
    const snapshot = {
      id: 905,
      gameId: 901,
      type: "cover",
      sourceUrl: IMAGE_SOURCE,
      sourceProvider: "steam" as const,
      storageUrl: null,
      storageKey: null,
      contentHash: null,
      mimeType: null,
      fileSize: null,
      width: null,
      height: null,
      sortOrder: 0,
      createdAt: new Date(1700000005000),
      updatedAt: new Date(1700000005000),
    } satisfies ImageIngestSnapshot["images"][number];

    await expect(repo.optimisticBindImage(snapshot, binding)).resolves.toBe("invariant_failure");
  });

  it("accepts lowercase SHA-256 metadata and rejects uppercase, non-hex, and wrong-length hashes", async () => {
    const { db, repo } = await setup();
    await expect(repo.conditionallyCreateImage({
      gameId: 901,
      type: "cover",
      sourceUrl: IMAGE_SOURCE,
      sourceProvider: "steam",
      gameUpdatedAt: new Date(1700000001000),
      ...binding,
    })).resolves.toBe("created");

    const invalidHashes = ["A".repeat(64), `${"a".repeat(63)}g`, "a".repeat(63)];
    for (const invalidHash of invalidHashes) {
      await expect(db.run(sql`
        update game_images
        set content_hash = ${invalidHash}
        where game_id = ${901} and source_url = ${IMAGE_SOURCE}
      `)).rejects.toThrow();
    }
  });
});
