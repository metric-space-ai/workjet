import type { DesktopUserDataMigrationOffer } from "@workjet/contracts";
import { FolderInputIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { InlineNoticePortal, InlineNoticeRow } from "../InlineNoticeSlot";
import { Button } from "../ui/button";

/**
 * One-time first-launch offer to import a compatible previous profile into the
 * historical user-data directory (docs/workjet-plan.md Wave 6).
 *
 * The decision itself lives in the main process (`DesktopUserDataMigration`):
 * this inline banner under the header (start view, no modal) only surfaces
 * the offer the bridge reports and forwards the user's answer. Accepting relaunches the app so the copy can run before the
 * Chromium profile is opened; declining is recorded durably and the offer is
 * never shown again. Without this prompt an upgraded install would boot into
 * an empty profile with no visible way to bring the paired CTOX instances
 * along — that silent break is exactly what the explicit offer prevents.
 */
export function UserDataMigrationNotice() {
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
        // the offer. Either way the banner is done.
        setOffer(null);
      })
      .catch((error: unknown) => {
        setIsResponding(false);
        setResponseError(error instanceof Error ? error.message : "unbekannter Fehler");
      });
  };

  return (
    <InlineNoticePortal>
      <UserDataMigrationBanner
        isResponding={isResponding}
        offer={offer}
        responseError={responseError}
        onRespond={respond}
      />
    </InlineNoticePortal>
  );
}

/** Presentational half: one line under the header, „Importieren“ and „Überspringen“. */
export function UserDataMigrationBanner({
  offer,
  isResponding,
  responseError,
  onRespond,
}: {
  readonly offer: Pick<DesktopUserDataMigrationOffer, "previousAttemptFailed">;
  readonly isResponding: boolean;
  readonly responseError: string | null;
  readonly onRespond: (accept: boolean) => void;
}) {
  const failed = responseError !== null || offer.previousAttemptFailed;
  const line =
    responseError !== null
      ? `Import fehlgeschlagen: ${responseError}`
      : offer.previousAttemptFailed
        ? "Profilimport unvollständig"
        : "Früheres Profil gefunden";

  return (
    <InlineNoticeRow
      data-user-data-migration-banner=""
      actions={
        <>
          <Button
            data-user-data-migration-accept=""
            disabled={isResponding}
            size="sm"
            type="button"
            onClick={() => onRespond(true)}
          >
            {failed ? "Erneut importieren" : "Importieren"}
          </Button>
          <Button
            data-user-data-migration-decline=""
            disabled={isResponding}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => onRespond(false)}
          >
            Überspringen
          </Button>
        </>
      }
      bodyClassName="min-w-[min(100%,18rem)]"
      className="flex-wrap"
      icon={failed ? TriangleAlertIcon : FolderInputIcon}
      label={line}
      tone={failed ? "destructive" : "neutral"}
    >
      <span className="min-w-0 break-words" role={failed ? "alert" : undefined}>
        {line}
      </span>
    </InlineNoticeRow>
  );
}
