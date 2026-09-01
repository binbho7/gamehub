import { GameGrid } from "@/components/game/game-grid";
import { GenreBrowse, PlatformBrowse } from "@/components/home/browse-sections";
import { HomeHero, HomeSearch } from "@/components/home/home-hero";
import { SectionHeading } from "@/components/home/section-heading";
import { Container } from "@/components/layout/container";
import { games } from "@/lib/mock-data";

export default function HomePage() {
  const popular = [...games].sort((a,b) => b.rating-a.rating).slice(0, 6);
  const latest = games.filter((g) => g.status === "released").sort((a,b) => b.releaseDate.localeCompare(a.releaseDate)).slice(0, 6);
  const free = games.filter((g) => g.isFree);
  const upcoming = games.filter((g) => g.status === "upcoming");
  return <><HomeHero game={games[0]} /><HomeSearch /><Container className="flex flex-col gap-16 pt-16 sm:gap-20 sm:pt-20"><section><SectionHeading title="热门游戏" href="/games?sort=popular" /><GameGrid games={popular} /></section><section><SectionHeading title="最新发布" href="/games?sort=newest" /><GameGrid games={latest} /></section><section className="grid gap-12 xl:grid-cols-2"><div><SectionHeading title="免费游戏" href="/games?free=true" /><GameGrid games={free} /></div><div><SectionHeading title="即将上线" href="/games?status=upcoming" /><GameGrid games={upcoming} /></div></section><section><SectionHeading title="按平台浏览" /><PlatformBrowse /></section><section><SectionHeading title="按类型浏览" /><GenreBrowse /></section></Container></>;
}
