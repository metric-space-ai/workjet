import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        iosPersonalTeamBuild: false,
      },
    },
  },
}));

import { supportsAgentAwarenessLiveActivities, supportsAgentAwarenessPush } from "./capabilities";

describe("agent-awareness native capabilities", () => {
  it("keeps Live Activities disabled when no signed widget target ships", () => {
    expect(supportsAgentAwarenessLiveActivities()).toBe(false);
  });

  it("keeps ordinary APNs notifications independent from the removed widget", () => {
    expect(typeof supportsAgentAwarenessPush()).toBe("boolean");
  });
});
