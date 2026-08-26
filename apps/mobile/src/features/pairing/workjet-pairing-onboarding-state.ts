export interface WorkjetPairingOnboardingStateInput {
  readonly preferencesReady: boolean;
  readonly environmentRegistryReady: boolean;
  readonly businessOsRegistryReady: boolean;
  readonly onboardingDismissed: boolean;
  readonly pairedEnvironmentCount: number;
  readonly pairedBusinessOsInstanceCount: number;
}

export function shouldShowWorkjetPairingOnboarding(
  input: WorkjetPairingOnboardingStateInput,
): boolean {
  if (
    !input.preferencesReady ||
    !input.environmentRegistryReady ||
    !input.businessOsRegistryReady
  ) {
    return false;
  }
  if (input.onboardingDismissed) return false;
  return input.pairedEnvironmentCount === 0 || input.pairedBusinessOsInstanceCount === 0;
}
