"use client";

import { useState } from "react";
import type { PublishedSystemRequirements } from "@/lib/site-data/contracts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const labels: Record<keyof PublishedSystemRequirements["minimum"], string> = { os: "操作系统", cpu: "处理器", ram: "内存", gpu: "显卡", directX: "DirectX", storage: "存储空间" };

export function SystemRequirements({ requirements }: { requirements: PublishedSystemRequirements | null }) {
  const [tab, setTab] = useState<"minimum" | "recommended">("minimum");
  if (!requirements) return <section><h2 className="text-2xl font-semibold">系统配置</h2><p className="mt-6 rounded-xl border bg-card p-5 text-sm text-muted-foreground">暂无系统配置</p></section>;
  return <section><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><h2 className="text-2xl font-semibold">系统配置</h2><div className="flex rounded-lg border bg-muted p-1"><Button size="sm" variant={tab === "minimum" ? "secondary" : "ghost"} onClick={() => setTab("minimum")} className={cn("flex-1", tab === "minimum" && "text-foreground")}>最低配置</Button><Button size="sm" variant={tab === "recommended" ? "secondary" : "ghost"} onClick={() => setTab("recommended")} className={cn("flex-1", tab === "recommended" && "text-foreground")}>推荐配置</Button></div></div><dl className="mt-6 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">{(Object.keys(requirements[tab]) as Array<keyof PublishedSystemRequirements["minimum"]>).map((key) => <div key={key} className="bg-card p-5"><dt className="text-xs text-muted-foreground">{labels[key]}</dt><dd className="mt-2 text-sm leading-6">{requirements[tab][key]}</dd></div>)}</dl></section>;
}
