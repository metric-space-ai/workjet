import { describe, expect, it } from "vite-plus/test";

import { shouldShowWorkjetPairingOnboarding } from "./workjet-pairing-onboarding-state";

const ready = {
  preferencesReady: true,
  environmentRegistryReady: true,
  businessOsRegistryReady: true,
  onboardingDismissed: false,
};

describe("Workjet pairing onboarding", () => {
  it("waits until all local registries are ready", () => {
    expect(
      shouldShowWorkjetPairingOnboarding({
        ...ready,
        preferencesReady: false,
        pairedEnvironmentCount: 0,
        pairedBusinessOsInstanceCount: 0,
      }),
    ).toBe(false);
  });

  it("requires one pairing to provision both Code and Business OS", () => {
    expect(
      shouldShowWorkjetPairingOnboarding({
        ...ready,
        pairedEnvironmentCount: 0,
        pairedBusinessOsInstanceCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldShowWorkjetPairingOnboarding({
        ...ready,
        pairedEnvironmentCount: 1,
        pairedBusinessOsInstanceCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldShowWorkjetPairingOnboarding({
        ...ready,
        pairedEnvironmentCount: 1,
        pairedBusinessOsInstanceCount: 1,
      }),
    ).toBe(false);
  });

  it("keeps local Code available when pairing is explicitly deferred", () => {
    expect(
      shouldShowWorkjetPairingOnboarding({
        ...ready,
        onboardingDismissed: true,
        pairedEnvironmentCount: 0,
        pairedBusinessOsInstanceCount: 0,
      }),
    ).toBe(false);
  });
});
