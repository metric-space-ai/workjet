import type {
  EnvironmentId,
  WorkjetComputer,
  WorkjetConfiguration,
  WorkjetHarnessAvailabilitySnapshot,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Fragment, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { RemoteEnvironmentsSection } from "./ConnectionsSettings";
import {
  type WorkjetEnvironmentTargetOption,
  WorkjetComputerEditor,
} from "./WorkjetComputerEditor";
import { workjetEnvironmentTargetOptions } from "./WorkjetSettings";
import {
  ConfirmingDeleteButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { workjetComputerKindLabel } from "../chat/ComposerWorkjetTargetControls";
import { workjetHarnessDisplayLabel } from "./WorkjetWorkerEditor";
import { ComputerProvisioningSection } from "./ComputerProvisioningSection";
import { searchableSetting } from "./settingsSearch";

/**
 * Computers as a TOP-LEVEL settings page, as the operator specified twice:
 * machines are not a detail of worker configuration — a worker references a
 * computer, so the computer has to exist first and deserves its own place
 * beside Models and Harnesses. The page owns the whole subject: the Workjet
 * computer catalog on top, and the remote environments those computers
 * reference right below it. The legacy Connections route redirects here; its
 * implementation remains an internal source for environment controls.
 */
export function WorkjetComputersSettingsView({
  configuration,
  environments,
  environmentsReady,
  harnessInspection = null,
  environmentId = null,
  onChange,
}: {
  readonly configuration: WorkjetConfiguration;
  readonly environments: ReadonlyArray<WorkjetEnvironmentTargetOption>;
  readonly environmentsReady: boolean;
  /**
   * Live probe of THIS server's harnesses (`workjet.harness.inspect`), plus
   * which environment it describes. Null before the first probe answers —
   * rows then show the declared state with "not probed from here" instead of
   * implying agreement.
   */
  readonly harnessInspection?: WorkjetHarnessAvailabilitySnapshot | null;
  readonly environmentId?: EnvironmentId | null;
  readonly onChange: (configuration: WorkjetConfiguration) => void;
}) {
  const [editingComputerId, setEditingComputerId] = useState<string | null>(null);
  const [addingComputer, setAddingComputer] = useState(() => {
    // Set by the composer's "+ Add computer…" entry: arriving here should
    // open the create editor, not just the list (Befund F8).
    try {
      if (window.sessionStorage.getItem("workjet-computer-create") !== null) {
        window.sessionStorage.removeItem("workjet-computer-create");
        return true;
      }
    } catch {
      // Blocked storage: plain list.
    }
    return false;
  });
  const editingComputer =
    configuration.computers.find((computer) => computer.id === editingComputerId) ?? null;
  const computerEditor = (
    <div className="px-3 pt-2 sm:px-4">
      <WorkjetComputerEditor
        key={editingComputer?.id ?? "new-computer"}
        computer={editingComputer}
        environments={environments}
        availability={
          // The probe describes THIS server only; a computer targeting
          // another environment must not borrow its answers.
          editingComputer !== null && environmentId === editingComputer.environmentId
            ? harnessInspection
            : null
        }
        onCancel={() => {
          setAddingComputer(false);
          setEditingComputerId(null);
        }}
        onSave={(computer: WorkjetComputer) => {
          onChange({
            ...configuration,
            computers: replaceComputer(computer),
          });
          setAddingComputer(false);
          setEditingComputerId(null);
          toastManager.add({
            type: "success",
            title: "Computer saved",
            description: computer.label,
          });
        }}
      />
    </div>
  );

  const replaceComputer = (computer: WorkjetComputer): ReadonlyArray<WorkjetComputer> => {
    const existing = configuration.computers;
    return existing.some((candidate) => candidate.id === computer.id)
      ? existing.map((candidate) => (candidate.id === computer.id ? computer : candidate))
      : [...existing, computer];
  };

  return (
    <SettingsSection
      id={searchableSetting("workjet-computers").id}
      title={searchableSetting("workjet-computers").title}
      headerAction={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setEditingComputerId(null);
            setAddingComputer(true);
          }}
          disabled={!environmentsReady || environments.length === 0}
        >
          <PlusIcon className="size-3.5" />
          Add computer
        </Button>
      }
    >
      <SettingsRow
        title={environmentsReady ? "Computer targets" : "Loading computer targets"}
        description="A computer is an existing local, relay, SSH, Tailscale, or other remote environment plus its declared harnesses. Workjet stores only the selected target and harness availability; credentials remain with the owning environment."
      />
      {/* The editor renders where the user is looking: adding — right here
          under the header button; editing — directly below the edited row
          (mounted at the page bottom it sat below the fold and the pencil
          looked dead). */}
      {addingComputer ? computerEditor : null}
      {configuration.computers.length === 0 ? (
        <SettingsRow
          title="No computers yet"
          description="Add a computer from an existing environment, or pair a new remote environment below and add it as a computer afterwards."
        />
      ) : null}
      {configuration.computers.map((computer) => {
        // The Swift page shows, per computer, ONE ROW PER HARNESS with a
        // live status dot and detail — not a count. The live snapshot
        // (workjet.harness.inspect) describes THIS server; a computer on
        // another environment shows its declared availability with an
        // explicit "not probed from here" instead of borrowing our probe.
        const probedHere = harnessInspection !== null && environmentId === computer.environmentId;
        // The environment's human label, never its raw id — an operator
        // recognises "gpu3-a4500", not a UUID. When the environment left the
        // catalog, the kind alone is the only truthful thing left to show.
        const environmentLabel =
          environments.find((environment) => environment.environmentId === computer.environmentId)
            ?.label ?? null;
        return (
          <Fragment key={computer.id}>
            <SettingsRow
              title={computer.label}
              description={
                probedHere
                  ? "This machine"
                  : environmentLabel === null
                    ? workjetComputerKindLabel(computer.presentationKind)
                    : `${workjetComputerKindLabel(computer.presentationKind)} · ${environmentLabel}`
              }
              control={
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Edit computer ${computer.label}`}
                    onClick={() => {
                      setAddingComputer(false);
                      setEditingComputerId(computer.id);
                    }}
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <ConfirmingDeleteButton
                    label={`computer ${computer.label}`}
                    onDelete={() =>
                      onChange({
                        ...configuration,
                        computers: configuration.computers.filter(
                          (candidate) => candidate.id !== computer.id,
                        ),
                      })
                    }
                  />
                </div>
              }
            >
              <div className="mt-1 space-y-1 pb-3">
                {computer.harnesses.map((declared) => {
                  const live = probedHere
                    ? (harnessInspection?.harnesses.find(
                        (entry) => entry.harness === declared.harness,
                      ) ?? null)
                    : null;
                  const state =
                    live === null
                      ? declared.available
                        ? "declared"
                        : "off"
                      : live.availability === "available"
                        ? "ok"
                        : "missing";
                  const detail =
                    live === null
                      ? declared.available
                        ? "declared available · not probed from here"
                        : "not offered"
                      : live.availability === "available"
                        ? `${live.version ? `v${live.version} · ` : ""}${live.executablePath}`
                        : humanizeHarnessProbeReason(live.reason);
                  return (
                    <p
                      key={declared.harness}
                      className="flex items-center gap-2 pl-1 text-xs text-muted-foreground"
                    >
                      <span
                        aria-hidden
                        className={
                          state === "ok"
                            ? "size-1.5 shrink-0 rounded-full bg-emerald-500"
                            : state === "missing"
                              ? "size-1.5 shrink-0 rounded-full bg-amber-500"
                              : "size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                        }
                      />
                      <span className="w-28 shrink-0 font-medium text-foreground">
                        {workjetHarnessDisplayLabel(declared.harness)}
                      </span>
                      <span className="min-w-0 truncate">{detail}</span>
                    </p>
                  );
                })}
                {computer.harnesses.length === 0 ? (
                  <p className="pl-1 text-xs text-muted-foreground">
                    No harnesses declared — edit the computer to declare them.
                  </p>
                ) : null}
              </div>
            </SettingsRow>
            {editingComputer?.id === computer.id ? computerEditor : null}
          </Fragment>
        );
      })}
      <SettingsRow
        title="Connection security"
        description="Remote environments are paired and removed below, then become selectable computer targets. Authentication material remains with its owning environment and is never copied into a computer entry."
      />
    </SettingsSection>
  );
}

export function WorkjetComputersSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { environments, isReady: environmentsReady } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  // Live harness probe of this server, for the per-computer rows. Same
  // environment-query mechanics as every other read on this page.
  const harnessInspectQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetHarnessInspect({ environmentId, input: {} }),
  );

  return (
    <SettingsPageContainer className="gap-6">
      <div className="px-3 sm:px-4">
        <h1 className="text-xl font-semibold tracking-[-0.025em]">Computers</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          The machines Workjet workers run on: pair remote environments and declare which harnesses
          each computer offers.
        </p>
      </div>
      <WorkjetComputersSettingsView
        configuration={settings.workjet}
        environments={workjetEnvironmentTargetOptions(environments)}
        environmentsReady={environmentsReady}
        harnessInspection={harnessInspectQuery.data ?? null}
        environmentId={environmentId}
        onChange={(workjet) => updateSettings({ workjet })}
      />
      <ComputerProvisioningSection />
      <RemoteEnvironmentsSection />
    </SettingsPageContainer>
  );
}

/** Probe reasons arrive as slugs; the row speaks prose (Befund F11). */
function humanizeHarnessProbeReason(reason: string): string {
  const known: Record<string, string> = {
    "executable-not-found": "Executable not found",
    "probe-failed": "Probe failed",
    "not-supported": "Not supported on this computer",
  };
  const mapped = known[reason];
  if (mapped !== undefined) return mapped;
  const spaced = reason.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
