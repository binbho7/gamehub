import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function SectionHeading({ title, href, label = "查看全部" }: { title: string; href?: string; label?: string }) {
  return <div className="mb-6 flex items-end justify-between gap-4"><h2 className="text-2xl font-semibold tracking-tight sm:text-[28px]">{title}</h2>{href && <Link href={href} className="flex items-center gap-1 text-sm text-muted-foreground transition hover:text-primary">{label}<ArrowRight className="size-4" /></Link>}</div>;
}
