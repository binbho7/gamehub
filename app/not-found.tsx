import Link from "next/link";
import { Container } from "@/components/layout/container";
import { buttonVariants } from "@/components/ui/button";
export default function NotFound() { return <Container className="flex min-h-[70vh] flex-col items-center justify-center pt-20 text-center"><p className="text-sm font-medium text-primary">404</p><h1 className="mt-3 text-4xl font-bold">没有找到这个游戏</h1><p className="mt-4 text-muted-foreground">它可能尚未收录，或者链接已经改变。</p><Link href="/games" className={buttonVariants({ className: "mt-7" })}>返回游戏库</Link></Container>; }
