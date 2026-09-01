import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GameHero } from "@/components/game/game-hero";
import { OfficialLinks } from "@/components/game/official-links";
import { GameGallery } from "@/components/game/game-gallery";
import { SystemRequirements } from "@/components/game/system-requirements";
import { GameInfo } from "@/components/game/game-info";
import { GameGrid } from "@/components/game/game-grid";
import { Container } from "@/components/layout/container";
import { SectionHeading } from "@/components/home/section-heading";
import { games } from "@/lib/mock-data";
import { getGameBySlug, getRelatedGames } from "@/lib/game-query";

type Props = { params: Promise<{ slug: string }> };
export function generateStaticParams() { return games.map((game) => ({ slug: game.slug })); }
export async function generateMetadata({ params }: Props): Promise<Metadata> { const game = getGameBySlug((await params).slug); if (!game) return { title: "游戏未找到" }; const description = `查看 ${game.title} 游戏介绍、系统配置、截图以及官方网站与官方商店入口。`; return { title: `${game.title} - 官网、Steam 与官方游戏信息`, description, alternates: { canonical: `/games/${game.slug}` }, openGraph: { title: game.title, description, type: "website", images: [{ url: game.hero }] } }; }

export default async function GameDetailPage({ params }: Props) {
  const game = getGameBySlug((await params).slug);
  if (!game) notFound();
  const related = getRelatedGames(game);

  return <>
    <GameHero game={game} />
    <Container className="grid gap-12 pt-12 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-16">
      <div className="flex min-w-0 flex-col gap-14">
        <OfficialLinks links={game.officialLinks} />
        <section>
          <h2 className="text-2xl font-semibold">关于这款游戏</h2>
          <p className="mt-5 max-w-3xl text-[15px] leading-8 text-secondary-foreground">{game.description}</p>
          <p className="mt-4 max-w-3xl text-xs leading-6 text-muted-foreground">GameHub 仅提供游戏资料与经验证的官方入口，不托管任何游戏文件。</p>
        </section>
        <GameGallery images={game.screenshots} title={game.title} />
        {game.trailerId && <section>
          <h2 className="text-2xl font-semibold">官方预告片</h2>
          <div className="mt-6 aspect-video overflow-hidden rounded-xl border bg-card">
            <iframe className="size-full" src={`https://www.youtube-nocookie.com/embed/${game.trailerId}`} title={`${game.title} 官方预告片`} loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
          </div>
        </section>}
        <SystemRequirements requirements={game.systemRequirements} />
      </div>
      <div className="lg:pt-1">
        <div className="lg:sticky lg:top-24"><GameInfo game={game} /></div>
      </div>
    </Container>
    <Container className="pt-16">
      <SectionHeading title="你可能还喜欢" />
      <GameGrid games={related} />
    </Container>
  </>;
}
