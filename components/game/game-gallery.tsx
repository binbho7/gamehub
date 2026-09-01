"use client";

import Image from "next/image";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function GameGallery({ images, title }: { images: string[]; title: string }) {
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (active === null) return;
      if (event.key === "Escape") setActive(null);
      if (event.key === "ArrowRight") setActive((active + 1) % images.length);
      if (event.key === "ArrowLeft") setActive((active - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, images.length]);
  return <section><h2 className="text-2xl font-semibold">游戏截图</h2><div className="mt-6 grid gap-3 md:grid-cols-2 md:grid-rows-2">{images.map((image, index) => <button key={image} onClick={() => setActive(index)} className={index === 0 ? "relative aspect-video overflow-hidden rounded-xl border md:row-span-2 md:h-full" : "relative aspect-video overflow-hidden rounded-xl border"}><Image src={image} alt={`${title} 截图 ${index + 1}`} fill sizes="(max-width: 768px) 100vw, 50vw" className="object-cover transition duration-300 hover:scale-[1.02]" /></button>)}</div>{active !== null && <div role="dialog" aria-modal="true" aria-label="截图预览" className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"><Button variant="ghost" size="icon" aria-label="关闭" onClick={() => setActive(null)} className="absolute right-4 top-4"><X /></Button><Button variant="secondary" size="icon" aria-label="上一张" onClick={() => setActive((active - 1 + images.length) % images.length)} className="absolute left-4"><ChevronLeft /></Button><div className="relative aspect-video w-full max-w-6xl"><Image src={images[active]} alt={`${title} 大图`} fill sizes="100vw" className="object-contain" /></div><Button variant="secondary" size="icon" aria-label="下一张" onClick={() => setActive((active + 1) % images.length)} className="absolute right-4"><ChevronRight /></Button></div>}</section>;
}
