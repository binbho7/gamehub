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
import { loadPublishedArtifact } from "@/lib/site-data/source";
import { getGameBySlug, getRelatedGames } from "@/lib/game-query";
import { buildGameMetadata, buildVideoGameJsonLd, serializeJsonLd } from "@/lib/seo";

type Props = { params: Promise<{ slug: string }> };
export async function generateStaticParams() { const { games } = await loadPublishedArtifact(); return games.map((game) => ({ slug: game.slug })); }
export async function generateMetadata({ params }: Props): Promise<Metadata> { const { games } = await loadPublishedArtifact(); const game = getGameBySlug(games, (await params).slug); return game ? buildGameMetadata(game) : { title: "游戏未找到" }; }

export default async function GameDetailPage({ params }: Props) {
  const { games } = await loadPublishedArtifact();
  const game = getGameBySlug(games, (await params).slug);
  if (!game) notFound();
  const related = getRelatedGames(games, game);

  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(buildVideoGameJsonLd(game)) }} />
    <GameHero game={game} />
    <Container className="grid gap-12 pt-12 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-16 lg:pt-16">
      <div className="flex min-w-0 flex-col gap-14 sm:gap-16">
        <OfficialLinks links={game.officialLinks} />
        <section>
          <h2 className="text-2xl font-semibold tracking-[-.02em]">关于这款游戏</h2>
          <p className="mt-5 max-w-3xl text-[15px] leading-8 text-secondary-foreground">{game.description}</p>
          <p className="mt-4 max-w-3xl text-xs leading-6 text-muted-foreground">GameHub 仅提供游戏资料与经验证的官方入口，不托管任何游戏文件。</p>
        </section>
        <GameGallery images={game.screenshots} title={game.title} />
        {game.videos[0] && <section>
          <h2 className="text-2xl font-semibold tracking-[-.02em]">官方预告片</h2>
          <div className="mt-6 aspect-video overflow-hidden rounded-xl border border-white/10 bg-card shadow-[0_18px_50px_rgba(0,0,0,.2)]">
            <iframe className="size-full" src={`https://www.youtube-nocookie.com/embed/${game.videos[0].id}`} title={`${game.title} 官方预告片`} loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
          </div>
        </section>}
        <SystemRequirements requirements={game.optional.systemRequirements} />
      </div>
      <div className="lg:pt-1">
        <div className="lg:sticky lg:top-24"><GameInfo game={game} /></div>
      </div>
    </Container>
    <Container className="pt-16 sm:pt-20">
      <SectionHeading title="你可能还喜欢" />
      <GameGrid games={related} />
    </Container>
  </>;
}
