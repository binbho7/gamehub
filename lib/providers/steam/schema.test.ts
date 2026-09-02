import { describe, expect, it } from "vitest";
import malformedFixture from "../../../test/fixtures/steam/appdetails-malformed.json";
import validFixture from "../../../test/fixtures/steam/appdetails-valid.json";
import { steamAppDetailsBodySchema } from "./schema";

describe("Steam app-details raw schema", () => {
  it("accepts a representative game response and unconsumed provider fields", () => {
    expect(steamAppDetailsBodySchema.parse(validFixture)).toMatchObject({
      "1245620": {
        success: true,
        data: {
          type: "game",
          steam_appid: 1245620,
          name: "Elden Ring",
          unconsumed_provider_field: { can_change: true },
        },
      },
    });
  });

  it("rejects a changed consumed platform field", () => {
    expect(steamAppDetailsBodySchema.safeParse(malformedFixture).success).toBe(false);
  });
});
