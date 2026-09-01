"use client";

import Link from "next/link";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Container } from "./container";
import { SearchDialog } from "@/components/search/search-dialog";
import { Button } from "@/components/ui/button";

const nav = [{ label: "游戏", href: "/games" }, { label: "最新发布", href: "/games?sort=newest" }, { label: "即将上线", href: "/games?status=upcoming" }, { label: "免费游戏", href: "/games?free=true" }, { label: "平台", href: "/platforms/pc" }, { label: "类型", href: "/genres/action" }];

export function Header() {
  const [open, setOpen] = useState(false);
  return <header className="fixed inset-x-0 top-0 z-40 h-16 border-b bg-background/90 backdrop-blur-xl"><Container className="flex h-full items-center"><Link href="/" className="text-xl font-black tracking-tight">Game<span className="text-primary">Hub</span></Link><nav className="ml-10 hidden items-center gap-1 lg:flex">{nav.map((item) => <Link key={item.href + item.label} href={item.href} className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">{item.label}</Link>)}</nav><div className="ml-auto flex items-center gap-1"><SearchDialog /><Button className="lg:hidden" variant="ghost" size="icon" onClick={() => setOpen((value) => !value)} aria-label="菜单">{open ? <X /> : <Menu />}</Button></div></Container>{open && <nav className="border-b bg-background p-4 lg:hidden"><div className="mx-auto grid max-w-[1360px] grid-cols-2 gap-2">{nav.map((item) => <Link onClick={() => setOpen(false)} key={item.href + item.label} href={item.href} className="rounded-lg bg-card px-4 py-3 text-sm">{item.label}</Link>)}</div></nav>}</header>;
}
