import { createDatabase } from "../../../lib/db/client";
import { canonicalGameExists, createCandidateRepository } from "../../../lib/db/repositories/scheduled/candidates";
import { assertFence } from "../../../lib/db/repositories/scheduled/fence";
import { createScheduledIgdbStore } from "../../../lib/db/repositories/scheduled/igdb";
import { createLeaseRepository } from "../../../lib/db/repositories/scheduled/lease";
import { createScheduledLinkStore } from "../../../lib/db/repositories/scheduled/links";
import { createSchedulerStateRepository } from "../../../lib/db/repositories/scheduled/state";
import { createScheduledSteamStore } from "../../../lib/db/repositories/scheduled/steam";
import { createIgdbEnricher } from "../../../lib/enrichers/igdb";
import { createScheduledImageClient } from "../../../lib/images/scheduled-client";
import { createSteamImporter } from "../../../lib/importers/steam";
import { createIgdbAuthClient } from "../../../lib/providers/igdb/auth-client";
import { createIgdbClient } from "../../../lib/providers/igdb/client";
import { createSteamClient } from "../../../lib/providers/steam/client";
import { FenceLostError } from "../../../lib/scheduler/errors";
import type { CronSyncDependencies } from "../../../lib/scheduler/service";
import { parseScheduledMutationAuthority, type CronExecutionInput } from "../../../lib/scheduler/types";
import { runBulkSyncBatch } from "../../../lib/sync/batch";
import { createIgdbStage } from "../../../lib/sync/igdb-stage";
import { createImageSyncStage } from "../../../lib/sync/image-stage";
import { createLinkStage } from "../../../lib/sync/link-stage";
import { createSteamStage } from "../../../lib/sync/steam-stage";
import { stageError } from "../../../lib/sync/stages";
import type { StageName } from "../../../lib/sync/types";
import { createRemoteVerifierTransport } from "../../../lib/verifiers/official-links/remote/client";
import { createLinkVerificationService } from "../../../lib/verifiers/official-links/service";
import { parseCronWorkerEnvironment, type CronWorkerEnv } from "./config";
import { emitCronEvent, type SafeCronEvent } from "./logging";
import { createPrivateVerifierBinding } from "./verifier-container";

export function composeCronDependencies(env: CronWorkerEnv, input: CronExecutionInput): CronSyncDependencies {
  const config = parseCronWorkerEnvironment(env);
  const started = performance.now();
  const db = createDatabase(env.DB);
  const lease = createLeaseRepository(env.DB);
  const candidates = createCandidateRepository(env.DB);
  const event = (value: SafeCronEvent) => emitCronEvent(value, line => console.log(line));
  const base = () => ({ executionId: input.executionId, timestamp: Date.now() });
  const auth = createIgdbAuthClient({ clientId: config.clientId, clientSecret: config.clientSecret });
  const steam = createSteamClient();
  const igdb = createIgdbClient({ auth, clientId: config.clientId });
  const verifier = createRemoteVerifierTransport({ binding: createPrivateVerifierBinding(env.VERIFIER_CONTAINER),
    secret: config.verifierSecret, nowMs: Date.now, newRequestId: () => crypto.randomUUID() });
  return {
    config: config.sync,
    lease: { ...lease, async acquire(owner, duration) {
      const result = await lease.acquire(owner, duration);
      if (result.status === "acquired") event({ ...base(), event: "lease_acquired", fenceEpoch: result.lease.fenceEpoch });
      else event({ ...base(), event: "lease_skipped" });
      return result;
    } },
    candidates: { ...candidates, async select(limit) {
      const result = await candidates.select(limit);
      event({ ...base(), event: "candidates_selected", selected: result.length });
      return result;
    } },
    state: createSchedulerStateRepository(env.DB),
    gameExists: id => canonicalGameExists(env.DB, id),
    elapsedMs: () => performance.now() - started,
    newOwnerToken: () => crypto.randomUUID(),
    runBatch: runBulkSyncBatch,
    createGameRuntime(candidateInput, authorityInput, signals) {
      const candidate = Object.freeze({ ...candidateInput });
      const authority = parseScheduledMutationAuthority(authorityInput);
      const storeInput = { binding: env.DB, db, candidate, authority, signals };
      const native = {
        steam: createSteamStage(createSteamImporter({ client: steam, store: createScheduledSteamStore(storeInput) })),
        igdb: createIgdbStage(createIgdbEnricher({ client: igdb, store: createScheduledIgdbStore(storeInput) })),
        links: createLinkStage(createLinkVerificationService({ store: createScheduledLinkStore(storeInput), verifyUrl: verifier.verify })),
        images: createImageSyncStage(createScheduledImageClient({ binding: env.IMAGE_INGEST,
          token: config.scheduledImageToken, authority, signals, newRequestId: () => crypto.randomUUID() })),
      };
      async function guarded<T>(stage: StageName, argument: string | number, dryRun: boolean, execute: () => Promise<T>): Promise<T> {
        const reject = () => stageError(stage, "write_conflict");
        const blocked = () => signals.readAuthorityLoss() !== null || signals.readUnsettledImageWork().length > 0;
        if (dryRun || argument !== (stage === "steam" ? candidate.appId : candidate.gameId) || blocked()) throw reject();
        try { await lease.assertOwned(authority); }
        catch { signals.markAuthorityLoss("lease_lost"); throw reject(); }
        if (blocked()) throw reject();
        try {
          return await execute();
        } finally {
          // Covers no-write plans and exceptions hidden by native stage mapping.
          // This diagnostic postcheck never authorizes a business mutation.
          try { await assertFence(env.DB, authority); }
          catch (error) {
            if (error instanceof FenceLostError) signals.markAuthorityLoss("fence_lost");
            throw reject();
          }
          if (signals.readAuthorityLoss()) throw reject();
        }
      }
      return {
        readAuthorityLoss: signals.readAuthorityLoss,
        readUnsettledImageWork: signals.readUnsettledImageWork,
        stages: {
          steam: { execute: (id, ctx) => guarded("steam", id, ctx.dryRun, () => native.steam.execute(id, ctx)) },
          igdb: { execute: (id, ctx) => guarded("igdb", id, ctx.dryRun, () => native.igdb.execute(id, ctx)) },
          links: { execute: (id, ctx) => guarded("links", id, ctx.dryRun, () => native.links.execute(id, ctx)) },
          images: { execute: (id, ctx) => guarded("images", id, ctx.dryRun, () => native.images.execute(id, ctx)) },
        },
      };
    },
  };
}
