import { downloadImageSource, type DownloadRequest } from "./downloader";
import { systemClock, type TimerHandle } from "./clock";
import { validateImageBytes } from "./formats";
import { sha256Hex } from "./hash";
import { buildImageStorageKey } from "./storage-key";
import { planImageIngest, resolvePlanCandidates } from "./plan";
import type { ImageCandidate } from "./candidates";
import type { ImageIngestDependencies, ImageOutcome, ImageResult, ImageIngestSnapshot } from "./types";

const GAME_DEADLINE_MS = 5 * 60 * 1000;
const CACHE_CONTROL = "public, max-age=31536000, immutable";
const SUCCESS_OUTCOMES = new Set<ImageOutcome>([
  "ingested", "deduplicated", "concurrent_dedup", "already_ingested", "restored", "skipped",
]);

type ImageRow = ImageIngestSnapshot["images"][number];

function storageComplete(row: ImageRow): boolean {
  const values = [row.storageUrl, row.storageKey, row.contentHash, row.mimeType, row.fileSize];
  return values.every((value) => value !== null);
}

function storageEmpty(row: ImageRow): boolean {
  const values = [row.storageUrl, row.storageKey, row.contentHash, row.mimeType, row.fileSize];
  return values.every((value) => value === null);
}

function outcomeFromDownload(result: Awaited<ReturnType<typeof downloadImageSource>>): ImageOutcome | null {
  if (result.outcome === "downloaded") return null;
  return result.outcome;
}

function metadataMatches(
  object: Awaited<ReturnType<ImageIngestDependencies["r2"]["head"]>>,
  row: ImageRow,
): boolean {
  if (!object.exists || row.contentHash === null || row.mimeType === null || row.fileSize === null) return false;
  return object.size === row.fileSize
    && object.hash === row.contentHash
    && object.sha256Metadata === row.contentHash
    && object.mimeType === row.mimeType
    && object.cacheControl === CACHE_CONTROL;
}

export function createImageIngestService(input: ImageIngestDependencies) {
  const now = input.now ?? (() => Date.now());
  const clock = input.clock ?? systemClock;
  const fetchImpl = input.fetchImpl ?? fetch;
  const download = input.download ?? downloadImageSource;
  const validate = input.validate ?? validateImageBytes;
  const hash = input.hash ?? sha256Hex;
  const storageKey = input.storageKey ?? buildImageStorageKey;
  const gameDeadlineMs = input.gameDeadlineMs ?? GAME_DEADLINE_MS;

  async function downloadAndValidate(candidate: ImageCandidate, signal: AbortSignal, deadlineAt: number) {
    const downloadRequest: DownloadRequest = {
      candidate,
      fetchImpl,
      signal,
      now,
      clock,
    };
    const downloaded = await download(downloadRequest);
    const downloadOutcome = outcomeFromDownload(downloaded);
    if (downloadOutcome !== null) return { outcome: downloadOutcome as ImageOutcome };
    if (downloaded.bytes === null) return { outcome: "download_failed" as ImageOutcome };
    if (now() >= deadlineAt) return { outcome: "deadline" as ImageOutcome };
    const validation = validate(downloaded.bytes, downloaded.contentType);
    if (!validation.ok) return { outcome: validation.outcome as ImageOutcome };
    const contentHash = await hash(downloaded.bytes);
    return {
      outcome: null,
      bytes: downloaded.bytes,
      mimeType: validation.mimeType,
      width: validation.dimensions.width,
      height: validation.dimensions.height,
      contentHash,
      finalUrl: downloaded.finalUrl,
    };
  }

  async function processCandidate(
    snapshot: ImageIngestSnapshot,
    candidate: ImageCandidate,
    write: boolean,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<{ imageId: number | null; outcome: ImageOutcome }> {
    const row = candidate.existingId === null
      ? null
      : snapshot.images.find((image) => image.id === candidate.existingId) ?? null;
    try {
      if (row !== null && !storageEmpty(row) && !storageComplete(row)) {
        return { imageId: row.id, outcome: "inconsistent_state" };
      }

      if (row !== null && storageComplete(row) && row.storageKey !== null) {
        let object;
        try {
          object = await input.r2.head(row.storageKey);
        } catch {
          return { imageId: row.id, outcome: "storage_failed" };
        }
        if (metadataMatches(object, row)) return { imageId: row.id, outcome: "already_ingested" };
        if (object.exists) return { imageId: row.id, outcome: "storage_conflict" };
      }

      if (now() >= deadlineAt || signal.aborted) return { imageId: row?.id ?? null, outcome: "deadline" };
      const imageController = new AbortController();
      const onAbort = (): void => imageController.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const fetched = await downloadAndValidate(candidate, imageController.signal, deadlineAt);
      signal.removeEventListener("abort", onAbort);
      if (fetched.outcome !== null) return { imageId: row?.id ?? null, outcome: fetched.outcome };

      const fetchedHash = fetched.contentHash!;
      if (row !== null && storageComplete(row)) {
        if (row.contentHash !== fetchedHash || row.mimeType !== fetched.mimeType || row.fileSize !== fetched.bytes!.byteLength) {
          return { imageId: row.id, outcome: "source_changed" };
        }
        const key = row.storageKey!;
        if (write) {
          const stored = await input.r2.ensureObject({ key, bytes: fetched.bytes!, hash: fetchedHash, mimeType: fetched.mimeType!, size: fetched.bytes!.byteLength });
          if (stored.outcome === "storage_conflict") return { imageId: row.id, outcome: "storage_conflict" };
          if (stored.outcome === "storage_failed") return { imageId: row.id, outcome: "storage_failed" };
        } else {
          const object = await input.r2.head(key);
          if (object.exists && !metadataMatches(object, row)) return { imageId: row.id, outcome: "storage_conflict" };
        }
        return { imageId: row.id, outcome: "restored" };
      }

      const key = storageKey(fetchedHash, fetched.mimeType!);
      let storageOutcome: "deduplicated" | "concurrent_dedup" | "created" | "storage_conflict" | "storage_failed";
      let storageUrl: string | null = null;
      if (write) {
        const stored = await input.r2.ensureObject({ key, bytes: fetched.bytes!, hash: fetchedHash, mimeType: fetched.mimeType!, size: fetched.bytes!.byteLength });
        storageOutcome = stored.outcome;
        storageUrl = stored.storageUrl;
      } else {
        const object = await input.r2.head(key);
        if (object.exists && !metadataMatches(object, { ...row ?? {
          id: 0, gameId: snapshot.game.id, type: candidate.type, sourceUrl: candidate.sourceUrl, sourceProvider: candidate.provider,
          storageUrl: null, storageKey: null, contentHash: null, mimeType: null, fileSize: null, width: null, height: null,
          sortOrder: candidate.sortOrder, createdAt: snapshot.game.updatedAt, updatedAt: snapshot.game.updatedAt,
        }, contentHash: fetchedHash, mimeType: fetched.mimeType, fileSize: fetched.bytes!.byteLength })) {
          return { imageId: row?.id ?? null, outcome: "storage_conflict" };
        }
        storageOutcome = object.exists ? "deduplicated" : "created";
      }
      if (storageOutcome === "storage_conflict") return { imageId: row?.id ?? null, outcome: "storage_conflict" };
      if (storageOutcome === "storage_failed") return { imageId: row?.id ?? null, outcome: "storage_failed" };
      if (!write) return {
        imageId: row?.id ?? null,
        outcome: storageOutcome === "deduplicated" ? "deduplicated" : "ingested",
      };

      const binding = {
        storageKey: key,
        storageUrl: storageUrl ?? "",
        contentHash: fetchedHash,
        mimeType: fetched.mimeType!,
        fileSize: fetched.bytes!.byteLength,
        width: fetched.width!,
        height: fetched.height!,
      };
      if (row !== null) {
        const bound = await input.repository.optimisticBindImage(row, binding);
        if (bound === "applied") {
          const outcome = storageOutcome === "created"
            ? "ingested"
            : storageOutcome === "concurrent_dedup" ? "concurrent_dedup" : "deduplicated";
          return { imageId: row.id, outcome };
        }
        if (bound === "write_conflict") return { imageId: row.id, outcome: "write_conflict" };
        return { imageId: row.id, outcome: "inconsistent_state" };
      }
      const created = await input.repository.conditionallyCreateImage({
        gameId: snapshot.game.id,
        type: candidate.type,
        sourceUrl: candidate.sourceUrl,
        sourceProvider: candidate.provider,
        sortOrder: candidate.sortOrder,
        gameUpdatedAt: snapshot.game.updatedAt,
        ...binding,
      });
      if (created === "created") {
        const createdRow = await input.repository.findImageByIdentity(snapshot.game.id, candidate.sourceUrl);
        const outcome = storageOutcome === "created"
          ? "ingested"
          : storageOutcome === "concurrent_dedup" ? "concurrent_dedup" : "deduplicated";
        return { imageId: createdRow?.id ?? null, outcome };
      }
      if (created === "race") {
        const winner = await input.repository.findImageByIdentity(snapshot.game.id, candidate.sourceUrl);
        if (!winner || !storageComplete(winner) || winner.contentHash !== fetchedHash) return { imageId: winner?.id ?? null, outcome: "inconsistent_state" };
        return { imageId: winner.id, outcome: "already_ingested" };
      }
      if (created === "write_conflict") return { imageId: null, outcome: "write_conflict" };
      return { imageId: null, outcome: "inconsistent_state" };
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return { imageId: row?.id ?? null, outcome: "deadline" };
      return { imageId: row?.id ?? null, outcome: "d1_write_failed" };
    }
  }

  return {
    async ingest(gameId: number, options: { write: boolean; signal?: AbortSignal }): Promise<ImageResult> {
      let snapshot: ImageIngestSnapshot | null;
      try {
        snapshot = await input.repository.readImageIngestSnapshot(gameId);
      } catch {
        return { gameId, status: "failed", preflightError: null, images: [] };
      }
      if (snapshot === null) return { gameId, status: "failed", preflightError: "game_not_found", images: [] };

      const dryRun = !options.write;
      const plan = planImageIngest(snapshot, dryRun);
      if (plan.preflight === "image_limit_exceeded") return { gameId, status: "failed", preflightError: "image_limit_exceeded", images: [] };

      const resolution = resolvePlanCandidates(snapshot);
      const results: ImageResult["images"] = resolution.rejected.map((rejected) => ({ imageId: rejected.existingId, outcome: "source_rejected" }));
      const startedAt = now();
      const deadlineAt = startedAt + gameDeadlineMs;
      const gameController = new AbortController();
      const onExternalAbort = (): void => gameController.abort();
      if (options.signal?.aborted) gameController.abort();
      else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
      const timer: TimerHandle = clock.setTimeout(() => gameController.abort(), gameDeadlineMs);
      try {
        for (const candidate of plan.candidates) {
          if (gameController.signal.aborted || now() >= deadlineAt) {
            results.push({ imageId: candidate.existingId, outcome: "skipped" });
            continue;
          }
          results.push(await processCandidate(snapshot, candidate, options.write, gameController.signal, deadlineAt));
        }
      } finally {
        clock.clearTimeout(timer);
        options.signal?.removeEventListener("abort", onExternalAbort);
      }
      const hitDeadline = gameController.signal.aborted || now() >= deadlineAt;
      const hasFailure = results.some((item) => !SUCCESS_OUTCOMES.has(item.outcome));
      const status = hitDeadline
        ? "partial"
        : results.length > 0 && results.every((item) => SUCCESS_OUTCOMES.has(item.outcome))
          ? "completed"
          : hasFailure && results.some((item) => SUCCESS_OUTCOMES.has(item.outcome)) ? "partial" : "failed";
      return {
        gameId,
        status,
        preflightError: hitDeadline ? "game_deadline" : null,
        images: results,
      };
    },
  };
}
