import Constants from "expo-constants";

export function supportsAgentAwarenessPush() {
  return Constants.expoConfig?.extra?.iosPersonalTeamBuild !== true;
}

export function supportsAgentAwarenessLiveActivities() {
  // The former Expo widget / Live Activity target was removed. Activity
  // registration remains fail-closed until a separately signed and reviewed
  // native target is introduced again.
  return false;
}
