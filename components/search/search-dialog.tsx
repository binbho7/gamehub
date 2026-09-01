"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Image from "next/image";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import { games } from "@/lib/mock-data";
import { filterGames } from "@/lib/game-filter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SearchDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const results = deferredQuery ? filterGames(games, { query: deferredQuery }).slice(0, 6) : games.slice(0, 5);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return <Dialog.Root open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (!nextOpen) setQuery(""); }}>
    <Dialog.Trigger asChild><Button variant="ghost" size="icon" aria-label="搜索游戏"><Search /></Button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" /><Dialog.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 rounded-xl border bg-[#0e131d] p-4 shadow-2xl sm:p-6">
      <div className="flex items-center justify-between"><Dialog.Title className="text-lg font-semibold">搜索 GameHub</Dialog.Title><Dialog.Close asChild><Button variant="ghost" size="icon" aria-label="关闭"><X /></Button></Dialog.Close></div>
      <div className="relative mt-4"><Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} className="pl-10" placeholder="搜索游戏名称、中文名、开发商或 Steam App ID" /></div>
      <div className="mt-4 flex max-h-[52vh] flex-col gap-1 overflow-y-auto">{results.map((game) => <Dialog.Close asChild key={game.id}><Link href={`/games/${game.slug}`} className="flex items-center gap-3 rounded-lg p-2.5 hover:bg-secondary"><Image src={game.cover} width={48} height={64} alt="" className="h-16 w-12 rounded-md object-cover" /><div className="min-w-0"><p className="truncate font-medium">{game.title}</p><p className="truncate text-sm text-muted-foreground">{game.developer} · {game.releaseDate.slice(0,4)}</p></div></Link></Dialog.Close>)}{query && results.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">没有找到“{query}”，请尝试英文名称、开发商或 Steam App ID。</p>}</div>
      {query && <Link className="mt-4 block text-center text-sm font-medium text-primary" href={`/search?q=${encodeURIComponent(query)}`}>查看全部搜索结果</Link>}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
