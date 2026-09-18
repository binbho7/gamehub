import type { R2ImageStore } from "./r2-store";
import { buildImageStorageKey } from "./storage-key";

export function createScheduledR2ImageStore(store: R2ImageStore): R2ImageStore {
  return {
    head: key => store.head(key),
    async ensureObject(input, context) {
      const conflict = { outcome: "storage_conflict" as const, storageKey: input.key, storageUrl: "" };
      if (input.mimeType !== "image/jpeg" && input.mimeType !== "image/png" && input.mimeType !== "image/webp") return conflict;
      let expected: string;
      try { expected = buildImageStorageKey(input.hash, input.mimeType); }
      catch { return conflict; }
      if (input.key !== expected) return conflict;
      return store.ensureObject(input, context);
    },
  };
}
