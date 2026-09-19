"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Container } from "@/components/layout/container";
import { EmptyState } from "@/components/ui/empty-state";
import { filterGames } from "@/lib/game-filter";
import { parseSearchQuery } from "@/lib/static-query";
import type { GameBrowseRecord } from "@/lib/search-contract";

export function StaticSearch({ games }: { games: GameBrowseRecord[] }) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    const read = () => setQuery(parseSearchQuery(new URLSearchParams(window.location.search)));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const results = useMemo(() => query ? filterGames(games, { query }) : games.slice(0, 8), [games, query]);
  function updateQuery(value: string) {
    setQuery(value);
    const params = new URLSearchParams(window.location.search);
    if (value.trim()) params.set("q", value.trim()); else params.delete("q");
    window.history.pushState(null, "", params.size ? `/search?${params}` : "/search");
  }
  return <Container className="pt-28"><h1 className="text-4xl font-bold tracking-tight">搜索</h1><form onSubmit={(event) => event.preventDefault()} className="relative mt-7 max-w-3xl"><Search className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" /><input autoFocus name="q" value={query} onChange={(event) => updateQuery(event.target.value)} className="h-14 w-full rounded-xl border bg-card pl-12 pr-4 text-base outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20" placeholder="搜索游戏、开发商或出版商" /></form><p className="mb-7 mt-8 text-sm text-muted-foreground">{query ? <>“{query}” 找到 {results.length} 个结果</> : "浏览游戏"}</p>{results.length ? <div className="flex max-w-4xl flex-col gap-3">{results.map((game) => <Link key={game.slug} href={`/games/${game.slug}`} className="flex gap-4 rounded-xl border bg-card p-3 transition hover:border-primary/50"><div className="relative h-24 w-[72px] shrink-0 overflow-hidden rounded-lg"><Image src={game.cover} alt="" fill sizes="72px" className="object-cover" /></div><div className="min-w-0 self-center"><h2 className="truncate font-semibold sm:text-lg">{game.title}</h2><p className="mt-1 truncate text-sm text-muted-foreground">{game.developer} · {game.releaseDate.slice(0, 4)}</p><p className="mt-2 text-xs text-secondary-foreground">{game.genres.join(" · ")} · {game.platforms.slice(0, 2).join(" / ")}</p></div></Link>)}</div> : <EmptyState title={`没有找到“${query}”`} description="尝试检查名称，或调整类型、平台与年份筛选。" />}</Container>;
}
