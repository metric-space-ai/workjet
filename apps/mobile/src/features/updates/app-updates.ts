export type AppUpdateCheckState = "idle" | "checking" | "downloading" | "restarting" | "current";

/** Workjet releases code only through signed store binaries. */
export function isAppUpdateCheckAvailable(): false {
  return false;
}

/** Kept as a stable UI boundary; it can never activate an OTA check. */
export function registerHiddenUpdateTap(count: number): {
  readonly nextCount: number;
  readonly shouldCheck: false;
} {
  return { nextCount: count + 1, shouldCheck: false };
}

export async function runAppUpdateCheck(): Promise<void> {}

export async function checkForAppUpdateOnLaunch(): Promise<void> {}
