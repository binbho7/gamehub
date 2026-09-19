import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PublishedArtifact } from "./contracts";
import { validateArtifact } from "./validation";

type ReadText = () => Promise<string | undefined>;

let defaultArtifactPromise: Promise<PublishedArtifact> | undefined;

async function loadFrom(readText: ReadText): Promise<PublishedArtifact> {
  const raw = await readText();
  if (raw === undefined) throw new Error("Published site-data artifact is missing");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Published site-data artifact is malformed JSON");
  }
  return validateArtifact(value);
}

export async function loadPublishedArtifact(options: { readText?: ReadText } = {}): Promise<PublishedArtifact> {
  if (options.readText) return loadFrom(options.readText);
  if (!defaultArtifactPromise) {
    defaultArtifactPromise = loadFrom(async () => readFile(resolve("generated/site-data.json"), "utf8"))
      .catch((error) => {
        defaultArtifactPromise = undefined;
        throw error;
      });
  }
  return defaultArtifactPromise;
}
