"use client";

import { useState } from "react";
import type { RequirementSet } from "@/types/game";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const labels: Record<keyof RequirementSet, string> = { os: "操作系统", cpu: "处理器", ram: "内存", gpu: "显卡", directX: "DirectX", storage: "存储空间" };

export function SystemRequirements({ requirements }: { requirements: { minimum: RequirementSet; recommended: RequirementSet } }) {
  const [tab, setTab] = useState<"minimum" | "recommended">("minimum");
  return <section><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><h2 className="text-2xl font-semibold">系统配置</h2><div className="flex rounded-lg border bg-muted p-1"><Button size="sm" variant={tab === "minimum" ? "secondary" : "ghost"} onClick={() => setTab("minimum")} className={cn("flex-1", tab === "minimum" && "text-foreground")}>最低配置</Button><Button size="sm" variant={tab === "recommended" ? "secondary" : "ghost"} onClick={() => setTab("recommended")} className={cn("flex-1", tab === "recommended" && "text-foreground")}>推荐配置</Button></div></div><dl className="mt-6 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">{Object.entries(requirements[tab]).map(([key, value]) => <div key={key} className="bg-card p-5"><dt className="text-xs text-muted-foreground">{labels[key as keyof RequirementSet]}</dt><dd className="mt-2 text-sm leading-6">{value}</dd></div>)}</dl></section>;
}
