import type {
  CanonicalGameCandidate,
  ImportWarning,
  NormalizationResult,
  PlannedSkip,
  PlannedUpdate,
  SteamImportPlan,
} from "./candidate";
import { normalizationResultSchema } from "./candidate";
import type {
  IndexedCompany,
  IndexedTaxonomy,
  SteamImportSnapshot,
  SteamImportStore,
} from "../db/repositories/steam-import";
import { SteamImportError } from "./errors";
import { companyCollisionSlug } from "./slug";

const MAX_SLUG_LENGTH = 160;
const MAX_GAME_SLUG_CANDIDATES = 100;
const COMPANY_HASH_LENGTHS = Array.from({ length: 15 }, (_, index) => 8 + index * 4);

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function suffixedSlug(base: string, suffix: string): string {
  const room = MAX_SLUG_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/g, "")}-${suffix}`;
}

function assertTaxonomyAgreement(
  kind: "genre" | "platform",
  incoming: Array<{ slug: string; name: string }>,
  stored: IndexedTaxonomy[],
): void {
  const incomingNames = new Map<string, string>();
  for (const item of incoming) {
    const name = normalizedName(item.name);
    const previous = incomingNames.get(item.slug);
    if (previous && previous !== name) {
      throw new SteamImportError(
        "taxonomy_conflict",
        `Incoming ${kind} slug ${item.slug} has contradictory names`,
      );
    }
    incomingNames.set(item.slug, name);
  }

  const incomingBySlug = new Map(incoming.map((item) => [item.slug, item]));
  for (const occupant of stored) {
    const item = incomingBySlug.get(occupant.slug);
    if (item && normalizedName(item.name) !== normalizedName(occupant.name)) {
      throw new SteamImportError(
        "taxonomy_conflict",
        `Incoming ${kind} ${item.name} contradicts indexed slug ${occupant.slug} (${occupant.name})`,
      );
    }
  }
}

async function resolveCompanies(
  store: SteamImportStore,
  incoming: CanonicalGameCandidate["companies"],
): Promise<{
  resolved: SteamImportPlan["resolvedCompanies"];
  existingSlugs: Set<string>;
}> {
  const baseSlugs = unique(incoming.map((company) => company.preferredSlug));
  const baseRows = await store.findCompaniesBySlugs(baseSlugs);
  const baseBySlug = new Map(baseRows.map((company) => [company.slug, company]));
  const reservedNames = new Map<string, string>();
  const provisional: Array<{
    slug: string | null;
    collisionSlugs: string[];
    normalizedName: string;
    name: string;
    role: "developer" | "publisher";
  }> = [];

  for (const company of incoming) {
    const name = normalizedName(company.name);
    const occupant = baseBySlug.get(company.preferredSlug);
    const reservedName = reservedNames.get(company.preferredSlug);
    if ((occupant && normalizedName(occupant.name) === name) || (!occupant && (!reservedName || reservedName === name))) {
      reservedNames.set(company.preferredSlug, name);
      provisional.push({
        slug: company.preferredSlug,
        collisionSlugs: [],
        normalizedName: name,
        name: company.name,
        role: company.role,
      });
      continue;
    }

    provisional.push({
      slug: null,
      collisionSlugs: await Promise.all(COMPANY_HASH_LENGTHS.map((hashLength) => (
        companyCollisionSlug(company.preferredSlug, name, hashLength)
      ))),
      normalizedName: name,
      name: company.name,
      role: company.role,
    });
  }

  const collisionSlugs = unique(provisional.flatMap((company) => company.collisionSlugs));
  const collisionRows = collisionSlugs.length > 0
    ? await store.findCompaniesBySlugs(collisionSlugs)
    : [];
  const collisionBySlug = new Map(collisionRows.map((company) => [company.slug, company]));
  const selectedNames = new Map(reservedNames);
  const resolved: SteamImportPlan["resolvedCompanies"] = [];

  for (const company of provisional) {
    let slug = company.slug;
    if (slug === null) {
      slug = company.collisionSlugs.find((candidateSlug) => {
        const occupant = collisionBySlug.get(candidateSlug);
        const reservedName = selectedNames.get(candidateSlug);
        return (!occupant || normalizedName(occupant.name) === company.normalizedName)
          && (!reservedName || reservedName === company.normalizedName);
      }) ?? null;
    }
    if (slug === null) {
      throw new SteamImportError(
        "company_conflict",
        `No deterministic company collision slug remained for ${company.name}`,
      );
    }
    selectedNames.set(slug, company.normalizedName);
    resolved.push({ slug, name: company.name, role: company.role });
  }

  return {
    resolved,
    existingSlugs: new Set([...baseRows, ...collisionRows].map((company: IndexedCompany) => company.slug)),
  };
}

async function selectCreateSlug(
  store: SteamImportStore,
  candidate: CanonicalGameCandidate,
  warnings: ImportWarning[],
): Promise<string> {
  const preferred = candidate.game.preferredSlug;
  for (let attempt = 0; attempt < MAX_GAME_SLUG_CANDIDATES; attempt += 1) {
    const suffix = attempt === 0
      ? null
      : attempt === 1
        ? `steam-${candidate.source.externalId}`
        : `steam-${candidate.source.externalId}-${attempt}`;
    const candidateSlug = suffix === null ? preferred : suffixedSlug(preferred, suffix);
    const occupant = await store.findGameBySlug(candidateSlug);
    if (!occupant) {
      return candidateSlug;
    }
    if (attempt === 0) {
      warnings.push({
        code: "possible_duplicate",
        message: `Preferred slug ${occupant.slug} is occupied by game ${occupant.id}; creating a separate Steam import`,
        path: "game.preferredSlug",
      });
    }
  }

  throw new SteamImportError(
    "write_conflict",
    `No available game slug remained after ${MAX_GAME_SLUG_CANDIDATES} deterministic candidates`,
  );
}

function addCreate(creates: SteamImportPlan["creates"], entity: string, key: string): void {
  if (!creates.some((item) => item.entity === entity && item.key === key)) {
    creates.push({ entity, key });
  }
}

function changedValues<T extends Record<string, unknown>>(
  incoming: T,
  stored: Record<string, unknown>,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(incoming).filter(([key, value]) => stored[key] !== value),
  ) as Partial<T>;
}

function planExistingRelations(
  snapshot: SteamImportSnapshot,
  candidate: CanonicalGameCandidate,
  resolvedCompanies: SteamImportPlan["resolvedCompanies"],
  updates: PlannedUpdate[],
  skips: PlannedSkip[],
): void {
  const gameFields = {
    title: candidate.game.title,
    summary: candidate.game.summary,
    description: candidate.game.description,
    status: candidate.game.status,
    releaseDate: candidate.game.releaseDate,
    coverUrl: candidate.game.coverUrl,
    heroUrl: candidate.game.heroUrl,
  };
  for (const [field, incoming] of Object.entries(gameFields)) {
    const stored = snapshot.game[field as keyof typeof gameFields];
    if (incoming !== stored) {
      skips.push({ field: `game.${field}`, reason: "existing game metadata is preserved", incoming, stored });
    }
  }

  const externalIds = new Map(snapshot.externalIds.map((item) => [`${item.provider}:${item.externalId}`, item]));
  for (const item of candidate.externalIds) {
    const key = `${item.provider}:${item.externalId}`;
    const stored = externalIds.get(key);
    if (!stored) {
      skips.push({
        field: `external_id.${key}`,
        reason: "existing game does not gain new external IDs",
        incoming: item,
        stored: null,
      });
    } else if (stored.externalUrl !== item.externalUrl) {
      updates.push({ entity: "external_id", key, changes: { externalUrl: item.externalUrl } });
    }
  }

  const links = new Map(snapshot.officialLinks.map((item) => [item.url, item]));
  const canonicalStoreUrl = `https://store.steampowered.com/app/${candidate.source.externalId}/`;
  for (const item of candidate.officialLinks) {
    const stored = links.get(item.url);
    if (!stored) {
      skips.push({
        field: `official_link.${item.url}`,
        reason: "existing game does not gain new official links",
        incoming: item,
        stored: null,
      });
      continue;
    }
    const identityChanges = changedValues({
      provider: item.provider,
      platform: item.platform,
      linkType: item.linkType,
    }, stored);
    for (const [field, incoming] of Object.entries(identityChanges)) {
      skips.push({
        field: `official_link.${item.url}.${field}`,
        reason: "existing official-link identity metadata is preserved",
        incoming,
        stored: stored[field as keyof typeof stored],
      });
    }

    const verificationChanges = changedValues({
      isOfficial: item.isOfficial,
      verificationStatus: item.verificationStatus,
      verificationMethod: item.verificationMethod,
    }, stored);
    if (stored.verificationMethod === "manual") {
      for (const [field, incoming] of Object.entries(verificationChanges)) {
        skips.push({
          field: `official_link.${item.url}.${field}`,
          reason: "manual verification metadata has precedence over provider refresh",
          incoming,
          stored: stored[field as keyof typeof stored],
        });
      }
    } else if (
      item.provider === "steam"
      && item.linkType === "store"
      && item.url === canonicalStoreUrl
      && stored.provider === "steam"
      && stored.platform === null
      && stored.linkType === "store"
    ) {
      if (Object.keys(verificationChanges).length > 0) {
        updates.push({ entity: "official_link", key: item.url, changes: verificationChanges });
      }
    } else {
      for (const [field, incoming] of Object.entries(verificationChanges)) {
        skips.push({
          field: `official_link.${item.url}.${field}`,
          reason: "only canonical Steam Store verification metadata may be updated",
          incoming,
          stored: stored[field as keyof typeof stored],
        });
      }
    }
  }

  const genreSlugs = new Set(snapshot.genres.map((item) => item.slug));
  for (const genre of candidate.genres) {
    if (!genreSlugs.has(genre.slug)) {
      skips.push({
        field: `game.genre.${genre.slug}`,
        reason: "existing game taxonomy relations are preserved",
        incoming: genre,
        stored: null,
      });
    }
  }
  const platformSlugs = new Set(snapshot.platforms.map((item) => item.slug));
  for (const platform of candidate.platforms) {
    if (!platformSlugs.has(platform.slug)) {
      skips.push({
        field: `game.platform.${platform.slug}`,
        reason: "existing game taxonomy relations are preserved",
        incoming: platform,
        stored: null,
      });
    }
  }
  const companyKeys = new Set(snapshot.companies.map((item) => `${item.slug}:${item.role}`));
  for (const company of resolvedCompanies) {
    const key = `${company.slug}:${company.role}`;
    if (!companyKeys.has(key)) {
      skips.push({
        field: `game.company.${key}`,
        reason: "existing game company relations are preserved",
        incoming: company,
        stored: null,
      });
    }
  }

  const images = new Map(snapshot.images.map((item) => [item.sourceUrl, item]));
  for (const item of candidate.images) {
    const stored = images.get(item.sourceUrl);
    if (!stored) {
      skips.push({
        field: `image.${item.sourceUrl}`,
        reason: "existing game does not gain new images",
        incoming: item,
        stored: null,
      });
    } else {
      const changes = changedValues({
        type: item.type,
        width: item.width,
        height: item.height,
        sortOrder: item.sortOrder,
      }, stored);
      for (const [field, incoming] of Object.entries(changes)) {
        skips.push({
          field: `image.${item.sourceUrl}.${field}`,
          reason: "existing image metadata is preserved",
          incoming,
          stored: stored[field as keyof typeof stored],
        });
      }
    }
  }

  const videos = new Map(snapshot.videos.map((item) => [`${item.provider}:${item.externalId}`, item]));
  for (const item of candidate.videos) {
    const key = `${item.provider}:${item.externalId}`;
    const stored = videos.get(key);
    if (!stored) {
      skips.push({
        field: `video.${key}`,
        reason: "existing game does not gain new videos",
        incoming: item,
        stored: null,
      });
      continue;
    }
    const changes = changedValues({
      title: item.title,
      thumbnailUrl: item.thumbnailUrl,
    }, stored);
    if (Object.keys(changes).length > 0) {
      updates.push({ entity: "video", key, changes });
    }
    if (item.sortOrder !== stored.sortOrder) {
      skips.push({
        field: `video.${key}.sortOrder`,
        reason: "existing video order is preserved",
        incoming: item.sortOrder,
        stored: stored.sortOrder,
      });
    }
  }
}

export async function planSteamImport(
  store: SteamImportStore,
  normalized: NormalizationResult,
): Promise<SteamImportPlan> {
  const parsed = normalizationResultSchema.parse(normalized);
  const { candidate } = parsed;
  const warnings = [...parsed.warnings];
  const snapshot = await store.findSnapshotByExternalId(candidate.source.provider, candidate.source.externalId);
  const selectedSlug = snapshot
    ? snapshot.game.slug
    : await selectCreateSlug(store, candidate, warnings);

  const [storedGenres, storedPlatforms] = await Promise.all([
    store.findGenresBySlugs(unique(candidate.genres.map((genre) => genre.slug))),
    store.findPlatformsBySlugs(unique(candidate.platforms.map((platform) => platform.slug))),
  ]);
  assertTaxonomyAgreement("genre", candidate.genres, storedGenres);
  assertTaxonomyAgreement("platform", candidate.platforms, storedPlatforms);
  const companies = await resolveCompanies(store, candidate.companies);

  const creates: SteamImportPlan["creates"] = [];
  const updates: PlannedUpdate[] = [];
  const skips: PlannedSkip[] = [];
  if (!snapshot) {
    addCreate(creates, "game", selectedSlug);
    for (const externalId of candidate.externalIds) addCreate(creates, "external_id", `${externalId.provider}:${externalId.externalId}`);
    for (const link of candidate.officialLinks) addCreate(creates, "official_link", link.url);
    const genreSlugs = new Set(storedGenres.map((genre) => genre.slug));
    for (const genre of candidate.genres) {
      if (!genreSlugs.has(genre.slug)) addCreate(creates, "genre", genre.slug);
      addCreate(creates, "game_genre", genre.slug);
    }
    const platformSlugs = new Set(storedPlatforms.map((platform) => platform.slug));
    for (const platform of candidate.platforms) {
      if (!platformSlugs.has(platform.slug)) addCreate(creates, "platform", platform.slug);
      addCreate(creates, "game_platform", platform.slug);
    }
    for (const company of companies.resolved) {
      if (!companies.existingSlugs.has(company.slug)) addCreate(creates, "company", company.slug);
      addCreate(creates, "game_company", `${company.slug}:${company.role}`);
    }
    for (const image of candidate.images) addCreate(creates, "image", image.sourceUrl);
    for (const video of candidate.videos) addCreate(creates, "video", `${video.provider}:${video.externalId}`);
  } else {
    planExistingRelations(snapshot, candidate, companies.resolved, updates, skips);
  }
  const action = !snapshot ? "create" : updates.length > 0 ? "update" : "existing";

  return {
    action,
    selectedSlug,
    existingGameId: snapshot?.game.id ?? null,
    candidate,
    resolvedCompanies: companies.resolved,
    creates,
    updates,
    skips,
    warnings,
  };
}
