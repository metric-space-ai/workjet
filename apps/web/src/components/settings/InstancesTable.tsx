import { useState, type ReactNode } from "react";
import type { CtoxManagedInstance } from "@workjet/contracts";

import { Row, type RowMenuAction, type RowStatus } from "../ui/row";
import { Button } from "../ui/button";
import { workjetUiLanguage } from "../../workjetProjectControl";
import { ctoxInstanceDisplayTitle } from "../ctox/ctoxInstanceDisplayTitle";
import { canActivateCtoxInstance } from "../ctox/CtoxModeShell";
import { openInstanceRePair } from "../../instanceSetup";

/**
 * Instanzliste (UI-Vertrag §1.2): ein Objekt, eine Zeile. Statuspunkt, Name,
 * Adresse als Meta. Eine Auswahl, kein Schalter (#598): die aktive Zeile ist
 * hervorgehoben, andere bieten „Wechseln“. Papierkorb mit Inline-Bestätigung,
 * ⋯-Menü für Seltenes (Aktivieren/Deaktivieren, Neu koppeln, Diagnose).
 */
export const INSTANCE_LIST_TEXT = {
  select: "Wechseln",
  disable: "Deaktivieren",
  enable: "Aktivieren",
  disabled: "Deaktiviert",
  remove: "Entfernen",
  removeConfirm: "Aus Workjet entfernen?",
  pair: "Neu koppeln",
  diagnose: "Diagnose",
  selectedStaysActive: "Ausgewählte Instanz bleibt aktiv.",
  error: "Änderung nicht gespeichert. Bitte erneut versuchen.",
} as const;

const INSTANCE_LIST_TEXT_EN: { readonly [K in keyof typeof INSTANCE_LIST_TEXT]: string } = {
  select: "Switch",
  disable: "Deactivate",
  enable: "Activate",
  disabled: "Deactivated",
  remove: "Remove",
  removeConfirm: "Remove from Workjet?",
  pair: "Pair again",
  diagnose: "Diagnostics",
  selectedStaysActive: "The selected instance stays active.",
  error: "Change not saved. Please try again.",
};

export interface InstanceRowState {
  readonly status: RowStatus;
  /** Kurzer Zustand für Statuspunkt und Diagnose. */
  readonly label: string;
  /** Chip nur bei einem Problem oder laufender Einrichtung. */
  readonly chip: string | null;
}

export function instanceRowState(instance: CtoxManagedInstance): InstanceRowState {
  if ((instance.workjetState ?? "enabled") !== "enabled") {
    return { status: "off", label: "Deaktiviert", chip: null };
  }
  switch (instance.status) {
    case "offline":
      return { status: "error", label: "Getrennt", chip: "Getrennt" };
    case "pairing_expired":
      return { status: "error", label: "Kopplung abgelaufen", chip: "Abgelaufen" };
    case "needs_auth":
      return { status: "error", label: "Anmeldung nötig", chip: "Anmeldung nötig" };
    case "error":
      return { status: "error", label: "Fehler", chip: "Fehler" };
    case "installing":
      return { status: "busy", label: "Wird eingerichtet", chip: "Wird eingerichtet" };
    default:
      return instance.healthSummary.dataPlaneReady
        ? { status: "ok", label: "Verbunden", chip: null }
        : { status: "busy", label: "Nicht bestätigt", chip: null };
  }
}

/** Meta-Zeile: die Adresse, sonst ein kurzer Ort. */
export function instanceRowMeta(instance: CtoxManagedInstance): string {
  if (instance.domain) return instance.domain;
  switch (instance.source) {
    case "local_daemon":
      return "Dieser Rechner";
    case "ctox_dev":
      return "ctox.dev";
    case "ssh_managed":
      return "SSH";
    default:
      return "—";
  }
}

const SOURCE_LABELS: Record<CtoxManagedInstance["source"], string> = {
  ctox_dev: "ctox.dev",
  local_daemon: "Dieser Rechner",
  pairing_invite: "Einladungslink",
  manual_pairing: "Verbindungsdaten",
  ssh_managed: "SSH",
};

function instanceDomainKey(instance: CtoxManagedInstance): string | null {
  const domain = instance.domain?.trim().toLowerCase();
  return domain ? domain : null;
}

function instanceRank(instance: CtoxManagedInstance, preferredId: string | null): number {
  return (
    (instance.id === preferredId ? 8 : 0) +
    ((instance.workjetState ?? "enabled") === "enabled" ? 4 : 0) +
    (canActivateCtoxInstance(instance) ? 2 : 0) +
    (instance.healthSummary.dataPlaneReady ? 1 : 0)
  );
}

/**
 * Doppelte Einträge derselben Instanz (gleiche ID oder gleiche Domain)
 * werden zu einer Zeile. Es bleibt der beste Eintrag: der ausgewählte,
 * dann der aktive, dann der erreichbare. Die Reihenfolge bleibt erhalten.
 */
export function dedupeCtoxInstances(
  instances: readonly CtoxManagedInstance[],
  preferredId: string | null = null,
): readonly CtoxManagedInstance[] {
  const groups: CtoxManagedInstance[] = [];
  for (const instance of instances) {
    const domain = instanceDomainKey(instance);
    const index = groups.findIndex(
      (existing) =>
        existing.id === instance.id || (domain !== null && instanceDomainKey(existing) === domain),
    );
    if (index === -1) groups.push(instance);
    else if (instanceRank(instance, preferredId) > instanceRank(groups[index]!, preferredId))
      groups[index] = instance;
  }
  return groups;
}

function InstanceDiagnosis({ instance }: { readonly instance: CtoxManagedInstance }) {
  const state = instanceRowState(instance);
  const entries: ReadonlyArray<readonly [string, string]> = [
    ["Zustand", state.label],
    ["Quelle", SOURCE_LABELS[instance.source]],
    ["Adresse", instance.domain ?? "—"],
    ["Synchronisierung", instance.healthSummary.dataPlaneReady ? "bereit" : "nicht bestätigt"],
  ];
  return (
    <dl
      className="mx-3 mb-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-0.5 rounded-md bg-muted/40 px-3 py-2 text-xs"
      data-workjet-instance-diagnosis={instance.id}
    >
      {entries.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function InstancesTable({
  instances,
  activeInstanceId,
  onSelect,
  onStateChange,
  onRePair = openInstanceRePair,
  selectedDetails = null,
}: {
  readonly instances: readonly CtoxManagedInstance[];
  readonly activeInstanceId: string | null;
  readonly onSelect?: ((id: string) => void | Promise<boolean>) | undefined;
  readonly onStateChange?:
    | ((
        instance: CtoxManagedInstance,
        state: "enabled" | "disabled" | "removed",
      ) => Promise<string | null>)
    | undefined;
  readonly onRePair?: (instance: CtoxManagedInstance) => void;
  /** Geräte und Netzwerk der ausgewählten Instanz, inline unter ihrer Zeile. */
  readonly selectedDetails?: ReactNode;
}) {
  const text = workjetUiLanguage() === "en" ? INSTANCE_LIST_TEXT_EN : INSTANCE_LIST_TEXT;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [diagnosed, setDiagnosed] = useState<string | null>(null);
  const rows = dedupeCtoxInstances(
    instances.filter((instance) => instance.workjetState !== "removed"),
    activeInstanceId,
  );

  const change = async (
    instance: CtoxManagedInstance,
    state: "enabled" | "disabled" | "removed",
  ) => {
    if (onStateChange === undefined || pending !== null) return;
    if (state === "disabled" && instance.id === activeInstanceId) {
      setError(text.selectedStaysActive);
      return;
    }
    setPending(instance.id);
    setError(null);
    try {
      const failure = await onStateChange(instance, state);
      if (failure !== null) setError(failure);
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
      <ul aria-label="Instanzen" className="divide-y divide-border/60">
        {rows.map((instance) => {
          const selected = instance.id === activeInstanceId;
          const enabled = (instance.workjetState ?? "enabled") === "enabled";
          const name = ctoxInstanceDisplayTitle(instance);
          const state = instanceRowState(instance);
          const paired =
            instance.source === "pairing_invite" ||
            instance.source === "manual_pairing" ||
            instance.source === "ctox_dev";
          const deletable = instance.source !== "local_daemon" && onStateChange !== undefined;
          const menuActions: RowMenuAction[] = [];
          const switchable =
            !selected &&
            enabled &&
            onSelect !== undefined &&
            pending === null &&
            canActivateCtoxInstance(instance);
          if (paired && enabled) {
            menuActions.push({ label: text.pair, onSelect: () => onRePair(instance) });
          }
          if (!selected && onStateChange !== undefined && pending === null) {
            menuActions.push({
              label: enabled ? text.disable : text.enable,
              onSelect: () => void change(instance, enabled ? "disabled" : "enabled"),
            });
          }
          menuActions.push({
            label: text.diagnose,
            onSelect: () =>
              setDiagnosed((current) => (current === instance.id ? null : instance.id)),
          });
          return (
            <li
              key={instance.id}
              data-workjet-instance-row={instance.id}
              data-workjet-instance-selected={selected ? "" : undefined}
              aria-current={selected ? "true" : undefined}
              className={selected ? "rounded-lg bg-muted/40" : undefined}
            >
              <Row
                name={name}
                meta={instanceRowMeta(instance)}
                // One status signal (#631): the chip names a problem; a dot only
                // for the one state without a chip. Healthy and deactivated stay quiet.
                {...(state.chip === null && state.status === "busy"
                  ? { status: state.status, statusLabel: state.label }
                  : {})}
                chips={
                  <>
                    {state.chip !== null ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {state.chip}
                      </span>
                    ) : null}
                    {enabled ? null : (
                      <span className="text-[11px] text-muted-foreground">{text.disabled}</span>
                    )}
                    {switchable ? (
                      <Button
                        size="xs"
                        variant="outline"
                        data-workjet-action={`instance.select:${instance.id}`}
                        onClick={() => void choose(instance.id)}
                      >
                        {text.select}
                      </Button>
                    ) : null}
                  </>
                }
                {...(deletable ? { onDelete: () => void change(instance, "removed") } : {})}
                deleteLabel={text.remove}
                deleteConfirmTitle={text.removeConfirm}
                menuActions={menuActions}
              />
              {diagnosed === instance.id ? <InstanceDiagnosis instance={instance} /> : null}
              {selected && selectedDetails !== null ? (
                <div
                  className="mb-2 ms-3 space-y-3 border-s border-border/70 ps-3 sm:ms-4"
                  data-workjet-instance-details={instance.id}
                >
                  {selectedDetails}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
