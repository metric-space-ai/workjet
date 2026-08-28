// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { ModelCapabilities } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { workerReasoningSelections } from "./workerReasoning";

function caps(optionIds: ReadonlyArray<string>): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "effort",
        type: "select",
        label: "Effort",
        options: optionIds.map((id) => ({ id, label: id })),
      },
    ],
  } as never);
}

describe("applying a worker's reasoning only where the provider offers it", () => {
  it("selects the matching option", () => {
    const selections = workerReasoningSelections({
      caps: caps(["low", "medium", "high"]),
      reasoning: "high",
    });

    expect(selections?.find((selection) => selection.id === "effort")?.value).toBe("high");
  });

  it("matches without caring about case", () => {
    expect(
      workerReasoningSelections({ caps: caps(["low", "High"]), reasoning: "HIGH" })?.find(
        (selection) => selection.id === "effort",
      )?.value,
    ).toBe("High");
  });

  it("refuses to pick a neighbour when the provider has no such effort", () => {
    // "max" onto "high" because both sound large would silently run the turn
    // at an effort nobody chose, and cost real money doing it. The provider's
    // own default is at least visible in the bar.
    expect(workerReasoningSelections({ caps: caps(["low", "high"]), reasoning: "max" })).toBeNull();
  });

  it("treats automatic as 'do not force one'", () => {
    expect(
      workerReasoningSelections({ caps: caps(["low", "high"]), reasoning: "automatic" }),
    ).toBeNull();
    expect(workerReasoningSelections({ caps: caps(["low"]), reasoning: "  " })).toBeNull();
  });

  it("does nothing for a model with no effort control at all", () => {
    expect(
      workerReasoningSelections({
        caps: createModelCapabilities({ optionDescriptors: [] } as never),
        reasoning: "high",
      }),
    ).toBeNull();
  });
});
