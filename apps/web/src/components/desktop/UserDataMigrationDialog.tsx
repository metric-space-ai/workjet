import type { DesktopUserDataMigrationOffer } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/**
 * One-time first-launch offer to import a compatible previous profile into the
 * historical user-data directory (docs/workjet-plan.md Wave 6).
 *
 * The decision itself lives in the main process (`DesktopUserDataMigration`):
 * this dialog only surfaces the offer the bridge reports and forwards the
 * user's answer. Accepting relaunches the app so the copy can run before the
 * Chromium profile is opened; declining is recorded durably and the offer is
 * never shown again. Without this prompt an upgraded install would boot into
 * an empty profile with no visible way to bring the paired CTOX instances
 * along — that silent break is exactly what the explicit offer prevents.
 */
export function UserDataMigrationDialog() {
  const [offer, setOffer] = useState<DesktopUserDataMigrationOffer | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.getUserDataMigrationOffer) return;
    let cancelled = false;
    void bridge
      .getUserDataMigrationOffer()
      .then((pendingOffer) => {
        if (!cancelled && pendingOffer) setOffer(pendingOffer);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!offer) return null;

  const respond = (accept: boolean) => {
    const bridge = window.desktopBridge;
    const method = accept ? bridge?.acceptUserDataMigration : bridge?.declineUserDataMigration;
    if (!method || isResponding) return;
    setIsResponding(true);
    setResponseError(null);
    void method()
      .then(() => {
        // Accept relaunches the app from the main process; decline just ends
        // the offer. Either way the dialog is done.
        setOffer(null);
      })
      .catch((error: unknown) => {
        setIsResponding(false);
        setResponseError(error instanceof Error ? error.message : "The migration request failed.");
      });
  };

  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogPopup data-user-data-migration-dialog>
        <DialogPanel>
          <DialogHeader>
            <DialogTitle>Import your existing profile?</DialogTitle>
            <DialogDescription>
              A compatible previous profile was found. Importing copies your settings and the
              pairings for connected CTOX instances into Workjet; the app restarts once to apply it.
              The old profile is left untouched. If you skip this, you start with an empty profile
              and this offer will not appear again.
            </DialogDescription>
          </DialogHeader>
          {responseError ? (
            <p className="text-destructive text-sm" role="alert">
              {responseError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={isResponding}
              onClick={() => respond(false)}
            >
              Start fresh
            </Button>
            <Button type="button" disabled={isResponding} onClick={() => respond(true)}>
              Import and restart
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
