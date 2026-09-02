import {
  normalizationResultSchema,
  type CanonicalGameCandidate,
  type ImportWarning,
  type NormalizationResult,
} from "../../importers/candidate";
import { toCanonicalSlug } from "../../importers/slug";
import type { SteamAppDetails } from "./schema";

const MAX_SCREENSHOTS = 50;
const MAX_MOVIES = 20;

const platformMappings = [
  ["windows", "windows", "Windows"],
  ["mac", "macos", "macOS"],
  ["linux", "linux", "Linux"],
] as const;

const monthNumbers: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function warning(code: string, message: string, path: string): ImportWarning {
  return { code, message, path };
}

function optionalHttpUrl(value: string | undefined | null, path: string, warnings: ImportWarning[]): string | null {
  if (value == null) {
    return null;
  }

  const url = value.trim();
  try {
    const parsed = new URL(url);
    if (url.length > 2048 || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new Error("non-HTTP(S) URL");
    }
    return url;
  } catch {
    warnings.push(warning("invalid_optional_url", "Ignored invalid optional HTTP(S) URL", path));
    return null;
  }
}

function parseReleaseDate(value: string | undefined, warnings: ImportWarning[]): string | null {
  const dateText = value?.trim();
  const ignoredDate = () => {
    if (dateText) {
      warnings.push(warning(
        "invalid_optional_value",
        "Ignored unsupported or invalid Steam release date",
        "release_date.date",
      ));
    }
    return null;
  };
  const match = dateText?.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  if (!match) {
    return ignoredDate();
  }

  const month = monthNumbers[match[1]!.toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month || !Number.isInteger(day) || !Number.isInteger(year)) {
    return ignoredDate();
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return ignoredDate();
  }

  const normalized = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const canonicalDate = new Date(Date.UTC(year, month - 1, day));
  if (
    canonicalDate.getUTCFullYear() !== year
    || canonicalDate.getUTCMonth() !== month - 1
    || canonicalDate.getUTCDate() !== day
  ) {
    return ignoredDate();
  }

  return normalized;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeSteamGame(
  details: SteamAppDetails,
  appId: string,
  fetchedAt: Date,
): NormalizationResult {
  const warnings: ImportWarning[] = [];
  const storeUrl = `https://store.steampowered.com/app/${appId}/`;
  const capsuleUrl = optionalHttpUrl(details.capsule_image, "capsule_image", warnings);
  const headerUrl = optionalHttpUrl(details.header_image, "header_image", warnings);
  const websiteUrl = optionalHttpUrl(details.website, "website", warnings);

  if (details.detailed_description != null) {
    warnings.push(warning(
      "ignored_optional_value",
      "Detailed Steam description is not stored because it may contain provider HTML",
      "detailed_description",
    ));
  }

  const officialLinks: CanonicalGameCandidate["officialLinks"] = [{
    provider: "steam" as const,
    platform: null,
    linkType: "store" as const,
    url: storeUrl,
    isOfficial: true,
    verificationStatus: "verified" as const,
    verificationMethod: "provider_api" as const,
  }];
  if (websiteUrl) {
    if (websiteUrl === storeUrl) {
      warnings.push(warning("duplicate_optional_value", "Ignored duplicate official link URL", "website"));
    } else {
      officialLinks.push({
        provider: "steam",
        platform: null,
        linkType: "official_website",
        url: websiteUrl,
        isOfficial: true,
        verificationStatus: "unverified",
        verificationMethod: null,
      });
    }
  }

  const genres: Array<{ slug: string; name: string }> = [];
  const genreKeys = new Set<string>();
  details.genres?.forEach((genre, index) => {
    const name = genre.description.trim();
    if (!name) {
      warnings.push(warning("ignored_optional_value", "Ignored genre without a name", `genres[${index}].description`));
      return;
    }
    const slug = toCanonicalSlug(name, `steam-${appId}-genre`);
    const key = `${slug}:${normalizedName(name)}`;
    if (genreKeys.has(key)) {
      warnings.push(warning("duplicate_optional_value", "Ignored duplicate genre", `genres[${index}]`));
      return;
    }
    genreKeys.add(key);
    genres.push({ slug, name });
  });

  const companies: Array<{ preferredSlug: string; name: string; role: "developer" | "publisher" }> = [];
  const companyKeys = new Set<string>();
  const addCompanies = (names: string[] | undefined, role: "developer" | "publisher", field: "developers" | "publishers") => {
    names?.forEach((company, index) => {
      const name = company.trim();
      if (!name) {
        warnings.push(warning("ignored_optional_value", "Ignored company without a name", `${field}[${index}]`));
        return;
      }
      const key = `${role}:${normalizedName(name)}`;
      if (companyKeys.has(key)) {
        warnings.push(warning("duplicate_optional_value", "Ignored duplicate company", `${field}[${index}]`));
        return;
      }
      companyKeys.add(key);
      companies.push({
        preferredSlug: toCanonicalSlug(name, `steam-${appId}-company`),
        name,
        role,
      });
    });
  };
  addCompanies(details.developers, "developer", "developers");
  addCompanies(details.publishers, "publisher", "publishers");

  const images: Array<{
    type: "cover" | "hero" | "screenshot";
    sourceUrl: string;
    width: null;
    height: null;
    sortOrder: number;
  }> = [];
  const videos: Array<{
    provider: "steam";
    externalId: string;
    title: string | null;
    thumbnailUrl: string | null;
    sortOrder: number;
  }> = [];

  const imageUrls = new Set<string>();
  const addImage = (type: "cover" | "hero" | "screenshot", url: string | null, path: string) => {
    if (!url) {
      return;
    }
    if (imageUrls.has(url)) {
      warnings.push(warning("duplicate_optional_value", "Ignored duplicate image URL", path));
      return;
    }
    imageUrls.add(url);
    images.push({ type, sourceUrl: url, width: null, height: null, sortOrder: images.length });
  };
  addImage("cover", capsuleUrl, "capsule_image");
  addImage("hero", headerUrl, "header_image");

  let screenshotCount = 0;
  details.screenshots?.forEach((screenshot, index) => {
    const path = `screenshots[${index}].path_full`;
    const thumbnailPath = `screenshots[${index}].path_thumbnail`;
    if (optionalHttpUrl(screenshot.path_thumbnail, thumbnailPath, warnings)) {
      warnings.push(warning(
        "ignored_optional_value",
        "Screenshot thumbnail is not stored when the full-size source is available",
        thumbnailPath,
      ));
    }
    const url = optionalHttpUrl(screenshot.path_full, path, warnings);
    if (!url) {
      return;
    }
    if (imageUrls.has(url)) {
      warnings.push(warning("duplicate_optional_value", "Ignored duplicate image URL", path));
      return;
    }
    if (screenshotCount >= MAX_SCREENSHOTS) {
      warnings.push(warning("media_cap_exceeded", "Ignored screenshot above the 50-item limit", `screenshots[${index}]`));
      return;
    }
    addImage("screenshot", url, path);
    screenshotCount += 1;
  });

  const videoIds = new Set<string>();
  details.movies?.forEach((movie, index) => {
    (['webm', 'mp4'] as const).forEach((format) => {
      const sources = movie[format];
      if (!sources) {
        return;
      }
      let hasSource = false;
      ([
        ["480", sources["480"]],
        ["max", sources.max],
      ] as const).forEach(([quality, sourceUrl]) => {
        if (sourceUrl == null) {
          return;
        }
        hasSource = true;
        optionalHttpUrl(sourceUrl, `movies[${index}].${format}.${quality}`, warnings);
      });
      if (hasSource) {
        warnings.push(warning(
          "ignored_optional_value",
          "Movie stream URLs are not stored; only Steam video metadata is retained",
          `movies[${index}].${format}`,
        ));
      }
    });
    const externalId = String(movie.id);
    const key = `steam:${externalId}`;
    const thumbnailUrl = optionalHttpUrl(movie.thumbnail, `movies[${index}].thumbnail`, warnings);
    if (videoIds.has(key)) {
      warnings.push(warning("duplicate_optional_value", "Ignored duplicate Steam movie", `movies[${index}].id`));
      return;
    }
    if (videos.length >= MAX_MOVIES) {
      warnings.push(warning("media_cap_exceeded", "Ignored movie above the 20-item limit", `movies[${index}]`));
      return;
    }
    videoIds.add(key);
    videos.push({
      provider: "steam",
      externalId,
      title: movie.name?.trim() || null,
      thumbnailUrl,
      sortOrder: videos.length,
    });
  });

  const candidate = {
    source: { provider: "steam" as const, externalId: appId, fetchedAt },
    game: {
      preferredSlug: toCanonicalSlug(details.name, `steam-${appId}`),
      title: details.name.trim(),
      summary: details.short_description?.trim() || null,
      description: null,
      status: details.release_date?.coming_soon === true ? "upcoming" as const : "released" as const,
      releaseDate: parseReleaseDate(details.release_date?.date, warnings),
      coverUrl: capsuleUrl,
      heroUrl: headerUrl,
    },
    externalIds: [{ provider: "steam" as const, externalId: appId, externalUrl: storeUrl }],
    officialLinks,
    genres,
    platforms: platformMappings.flatMap(([steamField, slug, name]) => (
      details.platforms?.[steamField] ? [{ slug, name }] : []
    )),
    companies,
    images,
    videos,
  };

  return normalizationResultSchema.parse({ candidate, warnings });
}
