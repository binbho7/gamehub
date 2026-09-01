import { SearchX } from "lucide-react";

export function EmptyState({ title = "没有找到游戏", description = "尝试调整关键词或筛选条件。" }) {
  return <div className="flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border bg-card/50 px-6 text-center"><SearchX className="size-8 text-muted-foreground" /><h2 className="text-lg font-semibold">{title}</h2><p className="text-sm text-muted-foreground">{description}</p></div>;
}
