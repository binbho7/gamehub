import { resolveImageCandidates, type ImageGameSnapshot } from "./candidates";
import type { ImageIngestSnapshot } from "../db/repositories/image-ingest";
import type { ImagePlan } from "./types";

export function planImageIngest(snapshot: ImageIngestSnapshot | null, dryRun: boolean): ImagePlan {
  if (snapshot === null) {
    return { gameId: 0, gameSnapshot: null, candidates: [], rejected: [], preflight: "game_not_found", dryRun };
  }
  const resolution = resolveImageCandidates(snapshot as ImageGameSnapshot);
  return {
    gameId: snapshot.game.id,
    gameSnapshot: { ...snapshot.game },
    candidates: resolution.candidates.map((candidate) => ({
      ...candidate,
      mode: dryRun ? "read_only" : "write",
      reason: candidate.existingId === null ? "create_missing_scalar"
        : snapshot.images.some((row) => row.id === candidate.existingId && row.storageKey !== null) ? "inspect_existing_storage" : "ingest_existing_image",
    })),
    rejected: resolution.rejected.map((candidate) => ({ imageId: candidate.existingId, sourceUrl: candidate.sourceUrl, mode: "read_only", reason: "source_rejected" })),
    preflight: resolution.preflight,
    dryRun,
  };
}

export function resolvePlanCandidates(snapshot: ImageIngestSnapshot): ReturnType<typeof resolveImageCandidates> {
  return resolveImageCandidates(snapshot as ImageGameSnapshot);
}
