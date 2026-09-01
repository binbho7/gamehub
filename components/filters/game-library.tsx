"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { Game, GameSort, ReleaseStatus } from "@/types/game";
import { filterGames, type GameFilters } from "@/lib/game-filter";
import { GameGrid } from "@/components/game/game-grid";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";

type Props = {
  games: Game[];
  genres: string[];
  platforms: string[];
  years: string[];
  initial?: GameFilters;
};

export function GameLibrary({ games, genres, platforms, years, initial = {} }: Props) {
  const [query, setQuery] = useState(initial.query ?? "");
  const [genre, setGenre] = useState(initial.genre ?? "");
  const [platform, setPlatform] = useState(initial.platform ?? "");
  const [year, setYear] = useState(initial.year ?? "");
  const [status, setStatus] = useState<ReleaseStatus | "">(initial.status ?? "");
  const [sort, setSort] = useState<GameSort>(initial.sort ?? "popular");
  const results = useMemo(() => filterGames(games, { query, genre: genre || undefined, platform: platform || undefined, year: year || undefined, sort, status: status || undefined, free: initial.free }), [games, query, genre, platform, year, sort, status, initial.free]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (genre) params.set("genre", genre);
    if (platform) params.set("platform", platform);
    if (year) params.set("year", year);
    if (status) params.set("status", status);
    if (sort !== "popular") params.set("sort", sort);
    if (initial.free !== undefined) params.set("free", String(initial.free));
    const nextUrl = params.size ? `/games?${params.toString()}` : "/games";
    window.history.replaceState(null, "", nextUrl);
  }, [query, genre, platform, year, status, sort, initial.free]);

  const selectClass = "h-11 rounded-lg border bg-muted px-3 text-sm text-secondary-foreground outline-none focus:border-primary";
  return <>
    <div className="mb-8 flex flex-col gap-3">
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-12 pl-10" placeholder="搜索游戏名称、中文名、开发商或 Steam App ID" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <select aria-label="类型" value={genre} onChange={(event) => setGenre(event.target.value)} className={selectClass}>
          <option value="">全部类型</option>
          {genres.map((value) => <option key={value}>{value}</option>)}
        </select>
        <select aria-label="平台" value={platform} onChange={(event) => setPlatform(event.target.value)} className={selectClass}>
          <option value="">全部平台</option>
          {platforms.map((value) => <option key={value}>{value}</option>)}
        </select>
        <select aria-label="年份" value={year} onChange={(event) => setYear(event.target.value)} className={selectClass}>
          <option value="">全部年份</option>
          {years.map((value) => <option key={value}>{value}</option>)}
        </select>
        <select aria-label="状态" className={selectClass} value={status} onChange={(event) => setStatus(event.target.value as ReleaseStatus | "")}>
          <option value="">全部状态</option>
          <option value="released">已发布</option>
          <option value="upcoming">即将上线</option>
        </select>
        <select aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value as GameSort)} className={selectClass}>
          <option value="popular">热门</option>
          <option value="newest">最新发布</option>
          <option value="title">名称</option>
          <option value="rating">评分</option>
        </select>
      </div>
    </div>
    <p className="mb-6 text-sm text-muted-foreground" aria-live="polite">找到 {results.length} 款游戏</p>
    {results.length
      ? <GameGrid games={results} />
      : <EmptyState title={`没有找到“${query || "符合条件的游戏"}”`} description="尝试检查名称，或调整类型、平台与年份筛选。" />}
  </>;
}
