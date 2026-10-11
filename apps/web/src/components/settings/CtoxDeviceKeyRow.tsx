import type { CtoxControlDeviceStatus, DesktopCtoxBridge } from "@workjet/contracts";
import { useEffect, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

export function CtoxDeviceKeyRow({
  status,
  onReset,
  pending = false,
}: {
  readonly status: CtoxControlDeviceStatus;
  readonly onReset?: (() => void) | undefined;
  readonly pending?: boolean;
}) {
  const date = (value: string | null | undefined) =>
    value
      ? new Date(value).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })
      : "–";
  const notice =
    status.notice === "DEVICE_KEY_LIMIT_REACHED"
      ? "Geräteschlüssel-Limit erreicht"
      : status.notice === "DEVICE_FRESH_LOGIN_REQUIRED" || status.notice === "DEVICE_AUTH_REQUIRED"
        ? "Bei ctox.dev neu anmelden"
        : status.notice === undefined
          ? undefined
          : "Geräteschlüssel nicht verfügbar";
  return (
    <div
      className="flex min-w-0 items-center gap-3 border-b border-border px-3 py-3 text-[13px] sm:px-4"
      data-testid="ctox-device-key-row"
    >
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          Geräteschlüssel:{" "}
          {status.state === "active"
            ? `aktiv seit ${date(status.createdAt)}`
            : "nicht eingerichtet"}
        </div>
        {status.state === "active" && (
          <div className="mt-1 flex flex-wrap gap-x-4 text-muted-foreground">
            <span>zuletzt genutzt {date(status.lastUsedAt)}</span>
            <span>läuft ab {date(status.expiresAt)}</span>
          </div>
        )}
        {notice !== undefined && (
          <div className="mt-1 text-destructive" role="status">
            {notice}
          </div>
        )}
      </div>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Geräteschlüssel-Menü"
              disabled={pending || onReset === undefined}
            />
          }
        >
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={onReset}>Neu einrichten</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

export function CtoxDeviceKeySettings({ bridge }: { readonly bridge: DesktopCtoxBridge }) {
  const [status, setStatus] = useState<CtoxControlDeviceStatus>({ state: "not_configured" });
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let current = true;
    void bridge
      .deviceStatus?.()
      .then((value) => {
        if (current) setStatus(value);
      })
      .catch(() => {
        if (current) setStatus({ state: "not_configured", notice: "DEVICE_SERVICE_UNAVAILABLE" });
      });
    return () => {
      current = false;
    };
  }, [bridge]);
  const reset = async () => {
    if (bridge.resetDevice === undefined) return;
    setPending(true);
    try {
      setStatus(await bridge.resetDevice());
    } catch {
      setStatus({ state: "not_configured", notice: "DEVICE_SERVICE_UNAVAILABLE" });
    } finally {
      setPending(false);
    }
  };
  return (
    <CtoxDeviceKeyRow
      status={status}
      pending={pending}
      onReset={bridge.resetDevice === undefined ? undefined : () => void reset()}
    />
  );
}
