import { describe, expect, it } from "@effect/vitest";

import { normalizeMembershipEnvironmentIds } from "./BusinessOsMemberships.ts";

describe("Business OS Relay membership", () => {
  it("represents zero, one, or many environments deterministically", () => {
    expect(normalizeMembershipEnvironmentIds([])).toEqual([]);
    expect(normalizeMembershipEnvironmentIds(["macbook"])).toEqual(["macbook"]);
    expect(normalizeMembershipEnvironmentIds(["gpu3", "macbook"])).toEqual(["gpu3", "macbook"]);
  });

  it("rejects duplicate environment identifiers", () => {
    expect(normalizeMembershipEnvironmentIds(["macbook", "macbook"])).toBeNull();
  });
});
