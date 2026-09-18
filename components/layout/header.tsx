import { loadPublishedArtifact } from "@/lib/site-data/source";
import { HeaderClient } from "./header-client";

export async function Header() {
  const { games } = await loadPublishedArtifact();
  return <HeaderClient games={games} />;
}
