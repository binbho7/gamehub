import type { GameBrowseRecord } from "@/lib/search-contract";
import { GameCard } from "./game-card";

export function GameGrid({ games }: { games: GameBrowseRecord[] }) {
  return <div className="grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-3 sm:gap-x-5 md:gap-y-9 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">{games.map((game) => <GameCard key={game.slug} game={game} />)}</div>;
}
