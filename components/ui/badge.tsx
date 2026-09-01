import * as React from "react";
import { cn } from "@/lib/utils";

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("inline-flex items-center rounded-md border border-[#31543f] bg-[#14271d] px-2 py-0.5 text-xs font-medium text-[#83d6a0]", className)} {...props} />;
}
