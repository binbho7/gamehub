import { and, asc, eq } from "drizzle-orm";
import { imageBindQuery, imageCreateQuery, validImageBinding } from "./image-ingest-queries";
import type { ImageProvider } from "../../images/source-policy";
import type { GameHubDatabase } from "../client";
import { gameImages, games } from "../schema";

export type ImageBinding = {
  storageKey: string;
  storageUrl: string;
  contentHash: string;
  mimeType: string;
  fileSize: number;
  width: number;
  height: number;
};

export type ImageIngestSnapshot = {
  game: {
    id: number;
    coverUrl: string | null;
    heroUrl: string | null;
    updatedAt: Date;
  };
  images: Array<{
    id: number;
    gameId: number;
    type: string;
    sourceUrl: string;
    sourceProvider: ImageProvider | null;
    storageUrl: string | null;
    storageKey: string | null;
    contentHash: string | null;
    mimeType: string | null;
    fileSize: number | null;
    width: number | null;
    height: number | null;
    sortOrder: number;
    createdAt: Date;
    updatedAt: Date;
  }>;
};

type ImageSnapshotRow = ImageIngestSnapshot["images"][number];
type CreateImageInput = ImageBinding & {
  gameId: number;
  type: string;
  sourceUrl: string;
  sourceProvider?: ImageProvider | null;
  sortOrder?: number;
  gameUpdatedAt: Date;
};

const imageSelection = {
  id: gameImages.id,
  gameId: gameImages.gameId,
  type: gameImages.type,
  sourceUrl: gameImages.sourceUrl,
  sourceProvider: gameImages.sourceProvider,
  storageUrl: gameImages.storageUrl,
  storageKey: gameImages.storageKey,
  contentHash: gameImages.contentHash,
  mimeType: gameImages.mimeType,
  fileSize: gameImages.fileSize,
  width: gameImages.width,
  height: gameImages.height,
  sortOrder: gameImages.sortOrder,
  createdAt: gameImages.createdAt,
  updatedAt: gameImages.updatedAt,
};

export function createImageIngestRepository(db: GameHubDatabase) {
  const findIdentityRows = async (
    gameId: number,
    sourceUrl: string,
  ): Promise<ImageSnapshotRow[]> => {
    const rows = await db.select(imageSelection)
      .from(gameImages)
      .where(and(eq(gameImages.gameId, gameId), eq(gameImages.sourceUrl, sourceUrl)))
      .orderBy(asc(gameImages.id));
    return rows as ImageSnapshotRow[];
  };

  const findImageByIdentity = async (
    gameId: number,
    sourceUrl: string,
  ): Promise<ImageSnapshotRow | null> => {
    return (await findIdentityRows(gameId, sourceUrl))[0] ?? null;
  };

  return {
    async readImageIngestSnapshot(gameId: number): Promise<ImageIngestSnapshot | null> {
      const game = (await db.select({
        id: games.id,
        coverUrl: games.coverUrl,
        heroUrl: games.heroUrl,
        updatedAt: games.updatedAt,
      })
        .from(games)
        .where(eq(games.id, gameId))
        .limit(1))[0];
      if (!game) return null;

      const images = await db.select(imageSelection)
        .from(gameImages)
        .where(eq(gameImages.gameId, gameId))
        .orderBy(asc(gameImages.sortOrder), asc(gameImages.id));
      return {
        game,
        images: images as ImageSnapshotRow[],
      };
    },

    findImageByIdentity,

    async findImagesByIdentity(
      gameId: number,
      sourceUrl: string,
    ): Promise<ImageSnapshotRow[]> {
      return findIdentityRows(gameId, sourceUrl);
    },

    async conditionallyCreateImage(input: CreateImageInput): Promise<"created" | "race" | "write_conflict" | "inconsistent_state"> {
      const result = await imageCreateQuery(db, input);
      const changes = Number(result.meta.changes);
      if (changes === 1) return "created";
      if (changes !== 0) throw new Error("Image identity insert changed more than one row");

      // Zero changes means the game snapshot no longer applies, or an identity
      // winner already exists. Reread every identity row before classifying;
      // the repository must not hide duplicate or incompatible legacy rows.
      const rows = await findIdentityRows(input.gameId, input.sourceUrl);
      if (rows.length === 0) return "write_conflict";
      if (rows.length !== 1) return "inconsistent_state";
      const [row] = rows;
      if (row!.type !== input.type) return "inconsistent_state";
      if (row!.sourceProvider !== null && row!.sourceProvider !== (input.sourceProvider ?? null)) {
        return "inconsistent_state";
      }
      return "race";
    },

    async optimisticBindImage(
      snapshot: ImageSnapshotRow,
      binding: ImageBinding,
    ): Promise<"applied" | "write_conflict" | "invariant_failure"> {
      if (!validImageBinding(snapshot, binding)) {
        return "invariant_failure";
      }

      const result = await imageBindQuery(db, snapshot, binding).run();

      const changes = Number(result.meta.changes);
      if (changes === 1) return "applied";
      if (changes === 0) return "write_conflict";
      return "invariant_failure";
    },
  };
}

export type ImageIngestRepository = ReturnType<typeof createImageIngestRepository>;
