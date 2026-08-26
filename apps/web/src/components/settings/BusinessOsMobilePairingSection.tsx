import type { CtoxMobileInviteCreateResult, EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { QrCodeIcon, RefreshCwIcon, ShieldXIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { businessOsMobileInviteEnvironment } from "../../state/businessOsMobileInvite";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { encodeWorkjetBusinessOsPairingLink, formatMobileInviteExpiry } from "./businessOsPairing";

const INVITE_TTL_SECONDS = 300;

function publicErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Die Pairing-Einladung ist fehlgeschlagen.";
}

export function BusinessOsMobilePairingSection({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly environmentLabel: string | null;
}) {
  const createInvite = useAtomCommand(businessOsMobileInviteEnvironment.create, {
    reportFailure: false,
  });
  const revokeInvite = useAtomCommand(businessOsMobileInviteEnvironment.revoke, {
    reportFailure: false,
  });
  const [invite, setInvite] = useState<CtoxMobileInviteCreateResult | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);
  const operationRef = useRef(false);

  const revokeCurrent = useCallback(async (): Promise<boolean> => {
    if (environmentId === null || invite === null || operationRef.current) return false;
    operationRef.current = true;
    setIsRevoking(true);
    const result = await revokeInvite({
      environmentId,
      input: { inviteId: invite.inviteId },
    });
    operationRef.current = false;
    setIsRevoking(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "QR-Code konnte nicht widerrufen werden",
          description: publicErrorMessage(squashAtomCommandFailure(result)),
        });
      }
      return false;
    }
    setInvite(null);
    return true;
  }, [environmentId, invite, revokeInvite]);

  const create = useCallback(async () => {
    if (environmentId === null || operationRef.current) return;
    if (invite !== null && !(await revokeCurrent())) return;
    operationRef.current = true;
    setIsCreating(true);
    const result = await createInvite({
      environmentId,
      input: { ttlSeconds: INVITE_TTL_SECONDS },
    });
    operationRef.current = false;
    setIsCreating(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "QR-Code konnte nicht erstellt werden",
          description: publicErrorMessage(squashAtomCommandFailure(result)),
        });
      }
      return;
    }
    setInvite(result.value);
  }, [createInvite, environmentId, invite, revokeCurrent]);

  const link = invite === null ? null : encodeWorkjetBusinessOsPairingLink(invite.invite);
  const disabled = environmentId === null || isCreating || isRevoking;

  return (
    <SettingsSection title="Mobiles Pairing">
      <SettingsRow
        title="Workjet mit diesem CTOX-Backend verbinden"
        description="Scanne in Workjet auf iOS oder Android einen kurzlebigen QR-Code. Verbindungs- und Zugangsdaten sind sicher enthalten; eine manuelle Eingabe ist nicht nötig."
        control={
          invite === null ? (
            <Button type="button" size="sm" onClick={() => void create()} disabled={disabled}>
              {isCreating ? <Spinner className="size-3.5" /> : <QrCodeIcon className="size-3.5" />}
              {isCreating ? "Wird erstellt…" : "QR-Code anzeigen"}
            </Button>
          ) : null
        }
      >
        {link !== null && invite !== null ? (
          <div className="flex flex-col gap-4 pb-4 pt-2 sm:flex-row sm:items-start">
            <div className="w-fit rounded-xl bg-white p-3 shadow-sm ring-1 ring-black/10">
              <QRCodeSvg
                value={link}
                size={220}
                level="M"
                marginSize={2}
                title={`Workjet mit ${invite.invite.display_name} verbinden`}
              />
            </div>
            <div className="min-w-0 space-y-3 text-sm">
              <div>
                <p className="font-medium text-foreground">{invite.invite.display_name}</p>
                <p className="text-muted-foreground">
                  Ausgewähltes Backend: {environmentLabel ?? "Verbundenes CTOX-Backend"}
                </p>
                <p className="text-muted-foreground">
                  Gültig bis {formatMobileInviteExpiry(invite.expiresAt)}
                </p>
              </div>
              <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                Behandle diesen QR-Code wie ein temporäres Passwort. Er läuft nach fünf Minuten ab
                und kann sofort widerrufen werden.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void create()}
                  disabled={disabled}
                >
                  {isCreating ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <RefreshCwIcon className="size-3.5" />
                  )}
                  Erneuern
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void revokeCurrent()}
                  disabled={disabled}
                >
                  {isRevoking ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <ShieldXIcon className="size-3.5" />
                  )}
                  Widerrufen
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Keine manuelle Verbindungskonfiguration"
        description="Workjet fragt weder nach Verbindungsserver, Kennung noch Passwort. Das CTOX-Backend erzeugt den vollständigen, widerrufbaren Handshake."
      />
    </SettingsSection>
  );
}
