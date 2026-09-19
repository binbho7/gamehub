import { z } from "zod";
import {
  MAX_ARTIFACT_BYTES,
  MAX_PUBLISHED_GAMES,
  PublishedArtifactSchema,
  SITE_DATA_VERSION,
  type PublishedArtifact,
} from "./contracts";
import { classifyIpAddress, normalizeIpAddress } from "../verifiers/official-links/ip-safety";
import { isSafeHostname } from "../verifiers/official-links/url-safety";
import { isCanonicalSlug } from "./slug";

const MAX_PUBLIC_URL_LENGTH = 2_048;
const IMAGE_HOSTS = new Set(["cdn.akamai.steamstatic.com", "shared.akamai.steamstatic.com", "images.igdb.com"]);
const FORBIDDEN_KEYS = new Set([
  "gameId", "canonicalId", "externalId", "steamAppId", "igdbId",
  "createdAt", "updatedAt", "deletedAt", "timestamp", "exportedAt", "generatedAt",
  "scheduler", "schedulerState", "lease", "leaseId", "fence", "fenceEpoch",
  "storageKey", "storageHash", "r2Key", "r2ObjectKey", "r2Metadata", "diagnostics",
  "rawPayload", "providerPayload", "secret", "token", "password", "localPath",
  "cloudflareId", "accountId",
]);

function fail(message: string): never {
  throw new Error(`Invalid published site data: ${message}`);
}

export function parseSnapshotDate(value: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail("snapshotDate must be YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail("snapshotDate is not a real UTC calendar date");
  return value;
}

function validateUrlWithHosts(url: string, hosts?: Set<string>): string {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_PUBLIC_URL_LENGTH) fail("URL is missing or too long");
  let parsed: URL;
  try { parsed = new URL(url); } catch { fail("URL is malformed"); }
  if (parsed.protocol !== "https:") fail("URL must use HTTPS");
  if (parsed.username || parsed.password) fail("URL credentials are forbidden");
  if (parsed.hash) fail("URL fragments are forbidden");
  if (parsed.port) fail("URL ports are forbidden");
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!isSafeHostname(hostname)) fail("unsafe URL host is forbidden");
  const literalIp = normalizeIpAddress(hostname);
  if (literalIp && !classifyIpAddress(hostname).safe) fail("private URL host is forbidden");
  if (hosts && !hosts.has(hostname)) fail("URL host is not approved");
  return url;
}

export function validateImageUrl(url: string): string {
  return validateUrlWithHosts(url, IMAGE_HOSTS);
}

export function validateOfficialLinkUrl(url: string): string {
  return validateUrlWithHosts(url);
}

export function validatePublicUrl(url: string): string {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_PUBLIC_URL_LENGTH) fail("URL is missing or too long");
  let parsed: URL;
  try { parsed = new URL(url); } catch { fail("URL is malformed"); }
  if (parsed.protocol !== "https:") fail("URL must use HTTPS");
  if (parsed.username || parsed.password) fail("URL credentials are forbidden");
  if (parsed.hash) fail("URL fragments are forbidden");
  if (parsed.port) fail("URL ports are forbidden");
  const host = parsed.hostname.toLowerCase();
  if (!IMAGE_HOSTS.has(host)) fail("URL host is not approved");
  return url;
}

export function validateYoutubeId(id: string): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id)) fail("YouTube ID is invalid");
  return id;
}

export function assertNoForbiddenKeys(value: unknown, path = "artifact"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`forbidden field ${path}.${key}`);
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

function assertAscending(values: string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) fail(`${label} must be strictly ordered`);
  }
}

function assertObjectOrder<T>(values: T[], key: (value: T) => string, label: string): void {
  assertAscending(values.map(key), label);
}

export function validateArtifact(value: unknown): PublishedArtifact {
  assertNoForbiddenKeys(value);
  const artifact = PublishedArtifactSchema.parse(value);
  if (artifact.version !== SITE_DATA_VERSION) fail(`version must be ${SITE_DATA_VERSION}`);
  parseSnapshotDate(artifact.snapshotDate);
  if (artifact.games.length === 0) fail("at least one published game is required");
  if (artifact.games.length > MAX_PUBLISHED_GAMES) fail("published game limit exceeded");
  assertAscending(artifact.games.map((game) => game.slug), "games");

  const genreBySlug = new Map<string, string>();
  const genreByName = new Map<string, string>();
  const platformBySlug = new Map<string, string>();
  const platformByName = new Map<string, string>();
  for (const game of artifact.games) {
    parseSnapshotDate(game.releaseDate);
    if (game.status === "released" && game.releaseDate > artifact.snapshotDate) fail(`${game.slug}.releaseDate is after snapshotDate`);
    if (game.status === "upcoming" && game.releaseDate <= artifact.snapshotDate) fail(`${game.slug}.releaseDate is not after snapshotDate`);
    if (!isCanonicalSlug(game.slug)) fail(`${game.slug}.slug is invalid`);
    validateImageUrl(game.cover);
    validateImageUrl(game.hero);
    game.screenshots.forEach(validateImageUrl);
    assertAscending(game.genres, `${game.slug}.genres`);
    assertAscending(game.platforms, `${game.slug}.platforms`);
    for (const [names, slugs, label] of [[game.genres, game.genreSlugs, "genres"], [game.platforms, game.platformSlugs, "platforms"]] as const) {
      if (slugs.length !== names.length || new Set(slugs).size !== slugs.length || slugs.some((slug) => !isCanonicalSlug(slug))) fail(`${game.slug}.${label} taxonomy identity is invalid`);
      const bySlug = label === "genres" ? genreBySlug : platformBySlug;
      const byName = label === "genres" ? genreByName : platformByName;
      names.forEach((name, index) => {
        const slug = slugs[index]!;
        if ((bySlug.has(slug) && bySlug.get(slug) !== name) || (byName.has(name) && byName.get(name) !== slug)) fail(`${label.slice(0, -1)} taxonomy identity is inconsistent`);
        bySlug.set(slug, name);
        byName.set(name, slug);
      });
    }
    if (new Set(game.screenshots).size !== game.screenshots.length) fail(`${game.slug}.screenshots contains duplicate URLs`);
    assertObjectOrder(game.officialLinks, (link) => `${link.type}\u0000${link.provider}\u0000${link.url}`, `${game.slug}.officialLinks`);
    if (new Set(game.videos.map((video) => `${video.provider}\u0000${video.id}`)).size !== game.videos.length) fail(`${game.slug}.videos contains duplicate identities`);
    for (const link of game.officialLinks) { if (link.type !== "official_website" && link.type !== "store") fail(`${game.slug}.officialLinks contains non-publishable type`); validateOfficialLinkUrl(link.url); }
    for (const video of game.videos) validateYoutubeId(video.id);
  }

  let serialized: string;
  try { serialized = JSON.stringify(artifact); } catch { fail("artifact cannot be serialized"); }
  if (new TextEncoder().encode(serialized).byteLength > MAX_ARTIFACT_BYTES) fail("artifact size limit exceeded");
  return artifact;
}

export const publishedArtifactValidator = z.custom<PublishedArtifact>(validateArtifact);
