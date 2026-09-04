import type {
  IgdbEnrichmentSnapshot,
  IgdbEnrichmentStore,
} from "../db/repositories/igdb-enrichment";
import { companyCollisionSlug } from "../importers/slug";
import {
  igdbNormalizationResultSchema,
  type IgdbEnrichmentCandidate,
  type IgdbEnrichmentPlan,
  type IgdbEnrichmentWarning,
  type IgdbNormalizationResult,
  type PlannedCreate,
  type PlannedSkip,
  type PlannedUpdate,
} from "./igdb-candidate";

const COMPANY_HASH_LENGTHS = Array.from({ length: 15 }, (_, index) => 8 + index * 4);

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const keys = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

function matchedGame(
  snapshot: IgdbEnrichmentSnapshot,
  candidate: IgdbEnrichmentCandidate,
): IgdbEnrichmentPlan["matchedIgdbGame"] {
  return {
    id: candidate.identity.igdbGameId,
    name: candidate.game.title ?? snapshot.game.title,
  };
}

function basePlan(
  snapshot: IgdbEnrichmentSnapshot,
  candidate: IgdbEnrichmentCandidate,
  warnings: IgdbEnrichmentWarning[],
): IgdbEnrichmentPlan {
  return {
    action: "existing",
    gameId: snapshot.game.id,
    slug: snapshot.game.slug,
    matchedIgdbGame: matchedGame(snapshot, candidate),
    creates: [],
    updates: [],
    skips: [],
    warnings,
    conflicts: [],
  };
}

function planScalars(
  snapshot: IgdbEnrichmentSnapshot,
  candidate: IgdbEnrichmentCandidate,
  updates: PlannedUpdate[],
  skips: PlannedSkip[],
): void {
  if (candidate.game.title !== null && candidate.game.title !== snapshot.game.title) {
    skips.push({
      field: "game.title",
      reason: "ownership_unknown",
      incoming: candidate.game.title,
      stored: snapshot.game.title,
    });
  }

  const changes: PlannedUpdate["changes"] = {};
  const fields = ["summary", "description", "releaseDate", "coverUrl", "heroUrl"] as const;
  for (const field of fields) {
    const incoming = candidate.game[field];
    const stored = snapshot.game[field];
    if (incoming === null || incoming === stored) continue;
    if (stored === null) {
      changes[field] = incoming;
      continue;
    }
    skips.push({ field: `game.${field}`, reason: "ownership_unknown", incoming, stored });
  }
  if (Object.keys(changes).length > 0) {
    updates.push({ entity: "game", key: String(snapshot.game.id), changes });
  }
}

function planTaxonomies(
  kind: "genre" | "platform",
  snapshot: IgdbEnrichmentSnapshot,
  incoming: Array<{ slug: string; name: string }>,
  indexed: Array<{ slug: string; name: string }>,
  creates: PlannedCreate[],
  skips: PlannedSkip[],
): void {
  const current = new Map(snapshot[`${kind}s`].map((row) => [row.slug, row]));
  const bySlug = new Map(indexed.map((row) => [row.slug, row]));
  const candidates = uniqueBy(incoming, (item) => item.slug);
  const namesBySlug = new Map<string, Map<string, string>>();
  for (const item of incoming) {
    const names = namesBySlug.get(item.slug) ?? new Map<string, string>();
    names.set(normalizedName(item.name), item.name);
    namesBySlug.set(item.slug, names);
  }

  for (const item of candidates) {
    const stored = bySlug.get(item.slug) ?? current.get(item.slug);
    const candidateNames = [...(namesBySlug.get(item.slug)?.values() ?? [])];
    if (candidateNames.length > 1) {
      skips.push({
        field: `${kind}.${item.slug}`,
        reason: "taxonomy_conflict",
        incoming: candidateNames,
        stored: stored?.name ?? null,
      });
      continue;
    }
    if (stored && normalizedName(stored.name) !== normalizedName(item.name)) {
      skips.push({
        field: `${kind}.${item.slug}`,
        reason: "taxonomy_conflict",
        incoming: item.name,
        stored: stored.name,
      });
      continue;
    }
    if (!stored) {
      if (kind === "genre") {
        creates.push({ entity: "genre", key: item.slug, values: { slug: item.slug, name: item.name } });
      } else {
        creates.push({ entity: "platform", key: item.slug, values: { slug: item.slug, name: item.name } });
      }
    }
    if (current.has(item.slug)) continue;
    if (kind === "genre") {
      creates.push({
        entity: "game_genre",
        key: `${snapshot.game.id}:${item.slug}`,
        values: { gameId: snapshot.game.id, genreSlug: item.slug },
      });
    } else {
      creates.push({
        entity: "game_platform",
        key: `${snapshot.game.id}:${item.slug}`,
        values: { gameId: snapshot.game.id, platformSlug: item.slug },
      });
    }
  }
}

type CompanyIdentity = {
  preferredSlug: string;
  name: string;
};

async function resolveCompanySlugs(
  store: IgdbEnrichmentStore,
  incoming: IgdbEnrichmentCandidate["companies"],
  indexed: Awaited<ReturnType<IgdbEnrichmentStore["findCompaniesBySlugs"]>>,
  warnings: IgdbEnrichmentWarning[],
  skips: PlannedSkip[],
): Promise<{
  selectedByIdentity: Map<string, string>;
  existingBySlug: Map<string, { slug: string; name: string }>;
}> {
  const identities = uniqueBy<CompanyIdentity>(incoming.map(({ preferredSlug, name }) => ({
    preferredSlug,
    name,
  })), (company) => `${company.preferredSlug}:${normalizedName(company.name)}`);
  const baseBySlug = new Map(indexed.map((row) => [row.slug, row]));
  const reservedNames = new Map<string, string>();
  const collisionCandidates = new Map<string, string[]>();

  for (const company of identities) {
    const identity = `${company.preferredSlug}:${normalizedName(company.name)}`;
    const name = normalizedName(company.name);
    const occupant = baseBySlug.get(company.preferredSlug);
    const reserved = reservedNames.get(company.preferredSlug);
    if ((!occupant || normalizedName(occupant.name) === name) && (!reserved || reserved === name)) {
      reservedNames.set(company.preferredSlug, name);
      collisionCandidates.set(identity, [company.preferredSlug]);
      continue;
    }
    collisionCandidates.set(identity, await Promise.all(COMPANY_HASH_LENGTHS.map((length) => (
      companyCollisionSlug(company.preferredSlug, name, length)
    ))));
  }

  const collisionSlugs = uniqueBy(
    [...collisionCandidates.values()].flat().filter((slug) => !baseBySlug.has(slug)),
    (slug) => slug,
  );
  const collisionRows = collisionSlugs.length === 0 ? [] : await store.findCompaniesBySlugs(collisionSlugs);
  const existingBySlug = new Map([...indexed, ...collisionRows].map((row) => [row.slug, row]));
  const selectedByIdentity = new Map<string, string>();

  for (const company of identities) {
    const name = normalizedName(company.name);
    const identity = `${company.preferredSlug}:${name}`;
    const selected = collisionCandidates.get(identity)?.find((slug) => {
      const occupant = existingBySlug.get(slug);
      const reserved = reservedNames.get(slug);
      return (!occupant || normalizedName(occupant.name) === name) && (!reserved || reserved === name);
    });
    if (!selected) {
      skips.push({
        field: `company.${company.preferredSlug}`,
        reason: "company_conflict",
        incoming: company.name,
        stored: baseBySlug.get(company.preferredSlug)?.name ?? null,
      });
      warnings.push({
        code: "company_conflict",
        message: `No deterministic company slug remained for ${company.name}`,
        path: `companies.${company.preferredSlug}`,
      });
      continue;
    }
    reservedNames.set(selected, name);
    selectedByIdentity.set(identity, selected);
    if (selected !== company.preferredSlug) {
      warnings.push({
        code: "company_slug_collision",
        message: `Used ${selected} because ${company.preferredSlug} belongs to a different company`,
        path: `companies.${company.preferredSlug}`,
      });
    }
  }

  return { selectedByIdentity, existingBySlug };
}

async function planCompanies(
  store: IgdbEnrichmentStore,
  snapshot: IgdbEnrichmentSnapshot,
  candidate: IgdbEnrichmentCandidate,
  indexed: Awaited<ReturnType<IgdbEnrichmentStore["findCompaniesBySlugs"]>>,
  creates: PlannedCreate[],
  warnings: IgdbEnrichmentWarning[],
  skips: PlannedSkip[],
): Promise<void> {
  const { selectedByIdentity, existingBySlug } = await resolveCompanySlugs(
    store,
    candidate.companies,
    indexed,
    warnings,
    skips,
  );
  const currentCompanies = new Map(snapshot.companies.map((row) => [row.slug, row]));
  const currentRelations = new Set(snapshot.companies.map((row) => `${row.slug}:${row.role}`));
  const createdCompanies = new Set<string>();
  const createdRelations = new Set<string>();

  for (const company of candidate.companies) {
    const identity = `${company.preferredSlug}:${normalizedName(company.name)}`;
    const slug = selectedByIdentity.get(identity);
    if (!slug) continue;
    const stored = existingBySlug.get(slug) ?? currentCompanies.get(slug);
    if (!stored && !createdCompanies.has(slug)) {
      creates.push({
        entity: "company",
        key: slug,
        values: { slug, name: company.name, websiteUrl: null },
      });
      createdCompanies.add(slug);
    }
    const relation = `${slug}:${company.role}`;
    if (!currentRelations.has(relation) && !createdRelations.has(relation)) {
      creates.push({
        entity: "game_company",
        key: `${snapshot.game.id}:${relation}`,
        values: { gameId: snapshot.game.id, companySlug: slug, role: company.role },
      });
      createdRelations.add(relation);
    }
  }
}

function planOfficialLinks(
  snapshot: IgdbEnrichmentSnapshot,
  candidate: IgdbEnrichmentCandidate,
  indexed: Awaited<ReturnType<IgdbEnrichmentStore["findOfficialLinksByUrls"]>>,
  creates: PlannedCreate[],
  skips: PlannedSkip[],
): void {
  const existing = new Map<string, IgdbEnrichmentSnapshot["officialLinks"][number]>([
    ...snapshot.officialLinks.map((row) => [row.url, row] as const),
    ...indexed.map((row) => [row.url, row] as const),
  ]);
  for (const link of candidate.officialLinks) {
    const stored = existing.get(link.url);
    if (stored) {
      const fields = [
        "provider",
        "platform",
        "linkType",
        "isOfficial",
        "verificationStatus",
        "verificationMethod",
      ] as const;
      for (const field of fields) {
        if (link[field] === stored[field]) continue;
        skips.push({
          field: `official_link.${link.url}.${field}`,
          reason: "existing_metadata_preserved",
          incoming: link[field],
          stored: stored[field],
        });
      }
      continue;
    }
    creates.push({
      entity: "official_link",
      key: link.url,
      values: { gameId: snapshot.game.id, ...link },
    });
  }
}

function planImages(
  snapshot: IgdbEnrichmentSnapshot,
  candidate: IgdbEnrichmentCandidate,
  indexed: Awaited<ReturnType<IgdbEnrichmentStore["findImagesBySourceUrls"]>>,
  creates: PlannedCreate[],
  skips: PlannedSkip[],
): void {
  const existing = new Map<string, IgdbEnrichmentSnapshot["images"][number]>([
    ...snapshot.images.map((row) => [row.sourceUrl, row] as const),
    ...indexed.map((row) => [row.sourceUrl, row] as const),
  ]);
  for (const item of candidate.images) {
    const stored = existing.get(item.sourceUrl);
    if (stored) {
      const fields = ["type", "width", "height", "sortOrder"] as const;
      for (const field of fields) {
        if (item[field] === stored[field]) continue;
        skips.push({
          field: `image.${item.sourceUrl}.${field}`,
          reason: "existing_metadata_preserved",
          incoming: item[field],
          stored: stored[field],
        });
      }
      continue;
    }
    creates.push({
      entity: "image",
      key: item.sourceUrl,
      values: { gameId: snapshot.game.id, ...item },
    });
  }
}

function planVideos(
  snapshot: IgdbEnrichmentSnapshot,
  candidate: IgdbEnrichmentCandidate,
  indexed: Awaited<ReturnType<IgdbEnrichmentStore["findVideosByProviderAndExternalIds"]>>,
  creates: PlannedCreate[],
  skips: PlannedSkip[],
): void {
  const existing = new Map<string, IgdbEnrichmentSnapshot["videos"][number]>([
    ...snapshot.videos.map((row) => [`${row.provider}:${row.externalId}`, row] as const),
    ...indexed.map((row) => [`${row.provider}:${row.externalId}`, row] as const),
  ]);
  for (const item of candidate.videos) {
    const key = `${item.provider}:${item.externalId}`;
    const stored = existing.get(key);
    if (stored) {
      const fields = ["title", "thumbnailUrl", "sortOrder"] as const;
      for (const field of fields) {
        if (item[field] === stored[field]) continue;
        skips.push({
          field: `video.${key}.${field}`,
          reason: "existing_metadata_preserved",
          incoming: item[field],
          stored: stored[field],
        });
      }
      continue;
    }
    creates.push({
      entity: "video",
      key,
      values: { gameId: snapshot.game.id, ...item },
    });
  }
}

export async function planIgdbEnrichment(
  store: IgdbEnrichmentStore,
  snapshot: IgdbEnrichmentSnapshot,
  normalization: IgdbNormalizationResult,
): Promise<IgdbEnrichmentPlan> {
  const parsed = igdbNormalizationResultSchema.parse(normalization);
  const { candidate } = parsed;
  const plan = basePlan(snapshot, candidate, [...parsed.warnings]);
  const igdbGameId = candidate.identity.igdbGameId;
  const currentIgdbIds = snapshot.externalIds.filter((row) => row.provider === "igdb");
  const indexedExternalIds = await store.findExternalIdsByProvider("igdb", [igdbGameId]);

  for (const row of currentIgdbIds) {
    if (row.externalId === igdbGameId) continue;
    plan.conflicts.push({
      code: "identity_conflict",
      field: "external_id.igdb",
      message: `Canonical game ${snapshot.game.id} already has IGDB identity ${row.externalId}`,
      incoming: igdbGameId,
      stored: row.externalId,
    });
  }
  for (const row of indexedExternalIds) {
    if (row.gameId === snapshot.game.id) continue;
    plan.conflicts.push({
      code: "identity_conflict",
      field: `external_id.igdb:${igdbGameId}`,
      message: `IGDB identity ${igdbGameId} already belongs to canonical game ${row.gameId}`,
      incoming: snapshot.game.id,
      stored: row.gameId,
    });
  }
  if (plan.conflicts.length > 0) {
    plan.action = "blocked";
    return plan;
  }

  if (
    !currentIgdbIds.some((row) => row.externalId === igdbGameId)
    && !indexedExternalIds.some((row) => row.gameId === snapshot.game.id)
  ) {
    plan.creates.push({
      entity: "external_id",
      key: `igdb:${igdbGameId}`,
      values: {
        gameId: snapshot.game.id,
        provider: "igdb",
        externalId: igdbGameId,
        externalUrl: null,
      },
    });
  }

  planScalars(snapshot, candidate, plan.updates, plan.skips);

  const [indexedGenres, indexedPlatforms, indexedCompanies, indexedImages, indexedVideos, indexedLinks] = await Promise.all([
    store.findGenresBySlugs(candidate.genres.map((item) => item.slug)),
    store.findPlatformsBySlugs(candidate.platforms.map((item) => item.slug)),
    store.findCompaniesBySlugs(candidate.companies.map((item) => item.preferredSlug)),
    store.findImagesBySourceUrls(snapshot.game.id, candidate.images.map((item) => item.sourceUrl)),
    store.findVideosByProviderAndExternalIds(
      snapshot.game.id,
      "igdb",
      candidate.videos.map((item) => item.externalId),
    ),
    store.findOfficialLinksByUrls(snapshot.game.id, candidate.officialLinks.map((item) => item.url)),
  ]);

  planTaxonomies("genre", snapshot, candidate.genres, indexedGenres, plan.creates, plan.skips);
  planTaxonomies("platform", snapshot, candidate.platforms, indexedPlatforms, plan.creates, plan.skips);
  await planCompanies(store, snapshot, candidate, indexedCompanies, plan.creates, plan.warnings, plan.skips);
  planOfficialLinks(snapshot, candidate, indexedLinks, plan.creates, plan.skips);
  planImages(snapshot, candidate, indexedImages, plan.creates, plan.skips);
  planVideos(snapshot, candidate, indexedVideos, plan.creates, plan.skips);

  plan.action = plan.creates.length > 0 || plan.updates.length > 0 ? "enrich" : "existing";
  return plan;
}
