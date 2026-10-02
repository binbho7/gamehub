import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function SectionHeading({ title, href, label = "查看全部" }: { title: string; href?: string; label?: string }) {
  return <div className="mb-6 flex items-end justify-between gap-4 border-b border-white/[.07] pb-4 sm:mb-7"><h2 className="text-2xl font-bold tracking-[-.025em] sm:text-[30px]">{title}</h2>{href && <Link href={href} className="group flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-muted-foreground transition hover:bg-white/5 hover:text-primary">{label}<ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" /></Link>}</div>;
}
