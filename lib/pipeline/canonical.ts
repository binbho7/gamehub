import { createHash } from "node:crypto";
import { parseInputManifest } from "./contracts";

function encode(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(encode).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => JSON.stringify(key) + ":" + encode(child)).join(",") + "}";
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Unsupported canonical value");
  return encoded;
}

export function canonicalizeManifest(value: unknown): string {
  return encode(parseInputManifest(value)) + "\n";
}

export function hashManifest(value: unknown): string {
  return createHash("sha256").update(canonicalizeManifest(value), "utf8").digest("hex");
}

export function deriveRunId(value: unknown): string {
  return "pipeline-v2.10:" + hashManifest(value);
}
