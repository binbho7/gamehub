"use client";

import Link from "next/link";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Container } from "./container";
import { SearchDialog } from "@/components/search/search-dialog";
import { Button } from "@/components/ui/button";
import type { SearchGameRecord } from "@/lib/search-contract";
import { buildTaxonomyNavigation } from "@/lib/site-data/navigation";

const nav = [{ label: "游戏", href: "/games" }, { label: "最新发布", href: "/games?sort=newest" }, { label: "即将上线", href: "/games?status=upcoming" }];

export function HeaderClient({ games, platforms, genres }: { games: SearchGameRecord[]; platforms: Array<{name:string;slug:string}>; genres: Array<{name:string;slug:string}> }) {
  const [open, setOpen] = useState(false);
  const taxonomy = buildTaxonomyNavigation(platforms, genres).desktop;
  const links = [...nav, ...taxonomy];
  return <header className="fixed inset-x-0 top-0 z-40 h-16 border-b border-white/10 bg-background/85 shadow-[0_8px_30px_rgba(0,0,0,.15)] backdrop-blur-xl"><Container className="flex h-full items-center"><Link href="/" className="rounded-md text-xl font-black tracking-[-.04em]">Game<span className="text-primary">Hub</span></Link><nav className="ml-8 hidden min-w-0 items-center gap-0.5 lg:flex">{links.map((item) => <Link key={item.href + item.label} href={item.href} className="whitespace-nowrap rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground xl:px-3">{item.label}</Link>)}</nav><div className="ml-auto flex shrink-0 items-center gap-1"><SearchDialog games={games} /><Button className="lg:hidden" variant="ghost" size="icon" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="mobile-navigation" aria-label={open ? "关闭菜单" : "打开菜单"}>{open ? <X /> : <Menu />}</Button></div></Container>{open && <nav id="mobile-navigation" className="border-b border-white/10 bg-background/98 p-4 shadow-2xl lg:hidden"><div className="mx-auto grid max-w-[1360px] grid-cols-1 gap-2 sm:grid-cols-2">{links.map((item) => <Link onClick={() => setOpen(false)} key={item.href + item.label} href={item.href} className="flex min-h-12 items-center rounded-lg border border-white/[.07] bg-card px-4 py-3 text-sm font-medium transition hover:border-primary/40 hover:bg-secondary">{item.label}</Link>)}</div></nav>}</header>;
}

export { buildTaxonomyNavigation };
