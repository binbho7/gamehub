import { resolveImageCandidates, type ImageGameSnapshot } from "./candidates";
import type { ImageIngestSnapshot } from "../db/repositories/image-ingest";
import type { ImagePlan } from "./types";

export function planImageIngest(snapshot: ImageIngestSnapshot | null, dryRun: boolean): ImagePlan {
  if (snapshot === null) {
    return { gameId: 0, candidates: [], preflight: "game_not_found", dryRun };
  }
  const resolution = resolveImageCandidates(snapshot as ImageGameSnapshot);
  return {
    gameId: snapshot.game.id,
    candidates: resolution.candidates,
    preflight: resolution.preflight,
    dryRun,
  };
}

export function resolvePlanCandidates(snapshot: ImageIngestSnapshot): ReturnType<typeof resolveImageCandidates> {
  return resolveImageCandidates(snapshot as ImageGameSnapshot);
}
