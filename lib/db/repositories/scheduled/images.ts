import type { GameHubDatabase } from "../../client";
import { createImageIngestRepository, type ImageIngestRepository } from "../image-ingest";
import { buildImageBindQuery, buildImageCreateQuery, validImageBinding } from "../image-ingest-queries";
import { FenceLostError } from "../../../scheduler/errors";
import { parseScheduledMutationAuthority, type CronSignals, type ScheduledMutationAuthority } from "../../../scheduler/types";
import { assertFence, executeFencedBatch, fencePredicate, type BuiltDomainQuery } from "./fence";

export function createScheduledImageRepository(input: { binding: D1Database; db: GameHubDatabase; authority: ScheduledMutationAuthority; signals: CronSignals }): ImageIngestRepository {
  const authority = parseScheduledMutationAuthority(input.authority);
  const legacy = createImageIngestRepository(input.db);
  async function run(query?: BuiltDomainQuery): Promise<number> {
    try {
      if (input.signals.readAuthorityLoss()) throw new FenceLostError();
      if (!query) { await assertFence(input.binding, authority); return 0; }
      return (await executeFencedBatch(input.binding, authority, [query])).changes[0];
    } catch (error) {
      if (error instanceof FenceLostError) input.signals.markAuthorityLoss("fence_lost");
      throw new Error("Image publication failed");
    }
  }
  return {
    ...legacy,
    async optimisticBindImage(snapshot, binding) {
      if (!validImageBinding(snapshot, binding)) { await run(); return "invariant_failure"; }
      return await run(buildImageBindQuery(input.db, snapshot, binding, fencePredicate(authority))) === 1 ? "applied" : "write_conflict";
    },
    async conditionallyCreateImage(image) {
      if (await run(buildImageCreateQuery(input.db, image, fencePredicate(authority))) === 1) return "created";
      const rows = await legacy.findImagesByIdentity(image.gameId, image.sourceUrl);
      if (rows.length === 0) return "write_conflict";
      if (rows.length !== 1 || rows[0].type !== image.type || (rows[0].sourceProvider !== null && rows[0].sourceProvider !== (image.sourceProvider ?? null))) return "inconsistent_state";
      return "race";
    },
  };
}
