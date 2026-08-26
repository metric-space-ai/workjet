import { describe, expect, it } from "vite-plus/test";

import { parseWorkjetPersonalizationMatrices } from "./WorkjetWorkerPersonalization";

describe("Workjet worker personalization matrices", () => {
  it("parses matrices with the exact expected dimensions and bounded weights", () => {
    expect(
      parseWorkjetPersonalizationMatrices("[[1, 0], [0, -1]]", "[[0, 0.2], [-0.5, 0]]", 2, 2),
    ).toEqual({
      metaToDetailWeights: [
        [1, 0],
        [0, -1],
      ],
      detailInfluenceWeights: [
        [0, 0.2],
        [-0.5, 0],
      ],
    });
  });

  it("rejects malformed dimensions and weights outside the interactive range", () => {
    expect(() => parseWorkjetPersonalizationMatrices("[[1]]", "[[0]]", 2, 2)).toThrow(
      "W must be 2 × 2",
    );
    expect(() =>
      parseWorkjetPersonalizationMatrices("[[1, 0], [0, 1]]", "[[0, 1.1], [0, 0]]", 2, 2),
    ).toThrow("weights from -1 to 1");
  });

  it("rejects JSON values that only coerce to numbers", () => {
    expect(() =>
      parseWorkjetPersonalizationMatrices('[[1, "0"], [0, 1]]', "[[0, 0], [0, 0]]", 2, 2),
    ).toThrow("weights from -1 to 1");
  });
});
