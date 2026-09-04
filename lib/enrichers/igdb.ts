import type {
  IgdbEnrichmentSnapshot,
  IgdbEnrichmentStore,
} from "../db/repositories/igdb-enrichment";
import type { IgdbClient } from "../providers/igdb/client";
import { IgdbError } from "../providers/igdb/errors";
import { normalizeIgdbGame } from "../providers/igdb/normalize";
import { parseIgdbGame, parseIgdbSteamMapping } from "../providers/igdb/response";
import type { IgdbEnrichmentPlan, IgdbEnrichmentResult } from "./igdb-candidate";
import { normalizeCanonicalGameId } from "./igdb-input";
import { planIgdbEnrichment } from "./igdb-plan";

const GAME_FIELDS = [
  "id",
  "name",
  "summary",
  "storyline",
  "first_release_date",
  "genres.id",
  "genres.name",
  "genres.slug",
  "platforms.id",
  "platforms.name",
  "platforms.slug",
  "involved_companies.developer",
  "involved_companies.publisher",
  "involved_companies.company.id",
  "involved_companies.company.name",
  "involved_companies.company.slug",
  "cover.image_id",
  "cover.width",
  "cover.height",
  "artworks.image_id",
  "artworks.width",
  "artworks.height",
  "screenshots.image_id",
  "screenshots.width",
  "screenshots.height",
  "videos.video_id",
  "videos.name",
  "websites.type",
  "websites.trusted",
  "websites.url",
] as const;

type IgdbEnricherDependencies = {
  client: IgdbClient;
  store: IgdbEnrichmentStore;
  parseSteamMapping?: typeof parseIgdbSteamMapping;
  parseGame?: typeof parseIgdbGame;
  normalizeGame?: typeof normalizeIgdbGame;
  planEnrichment?: typeof planIgdbEnrichment;
};

function isUsableProviderId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false;
  const numericId = Number(value);
  return Number.isSafeInteger(numericId) && numericId > 0;
}

function mappingQuery(steamAppId: string): string {
  if (!isUsableProviderId(steamAppId)) {
    throw new IgdbError(
      "steam_external_id_missing",
      "Canonical game does not have exactly one usable Steam external ID",
      { retryable: false },
    );
  }

  return `fields id,game,uid,external_game_source;
where external_game_source = 1 & uid = "${steamAppId}";
limit 2;`;
}

function gameQuery(igdbGameId: number): string {
  if (!Number.isSafeInteger(igdbGameId) || igdbGameId <= 0) {
    throw new IgdbError("schema_changed", "IGDB mapping returned an invalid game ID", {
      retryable: false,
    });
  }

  return `fields ${GAME_FIELDS.join(",")};
where id = ${igdbGameId};
limit 1;`;
}

function result(
  plan: IgdbEnrichmentPlan,
  dryRun: boolean,
  affectedRows: number,
): IgdbEnrichmentResult {
  if (plan.action === "enrich") {
    return {
      status: "enrich",
      gameId: plan.gameId,
      dryRun,
      affectedRows,
      plan: { ...plan, action: "enrich" },
    };
  }
  if (plan.action === "blocked") {
    return {
      status: "blocked",
      gameId: plan.gameId,
      dryRun,
      affectedRows,
      plan: { ...plan, action: "blocked" },
    };
  }
  return {
    status: "existing",
    gameId: plan.gameId,
    dryRun,
    affectedRows,
    plan: { ...plan, action: "existing" },
  };
}

function attemptedIdentityCreate(plan: IgdbEnrichmentPlan, igdbGameId: number): boolean {
  return plan.action === "enrich" && plan.creates.some((create) => (
    create.entity === "external_id"
    && create.values.gameId === plan.gameId
    && create.values.provider === "igdb"
    && create.values.externalId === String(igdbGameId)
  ));
}

function hasRecoveredSameGameIdentity(
  plan: IgdbEnrichmentPlan,
  snapshot: IgdbEnrichmentSnapshot,
  gameId: number,
  igdbGameId: number,
): boolean {
  const expectedIgdbId = String(igdbGameId);
  return plan.action === "existing"
    && plan.gameId === gameId
    && plan.matchedIgdbGame?.id === expectedIgdbId
    && plan.conflicts.length === 0
    && snapshot.externalIds.some((row) => (
      row.provider === "igdb"
      && row.externalId === expectedIgdbId
      && row.gameId === gameId
    ));
}

function hasRecoveredIdentityBlock(
  plan: IgdbEnrichmentPlan,
  snapshot: IgdbEnrichmentSnapshot,
  gameId: number,
  igdbGameId: number,
): boolean {
  if (
    plan.action !== "blocked"
    || plan.gameId !== gameId
    || plan.matchedIgdbGame?.id !== String(igdbGameId)
    || plan.creates.length > 0
    || plan.updates.length > 0
  ) {
    return false;
  }

  const expectedIgdbId = String(igdbGameId);
  const differentCurrentIds = new Set(snapshot.externalIds
    .filter((row) => row.provider === "igdb" && row.externalId !== expectedIgdbId)
    .map((row) => row.externalId));
  return plan.conflicts.some((conflict) => (
    conflict.code === "identity_conflict"
    && (
      (
        conflict.field === "external_id.igdb"
        && conflict.incoming === expectedIgdbId
        && typeof conflict.stored === "string"
        && differentCurrentIds.has(conflict.stored)
      )
      || (
        conflict.field === `external_id.igdb:${expectedIgdbId}`
        && conflict.incoming === gameId
        && typeof conflict.stored === "number"
        && Number.isSafeInteger(conflict.stored)
        && conflict.stored > 0
        && conflict.stored !== gameId
      )
    )
  ));
}

export function createIgdbEnricher(dependencies: IgdbEnricherDependencies) {
  const {
    client,
    store,
    parseSteamMapping = parseIgdbSteamMapping,
    parseGame = parseIgdbGame,
    normalizeGame = normalizeIgdbGame,
    planEnrichment = planIgdbEnrichment,
  } = dependencies;

  return {
    async enrichGame(
      input: number,
      options: { dryRun: boolean },
    ): Promise<IgdbEnrichmentResult> {
      const gameId = normalizeCanonicalGameId(input);
      const initialSnapshot = await store.findSnapshotByGameId(gameId);
      if (!initialSnapshot) {
        throw new IgdbError(
          "canonical_game_not_found",
          "Canonical GameHub game was not found",
          { retryable: false },
        );
      }
      if (!isUsableProviderId(initialSnapshot.steamAppId)) {
        throw new IgdbError(
          "steam_external_id_missing",
          "Canonical game does not have exactly one usable Steam external ID",
          { retryable: false },
        );
      }

      const mappingHttp = await client.request(
        "external_games",
        mappingQuery(initialSnapshot.steamAppId),
      );
      const { igdbGameId } = parseSteamMapping(mappingHttp.body, initialSnapshot.steamAppId);
      const gameHttp = await client.request("games", gameQuery(igdbGameId));
      const rawGame = parseGame(gameHttp.body, igdbGameId);
      const normalization = normalizeGame(rawGame, {
        canonicalGameId: gameId,
        steamAppId: initialSnapshot.steamAppId,
        igdbGameId,
      }, gameHttp.fetchedAt);
      const plan = await planEnrichment(store, initialSnapshot, normalization);

      if (options.dryRun || plan.action !== "enrich") {
        return result(plan, options.dryRun, 0);
      }

      try {
        const outcome = await store.applyPlan(plan);
        return result(plan, false, outcome.affectedRows);
      } catch (cause) {
        if (
          !(cause instanceof IgdbError)
          || cause.code !== "write_conflict"
          || cause.constraint !== "igdb_external_identity_unique"
          || !attemptedIdentityCreate(plan, igdbGameId)
        ) {
          throw cause;
        }

        const currentSnapshot = await store.findSnapshotByGameId(gameId);
        if (!currentSnapshot) throw cause;
        const recoveredPlan = await planEnrichment(store, currentSnapshot, normalization);
        if (
          hasRecoveredSameGameIdentity(recoveredPlan, currentSnapshot, gameId, igdbGameId)
          || hasRecoveredIdentityBlock(recoveredPlan, currentSnapshot, gameId, igdbGameId)
        ) {
          return result(recoveredPlan, false, 0);
        }
        throw cause;
      }
    },
  };
}
