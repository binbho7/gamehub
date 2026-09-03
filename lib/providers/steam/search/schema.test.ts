import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { steamSearchRawItemSchema, steamSearchRawResponseSchema } from "./schema";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), "test/fixtures/steam", name), "utf8"));
}

describe("Steam search raw schemas", () => {
  it("accepts app items and loose future fields", () => {
    expect(steamSearchRawResponseSchema.parse(fixture("search-success.json"))).toMatchObject({
      items: [{ id: 1245620, name: "ELDEN RING", type: "app" }],
    });
  });

  it("accepts mixed Store item types", () => {
    expect(() => steamSearchRawResponseSchema.parse(fixture("search-with-store-types.json"))).not.toThrow();
  });

  it("accepts extra fields and every total representation without consuming total", () => {
    expect(steamSearchRawResponseSchema.parse(fixture("search-extra-fields.json"))).toMatchObject({
      items: [{ id: 1245620 }],
    });

    for (const extra of [{}, { total: 1 }, { total: "1" }, { total: null }, { total: { future: true } }]) {
      expect(() => steamSearchRawResponseSchema.parse({ ...extra, items: [] })).not.toThrow();
    }
  });

  it("accepts tiny_image without URL semantics", () => {
    expect(() => steamSearchRawItemSchema.parse({ id: 1, name: "Example", type: "app", tiny_image: "not yet a URL" })).not.toThrow();
  });

  it.each([{}, { items: {} }, fixture("search-malformed.json")])("rejects missing or non-array items: %j", (value) => {
    expect(() => steamSearchRawResponseSchema.parse(value)).toThrow();
  });

  it.each([
    { id: 1, name: "", type: "app" },
    { id: 1, name: "Example", type: "" },
    { id: 1, name: "Example", type: "app", tiny_image: 42 },
  ])("rejects malformed item fields: %j", (value) => {
    expect(() => steamSearchRawItemSchema.parse(value)).toThrow();
  });

  it.each([1, 4_294_967_295])("accepts App ID boundary %s", (id) => {
    expect(() => steamSearchRawItemSchema.parse({ id, name: "Example", type: "app" })).not.toThrow();
  });

  it.each([0, 4_294_967_296, 1.5])("rejects invalid App ID %s", (id) => {
    expect(() => steamSearchRawItemSchema.parse({ id, name: "Example", type: "app" })).toThrow();
  });
});
