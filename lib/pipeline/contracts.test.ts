import { describe, expect, it } from "vitest";
import validManifestJson from "../../content/manifests/v2-10-example.json";
import validSelectionJson from "../../content/publication-selections/v2-10-example.json";
import {
  parseInputManifest,
  parsePublicationSelection,
  type InputManifest,
} from "./contracts";

const MANIFEST_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function validManifest(): unknown {
  return structuredClone(validManifestJson);
}

function parsedManifest(): InputManifest {
  return parseInputManifest(validManifest());
}

function validSelection(): unknown {
  return structuredClone(validSelectionJson);
}

function parseSelection(value: unknown) {
  return parsePublicationSelection(value, {
    manifest: parsedManifest(),
    manifestHash: MANIFEST_HASH,
  });
}

describe("parseInputManifest", () => {
  it("accepts the reviewed valid example", () => {
    expect(parseInputManifest(validManifest())).toEqual(validManifestJson);
  });

  it("rejects unknown top-level and item fields", () => {
    expect(() => parseInputManifest({ ...validManifestJson, title: "forbidden" })).toThrow();
    const value = validManifest() as typeof validManifestJson;
    expect(() => parseInputManifest({
      ...value,
      items: [{ ...value.items[0], url: "https://example.com" }, value.items[1]],
    })).toThrow();
  });

  it.each(["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10"])(
    "rejects invalid calendar date %s",
    (snapshotDate) => expect(() => parseInputManifest({ ...validManifestJson, snapshotDate })).toThrow(),
  );

  it.each(["2026-09-19T00:00:00Z", " 2026-09-19", "2026-09-19 "])(
    "rejects non-exact date %s",
    (snapshotDate) => expect(() => parseInputManifest({ ...validManifestJson, snapshotDate })).toThrow(),
  );

  it("rejects ordinal gaps", () => {
    expect(() => parseInputManifest({
      ...validManifestJson,
      items: [{ ordinal: 1, steamAppId: "1245620" }, { ordinal: 3, steamAppId: "292030" }],
    })).toThrow();
  });

  it("rejects duplicate ordinals", () => {
    expect(() => parseInputManifest({
      ...validManifestJson,
      items: [{ ordinal: 1, steamAppId: "1245620" }, { ordinal: 1, steamAppId: "292030" }],
    })).toThrow();
  });

  it("rejects out-of-order ordinals", () => {
    expect(() => parseInputManifest({
      ...validManifestJson,
      items: [{ ordinal: 2, steamAppId: "1245620" }, { ordinal: 1, steamAppId: "292030" }],
    })).toThrow();
  });

  it.each(["0", "-1", "+1", "1.5", "abc", "", " 1"])(
    "rejects invalid Steam App ID %j",
    (steamAppId) => expect(() => parseInputManifest({
      ...validManifestJson,
      items: [{ ordinal: 1, steamAppId }],
    })).toThrow(),
  );

  it("rejects leading-zero Steam App IDs", () => {
    expect(() => parseInputManifest({
      ...validManifestJson,
      items: [{ ordinal: 1, steamAppId: "01245620" }],
    })).toThrow();
  });

  it("rejects duplicate Steam App IDs", () => {
    expect(() => parseInputManifest({
      ...validManifestJson,
      items: [{ ordinal: 1, steamAppId: "1245620" }, { ordinal: 2, steamAppId: "1245620" }],
    })).toThrow();
  });

  it("rejects an empty item list", () => {
    expect(() => parseInputManifest({ ...validManifestJson, items: [] })).toThrow();
  });

  it("rejects more than 1000 items", () => {
    const items = Array.from({ length: 1001 }, (_, index) => ({
      ordinal: index + 1,
      steamAppId: String(index + 1),
    }));
    expect(() => parseInputManifest({ ...validManifestJson, items })).toThrow();
  });
});

describe("parsePublicationSelection", () => {
  it("accepts the reviewed valid selection", () => {
    expect(parseSelection(validSelection())).toEqual(validSelectionJson);
  });

  it("rejects unknown top-level and item fields", () => {
    expect(() => parseSelection({ ...validSelectionJson, note: "forbidden" })).toThrow();
    expect(() => parseSelection({
      ...validSelectionJson,
      items: [{ ...validSelectionJson.items[0], timestamp: "2026-09-19" }, validSelectionJson.items[1]],
    })).toThrow();
  });

  it("rejects invalid decisions", () => {
    expect(() => parseSelection({
      ...validSelectionJson,
      items: [{ steamAppId: "1245620", decision: "publish" }, validSelectionJson.items[1]],
    })).toThrow();
  });

  it("rejects duplicate Steam App IDs", () => {
    expect(() => parseSelection({
      ...validSelectionJson,
      items: [
        { steamAppId: "1245620", decision: "include" },
        { steamAppId: "1245620", decision: "exclude" },
      ],
    })).toThrow();
  });

  it("rejects a missing manifest ID", () => {
    expect(() => parseSelection({
      ...validSelectionJson,
      items: [validSelectionJson.items[0]],
    })).toThrow();
  });

  it("rejects an extra manifest ID", () => {
    expect(() => parseSelection({
      ...validSelectionJson,
      items: [...validSelectionJson.items, { steamAppId: "570", decision: "exclude" }],
    })).toThrow();
  });

  it("rejects a manifest hash mismatch", () => {
    expect(() => parseSelection({ ...validSelectionJson, manifestHash: "f".repeat(64) })).toThrow();
  });

  it("rejects a pipeline version mismatch", () => {
    expect(() => parseSelection({ ...validSelectionJson, pipelineVersion: "2.11" })).toThrow();
  });

  it("rejects a policy version mismatch", () => {
    expect(() => parseSelection({ ...validSelectionJson, policyVersion: "other-policy" })).toThrow();
  });

  it("rejects a snapshot date mismatch", () => {
    expect(() => parseSelection({ ...validSelectionJson, snapshotDate: "2026-09-20" })).toThrow();
  });

  it("rejects noncanonical Steam IDs and malformed hashes", () => {
    expect(() => parseSelection({
      ...validSelectionJson,
      items: [{ steamAppId: "01245620", decision: "include" }, validSelectionJson.items[1]],
    })).toThrow();
    expect(() => parseSelection({ ...validSelectionJson, manifestHash: "A".repeat(64) })).toThrow();
  });
});
