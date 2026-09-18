import type { PublishedGame } from "@/lib/site-data/contracts";
import { GameCard } from "./game-card";

export function GameGrid({ games }: { games: PublishedGame[] }) {
  return <div className="grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-3 sm:gap-x-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">{games.map((game) => <GameCard key={game.slug} game={game} />)}</div>;
}
