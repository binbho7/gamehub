import { MAX_ARTIFACT_BYTES, MAX_PUBLISHED_GAMES, PublishedArtifactSchema, type PublishedArtifact, type PublishedGame } from "./contracts";
import { assertNoForbiddenKeys, validateArtifact } from "./validation";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeGame(game: PublishedGame): PublishedGame {
  return {
    slug: game.slug,
    title: game.title,
    description: game.description,
    releaseDate: game.releaseDate,
    status: game.status,
    developer: game.developer,
    publisher: game.publisher,
    genres: game.genreSlugs.map((slug, index) => ({ slug, name: game.genres[index]! })).sort((a, b) => compare(a.name, b.name) || compare(a.slug, b.slug)).map((item) => item.name),
    platforms: game.platformSlugs.map((slug, index) => ({ slug, name: game.platforms[index]! })).sort((a, b) => compare(a.name, b.name) || compare(a.slug, b.slug)).map((item) => item.name),
    genreSlugs: game.genreSlugs.map((slug, index) => ({ slug, name: game.genres[index]! })).sort((a, b) => compare(a.name, b.name) || compare(a.slug, b.slug)).map((item) => item.slug),
    platformSlugs: game.platformSlugs.map((slug, index) => ({ slug, name: game.platforms[index]! })).sort((a, b) => compare(a.name, b.name) || compare(a.slug, b.slug)).map((item) => item.slug),
    cover: game.cover,
    hero: game.hero,
    screenshots: [...game.screenshots].sort(compare),
    officialLinks: [...game.officialLinks].sort((left, right) => compare(`${left.type}\u0000${left.provider}\u0000${left.url}`, `${right.type}\u0000${right.provider}\u0000${right.url}`)),
    videos: [...game.videos].sort((left, right) => compare(`${left.provider}\u0000${left.id}`, `${right.provider}\u0000${right.id}`)),
    optional: {
      titleCn: game.optional.titleCn,
      rating: game.optional.rating,
      systemRequirements: game.optional.systemRequirements,
      modes: game.optional.modes,
      controllerSupport: game.optional.controllerSupport,
      isFree: game.optional.isFree,
    },
  };
}

export function normalizeArtifact(artifact: PublishedArtifact): PublishedArtifact {
  assertNoForbiddenKeys(artifact);
  return {
    version: artifact.version,
    snapshotDate: artifact.snapshotDate,
    games: [...artifact.games].sort((left, right) => compare(left.slug, right.slug)).map(normalizeGame),
  };
}

export function serializeArtifact(artifact: PublishedArtifact): string {
  const normalized = normalizeArtifact(artifact);
  PublishedArtifactSchema.parse(normalized);
  validateArtifact(normalized);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function assertArtifactLimits(serialized: string, gameCount: number): void {
  if (new TextEncoder().encode(serialized).byteLength > MAX_ARTIFACT_BYTES) throw new Error("Serialized artifact exceeds 10 MiB");
  if (!Number.isInteger(gameCount) || gameCount < 0 || gameCount > MAX_PUBLISHED_GAMES) throw new Error("Published game count exceeds 10,000");
}
