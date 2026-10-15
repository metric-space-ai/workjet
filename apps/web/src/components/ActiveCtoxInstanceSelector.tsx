import { workjetUiLanguage } from "../workjetProjectControl";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  UnplugIcon,
} from "lucide-react";
import type { CtoxDiscoveryResult, CtoxManagedInstance } from "@workjet/contracts";
import { useEffect, useMemo, useState } from "react";

import {
  INSTANCES_SETTINGS_PATH,
  openInstanceSetup,
  registerInstanceSetupNavigator,
} from "../instanceSetup";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { RowStatusDot, type RowStatus } from "./ui/row";
import { Spinner } from "./ui/spinner";
import { canActivateCtoxInstance, useCtoxMode } from "./ctox/CtoxModeShell";
import { ctoxInstanceDisplayTitle } from "./ctox/ctoxInstanceDisplayTitle";
import { dedupeCtoxInstances } from "./settings/InstancesTable";
import { useActiveWorkjetScope } from "../activeWorkjetScope";
import { cn } from "../lib/utils";
import { scheduleUndoableDelete } from "../lib/undoableDelete";

type InstanceDiscovery = "loading" | CtoxDiscoveryResult;

/** Ab dieser Zahl erscheint ein Suchfeld; bis dahin ist alles ohne Scrollen sichtbar. */
export const INSTANCE_PICKER_SEARCH_THRESHOLD = 12;

export function selectableCtoxInstances(
  discovery: InstanceDiscovery,
  preferredId: string | null = null,
): readonly CtoxManagedInstance[] {
  if (discovery === "loading" || discovery._tag !== "ready") return [];
  // Identity comes from the instance id (or its domain), never a shared label.
  return dedupeCtoxInstances(
    discovery.instances
      .filter((instance) => instance.workjetState !== "removed")
      .toSorted((left, right) => left.displayName.localeCompare(right.displayName)),
    preferredId,
  );
}

export function resolveActiveCtoxInstanceId(
  instances: readonly Pick<CtoxManagedInstance, "id">[],
  rememberedId: string | null,
): string | null {
  return rememberedId !== null && instances.some((instance) => instance.id === rememberedId)
    ? rememberedId
    : null;
}

export function filterCtoxInstances(
  instances: readonly CtoxManagedInstance[],
  search: string,
): readonly CtoxManagedInstance[] {
  const query = search.trim().toLocaleLowerCase();
  return query
    ? instances.filter((instance) =>
        `${ctoxInstanceDisplayTitle(instance)} ${instance.domain ?? ""} ${instance.source === "local_daemon" ? "local this computer lokal dieser rechner computer" : ""}`
          .toLocaleLowerCase()
          .includes(query),
      )
    : instances;
}

function pickerText(de: string, en: string): string {
  return workjetUiLanguage() === "en" ? en : de;
}

export function ctoxInstancePickerStatus(instance: CtoxManagedInstance): string {
  if (instance.status === "pairing_expired") {
    return pickerText("Kopplung abgelaufen", "Pairing expired");
  }
  if (!canActivateCtoxInstance(instance)) return pickerText("getrennt", "disconnected");
  return instance.healthSummary.dataPlaneReady
    ? pickerText("verbunden", "connected")
    : pickerText("verbindet", "connecting");
}

function pickerDot(instance: CtoxManagedInstance): RowStatus {
  if (!canActivateCtoxInstance(instance)) return "off";
  return instance.healthSummary.dataPlaneReady ? "ok" : "busy";
}

/**
 * Instanz-Menü im Kopf: der einzige Ort für die Liste aller Instanzen (#556).
 * Eine Zeile je Instanz mit „Trennen“ (sofort, Rückgängig im Toast), darunter
 * „Instanz hinzufügen“ und „Instanz-Einstellungen“ (die gewählte Instanz).
 */
export function ActiveCtoxInstanceSelector({
  placement = "sidebar",
}: {
  /** The shared header renders this compactly; the sidebar keeps its own band. */
  readonly placement?: "header" | "sidebar" | "settings";
} = {}) {
  const navigate = useNavigate();
  const { discovery, selectedId, select, refresh, setInstanceState } = useCtoxMode();
  // „Trennen“ wirkt sofort und lässt sich im Toast rückgängig machen (#556, #687).
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const { selectionRevision } = useActiveWorkjetScope();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const instances = useMemo(
    () => selectableCtoxInstances(discovery, selectedId),
    [discovery, selectedId],
  );
  const activeId = resolveActiveCtoxInstanceId(instances, selectedId);
  const active = instances.find((instance) => instance.id === activeId);
  const searchable = instances.length > INSTANCE_PICKER_SEARCH_THRESHOLD;
  const visible = (searchable ? filterCtoxInstances(instances, search) : instances).filter(
    (instance) => !hiddenIds.has(instance.id),
  );
  const disconnect = (instance: CtoxManagedInstance) => {
    const show = () =>
      setHiddenIds((current) => {
        const next = new Set(current);
        next.delete(instance.id);
        return next;
      });
    setHiddenIds((current) => new Set(current).add(instance.id));
    scheduleUndoableDelete({
      title: pickerText("Getrennt", "Disconnected"),
      undoLabel: pickerText("Rückgängig", "Undo"),
      run: async () => {
        const result = await setInstanceState(instance, "removed");
        if (!result.ok) show();
      },
      onUndo: show,
    });
  };
  const loading = discovery === "loading";
  const failed = discovery !== "loading" && discovery._tag === "failed";

  // Der Kopf ist immer da: hier meldet sich die Navigation für
  // openInstanceSetup() an, damit jeder Aufruf nach Einstellungen › Instanzen führt.
  useEffect(
    () => registerInstanceSetupNavigator((path) => void navigate({ to: path })),
    [navigate],
  );

  const setMenuOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setSearch("");
      setError(null);
    }
  };

  const chooseInstance = async (instance: CtoxManagedInstance) => {
    if (instance.id === activeId) {
      setMenuOpen(false);
      return;
    }
    setPendingId(instance.id);
    setError(null);
    try {
      if (await select(instance)) setMenuOpen(false);
      else setError(pickerText("Wechsel nicht bestätigt.", "Switch not confirmed."));
    } catch {
      setError(pickerText("Wechsel fehlgeschlagen.", "Switch failed."));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div
      className={
        placement === "header"
          ? "no-drag relative min-w-0 max-w-48 shrink"
          : placement === "settings"
            ? "relative min-w-0 pl-6 pb-1"
            : "relative order-[-1] min-w-0 shrink-0 border-b border-sidebar-border px-[calc(var(--sidebar-content-inset)+0.5rem)] py-2"
      }
      data-active-ctox-instance-selector=""
      data-active-ctox-instance-id={activeId ?? ""}
      data-active-workjet-selection-revision={selectionRevision}
    >
      <Menu open={open} onOpenChange={setMenuOpen}>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              className={cn(
                "min-w-0 px-2 text-sm",
                placement === "header"
                  ? "h-7 max-w-full justify-start gap-1.5 font-normal text-muted-foreground hover:text-foreground sm:h-7"
                  : "w-full justify-between gap-2",
              )}
              aria-label={pickerText("Instanz wählen", "Choose instance")}
            />
          }
        >
          {active ? (
            <RowStatusDot status={pickerDot(active)} label={ctoxInstancePickerStatus(active)} />
          ) : null}
          {/* The trigger names what it switches (#592): "Instanz: Welsch". */}
          <span className="truncate">
            {active ? (
              <>
                <span className="text-muted-foreground">{pickerText("Instanz:", "Instance:")}</span>{" "}
                {ctoxInstanceDisplayTitle(active)}
              </>
            ) : (
              pickerText("Instanz wählen", "Choose instance")
            )}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup
          align="start"
          className="w-60 max-w-[calc(100vw-24px)]"
          aria-label={pickerText("Instanzen", "Instances")}
          data-workjet-instance-picker=""
        >
          {searchable ? (
            <label className="mb-1 flex items-center gap-2 border-b border-border px-2 pb-1.5 pt-1">
              <SearchIcon className="size-3.5 text-muted-foreground" aria-hidden />
              <input
                aria-label={pickerText("Instanz suchen", "Search instances")}
                placeholder={pickerText("Instanz suchen", "Search instances")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </label>
          ) : null}
          {loading ? (
            <MenuItem disabled>
              <Spinner className="size-3.5" />
              {pickerText("Instanzen werden geladen …", "Loading instances …")}
            </MenuItem>
          ) : failed ? (
            <MenuItem closeOnClick={false} onClick={refresh}>
              {pickerText("Erneut laden", "Reload")}
            </MenuItem>
          ) : visible.length === 0 ? (
            <MenuItem disabled>
              {search.trim()
                ? pickerText("Keine Instanz gefunden", "No instance found")
                : pickerText("Keine Instanz verbunden", "No instance connected")}
            </MenuItem>
          ) : (
            visible.map((instance) => (
              <div key={instance.id} className="flex min-w-0 items-center gap-0.5">
                <MenuItem
                  closeOnClick={false}
                  className="min-w-0 flex-1"
                  disabled={!canActivateCtoxInstance(instance) || pendingId !== null}
                  data-workjet-instance-option={instance.id}
                  data-selected={activeId === instance.id ? "" : undefined}
                  onClick={() => void chooseInstance(instance)}
                >
                  <RowStatusDot
                    status={pickerDot(instance)}
                    label={ctoxInstancePickerStatus(instance)}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {ctoxInstanceDisplayTitle(instance)}
                  </span>
                  {/* D33: Status nur als Punkt mit Tooltip (überstimmt #592). */}
                  {pendingId === instance.id ? (
                    <Spinner className="size-3.5" />
                  ) : activeId === instance.id ? (
                    <CheckIcon
                      className="size-4 text-foreground"
                      aria-label={pickerText("Ausgewählt", "Selected")}
                    />
                  ) : null}
                </MenuItem>
                {instance.source !== "local_daemon" && activeId !== instance.id ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground"
                    aria-label={pickerText("Trennen", "Disconnect")}
                    title={pickerText("Trennen", "Disconnect")}
                    data-workjet-action={`instance.disconnect:${instance.id}`}
                    onClick={() => disconnect(instance)}
                  >
                    <UnplugIcon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            ))
          )}
          {error ? (
            <p role="alert" className="px-2 py-1 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              setMenuOpen(false);
              openInstanceSetup("choose");
            }}
          >
            <PlusIcon />
            {pickerText("Instanz hinzufügen", "Add instance")}
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenuOpen(false);
              void navigate({ to: INSTANCES_SETTINGS_PATH });
            }}
          >
            <SettingsIcon />
            {pickerText("Instanz-Einstellungen", "Instance settings")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
