import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import malformedEnvelopeFixture from "../../../test/fixtures/steam/appdetails-malformed-envelope.json";
import malformedFixture from "../../../test/fixtures/steam/appdetails-malformed.json";
import successFalseFixture from "../../../test/fixtures/steam/appdetails-success-false.json";
import validFixture from "../../../test/fixtures/steam/appdetails-valid.json";
import { parseSteamAppDetails } from "./response";

describe("Steam app-details response adapter", () => {
  it("returns the selected valid game details", () => {
    expect(parseSteamAppDetails(validFixture, "1245620")).toMatchObject({
      type: "game",
      steam_appid: 1245620,
    });
  });

  it("maps Steam success:false to app_not_found", () => {
    expect(() => parseSteamAppDetails(successFalseFixture, "999999999")).toThrowError(
      expect.objectContaining({ code: "app_not_found", retryable: false }),
    );
  });

  it("maps missing selected records to schema_changed without choosing another record", () => {
    expect(() => parseSteamAppDetails(validFixture, "999999999")).toThrowError(
      expect.objectContaining({ code: "schema_changed", retryable: false }),
    );
  });

  it("maps malformed consumed data to schema_changed", () => {
    expect(() => parseSteamAppDetails(malformedFixture, "1245620")).toThrowError(
      expect.objectContaining({ code: "schema_changed", retryable: false }),
    );
  });

  it("maps a malformed success envelope without data to schema_changed", () => {
    expect(() => parseSteamAppDetails(malformedEnvelopeFixture, "1245620")).toThrowError(
      expect.objectContaining({ code: "schema_changed", retryable: false }),
    );
  });

  it("maps a differing Steam App ID to app_id_mismatch", () => {
    const mismatchedFixture = structuredClone(validFixture);
    mismatchedFixture["1245620"].data.steam_appid = 1245621;

    expect(() => parseSteamAppDetails(mismatchedFixture, "1245620")).toThrowError(
      expect.objectContaining({ code: "app_id_mismatch", retryable: false }),
    );
  });

  it("maps valid non-game application types to unsupported_app_type", () => {
    const nonGameFixture = structuredClone(validFixture);
    nonGameFixture["1245620"].data.type = "dlc";

    expect(() => parseSteamAppDetails(nonGameFixture, "1245620")).toThrowError(
      expect.objectContaining({ code: "unsupported_app_type", retryable: false }),
    );
  });

  it("does not couple semantic response handling to the HTTP client", () => {
    const source = readFileSync(new URL("./response.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/import\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["']\.\/client["']/);
  });
});
