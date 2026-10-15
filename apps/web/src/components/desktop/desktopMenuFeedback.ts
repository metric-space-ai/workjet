import type { DesktopBridge } from "@workjet/contracts";

import { toastManager } from "../ui/toast";

/**
 * Rückmeldungen der nativen Menüleiste als einzeiliger Toast in der App statt
 * als nativer Dialog (Owner-Regel: nichts außerhalb der App). Die Aktions-IDs
 * spiegeln `DESKTOP_MENU_FEEDBACK` in apps/desktop/src/window/DesktopApplicationMenu.ts.
 */
export const DESKTOP_MENU_FEEDBACK_ACTIONS = {
  updateUpToDate: "update-up-to-date",
  updateCheckFailed: "update-check-failed",
  updatesUnavailable: "updates-unavailable",
  supportBundleCreated: "support-bundle-created",
  supportBundleFailed: "support-bundle-failed",
} as const;

type MenuFeedbackBridge = Pick<DesktopBridge, "checkForUpdate">;

function retryUpdateCheck(bridge: MenuFeedbackBridge | undefined): void {
  if (!bridge) return;
  void (async () => {
    try {
      const result = await bridge.checkForUpdate();
      if (result.state.status === "up-to-date") {
        handleDesktopMenuFeedback(DESKTOP_MENU_FEEDBACK_ACTIONS.updateUpToDate, bridge);
        return;
      }
      if (result.state.status !== "error") return;
    } catch {
      // Abgelehnter IPC-Aufruf: gleiche Fehlerzeile wie ein fehlgeschlagener Check.
    }
    handleDesktopMenuFeedback(DESKTOP_MENU_FEEDBACK_ACTIONS.updateCheckFailed, bridge);
  })();
}

/** Zeigt die Rückmeldung zu einer Menüaktion; `false`, wenn die Aktion keine Rückmeldung ist. */
export function handleDesktopMenuFeedback(
  action: string,
  bridge: MenuFeedbackBridge | undefined,
): boolean {
  switch (action) {
    case DESKTOP_MENU_FEEDBACK_ACTIONS.updateUpToDate:
      toastManager.add({ type: "success", title: "Workjet ist aktuell" });
      return true;
    case DESKTOP_MENU_FEEDBACK_ACTIONS.updateCheckFailed:
      toastManager.add({
        type: "error",
        title: "Update-Prüfung fehlgeschlagen",
        ...(bridge
          ? { actionProps: { children: "Erneut prüfen", onClick: () => retryUpdateCheck(bridge) } }
          : {}),
      });
      return true;
    case DESKTOP_MENU_FEEDBACK_ACTIONS.updatesUnavailable:
      toastManager.add({ type: "info", title: "Updates hier nicht verfügbar" });
      return true;
    case DESKTOP_MENU_FEEDBACK_ACTIONS.supportBundleCreated:
      toastManager.add({ type: "success", title: "Support-Paket gespeichert, Pfad kopiert" });
      return true;
    case DESKTOP_MENU_FEEDBACK_ACTIONS.supportBundleFailed:
      toastManager.add({ type: "error", title: "Support-Paket nicht gespeichert" });
      return true;
    default:
      return false;
  }
}
