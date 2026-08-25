import { describe, expect, it } from "vite-plus/test";

import { buildWorkjetUrl, isBusinessOsPairLink, normalizeIncomingWorkjetUrl } from "./workjetLinks";

describe("Workjet links", () => {
  it("only generates canonical Workjet schemes", () => {
    expect(
      buildWorkjetUrl("pair", { query: new URLSearchParams([["pairingUrl", "https://host"]]) }),
    ).toBe("workjet://pair?pairingUrl=https%3A%2F%2Fhost");
    expect(buildWorkjetUrl("pair", { variant: "development" })).toBe("workjet-dev://pair");
    expect(buildWorkjetUrl("pair", { variant: "preview" })).toBe("workjet-preview://pair");
  });

  it.each([
    ["ctox-mobile://pair?pairingUrl=x", "workjet://pair?pairingUrl=x"],
    ["ctox-mobile-dev://pair?pairingUrl=x", "workjet-dev://pair?pairingUrl=x"],
    ["ctox-mobile-preview://pair?pairingUrl=x", "workjet-preview://pair?pairingUrl=x"],
    ["t3code://pair?pairingUrl=x", "workjet://pair?pairingUrl=x"],
    ["t3code-dev://pair?pairingUrl=x", "workjet-dev://pair?pairingUrl=x"],
    ["t3code-preview://pair?pairingUrl=x", "workjet-preview://pair?pairingUrl=x"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeIncomingWorkjetUrl(input)).toBe(expected);
  });

  it("normalizes the standalone Business OS prototype link without decoding its credential", () => {
    expect(
      normalizeIncomingWorkjetUrl("ctox-business-os-mobile://pair?payload=opaque-credential"),
    ).toBe("workjet://business-os/pair?payload=opaque-credential");
    expect(isBusinessOsPairLink("ctox-business-os-mobile://pair?payload=opaque-credential")).toBe(
      true,
    );
  });

  it("preserves unsupported legacy components for fail-closed validation", () => {
    expect(
      normalizeIncomingWorkjetUrl(
        "ctox-business-os-mobile://pair?payload=opaque-credential&debug=true#fragment",
      ),
    ).toBe("workjet://business-os/pair?payload=opaque-credential&debug=true#fragment");
  });

  it("leaves unknown and malformed links untouched", () => {
    expect(normalizeIncomingWorkjetUrl("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(normalizeIncomingWorkjetUrl("not a url")).toBe("not a url");
  });
});
