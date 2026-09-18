import type { PublishedGame } from "@/lib/site-data/contracts";

export function GameInfo({ game }: { game: PublishedGame }) {
  const rows = [["开发商", game.developer], ["发行商", game.publisher], ["发布日期", game.releaseDate], ["类型", game.genres.join(" · ")], ["平台", game.platforms.join(" · ")], ["模式", game.optional.modes?.join(" · ") ?? "暂无数据"], ["控制器", game.optional.controllerSupport === null ? "暂无数据" : game.optional.controllerSupport ? "支持" : "不支持"]];
  return <aside className="rounded-xl border bg-card p-5"><h2 className="text-lg font-semibold">游戏信息</h2><dl className="mt-5 flex flex-col gap-4">{rows.map(([label, value]) => <div key={label} className="grid grid-cols-[72px_1fr] gap-3 text-sm"><dt className="text-muted-foreground">{label}</dt><dd className="text-secondary-foreground">{value}</dd></div>)}</dl></aside>;
}
