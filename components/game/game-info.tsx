import type { PublishedGame } from "@/lib/site-data/contracts";

export function GameInfo({ game }: { game: PublishedGame }) {
  const rows = [["开发商", game.developer], ["发行商", game.publisher], ["发布日期", game.releaseDate], ["类型", game.genres.join(" · ")], ["平台", game.platforms.join(" · ")]];
  return <aside className="rounded-2xl border border-white/10 bg-card/80 p-5 shadow-[0_20px_60px_rgba(0,0,0,.18)] backdrop-blur-sm sm:p-6"><h2 className="text-lg font-semibold tracking-[-.015em]">游戏信息</h2><dl className="mt-5 divide-y divide-white/[.07]">{rows.map(([label, value]) => <div key={label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 py-3.5 first:pt-0 last:pb-0 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words leading-6 text-secondary-foreground">{value}</dd></div>)}</dl></aside>;
}
