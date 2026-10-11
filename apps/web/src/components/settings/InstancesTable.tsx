import { useState } from "react";
import type { CtoxManagedInstance } from "@workjet/contracts";
import { Trash2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { ctoxInstanceDisplayTitle } from "../ctox/ctoxInstanceDisplayTitle";
import { canActivateCtoxInstance } from "../ctox/CtoxModeShell";
import { openInstanceSetup } from "../../instanceSetup";

export const INSTANCE_LIST_TEXT = {
  de: {
    selected: "Ausgewählt",
    select: "Auswählen",
    enabled: "Aktiv",
    disabled: "Instanz deaktiviert",
    removed: "Instanz entfernt",
    selectedReason: "Wechsle zuerst die ausgewählte Instanz, um sie zu deaktivieren.",
    remove: "Aus Workjet entfernen",
    confirm: "Entfernen",
    cancel: "Abbrechen",
    removal:
      "Entfernt nur die Verbindung in diesem Workjet. Die CTOX-Instanz und ihre Daten bleiben unverändert.",
    pair: "Neu koppeln",
    connected: "Verbunden",
    available: "Verfügbar",
    offline: "Die Instanz ist nicht erreichbar.",
    expired: "Die Geräteberechtigung ist abgelaufen.",
    auth: "Eine Anmeldung an der Instanz ist erforderlich.",
    failed: "Die Verbindung ist fehlgeschlagen. Ein genauer Grund ist noch nicht verfügbar.",
    pending: "Die Instanz wird eingerichtet.",
    error: "Die Änderung konnte nicht gespeichert werden. Bitte erneut versuchen.",
  },
  en: {
    selected: "Selected",
    select: "Select",
    enabled: "Enabled",
    disabled: "Instance disabled",
    removed: "Instance removed",
    selectedReason: "Select another instance before disabling this one.",
    remove: "Remove from Workjet",
    confirm: "Remove",
    cancel: "Cancel",
    removal:
      "Only removes the connection in this Workjet. The CTOX instance and its data stay unchanged.",
    pair: "Pair again",
    connected: "Connected",
    available: "Available",
    offline: "The instance is unreachable.",
    expired: "Device authorization has expired.",
    auth: "Sign in to the instance to connect.",
    failed: "The connection failed. Its cause is not available yet.",
    pending: "The instance is being set up.",
    error: "The change could not be saved. Please try again.",
  },
};

export function InstancesTable({
  instances,
  activeInstanceId,
  language = "en",
  onSelect,
  onStateChange,
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly activeInstanceId: string | null;
  readonly language?: "de" | "en";
  readonly onSelect?: ((id: string) => void | Promise<boolean>) | undefined;
  readonly onStateChange?:
    | ((
        instance: CtoxManagedInstance,
        state: "enabled" | "disabled" | "removed",
      ) => Promise<string | null>)
    | undefined;
}) {
  const text = INSTANCE_LIST_TEXT[language];
  const [pending, setPending] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = async (
    instance: CtoxManagedInstance,
    state: "enabled" | "disabled" | "removed",
  ) => {
    if (onStateChange === undefined || (state === "disabled" && instance.id === activeInstanceId))
      return;
    setPending(instance.id);
    setError(null);
    try {
      const failure = await onStateChange(instance, state);
      if (failure === null) setConfirmation(null);
      else setError(failure);
    } catch {
      setError(text.error);
    } finally {
      setPending(null);
    }
  };
  const choose = async (id: string) => {
    if (onSelect === undefined) return;
    setPending(id);
    setError(null);
    try {
      if ((await onSelect(id)) === false) setError(text.error);
    } catch {
      setError(text.error);
    } finally {
      setPending(null);
    }
  };
  return (
    <div>
      <ul aria-label="CTOX instances" className="divide-y divide-border/60">
        {instances
          .filter((instance) => instance.workjetState !== "removed")
          .map((instance) => {
            const selected = instance.id === activeInstanceId;
            const enabled = (instance.workjetState ?? "enabled") === "enabled";
            const name = ctoxInstanceDisplayTitle(instance);
            const reason = !enabled
              ? text.disabled
              : instance.status === "offline"
                ? text.offline
                : instance.status === "pairing_expired"
                  ? text.expired
                  : instance.status === "needs_auth"
                    ? text.auth
                    : instance.status === "error"
                      ? text.failed
                      : instance.status === "installing"
                        ? text.pending
                        : instance.healthSummary.dataPlaneReady
                          ? text.connected
                          : text.available;
            return (
              <li
                key={instance.id}
                data-workjet-instance-row={instance.id}
                className="px-3 py-2 sm:px-4"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">
                    {name}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    {selected ? (
                      <span className="text-xs text-primary" aria-label={text.selected}>
                        {text.selected}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          pending !== null ||
                          !enabled ||
                          !canActivateCtoxInstance(instance) ||
                          onSelect === undefined
                        }
                        onClick={() => void choose(instance.id)}
                      >
                        {text.select}
                      </Button>
                    )}
                    <label
                      className="flex items-center gap-1.5 text-xs"
                      title={selected ? text.selectedReason : undefined}
                    >
                      <Switch
                        aria-label={text.enabled + " · " + name}
                        checked={enabled}
                        disabled={selected || pending !== null || onStateChange === undefined}
                        onCheckedChange={(checked) =>
                          void change(instance, checked ? "enabled" : "disabled")
                        }
                      />
                      {text.enabled}
                    </label>
                    {instance.source !== "local_daemon" ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={text.remove + " · " + name}
                        disabled={pending !== null || onStateChange === undefined}
                        onClick={() => {
                          setConfirmation(instance.id);
                          setError(null);
                        }}
                      >
                        <Trash2Icon aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground" role="status">
                  {reason}
                  {selected ? <span className="ml-2">{text.selectedReason}</span> : null}
                  {enabled &&
                  (instance.status === "error" ||
                    instance.status === "pairing_expired" ||
                    instance.status === "needs_auth") ? (
                    <button
                      type="button"
                      className="ml-2 underline underline-offset-2"
                      onClick={() => openInstanceSetup()}
                    >
                      {text.pair}
                    </button>
                  ) : null}
                </div>
                {confirmation === instance.id ? (
                  <div
                    className="mt-2 border-l-2 border-border pl-3"
                    data-workjet-instance-removal=""
                  >
                    <p className="text-xs text-muted-foreground">{text.removal}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending !== null}
                        onClick={() => setConfirmation(null)}
                      >
                        {text.cancel}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending !== null}
                        onClick={() => void change(instance, "removed")}
                      >
                        {text.confirm}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
      </ul>
      {error ? (
        <p role="alert" className="px-4 py-2 text-xs text-muted-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
