import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon, SettingsIcon } from "lucide-react";
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

export function ctoxInstancePickerStatus(instance: CtoxManagedInstance): string {
  if (instance.status === "pairing_expired") return "Kopplung abgelaufen";
  if (!canActivateCtoxInstance(instance)) return "Nicht erreichbar";
  return instance.healthSummary.dataPlaneReady ? "Verbunden" : "Nicht bestätigt";
}

function pickerDot(instance: CtoxManagedInstance): RowStatus {
  if (!canActivateCtoxInstance(instance)) return "off";
  return instance.healthSummary.dataPlaneReady ? "ok" : "busy";
}

/**
 * Instanz-Dropdown im Kopf (drei Orte): eine reine Auswahl. Eine Zeile je
 * Instanz, darunter „Instanz hinzufügen“ und „Instanzen verwalten“; beide
 * führen nach Einstellungen › Instanzen. Kein Popover mit Inhalt.
 */
export function ActiveCtoxInstanceSelector({
  placement = "sidebar",
}: {
  /** The shared header renders this compactly; the sidebar keeps its own band. */
  readonly placement?: "header" | "sidebar" | "settings";
} = {}) {
  const navigate = useNavigate();
  const { discovery, selectedId, select, refresh } = useCtoxMode();
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
  const visible = searchable ? filterCtoxInstances(instances, search) : instances;
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
      else setError("Wechsel nicht bestätigt.");
    } catch {
      setError("Wechsel fehlgeschlagen.");
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
              aria-label="Instanz wählen"
            />
          }
        >
          {active ? (
            <RowStatusDot status={pickerDot(active)} label={ctoxInstancePickerStatus(active)} />
          ) : null}
          <span className="truncate">
            {active ? ctoxInstanceDisplayTitle(active) : "Instanz wählen"}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup
          align="start"
          className="w-72 max-w-[calc(100vw-24px)]"
          aria-label="Instanzen"
          data-workjet-instance-picker=""
        >
          {searchable ? (
            <label className="mb-1 flex items-center gap-2 border-b border-border px-2 pb-1.5 pt-1">
              <SearchIcon className="size-3.5 text-muted-foreground" aria-hidden />
              <input
                aria-label="Instanz suchen"
                placeholder="Instanz suchen"
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
              Instanzen werden geladen …
            </MenuItem>
          ) : failed ? (
            <MenuItem closeOnClick={false} onClick={refresh}>
              Erneut laden
            </MenuItem>
          ) : visible.length === 0 ? (
            <MenuItem disabled>
              {search.trim() ? "Keine Instanz gefunden" : "Keine Instanz verbunden"}
            </MenuItem>
          ) : (
            visible.map((instance) => (
              <MenuItem
                key={instance.id}
                closeOnClick={false}
                disabled={!canActivateCtoxInstance(instance) || pendingId !== null}
                data-workjet-instance-option={instance.id}
                data-selected={activeId === instance.id ? "" : undefined}
                title={ctoxInstancePickerStatus(instance)}
                onClick={() => void chooseInstance(instance)}
              >
                <RowStatusDot
                  status={pickerDot(instance)}
                  label={ctoxInstancePickerStatus(instance)}
                />
                <span className="min-w-0 flex-1 truncate">
                  {ctoxInstanceDisplayTitle(instance)}
                </span>
                {pendingId === instance.id ? (
                  <Spinner className="size-3.5" />
                ) : activeId === instance.id ? (
                  <CheckIcon className="size-4 text-foreground" aria-label="Ausgewählt" />
                ) : null}
              </MenuItem>
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
            Instanz hinzufügen
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenuOpen(false);
              void navigate({ to: INSTANCES_SETTINGS_PATH });
            }}
          >
            <SettingsIcon />
            Instanzen verwalten
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
