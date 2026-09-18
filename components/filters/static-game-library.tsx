"use client";
import { useEffect, useState, type ComponentProps } from "react";
import { GameLibrary } from "./game-library";
import { parseGameFilters } from "@/lib/static-query";
export function StaticGameLibrary(props: Omit<ComponentProps<typeof GameLibrary>, "initial">) {
  const [initial, setInitial] = useState<NonNullable<ComponentProps<typeof GameLibrary>["initial"]> | null>(null);
  useEffect(() => {
    const read = () => setInitial(parseGameFilters(new URLSearchParams(window.location.search)));
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  return initial ? <GameLibrary {...props} initial={initial} /> : null;
}
