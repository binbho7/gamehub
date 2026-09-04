import {
  igdbEnrichmentCandidateSchema,
  igdbNormalizationResultSchema,
  type IgdbEnrichmentCandidate,
  type IgdbEnrichmentWarning,
  type IgdbNormalizationResult,
} from "../../enrichers/igdb-candidate";
import { toCanonicalSlug } from "../../importers/slug";
import {
  igdbImageSchema,
  igdbInvolvedCompanySchema,
  igdbNamedEntitySchema,
  igdbVideoSchema,
  igdbWebsiteSchema,
  type IgdbGameRaw,
  type IgdbImageRaw,
} from "./schema";

const MAX_ARTWORKS = 20;
const MAX_SCREENSHOTS = 50;
const MAX_VIDEOS = 20;
const safeImageId = /^[A-Za-z0-9_-]{1,255}$/;
const safeYoutubeVideoId = /^[A-Za-z0-9_-]{11}$/;

export type IgdbNormalizationIdentity = {
  canonicalGameId: number;
  steamAppId: string;
  igdbGameId: number;
};

const platformByIgdbId = new Map<number, { slug: "windows" | "macos" | "linux"; name: string }>([
  [6, { slug: "windows", name: "Windows" }],
  [14, { slug: "macos", name: "macOS" }],
  [3, { slug: "linux", name: "Linux" }],
]);

function warning(code: string, message: string, path: string): IgdbEnrichmentWarning {
  return { code, message, path };
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function boundedOptionalText(
  value: string | null | undefined,
  maximum: number,
  path: string,
  warnings: IgdbEnrichmentWarning[],
): string | null {
  if (value == null || value.trim() === "") {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    warnings.push(warning("invalid_optional_value", "Ignored optional text above the canonical limit", path));
    return null;
  }
  return normalized;
}

function releaseDateFromUnixSeconds(
  value: number | null | undefined,
  warnings: IgdbEnrichmentWarning[],
): string | null {
  if (value == null) {
    return null;
  }
  const milliseconds = value * 1000;
  const date = new Date(milliseconds);
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(date.getTime())) {
    warnings.push(warning(
      "invalid_optional_value",
      "Ignored invalid IGDB first release date",
      "first_release_date",
    ));
    return null;
  }
  const normalized = date.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    warnings.push(warning(
      "invalid_optional_value",
      "Ignored IGDB first release date outside the canonical range",
      "first_release_date",
    ));
    return null;
  }
  return normalized;
}

function imageUrl(kind: "cover" | "artwork" | "screenshot", imageId: string): string {
  const size = kind === "cover"
    ? "t_cover_big_2x"
    : kind === "artwork"
      ? "t_1080p"
      : "t_screenshot_big";
  return `https://images.igdb.com/igdb/image/upload/${size}/${imageId}.jpg`;
}

function parseImage(
  value: unknown,
  kind: "cover" | "artwork" | "screenshot",
  path: string,
  warnings: IgdbEnrichmentWarning[],
): (IgdbImageRaw & { sourceUrl: string }) | null {
  const parsed = igdbImageSchema.safeParse(value);
  if (!parsed.success || !safeImageId.test(parsed.data.image_id)) {
    warnings.push(warning("invalid_optional_item", "Ignored invalid IGDB image", path));
    return null;
  }
  return { ...parsed.data, sourceUrl: imageUrl(kind, parsed.data.image_id) };
}

function normalizeImageCollection(
  values: unknown[] | undefined,
  kind: "artwork" | "screenshot",
  maximum: number,
  warnings: IgdbEnrichmentWarning[],
): Array<IgdbImageRaw & { sourceUrl: string }> {
  const normalized: Array<IgdbImageRaw & { sourceUrl: string }> = [];
  const urls = new Set<string>();
  values?.forEach((value, index) => {
    const path = `${kind === "artwork" ? "artworks" : "screenshots"}[${index}]`;
    const image = parseImage(value, kind, path, warnings);
    if (!image) {
      return;
    }
    if (urls.has(image.sourceUrl)) {
      warnings.push(warning("duplicate_optional_value", "Ignored duplicate IGDB image URL", path));
      return;
    }
    urls.add(image.sourceUrl);
    normalized.push(image);
  });
  if (normalized.length > maximum) {
    warnings.push(warning(
      "media_limit_applied",
      `Limited IGDB ${kind === "artwork" ? "artworks" : "screenshots"} to ${maximum} items`,
      kind === "artwork" ? "artworks" : "screenshots",
    ));
  }
  return normalized.slice(0, maximum);
}

export function normalizeIgdbGame(
  raw: IgdbGameRaw,
  identity: IgdbNormalizationIdentity,
  fetchedAt: Date,
): IgdbNormalizationResult {
  const warnings: IgdbEnrichmentWarning[] = [];
  const igdbGameId = String(identity.igdbGameId);

  const genres: IgdbEnrichmentCandidate["genres"] = [];
  const genreKeys = new Set<string>();
  raw.genres?.forEach((value, index) => {
    const parsed = igdbNamedEntitySchema.safeParse(value);
    if (!parsed.success) {
      warnings.push(warning("invalid_optional_item", "Ignored invalid IGDB genre", `genres[${index}]`));
      return;
    }
    const name = normalizedName(parsed.data.name);
    if (name.length > 160) {
      warnings.push(warning("invalid_optional_item", "Ignored IGDB genre above the canonical limit", `genres[${index}]`));
      return;
    }
    const slug = toCanonicalSlug(parsed.data.slug, `igdb-genre-${parsed.data.id}`);
    const key = `${slug}:${name.toLowerCase()}`;
    if (genreKeys.has(key)) {
      warnings.push(warning("duplicate_optional_value", "Ignored duplicate IGDB genre", `genres[${index}]`));
      return;
    }
    genreKeys.add(key);
    genres.push({ slug, name });
  });

  const platforms: IgdbEnrichmentCandidate["platforms"] = [];
  const platformKeys = new Set<string>();
  raw.platforms?.forEach((value, index) => {
    const parsed = igdbNamedEntitySchema.safeParse(value);
    if (!parsed.success) {
      warnings.push(warning("invalid_optional_item", "Ignored invalid IGDB platform", `platforms[${index}]`));
      return;
    }
    const mapped = platformByIgdbId.get(parsed.data.id);
    if (!mapped) {
      warnings.push(warning("unsupported_optional_value", "Ignored unmapped IGDB platform", `platforms[${index}]`));
      return;
    }
    if (platformKeys.has(mapped.slug)) {
      warnings.push(warning("duplicate_optional_value", "Ignored duplicate mapped IGDB platform", `platforms[${index}]`));
      return;
    }
    platformKeys.add(mapped.slug);
    platforms.push(mapped);
  });

  const companies: IgdbEnrichmentCandidate["companies"] = [];
  const companyKeys = new Set<string>();
  raw.involved_companies?.forEach((value, index) => {
    const parsed = igdbInvolvedCompanySchema.safeParse(value);
    if (!parsed.success) {
      warnings.push(warning("invalid_optional_item", "Ignored invalid IGDB involved company", `involved_companies[${index}]`));
      return;
    }
    const name = normalizedName(parsed.data.company.name);
    if (name.length > 160) {
      warnings.push(warning("invalid_optional_item", "Ignored IGDB company above the canonical limit", `involved_companies[${index}]`));
      return;
    }
    const preferredSlug = toCanonicalSlug(parsed.data.company.slug, `igdb-company-${parsed.data.company.id}`);
    (["developer", "publisher"] as const).forEach((role) => {
      if (!parsed.data[role]) {
        return;
      }
      const key = `${role}:${parsed.data.company.id}`;
      if (companyKeys.has(key)) {
        warnings.push(warning("duplicate_optional_value", "Ignored duplicate IGDB company role", `involved_companies[${index}]`));
        return;
      }
      companyKeys.add(key);
      companies.push({ preferredSlug, name, websiteUrl: null, role });
    });
  });

  const officialLinks: IgdbEnrichmentCandidate["officialLinks"] = [];
  const websiteUrls = new Set<string>();
  raw.websites?.forEach((value, index) => {
    const path = `websites[${index}]`;
    const parsed = igdbWebsiteSchema.safeParse(value);
    if (!parsed.success) {
      warnings.push(warning("invalid_optional_item", "Ignored invalid IGDB website", path));
      return;
    }
    if (parsed.data.type !== 1 || parsed.data.trusted !== true) {
      warnings.push(warning("ineligible_optional_value", "Ignored ineligible IGDB website", path));
      return;
    }
    const url = parsed.data.url.trim();
    try {
      const parsedUrl = new URL(url);
      if (url.length > 2048 || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")) {
        throw new Error("unsafe URL");
      }
    } catch {
      warnings.push(warning("invalid_optional_url", "Ignored invalid IGDB website URL", path));
      return;
    }
    if (websiteUrls.has(url)) {
      warnings.push(warning("duplicate_optional_value", "Ignored duplicate IGDB website URL", path));
      return;
    }
    websiteUrls.add(url);
    officialLinks.push({
      provider: "igdb",
      platform: null,
      linkType: "official_website",
      url,
      isOfficial: true,
      verificationStatus: "unverified",
      verificationMethod: null,
    });
  });

  const cover = raw.cover == null ? null : parseImage(raw.cover, "cover", "cover", warnings);
  const artworks = normalizeImageCollection(raw.artworks, "artwork", MAX_ARTWORKS, warnings);
  const screenshots = normalizeImageCollection(raw.screenshots, "screenshot", MAX_SCREENSHOTS, warnings);
  const images: IgdbEnrichmentCandidate["images"] = [
    ...(cover ? [{
      type: "cover" as const,
      sourceUrl: cover.sourceUrl,
      width: cover.width,
      height: cover.height,
    }] : []),
    ...artworks.map((image) => ({
      type: "artwork" as const,
      sourceUrl: image.sourceUrl,
      width: image.width,
      height: image.height,
    })),
    ...screenshots.map((image) => ({
      type: "screenshot" as const,
      sourceUrl: image.sourceUrl,
      width: image.width,
      height: image.height,
    })),
  ].map((image, sortOrder) => ({ ...image, sortOrder }));

  const videos: IgdbEnrichmentCandidate["videos"] = [];
  const videoIds = new Set<string>();
  raw.videos?.forEach((value, index) => {
    const path = `videos[${index}]`;
    const parsed = igdbVideoSchema.safeParse(value);
    if (!parsed.success || !safeYoutubeVideoId.test(parsed.data.video_id)) {
      warnings.push(warning("invalid_optional_item", "Ignored invalid IGDB video", path));
      return;
    }
    if (videoIds.has(parsed.data.video_id)) {
      warnings.push(warning("duplicate_optional_value", "Ignored duplicate IGDB video ID", path));
      return;
    }
    videoIds.add(parsed.data.video_id);
    const title = boundedOptionalText(parsed.data.name, 500, `${path}.name`, warnings);
    videos.push({
      provider: "igdb",
      externalId: parsed.data.video_id,
      title,
      thumbnailUrl: null,
      sortOrder: videos.length,
    });
  });
  if (videos.length > MAX_VIDEOS) {
    warnings.push(warning("media_limit_applied", `Limited IGDB videos to ${MAX_VIDEOS} items`, "videos"));
    videos.length = MAX_VIDEOS;
  }

  const candidate = igdbEnrichmentCandidateSchema.parse({
    source: { provider: "igdb", externalId: String(raw.id), fetchedAt },
    identity: {
      canonicalGameId: identity.canonicalGameId,
      steamAppId: identity.steamAppId,
      igdbGameId,
    },
    game: {
      title: boundedOptionalText(raw.name, 300, "name", warnings),
      summary: boundedOptionalText(raw.summary, 1000, "summary", warnings),
      description: boundedOptionalText(raw.storyline, 100_000, "storyline", warnings),
      releaseDate: releaseDateFromUnixSeconds(raw.first_release_date, warnings),
      coverUrl: cover?.sourceUrl ?? null,
      heroUrl: artworks[0]?.sourceUrl ?? null,
    },
    externalIds: [{ provider: "igdb", externalId: igdbGameId, externalUrl: null }],
    genres,
    platforms,
    companies,
    officialLinks,
    images,
    videos,
  });

  return igdbNormalizationResultSchema.parse({ candidate, warnings });
}
