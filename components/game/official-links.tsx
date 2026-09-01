import { ArrowUpRight, CheckCircle2, Globe2, Store } from "lucide-react";
import type { OfficialLink } from "@/types/game";
import { Badge } from "@/components/ui/badge";

export function OfficialLinks({ links }: { links: OfficialLink[] }) {
  return <section id="official-links"><h2 className="text-2xl font-semibold">官方资源</h2><p className="mt-2 text-sm text-muted-foreground">已验证的游戏官网和官方商店入口</p><div className="mt-6 grid gap-3 md:grid-cols-2">{links.map((link) => <a key={`${link.provider}-${link.platform}`} href={link.url} target="_blank" rel="noreferrer" className="group flex min-h-32 items-start gap-4 rounded-xl border bg-card p-5 transition hover:border-primary/50 hover:bg-secondary"><div className="rounded-lg bg-muted p-2.5 text-primary">{link.type === "官方网站" ? <Globe2 className="size-5" /> : <Store className="size-5" />}</div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{link.provider}</h3><Badge><CheckCircle2 className="mr-1 size-3" />官方</Badge></div><p className="mt-2 text-sm text-muted-foreground">{link.platform} · {link.type}</p><p className="mt-3 text-sm font-medium text-primary">{link.type === "官方网站" ? "访问官网" : `在 ${link.provider} 查看`}</p></div><ArrowUpRight className="size-4 text-muted-foreground transition group-hover:text-primary" /></a>)}</div></section>;
}
