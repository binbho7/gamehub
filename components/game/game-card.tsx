import Image from "next/image";
import Link from "next/link";
import type { GameBrowseRecord } from "@/lib/search-contract";

export function GameCard({ game }: { game: GameBrowseRecord }) {
  return (
    <Link href={`/games/${game.slug}`} className="group block min-w-0 rounded-xl focus-visible:outline-offset-4">
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl border border-white/10 bg-card shadow-[0_10px_30px_rgba(0,0,0,.18)] transition duration-300 group-hover:-translate-y-1 group-hover:border-primary/45 group-hover:shadow-[0_18px_42px_rgba(0,0,0,.38)]">
        <Image src={game.cover} alt={`${game.title} 封面`} fill sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw" className="object-cover transition duration-500 ease-out group-hover:scale-[1.035]" />
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/70 to-transparent" />
        {game.status === "upcoming" && <span className="absolute left-2.5 top-2.5 rounded-md bg-[#b96a23]/90 px-2 py-1 text-[11px] font-semibold">即将上线</span>}
      </div>
      <div className="mt-3 min-w-0 px-0.5">
        <h3 className="truncate text-[15px] font-bold leading-5 text-foreground transition-colors group-hover:text-white sm:text-base">{game.title}</h3>
        <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate">{game.developer}</span>
          <span className="shrink-0">{game.releaseDate.slice(0, 4)}</span>
        </div>
      </div>
    </Link>
  );
}
