import { loadPublishedArtifact } from "@/lib/site-data/source";
import { HeaderClient } from "./header-client";

export async function Header() {
  const { games } = await loadPublishedArtifact();
  const searchGames = games.map(({ slug, title, developer, publisher, releaseDate, cover, genres }) => ({ slug, title, developer, publisher, releaseDate, cover, genres }));
  const platforms = [...new Set(games.flatMap((game) => game.platforms.map((name, index) => ({ name, slug: game.platformSlugs?.[index] })) ))].filter((item): item is { name: string; slug: string } => Boolean(item.slug));
  const genres = [...new Map(games.flatMap((game) => game.genres.map((name, index) => [game.genreSlugs?.[index], { name, slug: game.genreSlugs?.[index] }] as const)).filter(([slug]) => Boolean(slug))).values()] as Array<{ name: string; slug: string }>;
  return <HeaderClient games={searchGames} platforms={platforms} genres={genres} />;
}
