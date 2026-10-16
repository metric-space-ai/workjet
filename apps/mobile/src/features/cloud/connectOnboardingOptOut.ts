import { loadPreferences, updatePreferences } from "../../persistence/imperative";

// Lives apart from connectOnboarding.ts so CloudAuthProvider (which imports
// the request signal) never pulls the persistence adapter into its
// module graph; that breaks CloudAuthProvider.test.ts suite loading.

/** Whether the account chose "Nicht mehr zeigen". */
export async function isConnectOnboardingOptedOut(accountId: string): Promise<boolean> {
  const preferences = await loadPreferences();
  return preferences.connectOnboardingOptOutAccounts?.includes(accountId) ?? false;
}

/** Persists "Nicht mehr zeigen" for the account. */
export async function optOutOfConnectOnboarding(accountId: string): Promise<void> {
  await updatePreferences((current) => {
    const optedOut = current.connectOnboardingOptOutAccounts ?? [];
    return optedOut.includes(accountId)
      ? {}
      : { connectOnboardingOptOutAccounts: [...optedOut, accountId] };
  });
}
