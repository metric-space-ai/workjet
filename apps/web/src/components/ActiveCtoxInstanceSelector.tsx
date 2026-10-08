import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  LinkIcon,
  NetworkIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { openInstanceSetup } from "../instanceSetup";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import type { CtoxDiscoveryResult, CtoxManagedInstance } from "@workjet/contracts";
import { useMemo, useState } from "react";
import { canActivateCtoxInstance, useCtoxMode } from "./ctox/CtoxModeShell";
import { ctoxInstanceDisplayTitle } from "./ctox/ctoxInstanceDisplayTitle";
import { useActiveWorkjetScope } from "../activeWorkjetScope";
import { cn } from "../lib/utils";

type InstanceDiscovery = "loading" | CtoxDiscoveryResult;

export function selectableCtoxInstances(
  discovery: InstanceDiscovery,
): readonly CtoxManagedInstance[] {
  if (discovery === "loading" || discovery._tag !== "ready") return [];
  // Identity comes from the instance id, never a shared label or hostname.
  const unique = new Map<string, CtoxManagedInstance>();
  for (const instance of discovery.instances) {
    if (!unique.has(instance.id)) unique.set(instance.id, instance);
  }
  return [...unique.values()].toSorted((left, right) =>
    left.displayName.localeCompare(right.displayName),
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
        `${ctoxInstanceDisplayTitle(instance)} ${instance.domain ?? ""} ${instance.source === "local_daemon" ? "local this computer lokal dieser computer" : ""}`
          .toLocaleLowerCase()
          .includes(query),
      )
    : instances;
}

export function ctoxInstancePickerStatus(instance: CtoxManagedInstance): string {
  if (instance.status === "pairing_expired") return "Invitation expired";
  if (!canActivateCtoxInstance(instance)) return "Unavailable";
  return instance.healthSummary.dataPlaneReady ? "Connected" : "Connection not confirmed";
}

export function ActiveCtoxInstanceSelector({
  placement = "sidebar",
}: {
  /** The shared header renders this compactly; the sidebar keeps its own band. */
  readonly placement?: "header" | "sidebar" | "settings";
} = {}) {
  const navigate = useNavigate();
  const { discovery, selectedId, select, showNetwork, refresh } = useCtoxMode();
  const { selectionRevision } = useActiveWorkjetScope();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [returning, setReturning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const instances = useMemo(() => selectableCtoxInstances(discovery), [discovery]);
  const activeId = resolveActiveCtoxInstanceId(instances, selectedId);
  const active = instances.find((instance) => instance.id === activeId);
  const filtered = filterCtoxInstances(instances, search);
  const loading = discovery === "loading";
  const failed = discovery !== "loading" && discovery._tag === "failed";
  const close = () => {
    setOpen(false);
    setSearch("");
    setError(null);
  };
  const returnToNetwork = async () => {
    setReturning(true);
    setError(null);
    try {
      if (await showNetwork()) {
        close();
        await navigate({ to: "/" });
      } else setError("Could not leave the instance. Please try again.");
    } catch {
      setError("Could not open the network overview.");
    } finally {
      setReturning(false);
    }
  };
  const chooseInstance = async (instance: CtoxManagedInstance) => {
    setReturning(true);
    setError(null);
    try {
      if (await select(instance)) close();
      else setError("Instance switch not confirmed. Please try again.");
    } catch {
      setError("Could not select the instance.");
    } finally {
      setReturning(false);
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
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setSearch("");
            setError(null);
          }
        }}
      >
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              className={cn(
                "min-w-0 px-2 text-sm",
                placement === "header"
                  ? "h-7 max-w-full justify-start gap-1 font-normal text-muted-foreground hover:text-foreground sm:h-7"
                  : "w-full justify-between gap-2",
              )}
              aria-label="Select CTOX instance"
            />
          }
        >
          <span className="truncate">
            {active ? ctoxInstanceDisplayTitle(active) : "Network overview"}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverPopup
          align="start"
          className="w-80 max-w-[calc(100vw-24px)]"
          viewportClassName="p-2"
          aria-label="Instances"
        >
          <label className="mb-2 flex items-center gap-2 border-b border-border px-2 pb-3 pt-1">
            <SearchIcon className="size-4 text-muted-foreground" aria-hidden />
            <input
              autoFocus
              aria-label="Search instances"
              placeholder="Search instance or host…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <button
            type="button"
            className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
            aria-current={activeId === null ? "page" : undefined}
            disabled={returning}
            onClick={() => void returnToNetwork()}
          >
            <NetworkIcon className="size-4 text-muted-foreground" />{" "}
            <span className="flex-1">{returning ? "Opening network…" : "Network overview"}</span>
            {activeId === null && <CheckIcon className="size-4" />}
          </button>
          <div
            className="my-2 max-h-64 overflow-y-auto"
            aria-label="Available instances"
            aria-busy={loading}
          >
            {loading ? (
              <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
                Loading instances…
              </p>
            ) : failed ? (
              <div className="px-2 py-3">
                <p role="alert" className="text-xs text-muted-foreground">
                  Could not load instances.
                </p>
                <Button size="sm" variant="ghost" className="mt-2" onClick={refresh}>
                  Try again
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {search.trim() ? "No matching instance." : "No instance connected yet."}
              </p>
            ) : (
              filtered.map((instance) => (
                <button
                  key={instance.id}
                  type="button"
                  disabled={!canActivateCtoxInstance(instance) || returning}
                  aria-current={activeId === instance.id ? "page" : undefined}
                  className="flex min-h-14 w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
                  onClick={() => void chooseInstance(instance)}
                >
                  <span
                    aria-hidden
                    className={`size-1.5 shrink-0 rounded-full ${instance.healthSummary.dataPlaneReady && canActivateCtoxInstance(instance) ? "bg-primary" : "bg-muted-foreground"}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {ctoxInstanceDisplayTitle(instance)}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {instance.source === "local_daemon"
                        ? "Dieser Computer"
                        : (instance.domain ?? "Remote")}{" "}
                      · {ctoxInstancePickerStatus(instance)}
                    </span>
                  </span>
                  {activeId === instance.id && <CheckIcon className="size-4 shrink-0" />}
                </button>
              ))
            )}
          </div>
          {error && (
            <p role="alert" className="px-2 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="space-y-1 border-t border-border pt-2">
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                close();
                openInstanceSetup("create");
              }}
            >
              <PlusIcon className="size-4" />
              Create instance
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                close();
                openInstanceSetup("connect");
              }}
            >
              <LinkIcon className="size-4" />
              Connect instance
            </Button>
            <Button
              variant="ghost"
              className="w-full justify-start"
              onClick={() => {
                close();
                void navigate({ to: "/settings/business-os" });
              }}
            >
              <SettingsIcon className="size-4" />
              Manage instances
            </Button>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
