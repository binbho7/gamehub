"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Image from "next/image";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const GALLERY_PREVIEW_LIMIT = 5;

export function GameGallery({ images, title }: { images: string[]; title: string }) {
  const [active, setActive] = useState<number | null>(null);
  const activeTrigger = useRef<number | null>(null);
  const triggerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visibleImages = images.slice(0, GALLERY_PREVIEW_LIMIT);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (active === null) return;
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setActive((active + 1) % images.length);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActive((active - 1 + images.length) % images.length);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, images.length]);
  if (images.length === 0) return <section><h2 className="text-2xl font-semibold tracking-[-.02em]">游戏截图</h2><p className="mt-5 rounded-xl border border-white/[.08] bg-card/60 px-5 py-4 text-sm text-muted-foreground">当前公开资料未提供游戏截图。</p></section>;

  return <Dialog.Root open={active !== null} onOpenChange={(open) => { if (!open) setActive(null); }}>
    <section>
      <div className="flex items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold tracking-[-.02em]">游戏截图</h2><p className="mt-2 text-sm text-muted-foreground">浏览来自官方资料的游戏画面</p></div><span className="shrink-0 text-xs tabular-nums text-muted-foreground">{images.length} 张</span></div>
      <div className="mt-6 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4 lg:grid-rows-2">
        {visibleImages.map((image, index) => {
          const showsAllCount = index === visibleImages.length - 1 && images.length > GALLERY_PREVIEW_LIMIT;
          return <Dialog.Trigger key={image} asChild>
            <button ref={(node) => { triggerRefs.current[index] = node; }} type="button" data-gallery-trigger-index={index} aria-label={`打开第 ${index + 1} 张截图`} onClick={() => { activeTrigger.current = index; setActive(index); }} className={cn("group relative aspect-video overflow-hidden rounded-xl border border-white/10 bg-card text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary", index === 0 && "col-span-2 lg:row-span-2 lg:h-full")}>
              <Image src={image} alt={`${title} 截图 ${index + 1}`} fill sizes={index === 0 ? "(max-width: 1024px) 100vw, 50vw" : "(max-width: 640px) 50vw, 25vw"} className="object-cover transition duration-500 group-hover:scale-[1.025] motion-reduce:transition-none" />
              <span className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent opacity-0 transition group-hover:opacity-100 motion-reduce:transition-none" />
              {showsAllCount && <span className="absolute inset-0 flex items-center justify-center bg-black/58 px-3 text-center text-sm font-semibold text-white backdrop-blur-[2px]">查看全部 {images.length} 张</span>}
            </button>
          </Dialog.Trigger>;
        })}
      </div>
    </section>

    {active !== null && <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/92 backdrop-blur-md data-[state=closed]:animate-out data-[state=open]:animate-in motion-reduce:animate-none" />
      <Dialog.Content aria-describedby="gallery-dialog-description" onCloseAutoFocus={(event) => { event.preventDefault(); const index = activeTrigger.current; if (index !== null) triggerRefs.current[index]?.focus(); }} className="fixed inset-0 z-50 grid grid-rows-[auto_minmax(0,1fr)_auto] p-3 focus:outline-none sm:p-6">
        <Dialog.Title className="sr-only">{title} 截图预览</Dialog.Title>
        <Dialog.Description id="gallery-dialog-description" className="sr-only">使用左右方向键浏览截图，按 Escape 关闭预览。</Dialog.Description>
        <div className="flex items-center justify-between gap-4 text-white">
          <span aria-live="polite" className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium tabular-nums">{active + 1} / {images.length}</span>
          <Dialog.Close asChild><Button variant="ghost" size="icon" aria-label="关闭截图预览" className="bg-black/30 text-white hover:bg-white/15 hover:text-white"><X /></Button></Dialog.Close>
        </div>
        <div className="relative my-3 min-h-0 w-full sm:my-5">
          <Image src={images[active]} alt={`${title} 截图 ${active + 1}`} fill priority sizes="100vw" className="object-contain" />
        </div>
        <div className="flex items-center justify-center gap-4 pb-[max(.25rem,env(safe-area-inset-bottom))]">
          <Button variant="secondary" size="icon" aria-label="上一张截图" onClick={() => setActive((active - 1 + images.length) % images.length)} className="border border-white/10 bg-white/10 text-white hover:bg-white/20"><ChevronLeft /></Button>
          <span className="min-w-24 text-center text-xs text-white/65">方向键浏览</span>
          <Button variant="secondary" size="icon" aria-label="下一张截图" onClick={() => setActive((active + 1) % images.length)} className="border border-white/10 bg-white/10 text-white hover:bg-white/20"><ChevronRight /></Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>}
  </Dialog.Root>;
}
