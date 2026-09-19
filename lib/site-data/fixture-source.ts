import { games } from "../mock-data";
import type { Game } from "../../types/game";

export async function loadFixtureArtifact(): Promise<Game[]> {
  return games;
}
