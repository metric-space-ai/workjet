import type { RelayClientDeviceRecord } from "@workjet/contracts/relay";

const mobileClientUpdatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const NOTIFICATION_PREFERENCES = [
  ["notifyOnApproval", "Freigaben"],
  ["notifyOnInput", "Rückfragen"],
  ["notifyOnCompletion", "Abschlüsse"],
  ["notifyOnFailure", "Fehler"],
] as const satisfies ReadonlyArray<
  readonly [keyof RelayClientDeviceRecord["notifications"], string]
>;

export function mobileClientPlatformLabel(device: RelayClientDeviceRecord): string {
  return `iOS ${device.iosMajorVersion}${device.appVersion ? ` · CTOX ${device.appVersion}` : ""}`;
}

export function mobileClientNotificationDetail(device: RelayClientDeviceRecord): string {
  if (!device.notifications.enabled) {
    return "Mitteilungen aus";
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) =>
    device.notifications[preference] ? [label] : [],
  );
  return enabledPreferences.length > 0
    ? `Mitteilungen: ${enabledPreferences.join(", ")}`
    : "Mitteilungen an, keine Arten gewählt";
}

export function mobileClientUpdatedAtLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? "—"
    : `Aktualisiert ${mobileClientUpdatedAtFormatter.format(date)}`;
}
