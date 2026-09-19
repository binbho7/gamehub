import type { PublishedGame, PublishedOfficialLink, PublishedVideo } from "./contracts";
import { parseSnapshotDate, validateImageUrl, validateOfficialLinkUrl, validateYoutubeId } from "./validation";
import type { SiteSnapshotGame } from "./read-model";

export type EligibilityDiagnostic = { slug: string; code: string; message: string };
export type EligibilityResult = { published: PublishedGame | null; diagnostics: EligibilityDiagnostic[] };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VALID_METHODS = new Set(["manual", "http", "provider_api"]);
const VALID_IMAGE_PROVIDERS = new Set(["steam", "igdb"]);

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function evaluateGameInternal(snapshotGame: SiteSnapshotGame, snapshotDate: string, duplicateSlug: boolean): EligibilityResult {
  const slug = snapshotGame.game.slug;
  const diagnostics: EligibilityDiagnostic[] = [];
  const add = (code: string, message: string) => diagnostics.push({ slug, code, message });

  try {
    parseSnapshotDate(snapshotDate);
  } catch {
    add("invalid_snapshot_date", "snapshot date is invalid");
  }

  if (!SLUG_PATTERN.test(slug) || slug.length > 160) add("invalid_slug", "canonical slug is invalid");
  if (duplicateSlug) add("duplicate_slug", "canonical slug is duplicated in the snapshot");
  if (!nonEmpty(snapshotGame.game.title)) add("missing_title", "title is missing");
  if (!nonEmpty(snapshotGame.game.description)) add("missing_description", "description is missing");

  const steamIds = snapshotGame.externalIds.filter((row) => row.provider === "steam" && /^[1-9]\d*$/.test(row.externalId));
  if (steamIds.length !== 1) add("invalid_steam_identity", "exactly one valid Steam identity is required");

  const identityKeys = snapshotGame.externalIds.map((row) => `${row.provider}\u0000${row.externalId}`);
  if (new Set(identityKeys).size !== identityKeys.length) add("duplicate_public_identity", "public external identity is duplicated");

  const developer = snapshotGame.companies.find((company) => company.role === "developer" && nonEmpty(company.name));
  const publisher = snapshotGame.companies.find((company) => company.role === "publisher" && nonEmpty(company.name));
  if (!developer) add("missing_developer", "developer relation is missing");
  if (!publisher) add("missing_publisher", "publisher relation is missing");
  if (snapshotGame.genres.length === 0) add("missing_genres", "at least one genre is required");
  if (snapshotGame.platforms.length === 0) add("missing_platforms", "at least one platform is required");

  let validSnapshotDate = false;
  try {
    parseSnapshotDate(snapshotDate);
    validSnapshotDate = true;
  } catch { /* diagnostic already recorded */ }
  const releaseDate = snapshotGame.game.releaseDate;
  if (typeof releaseDate !== "string" || releaseDate.trim().length === 0) {
    add("missing_release_date", "release date is missing");
  } else {
    try {
      parseSnapshotDate(releaseDate);
      if (validSnapshotDate) {
        if (snapshotGame.game.status === "released" && releaseDate > snapshotDate) add("released_after_snapshot", "released game is after snapshot date");
        if (snapshotGame.game.status === "upcoming" && releaseDate <= snapshotDate) add("upcoming_not_after_snapshot", "upcoming game is not after snapshot date");
      }
    } catch {
      add("invalid_release_date", "release date is invalid");
    }
  }
  if (snapshotGame.game.status !== "released" && snapshotGame.game.status !== "upcoming") add("invalid_status", "status is not publishable");

  for (const [type, url] of [["cover", snapshotGame.game.coverUrl], ["hero", snapshotGame.game.heroUrl]] as const) {
    try { validateImageUrl(url ?? ""); }
    catch { add(`invalid_${type}`, `${type} image URL is invalid`); }
  }

  const publishableLinks = snapshotGame.officialLinks.filter((link) => {
    if (link.linkType !== "official_website" && link.linkType !== "store") return false;
    if (!link.isOfficial || link.verificationStatus !== "verified" || !link.verificationMethod || !VALID_METHODS.has(link.verificationMethod)) return false;
    try { validateOfficialLinkUrl(link.url); return true; } catch { return false; }
  });
  if (publishableLinks.length === 0) add("missing_verified_official_link", "a verified official link is required");

  const videos: PublishedVideo[] = [];
  for (const video of snapshotGame.videos) {
    if (video.provider !== "youtube") continue;
    try { validateYoutubeId(video.externalId); }
    catch { continue; }
    videos.push({ provider: "youtube", id: video.externalId, title: video.title });
  }

  const sortedDiagnostics = diagnostics.sort((a, b) => a.code.localeCompare(b.code));
  if (sortedDiagnostics.length > 0) return { published: null, diagnostics: sortedDiagnostics };

  const officialLinks: PublishedOfficialLink[] = publishableLinks.map((link) => ({ provider: link.provider, type: link.linkType, url: link.url }));
  const screenshots = snapshotGame.images
    .filter((image) => image.type === "screenshot" && (!image.sourceProvider || VALID_IMAGE_PROVIDERS.has(image.sourceProvider)))
    .flatMap((image) => {
      try { validateImageUrl(image.sourceUrl); return [image.sourceUrl]; }
      catch { return []; }
    })
    .sort((left, right) => left.localeCompare(right));
  return {
    diagnostics: [],
    published: {
      slug,
      title: snapshotGame.game.title,
      description: snapshotGame.game.description!,
      releaseDate: releaseDate!,
      status: snapshotGame.game.status as "released" | "upcoming",
      developer: developer!.name,
      publisher: publisher!.name,
      genres: snapshotGame.genres.map((genre) => genre.name),
      platforms: snapshotGame.platforms.map((platform) => platform.name),
      cover: snapshotGame.game.coverUrl!,
      hero: snapshotGame.game.heroUrl!,
      screenshots,
      officialLinks,
      videos,
      optional: { titleCn: null, rating: null, systemRequirements: null, modes: null, controllerSupport: null, isFree: null },
    },
  };
}

export function evaluateGame(snapshotGame: SiteSnapshotGame, snapshotDate: string): EligibilityResult {
  return evaluateGameInternal(snapshotGame, snapshotDate, false);
}

export function evaluateGames(snapshotGames: SiteSnapshotGame[], snapshotDate: string): EligibilityResult[] {
  const counts = new Map<string, number>();
  for (const snapshotGame of snapshotGames) counts.set(snapshotGame.game.slug, (counts.get(snapshotGame.game.slug) ?? 0) + 1);
  return snapshotGames.map((snapshotGame) => evaluateGameInternal(
    snapshotGame,
    snapshotDate,
    (counts.get(snapshotGame.game.slug) ?? 0) > 1,
  ));
}
