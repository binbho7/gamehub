import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Search } from "lucide-react";
import { Container } from "@/components/layout/container";
import { EmptyState } from "@/components/ui/empty-state";
import { filterGames } from "@/lib/game-filter";
import { games } from "@/lib/mock-data";

export const metadata: Metadata = { title: "搜索", description: "搜索游戏、开发商或 Steam App ID。", robots: { index: false, follow: true } };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const query = (await searchParams).q?.trim() ?? "";
  const results = query ? filterGames(games, { query }) : games.slice(0, 8);

  return <Container className="pt-28">
    <h1 className="text-4xl font-bold tracking-tight">搜索</h1>
    <form action="/search" className="relative mt-7 max-w-3xl">
      <Search className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
      <input autoFocus name="q" defaultValue={query} className="h-14 w-full rounded-xl border bg-card pl-12 pr-4 text-base outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20" placeholder="搜索游戏、开发商或 Steam App ID" />
    </form>
    <p className="mb-7 mt-8 text-sm text-muted-foreground">
      {query ? <>“{query}” 找到 {results.length} 个结果</> : "热门搜索结果"}
    </p>
    {results.length ? <div className="flex max-w-4xl flex-col gap-3">
      {results.map((game) => <Link key={game.id} href={`/games/${game.slug}`} className="flex gap-4 rounded-xl border bg-card p-3 transition hover:border-primary/50">
        <div className="relative h-24 w-[72px] shrink-0 overflow-hidden rounded-lg">
          <Image src={game.cover} alt="" fill sizes="72px" className="object-cover" />
        </div>
        <div className="min-w-0 self-center">
          <h2 className="truncate font-semibold sm:text-lg">{game.title}</h2>
          <p className="mt-1 truncate text-sm text-muted-foreground">{game.developer} · {game.releaseDate.slice(0, 4)}</p>
          <p className="mt-2 text-xs text-secondary-foreground">{game.genres.join(" · ")} · {game.platforms.slice(0, 2).join(" / ")}</p>
        </div>
      </Link>)}
    </div> : <EmptyState title={`没有找到“${query}”`} description="尝试检查游戏名称、搜索英文名称或开发商。" />}
  </Container>;
}
