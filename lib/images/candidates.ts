import {
  resolveImageProviderFromUrl,
  validateImageSource,
  type ImageProvider,
} from "./source-policy";

export type ImageType = "cover" | "hero" | "screenshot" | "artwork" | "logo";

export type ImageCandidate = {
  gameId: number;
  type: ImageType;
  sourceUrl: string;
  provider: ImageProvider;
  width: number | null;
  height: number | null;
  sortOrder: number;
  existingId: number | null;
};

export type ImageGameSnapshot = {
  game: { id: number; coverUrl: string | null; heroUrl: string | null };
  images: Array<{
    id: number;
    gameId: number;
    type: string;
    sourceUrl: string;
    sourceProvider: string | null;
    width: number | null;
    height: number | null;
    sortOrder: number;
  }>;
};

export type RejectedImageCandidate = {
  existingId: number | null;
  sourceUrl: string;
  outcome: "source_rejected";
};

export type CandidateResolution = {
  preflight: "ok" | "image_limit_exceeded";
  candidates: ImageCandidate[];
  rejected: RejectedImageCandidate[];
};

export const MAX_IMAGES_PER_GAME = 128;

const IMAGE_TYPES = new Set<ImageType>(["cover", "hero", "screenshot", "artwork", "logo"]);

function isImageType(type: string): type is ImageType {
  return IMAGE_TYPES.has(type as ImageType);
}

function isImageProvider(provider: string | null): provider is ImageProvider {
  return provider === "steam" || provider === "igdb";
}

function assetIdentity(gameId: number, sourceUrl: string): string {
  return `${gameId}\u0000${sourceUrl}`;
}

function candidateForExisting(
  row: ImageGameSnapshot["images"][number],
): ImageCandidate | null {
  if (!isImageType(row.type) || !isImageProvider(row.sourceProvider)) return null;

  const source = validateImageSource(row.sourceUrl, row.sourceProvider);
  if (!source.ok) return null;

  return {
    gameId: row.gameId,
    type: row.type,
    sourceUrl: row.sourceUrl,
    provider: source.provider,
    width: row.width,
    height: row.height,
    sortOrder: row.sortOrder,
    existingId: row.id,
  };
}

function candidateForHistoricalExisting(
  row: ImageGameSnapshot["images"][number],
): ImageCandidate | null {
  const inferred = resolveImageProviderFromUrl(row.sourceUrl);
  if (!inferred.ok) return null;

  const source = validateImageSource(row.sourceUrl, inferred.provider);
  if (!source.ok || !isImageType(row.type)) return null;

  return {
    gameId: row.gameId,
    type: row.type,
    sourceUrl: row.sourceUrl,
    provider: source.provider,
    width: row.width,
    height: row.height,
    sortOrder: row.sortOrder,
    existingId: row.id,
  };
}

function candidateForNewScalar(
  gameId: number,
  type: "cover" | "hero",
  sourceUrl: string,
): ImageCandidate | null {
  const inferred = resolveImageProviderFromUrl(sourceUrl);
  if (!inferred.ok) return null;

  const source = validateImageSource(sourceUrl, inferred.provider);
  if (!source.ok) return null;

  return {
    gameId,
    type,
    sourceUrl,
    provider: source.provider,
    width: null,
    height: null,
    sortOrder: 0,
    existingId: null,
  };
}

export function resolveImageCandidates(snapshot: ImageGameSnapshot): CandidateResolution {
  const candidates: ImageCandidate[] = [];
  const rejected: RejectedImageCandidate[] = [];
  const seen = new Set<string>();
  const existingByIdentity = new Map<string, ImageGameSnapshot["images"][number]>();
  const orderedRows = [...snapshot.images].sort((left, right) => (
    left.sortOrder - right.sortOrder || left.id - right.id
  ));

  for (const row of orderedRows) {
    const identity = assetIdentity(row.gameId, row.sourceUrl);
    if (!existingByIdentity.has(identity)) existingByIdentity.set(identity, row);
  }

  const addExisting = (row: ImageGameSnapshot["images"][number]): void => {
    const identity = assetIdentity(row.gameId, row.sourceUrl);
    if (seen.has(identity)) return;
    seen.add(identity);

    const candidate = row.sourceProvider === null
      ? candidateForHistoricalExisting(row)
      : candidateForExisting(row);
    if (candidate === null) {
      rejected.push({ existingId: row.id, sourceUrl: row.sourceUrl, outcome: "source_rejected" });
      return;
    }
    candidates.push(candidate);
  };

  const addScalar = (type: "cover" | "hero", sourceUrl: string | null): void => {
    if (sourceUrl === null) return;
    const identity = assetIdentity(snapshot.game.id, sourceUrl);
    if (seen.has(identity)) return;

    const existing = existingByIdentity.get(identity);
    if (existing !== undefined) {
      addExisting(existing);
      return;
    }

    seen.add(identity);
    const candidate = candidateForNewScalar(snapshot.game.id, type, sourceUrl);
    if (candidate === null) {
      rejected.push({ existingId: null, sourceUrl, outcome: "source_rejected" });
      return;
    }
    candidates.push(candidate);
  };

  addScalar("cover", snapshot.game.coverUrl);
  addScalar("hero", snapshot.game.heroUrl);
  for (const row of orderedRows) addExisting(row);

  if (candidates.length > MAX_IMAGES_PER_GAME) {
    return { preflight: "image_limit_exceeded", candidates: [], rejected };
  }
  return { preflight: "ok", candidates, rejected };
}
