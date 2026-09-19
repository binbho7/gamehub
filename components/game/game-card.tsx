import Image from "next/image";
import Link from "next/link";
import type { GameBrowseRecord } from "@/lib/search-contract";

export function GameCard({ game }: { game: GameBrowseRecord }) {
  return (
    <Link href={`/games/${game.slug}`} className="group min-w-0">
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl border bg-card transition duration-200 group-hover:-translate-y-1 group-hover:border-primary/50">
        <Image src={game.cover} alt={`${game.title} 封面`} fill sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 17vw" className="object-cover transition duration-300 group-hover:scale-[1.03]" />
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/70 to-transparent" />
        {game.status === "upcoming" && <span className="absolute left-2.5 top-2.5 rounded-md bg-[#b96a23]/90 px-2 py-1 text-[11px] font-semibold">即将上线</span>}
      </div>
      <div className="mt-3 min-w-0">
        <h3 className="truncate text-[15px] font-semibold text-foreground">{game.title}</h3>
        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">{game.genres[0]}</span>
          <span aria-hidden="true" />
        </div>
      </div>
    </Link>
  );
}
