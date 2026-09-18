import { describe, expect, it, vi } from "vitest";
import { createScheduledR2ImageStore } from "./scheduled-r2-store";

const hash = "a".repeat(64);
const input = { key: `images/sha256/aa/aa/${hash}.png`, bytes: new Uint8Array([1]), hash, mimeType: "image/png", size: 1 };

describe("scheduled immutable R2 keys", () => {
  it.each([
    { key: "covers/current.png" },
    { key: `images/sha256/bb/aa/${hash}.png` },
    { key: `images/sha256/aa/aa/${hash}.jpg` },
    { hash: "b".repeat(64) },
    { hash: "A".repeat(64) },
    { hash: "invalid" },
    { mimeType: "image/gif" },
    { mimeType: "toString" },
  ])("rejects a noncanonical write before any storage access: %j", async override => {
    const head = vi.fn();
    const ensureObject = vi.fn().mockResolvedValue({ outcome: "created", storageKey: input.key, storageUrl: "https://images.example.test/unsafe" });
    const request = { ...input, ...override };
    await expect(createScheduledR2ImageStore({ head, ensureObject }).ensureObject(request)).resolves.toEqual({ outcome: "storage_conflict", storageKey: request.key, storageUrl: "" });
    expect(head).not.toHaveBeenCalled();
    expect(ensureObject).not.toHaveBeenCalled();
  });

  it.each([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"]])("passes canonical %s writes and their deadline context unchanged", async (mimeType, extension) => {
    const request = { ...input, mimeType, key: `images/sha256/aa/aa/${hash}.${extension}` };
    const result = { outcome: "created" as const, storageKey: request.key, storageUrl: `https://images.example.test/${request.key}` };
    const ensureObject = vi.fn().mockResolvedValue(result);
    const context = { signal: new AbortController().signal, deadlineAt: 100, now: () => 0 };
    await expect(createScheduledR2ImageStore({ head: vi.fn(), ensureObject }).ensureObject(request, context)).resolves.toBe(result);
    expect(ensureObject).toHaveBeenCalledExactlyOnceWith(request, context);
  });

  it("allows read-only inspection of a legacy alias", async () => {
    const head = vi.fn().mockResolvedValue({ exists: false });
    await expect(createScheduledR2ImageStore({ head, ensureObject: vi.fn() }).head("covers/current.png")).resolves.toEqual({ exists: false });
    expect(head).toHaveBeenCalledExactlyOnceWith("covers/current.png");
  });
});
