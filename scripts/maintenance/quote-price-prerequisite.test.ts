import { describe, expect, it } from "vitest";
import { quotePricePrerequisite } from "./quote-price-prerequisite";

describe("quote price prerequisite", () => {
  it("reports missing authentication without disclosing a credential", () => {
    expect(quotePricePrerequisite(" ")).toMatchObject({ authenticationConfigured: false,
      reason: expect.stringContaining("PYTH_API_KEY") });
    expect(quotePricePrerequisite("test-only")).toEqual({ authenticationConfigured: true });
  });
});
