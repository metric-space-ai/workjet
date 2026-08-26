import type { AdvertisedEndpoint, WorkjetDeviceInviteCreateResult } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { QrCodeIcon, RefreshCwIcon, ShieldXIcon, SmartphoneIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import {
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { workjetDeviceInviteEnvironment } from "../../state/businessOsMobileInvite";
import { isQrShareableEndpoint } from "./ConnectionsSettings.logic";
import { encodeWorkjetDevicePairingLink, formatMobileInviteExpiry } from "./businessOsPairing";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

const INVITE_TTL_SECONDS = 300;
export const WORKJET_DEVICE_PAIRING_EVENT = "workjet:open-device-pairing";

export function openWorkjetDevicePairing(): void {
  window.dispatchEvent(new Event(WORKJET_DEVICE_PAIRING_EVENT));
}

function selectDevicePairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
): AdvertisedEndpoint | null {
  const shareable = endpoints.filter(isQrShareableEndpoint);
  return (
    shareable.find((endpoint) => endpoint.isDefault && endpoint.reachability !== "loopback") ??
    shareable.find((endpoint) => endpoint.reachability !== "loopback") ??
    shareable[0] ??
    null
  );
}

export function WorkjetDevicePairingDialog() {
  const [open, setOpen] = useState(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryEnvironment = usePrimaryEnvironment();
  const connectedBaseUrl = useEnvironmentHttpBaseUrl(primaryEnvironmentId);
  const desktopNetworkAccess = useEnvironmentQuery(
    typeof window !== "undefined" && window.desktopBridge ? desktopNetworkAccessStateAtom : null,
  );
  const endpoint = useMemo(
    () => selectDevicePairingEndpoint(desktopNetworkAccess.data?.advertisedEndpoints ?? []),
    [desktopNetworkAccess.data?.advertisedEndpoints],
  );
  const connectionUrl = endpoint?.httpBaseUrl ?? connectedBaseUrl;
  const loopbackOnly = useMemo(() => {
    if (!connectionUrl) return false;
    try {
      const hostname = new URL(connectionUrl).hostname;
      return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
    } catch {
      return true;
    }
  }, [connectionUrl]);

  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener(WORKJET_DEVICE_PAIRING_EVENT, handleOpen);
    return () => window.removeEventListener(WORKJET_DEVICE_PAIRING_EVENT, handleOpen);
  }, []);

  const createInvite = useAtomCommand(workjetDeviceInviteEnvironment.create, {
    reportFailure: false,
  });
  const revokeInvite = useAtomCommand(workjetDeviceInviteEnvironment.revoke, {
    reportFailure: false,
  });
  const [invite, setInvite] = useState<WorkjetDeviceInviteCreateResult | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const operationRef = useRef(false);

  const revokeCurrent = useCallback(async (): Promise<boolean> => {
    if (primaryEnvironmentId === null || invite === null || operationRef.current) return false;
    operationRef.current = true;
    setIsRevoking(true);
    const result = await revokeInvite({
      environmentId: primaryEnvironmentId,
      input: { inviteId: invite.inviteId },
    });
    operationRef.current = false;
    setIsRevoking(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "QR-Code konnte nicht widerrufen werden",
          description: "Bitte erneut versuchen. Technische Details findest du in der Diagnostik.",
        });
      }
      return false;
    }
    setInvite(null);
    return true;
  }, [invite, primaryEnvironmentId, revokeInvite]);

  const create = useCallback(async () => {
    if (
      primaryEnvironmentId === null ||
      connectionUrl === null ||
      loopbackOnly ||
      operationRef.current
    ) {
      return;
    }
    if (invite !== null && !(await revokeCurrent())) return;
    operationRef.current = true;
    setIsCreating(true);
    const result = await createInvite({
      environmentId: primaryEnvironmentId,
      input: { ttlSeconds: INVITE_TTL_SECONDS, connectionUrl },
    });
    operationRef.current = false;
    setIsCreating(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "QR-Code konnte nicht erstellt werden",
          description: "Bitte erneut versuchen. Technische Details findest du in der Diagnostik.",
        });
      }
      return;
    }
    setInvite(result.value);
  }, [connectionUrl, createInvite, invite, loopbackOnly, primaryEnvironmentId, revokeCurrent]);

  const encodedLink = useMemo(() => {
    if (invite === null) return { link: null, failed: false } as const;
    try {
      return { link: encodeWorkjetDevicePairingLink(invite.invite), failed: false } as const;
    } catch {
      return { link: null, failed: true } as const;
    }
  }, [invite]);
  const disabled =
    primaryEnvironmentId === null ||
    connectionUrl === null ||
    loopbackOnly ||
    isCreating ||
    isRevoking;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="w-[min(44rem,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <SmartphoneIcon className="size-5" aria-hidden />
            <DialogTitle>Mobilgerät verbinden</DialogTitle>
          </div>
          <DialogDescription>
            Ein QR-Code verbindet Workjet einmalig mit Code und Business OS. Code bleibt auf diesem
            Rechner auch ohne Mobilgerät vollständig nutzbar.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5 px-6 pb-6">
          {loopbackOnly ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm">
              Netzwerkzugriff ist noch nicht aktiviert. Öffne Einstellungen → Verbindungen und gib
              Workjet im lokalen Netzwerk oder über Tailscale frei.
            </div>
          ) : null}
          {invite === null ? (
            <Button type="button" onClick={() => void create()} disabled={disabled}>
              {isCreating ? <Spinner className="size-4" /> : <QrCodeIcon className="size-4" />}
              {isCreating ? "QR-Code wird erstellt…" : "QR-Code anzeigen"}
            </Button>
          ) : null}
          {encodedLink.failed && invite !== null ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm">
              Der QR-Code konnte nicht sicher erzeugt werden. Widerrufe die Einladung und versuche
              es erneut.
              <div className="mt-3">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void revokeCurrent()}
                  disabled={isRevoking}
                >
                  {isRevoking ? <Spinner className="size-3.5" /> : <ShieldXIcon />}
                  Widerrufen
                </Button>
              </div>
            </div>
          ) : null}
          {encodedLink.link !== null && invite !== null ? (
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
              <div className="w-fit rounded-xl bg-white p-3 shadow-sm ring-1 ring-black/10">
                <QRCodeSvg
                  value={encodedLink.link}
                  size={220}
                  level="M"
                  marginSize={2}
                  title={`Workjet mit ${invite.invite.business_os.display_name} verbinden`}
                />
              </div>
              <div className="min-w-0 space-y-3 text-sm">
                <div>
                  <p className="font-medium text-foreground">
                    {primaryEnvironment?.label ?? invite.invite.business_os.display_name}
                  </p>
                  <p className="text-muted-foreground">
                    CTOX Backend: {invite.invite.business_os.display_name}
                  </p>
                  <p className="text-muted-foreground">
                    Gültig bis {formatMobileInviteExpiry(invite.expiresAt)}
                  </p>
                </div>
                <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Der QR-Code ist fünf Minuten gültig. Er enthält die kurzlebigen, getrennt
                  berechtigten Zugänge für Code und Business OS und wird nicht gespeichert.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void create()}
                    disabled={disabled}
                  >
                    {isCreating ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
                    Erneuern
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void revokeCurrent()}
                    disabled={disabled}
                  >
                    {isRevoking ? <Spinner className="size-3.5" /> : <ShieldXIcon />}
                    Widerrufen
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
