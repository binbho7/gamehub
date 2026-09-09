import { downloadImageSource, type DownloadHop, type DownloadRequest } from "./downloader";
import { systemClock, type Clock, type TimerHandle } from "./clock";
import { validateImageBytes } from "./formats";
import { sha256Hex } from "./hash";
import { buildImageStorageKey } from "./storage-key";
import { matchesR2ImageMetadata } from "./r2-store";
import { assertImageOperationAlive, ImageDeadlineError, type ImageOperationContext } from "./deadline";
import { planImageIngest, resolvePlanCandidates } from "./plan";
import type { ImageCandidate } from "./candidates";
import { sanitizeUrlForPresentation } from "../verifiers/official-links/presentation";
import type { ImageIngestDependencies, ImageOutcome, ImageResult, ImageIngestSnapshot, ImageItemResult, ImageStage, ImageAttempt } from "./types";

const GAME_DEADLINE_MS = 5 * 60 * 1000;
const IMAGE_DEADLINE_MS = 30 * 1000;
const SUCCESS_OUTCOMES = new Set<ImageOutcome>([
  "ingested", "deduplicated", "concurrent_dedup", "already_ingested", "restored", "skipped",
]);

type ImageRow = ImageIngestSnapshot["images"][number];
type StorageOutcome = "deduplicated" | "concurrent_dedup" | "created" | "storage_conflict" | "storage_failed";
type DiagnosticState = { image: ImageItemResult; stage: ImageStage };
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function newImageResult(imageId: number | null, sourceUrl: string, provider: ImageCandidate["provider"] | null, startedAt: number): ImageItemResult {
  return {
    imageId, sourceUrl, provider, presentationUrl: sanitizeUrlForPresentation(sourceUrl), outcome: "skipped",
    attempts: [], redirectChain: [], finalUrl: null, httpStatus: null, selectedMimeType: null,
    byteCount: null, contentHash: null, dimensions: null, error: null,
    timing: { startedAt, finishedAt: startedAt, durationMs: 0 },
  };
}

function recordHop(state: DiagnosticState, candidate: ImageCandidate, hop: DownloadHop): void {
  const redirect = hop.status !== null && REDIRECT_STATUSES.has(hop.status);
  if (redirect) {
    let resolvedUrl: string | null = null;
    try { if (hop.location) resolvedUrl = new URL(hop.location, hop.url).toString(); } catch { /* Malformed Location stays available internally. */ }
    state.image.redirectChain.push({ fromUrl: hop.url, location: hop.location, resolvedUrl, status: hop.status! });
  }
  const attempt: ImageAttempt = {
    ...hop,
    presentationUrl: sanitizeUrlForPresentation(hop.url), provider: candidate.provider, method: "GET",
    hopStatus: redirect ? "redirect" : hop.status === null ? "failed" : "response",
    headers: hop.headers ?? { contentType: null, contentLength: null },
    redirectChain: state.image.redirectChain.map((entry) => ({ ...entry })),
    finalUrl: redirect ? null : hop.url, selectedMimeType: null, byteCount: null, contentHash: null, dimensions: null,
    timing: hop.timing ?? { ...state.image.timing }, errorCode: null,
  };
  state.image.attempts.push(attempt);
}

function storageComplete(row: ImageRow): boolean {
  return [row.storageUrl, row.storageKey, row.contentHash, row.mimeType, row.fileSize].every((value) => value !== null);
}

function storageEmpty(row: ImageRow): boolean {
  return [row.storageUrl, row.storageKey, row.contentHash, row.mimeType, row.fileSize].every((value) => value === null);
}

function metadataMatches(
  object: Awaited<ReturnType<ImageIngestDependencies["r2"]["head"]>>,
  row: Pick<ImageRow, "contentHash" | "mimeType" | "fileSize">,
): boolean {
  if (!object.exists || row.contentHash === null || row.mimeType === null || row.fileSize === null) return false;
  return matchesR2ImageMetadata(object, { size: row.fileSize, hash: row.contentHash, mimeType: row.mimeType });
}

function bindingMatches(row: ImageRow, binding: {
  storageKey: string; storageUrl: string; contentHash: string; mimeType: string; fileSize: number; width: number; height: number;
}, candidate: ImageCandidate): boolean {
  return row.type === candidate.type && row.sourceProvider === candidate.provider && row.sourceUrl === candidate.sourceUrl
    && row.storageKey === binding.storageKey && row.storageUrl === binding.storageUrl && row.contentHash === binding.contentHash
    && row.mimeType === binding.mimeType && row.fileSize === binding.fileSize && row.width === binding.width && row.height === binding.height;
}

function outcomeFromDownload(result: Awaited<ReturnType<typeof downloadImageSource>>): ImageOutcome | null {
  return result.outcome === "downloaded" ? null : result.outcome;
}

export function createImageIngestService(input: ImageIngestDependencies) {
  const now = input.now ?? (() => Date.now());
  const clock: Clock = input.clock ?? systemClock;
  const fetchImpl = input.fetchImpl ?? fetch;
  const download = input.download ?? downloadImageSource;
  const validate = input.validate ?? validateImageBytes;
  const hash = input.hash ?? sha256Hex;
  const storageKey = input.storageKey ?? buildImageStorageKey;
  const gameDeadlineMs = input.gameDeadlineMs ?? GAME_DEADLINE_MS;
  type ImageContext = ImageOperationContext & { cancel: () => void; dispose: () => void };

  function imageContext(parent: AbortSignal, gameDeadlineAt: number): ImageContext {
    const controller = new AbortController();
    const deadlineAt = Math.min(gameDeadlineAt, now() + IMAGE_DEADLINE_MS);
    const onParentAbort = (): void => controller.abort();
    if (parent.aborted) controller.abort(); else parent.addEventListener("abort", onParentAbort, { once: true });
    const timer: TimerHandle = clock.setTimeout(() => controller.abort(), Math.max(0, deadlineAt - now()));
    return { signal: controller.signal, deadlineAt, now, cancel: () => controller.abort(), dispose: () => { controller.abort(); clock.clearTimeout(timer); parent.removeEventListener("abort", onParentAbort); } };
  }

  function assertAlive(context: ImageContext): void {
    assertImageOperationAlive(context);
  }

  async function withImageDeadline<T>(operation: () => Promise<T>, context: ImageContext): Promise<T> {
    assertAlive(context);
    const pending = Promise.resolve().then(() => { assertAlive(context); return operation(); });
    void pending.catch(() => undefined);
    let timer: TimerHandle | null = null;
    let removeAbort: () => void = () => undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = clock.setTimeout(() => { context.cancel(); reject(new ImageDeadlineError()); }, Math.max(0, context.deadlineAt - now()));
    });
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(new ImageDeadlineError());
      removeAbort = () => context.signal.removeEventListener("abort", onAbort);
      context.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([pending, timeout, aborted]);
      assertAlive(context);
      return result;
    } finally {
      if (timer !== null) clock.clearTimeout(timer);
      removeAbort();
    }
  }

  async function downloadAndValidate(candidate: ImageCandidate, context: ImageContext, state: DiagnosticState) {
    assertAlive(context);
    state.stage = "download";
    const request: DownloadRequest = { candidate, fetchImpl, signal: context.signal, now, clock, onAttempt: (hop) => {
      if (!context.signal.aborted) recordHop(state, candidate, hop);
    } };
    let downloaded;
    try { downloaded = await withImageDeadline(() => download(request), context); }
    catch (error) { return { outcome: error instanceof ImageDeadlineError ? "deadline" as ImageOutcome : "download_failed" as ImageOutcome }; }
    // Rebuild from the completed transport result, including injected transports.
    state.image.attempts = [];
    state.image.redirectChain = [];
    for (const hop of downloaded.attempts) recordHop(state, candidate, hop);
    state.image.finalUrl = downloaded.finalUrl;
    state.image.httpStatus = downloaded.httpStatus;
    state.image.byteCount = downloaded.byteCount ?? downloaded.bytes?.byteLength ?? null;
    if (downloaded.errorCode) state.image.error = { stage: "download", code: downloaded.errorCode };
    if (context.signal.aborted || now() >= context.deadlineAt) return { outcome: "deadline" as ImageOutcome };
    const downloadOutcome = outcomeFromDownload(downloaded);
    if (downloadOutcome !== null) return { outcome: downloadOutcome };
    if (downloaded.bytes === null) return { outcome: "download_failed" as ImageOutcome };
    state.stage = "validation";
    let validation;
    try { assertAlive(context); validation = validate(downloaded.bytes, downloaded.contentType); }
    catch (error) { return { outcome: error instanceof ImageDeadlineError ? "deadline" as ImageOutcome : "invalid_image" as ImageOutcome }; }
    if (!validation.ok) return { outcome: validation.outcome as ImageOutcome };
    state.image.selectedMimeType = validation.mimeType;
    state.image.dimensions = { ...validation.dimensions };
    state.stage = "hash";
    let contentHash: string;
    try { contentHash = await withImageDeadline(() => hash(downloaded.bytes!), context); }
    catch (error) { return { outcome: error instanceof ImageDeadlineError ? "deadline" as ImageOutcome : "invalid_image" as ImageOutcome }; }
    state.image.contentHash = contentHash;
    return { outcome: null, bytes: downloaded.bytes, mimeType: validation.mimeType, width: validation.dimensions.width, height: validation.dimensions.height, contentHash };
  }

  async function identityRows(gameId: number, sourceUrl: string): Promise<ImageRow[]> {
    if (input.repository.findImagesByIdentity) return input.repository.findImagesByIdentity(gameId, sourceUrl);
    const row = await input.repository.findImageByIdentity(gameId, sourceUrl);
    return row === null ? [] : [row];
  }

  async function executeCandidate(snapshot: ImageIngestSnapshot, candidate: ImageCandidate, write: boolean, context: ImageContext, state: DiagnosticState): Promise<{ imageId: number | null; outcome: ImageOutcome }> {
    const row = candidate.existingId === null ? null : snapshot.images.find((image) => image.id === candidate.existingId) ?? null;
    const id = row?.id ?? null;
    try {
      if (row !== null && !storageEmpty(row) && !storageComplete(row)) return { imageId: id, outcome: "inconsistent_state" };
      if (row !== null && storageComplete(row) && row.storageKey !== null) {
        state.stage = "storage";
        state.image.selectedMimeType = row.mimeType;
        state.image.contentHash = row.contentHash;
        state.image.byteCount = row.fileSize;
        state.image.dimensions = row.width !== null && row.height !== null ? { width: row.width, height: row.height } : null;
        let object;
        try { object = await withImageDeadline(() => input.r2.head(row.storageKey!), context); }
        catch (error) { return { imageId: id, outcome: error instanceof ImageDeadlineError ? "deadline" : "storage_failed" }; }
        if (metadataMatches(object, row)) return { imageId: id, outcome: "already_ingested" };
        if (object.exists) return { imageId: id, outcome: "storage_conflict" };
      }
      const fetched = await downloadAndValidate(candidate, context, state);
      if (fetched.outcome !== null) return { imageId: id, outcome: fetched.outcome };
      const fetchedBytes = fetched.bytes!;
      const fetchedHash = fetched.contentHash!;
      state.stage = "storage";
      if (row !== null && storageComplete(row)) {
        if (row.contentHash !== fetchedHash || row.mimeType !== fetched.mimeType || row.fileSize !== fetchedBytes.byteLength) return { imageId: id, outcome: "source_changed" };
        if (write) {
          try { const stored = await withImageDeadline(() => input.r2.ensureObject({ key: row.storageKey!, bytes: fetchedBytes, hash: fetchedHash, mimeType: fetched.mimeType!, size: fetchedBytes.byteLength }, context), context); if (stored.outcome === "storage_conflict") return { imageId: id, outcome: "storage_conflict" }; if (stored.outcome === "storage_failed") return { imageId: id, outcome: "storage_failed" }; }
          catch (error) { return { imageId: id, outcome: error instanceof ImageDeadlineError ? "deadline" : "storage_failed" }; }
        }
        return { imageId: id, outcome: "restored" };
      }

      const key = storageKey(fetchedHash, fetched.mimeType!);
      let storageOutcome: StorageOutcome;
      let storageUrl: string | null = null;
      if (write) {
        try { const stored = await withImageDeadline(() => input.r2.ensureObject({ key, bytes: fetchedBytes, hash: fetchedHash, mimeType: fetched.mimeType!, size: fetchedBytes.byteLength }, context), context); storageOutcome = stored.outcome; storageUrl = stored.storageUrl; }
        catch (error) { return { imageId: id, outcome: error instanceof ImageDeadlineError ? "deadline" : "storage_failed" }; }
      } else {
        let object;
        try { object = await withImageDeadline(() => input.r2.head(key), context); }
        catch (error) { return { imageId: id, outcome: error instanceof ImageDeadlineError ? "deadline" : "storage_failed" }; }
        const expected = { contentHash: fetchedHash, mimeType: fetched.mimeType, fileSize: fetchedBytes.byteLength };
        if (object.exists && !metadataMatches(object, expected)) return { imageId: id, outcome: "storage_conflict" };
        storageOutcome = object.exists ? "deduplicated" : "created";
      }
      if (storageOutcome === "storage_conflict") return { imageId: id, outcome: "storage_conflict" };
      if (storageOutcome === "storage_failed") return { imageId: id, outcome: "storage_failed" };
      if (!write) return { imageId: id, outcome: storageOutcome === "deduplicated" ? "deduplicated" : "ingested" };

      state.stage = "d1";
      const binding = { storageKey: key, storageUrl: storageUrl!, contentHash: fetchedHash, mimeType: fetched.mimeType!, fileSize: fetchedBytes.byteLength, width: fetched.width!, height: fetched.height! };
      if (row !== null) {
        let bound: Awaited<ReturnType<typeof input.repository.optimisticBindImage>>;
        try { bound = await withImageDeadline(() => input.repository.optimisticBindImage(row, binding), context); }
        catch (error) { return { imageId: id, outcome: error instanceof ImageDeadlineError ? "deadline" : "d1_write_failed" }; }
        if (bound === "applied") { const outcome = storageOutcome === "created" ? "ingested" : storageOutcome === "concurrent_dedup" ? "concurrent_dedup" : "deduplicated"; return { imageId: id, outcome }; }
        return { imageId: id, outcome: bound === "write_conflict" ? "write_conflict" : "inconsistent_state" };
      }

      let created: Awaited<ReturnType<typeof input.repository.conditionallyCreateImage>>;
      try { created = await withImageDeadline(() => input.repository.conditionallyCreateImage({ gameId: snapshot.game.id, type: candidate.type, sourceUrl: candidate.sourceUrl, sourceProvider: candidate.provider, sortOrder: candidate.sortOrder, gameUpdatedAt: snapshot.game.updatedAt, ...binding }), context); }
      catch (error) { return { imageId: null, outcome: error instanceof ImageDeadlineError ? "deadline" : "d1_write_failed" }; }
      if (created === "write_conflict") return { imageId: null, outcome: "write_conflict" };
      if (created === "inconsistent_state") return { imageId: null, outcome: "inconsistent_state" };
      let winners: ImageRow[];
      try { winners = await withImageDeadline(() => identityRows(snapshot.game.id, candidate.sourceUrl), context); }
      catch (error) { return { imageId: null, outcome: error instanceof ImageDeadlineError ? "deadline" : "d1_write_failed" }; }
      if (winners.length !== 1) return { imageId: winners[0]?.id ?? null, outcome: "inconsistent_state" };
      const winner = winners[0]!;
      if (!bindingMatches(winner, binding, candidate)) return { imageId: winner.id, outcome: "inconsistent_state" };
      if (created === "race") return { imageId: winner.id, outcome: "concurrent_dedup" };
      const outcome = storageOutcome === "created" ? "ingested" : storageOutcome === "concurrent_dedup" ? "concurrent_dedup" : "deduplicated";
      return { imageId: winner.id, outcome };
    } catch (error) {
      return { imageId: id, outcome: error instanceof ImageDeadlineError ? "deadline" : "download_failed" };
    }
  }

  async function processCandidate(snapshot: ImageIngestSnapshot, candidate: ImageCandidate, write: boolean, parentSignal: AbortSignal, gameDeadlineAt: number): Promise<ImageItemResult> {
    const state: DiagnosticState = { image: newImageResult(candidate.existingId, candidate.sourceUrl, candidate.provider, now()), stage: "source" };
    const context = imageContext(parentSignal, gameDeadlineAt);
    try {
      const outcome = await executeCandidate(snapshot, candidate, write, context, state);
      Object.assign(state.image, outcome);
      if (!SUCCESS_OUTCOMES.has(outcome.outcome)) {
        state.image.error ??= { stage: state.stage, code: outcome.outcome === "deadline" ? "image_deadline" : outcome.outcome };
      }
      const finalAttempt = state.image.attempts.at(-1);
      if (finalAttempt) {
        finalAttempt.finalUrl = state.image.finalUrl;
        finalAttempt.selectedMimeType = state.image.selectedMimeType;
        finalAttempt.byteCount = state.image.byteCount;
        finalAttempt.contentHash = state.image.contentHash;
        finalAttempt.dimensions = state.image.dimensions === null ? null : { ...state.image.dimensions };
        finalAttempt.errorCode = state.image.error?.code ?? null;
      }
      const finishedAt = now();
      state.image.timing = { startedAt: state.image.timing.startedAt, finishedAt, durationMs: Math.max(0, finishedAt - state.image.timing.startedAt) };
      return state.image;
    } finally { context.dispose(); }
  }

  return {
    async ingest(gameId: number, options: { write: boolean; signal?: AbortSignal }): Promise<ImageResult> {
      let snapshot: ImageIngestSnapshot | null;
      try { snapshot = await input.repository.readImageIngestSnapshot(gameId); }
      catch { return { gameId, status: "failed", preflightError: null, plan: null, images: [] }; }
      if (snapshot === null) return { gameId, status: "failed", preflightError: "game_not_found", plan: null, images: [] };
      const plan = planImageIngest(snapshot, !options.write);
      if (plan.preflight === "image_limit_exceeded") return { gameId, status: "failed", preflightError: "image_limit_exceeded", plan, images: [] };
      const resolution = resolvePlanCandidates(snapshot);
      const results: ImageResult["images"] = resolution.rejected.map((rejected) => ({
        ...newImageResult(rejected.existingId, rejected.sourceUrl, null, now()), outcome: "source_rejected", error: { stage: "source", code: "source_rejected" },
      }));
      const gameDeadlineAt = now() + gameDeadlineMs;
      const gameController = new AbortController();
      const onExternalAbort = (): void => gameController.abort();
      if (options.signal?.aborted) gameController.abort(); else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
      const timer = clock.setTimeout(() => gameController.abort(), Math.max(0, gameDeadlineMs));
      try {
        for (const candidate of plan.candidates) {
          if (gameController.signal.aborted || now() >= gameDeadlineAt) results.push(newImageResult(candidate.existingId, candidate.sourceUrl, candidate.provider, now()));
          else results.push(await processCandidate(snapshot, candidate, options.write, gameController.signal, gameDeadlineAt));
        }
      } finally { clock.clearTimeout(timer); options.signal?.removeEventListener("abort", onExternalAbort); }
      const hitDeadline = gameController.signal.aborted || now() >= gameDeadlineAt;
      const hasSuccess = results.some((item) => SUCCESS_OUTCOMES.has(item.outcome));
      const allSuccess = results.length > 0 && results.every((item) => SUCCESS_OUTCOMES.has(item.outcome));
      return { gameId, status: hitDeadline || (hasSuccess && !allSuccess) ? "partial" : allSuccess ? "completed" : "failed", preflightError: hitDeadline ? "game_deadline" : null, plan, images: results };
    },
  };
}
