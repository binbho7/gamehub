import Link from "next/link";
import { Container } from "./container";

export function Footer() {
  return <footer className="mt-20 border-t py-10"><Container className="flex flex-col gap-5 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><div><span className="font-bold text-foreground">Game<span className="text-primary">Hub</span></span><p className="mt-1">发现游戏，直达可信的官方资源。</p></div><nav className="flex flex-wrap gap-5"><Link href="/games">游戏库</Link><Link href="/genres/action">按类型</Link><Link href="/platforms/pc">按平台</Link></nav><p>© 2026 GameHub</p></Container></footer>;
}
