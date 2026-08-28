import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { decodeNativeDecisionHubNotification } from "./decision-hub-notification-payload";

const CHANNEL_ID = "decision-hub";
const delivered = new Set<string>();

export async function deliverDecisionHubNotification(input: {
  readonly storageIdentity: string;
  readonly payload: unknown;
}): Promise<boolean> {
  const notification = decodeNativeDecisionHubNotification(input.payload);
  if (!notification) return false;
  const dedupeId = `${input.storageIdentity}:${notification.tag ?? notification.recordId ?? notification.title}`;
  if (delivered.has(dedupeId)) return true;

  const permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted) return false;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Decision Hub",
      description: "Offene Entscheidungen aus Workjet Business OS",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      enableVibrate: true,
      vibrationPattern: [0, 250, 150, 250],
    });
  }

  await Notifications.scheduleNotificationAsync({
    identifier: `decision-hub:${dedupeId}`.slice(0, 240),
    content: {
      title: notification.title,
      body: notification.body,
      sound: "default",
      priority:
        notification.urgency === "critical"
          ? Notifications.AndroidNotificationPriority.MAX
          : Notifications.AndroidNotificationPriority.HIGH,
      interruptionLevel: notification.urgency === "critical" ? "timeSensitive" : "active",
      data: {
        kind: "decision_hub",
        businessOsStorageIdentity: input.storageIdentity,
        ...(notification.recordId ? { decisionId: notification.recordId } : {}),
      },
    },
    trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
  });
  delivered.add(dedupeId);
  if (delivered.size > 256) delivered.delete(delivered.values().next().value ?? "");
  return true;
}

export function configureNotificationPresentation(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}
