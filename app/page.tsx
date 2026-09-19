import { GameGrid } from "@/components/game/game-grid";
import { GenreBrowse, PlatformBrowse } from "@/components/home/browse-sections";
import { HomeHero, HomeSearch } from "@/components/home/home-hero";
import { SectionHeading } from "@/components/home/section-heading";
import { Container } from "@/components/layout/container";
import { loadPublishedArtifact } from "@/lib/site-data/source";
import { hasPublishedRatingSignal } from "@/lib/site-data/presentation-policy";
import { selectUpcomingGames } from "@/lib/home-query";

export default async function HomePage() {
  const { games } = await loadPublishedArtifact();
  const latest = games.filter((g) => g.status === "released").sort((a,b) => b.releaseDate.localeCompare(a.releaseDate)).slice(0, 6);
  const upcoming = selectUpcomingGames(games);
  const hasRatings = hasPublishedRatingSignal(games);
  const genres = [...new Map(games.flatMap((game) => game.genres.map((name, index) => [game.genreSlugs?.[index], { name, slug: game.genreSlugs?.[index] }] as const)).filter(([slug]) => Boolean(slug))).values()] as Array<{ name: string; slug: string }>;
  return <><HomeHero game={games[0]} /><HomeSearch /><Container className="flex flex-col gap-16 pt-16 sm:gap-20 sm:pt-20">{hasRatings && <section><SectionHeading title="热门游戏" href="/games?sort=popular" /><GameGrid games={[...games].sort((a, b) => (b.optional.rating ?? -1) - (a.optional.rating ?? -1)).slice(0, 6)} /></section>}<section><SectionHeading title="最新发布" href="/games?sort=newest" /><GameGrid games={latest} /></section><section><SectionHeading title="即将上线" href="/games?status=upcoming" /><GameGrid games={upcoming} /></section><section><SectionHeading title="按平台浏览" /><PlatformBrowse games={games} /></section><section><SectionHeading title="按类型浏览" /><GenreBrowse genres={genres} /></section></Container></>;
}
