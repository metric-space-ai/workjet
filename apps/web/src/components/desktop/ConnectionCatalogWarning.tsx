import type { DesktopBridge } from "@workjet/contracts";
import { useEffect } from "react";
import { toastManager } from "../ui/toast";

export function subscribeConnectionCatalogWarning(
  bridge: Pick<DesktopBridge, "onConnectionCatalogWarning"> | undefined,
  notify: () => void,
) {
  let reported = false;
  return bridge?.onConnectionCatalogWarning?.(() => {
    if (reported) return;
    reported = true;
    notify();
  });
}

/** A catalog read failure is informational while local worker provisioning continues. */
export function ConnectionCatalogWarning() {
  useEffect(
    () =>
      subscribeConnectionCatalogWarning(window.desktopBridge, () => {
        toastManager.add({ type: "info", title: "Gespeicherte Verbindungen nicht lesbar" });
      }),
    [],
  );
  return null;
}
