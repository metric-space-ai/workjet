import type { WorkjetNativeProviderAccount } from "@workjet/contracts";
import { nativeAccountForRoute, requireNativeLumaModel } from "../../lib/workjetNativeProviders";
import {
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetLlmRouteId,
  WorkjetWorkerProfileId,
  createDefaultWorkjetWorkerPersonalization,
  type WorkjetCapabilityId,
  type WorkjetComputer,
  type EnvironmentId,
  type WorkjetGatewayAccountSummary,
  type WorkjetGatewayAccountModels,
  type WorkjetCapabilityBinding,
  type CtoxManagedInstance,
  type WorkjetHarness,
  type WorkjetLlmRoute,
  type WorkjetReasoningSelection,
  type WorkjetWorkerProfile,
  type WorkjetWorkerPersonalization,
} from "@workjet/contracts";
import { PlusIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { cn } from "../../lib/utils";
import { Textarea } from "../ui/textarea";
import { WorkjetWorkerPersonalizationEditor } from "./WorkjetWorkerPersonalization";

/** Display name for a harness id — raw slugs kept leaking into lists (K-A11). */
export function workjetHarnessDisplayLabel(harness: string): string {
  return WORKJET_HARNESS_OPTIONS.find((option) => option.id === harness)?.label ?? harness;
}

/** Display name for a reasoning id ("xhigh" → "Extra high"), same reason. */
export function workjetReasoningDisplayLabel(reasoning: string): string {
  return REASONING_OPTIONS.find((option) => option.id === reasoning)?.label ?? reasoning;
}

export const WORKJET_HARNESS_OPTIONS: ReadonlyArray<{
  readonly id: WorkjetHarness;
  readonly label: string;
}> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex-cli", label: "Codex CLI" },
  { id: "opencode", label: "OpenCode" },
  { id: "grok-cli", label: "Grok CLI" },
  { id: "cursor-agent", label: "Cursor Agent" },
  { id: "greppy", label: "Greppy" },
  { id: "minimax-code", label: "MiniMax Code" },
  { id: "pi-code", label: "Pi Code" },
];

const REASONING_OPTIONS: ReadonlyArray<{
  readonly id: WorkjetReasoningSelection;
  readonly label: string;
}> = [
  { id: "automatic", label: "Automatic" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
  { id: "ultracode", label: "Ultracode" },
  { id: "ultrathink", label: "Ultrathink" },
];

const CAPABILITY_OPTIONS: ReadonlyArray<{
  readonly id: WorkjetCapabilityId;
  readonly label: string;
  readonly description: string;
}> = [
  {
    id: "greppy",
    label: "Greppy",
    description: "Repository search and indexing when the target runtime supports it.",
  },
  {
    id: "web-search",
    label: "Web Search",
    description: "Current-source web research through the configured runtime.",
  },
  {
    id: "web-stack-browser",
    label: "Web Stack Browser",
    description: "Browser-backed inspection for web applications.",
  },
  {
    id: "decision-hub",
    label: "Decision Hub",
    description: "Escalate a blocking owner decision to a connected CTOX instance.",
  },
];

export interface WorkjetWorkerDraft {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly computerId: string;
  readonly harness: WorkjetHarness;
  readonly llmRouteId: string;
  readonly modelId: string;
  readonly reasoning: WorkjetReasoningSelection;
  readonly role: "standard" | "orchestrator";
  readonly capabilityIds: ReadonlyArray<WorkjetCapabilityId>;
  readonly capabilityBindings: ReadonlyArray<WorkjetCapabilityBinding>;
  readonly personalization: WorkjetWorkerPersonalization;
}

export function createWorkjetWorkerDraft(input: {
  readonly worker?: WorkjetWorkerProfile | null;
  readonly computers: ReadonlyArray<WorkjetComputer>;
  readonly routes: ReadonlyArray<WorkjetLlmRoute>;
  readonly id?: string;
}): WorkjetWorkerDraft {
  if (input.worker) {
    return {
      ...input.worker,
      instructions: input.worker.instructions ?? "",
      personalization: input.worker.personalization ?? createDefaultWorkjetWorkerPersonalization(),
    };
  }
  return {
    id: input.id ?? randomUUID(),
    name: "",
    instructions: "",
    computerId: input.computers[0]?.id ?? "",
    harness: "claude-code",
    llmRouteId: input.routes[0]?.id ?? "",
    modelId: "",
    reasoning: "automatic",
    role: "standard",
    capabilityIds: [],
    capabilityBindings: [],
    personalization: createDefaultWorkjetWorkerPersonalization(),
  };
}

export function updateWorkjetWorkerDraft(
  draft: WorkjetWorkerDraft,
  patch: Partial<WorkjetWorkerDraft>,
): WorkjetWorkerDraft {
  return { ...draft, ...patch };
}

export function workjetHarnessAvailabilityWarning(
  draft: Pick<WorkjetWorkerDraft, "computerId" | "harness">,
  computers: ReadonlyArray<WorkjetComputer>,
): string | null {
  if (computers.length === 0) {
    return "Add a computer in Workjet Settings before saving this Luma.";
  }
  const computer = computers.find((candidate) => candidate.id === draft.computerId);
  if (!computer) {
    return "The selected computer is no longer in the Workjet catalog. Choose or restore a computer target.";
  }
  const harness = computer.harnesses.find((candidate) => candidate.harness === draft.harness);
  if (harness?.available) return null;
  const label = WORKJET_HARNESS_OPTIONS.find((candidate) => candidate.id === draft.harness)?.label;
  return `${label ?? draft.harness} is not marked available on ${computer.label}. Enable it in Computers or keep this Luma saved for later.`;
}

export function saveWorkjetWorkerDraft(draft: WorkjetWorkerDraft): WorkjetWorkerProfile {
  const name = draft.name.trim();
  const modelId = draft.modelId.trim();
  if (!name) throw new Error("Enter a Luma name or role.");
  if (!draft.computerId) throw new Error("Choose a computer target.");
  if (!draft.llmRouteId) throw new Error("Choose an LLM route.");
  if (!modelId) throw new Error("Enter a model ID.");
  const instructions = draft.instructions.trim();
  const decisionHubBindings = draft.capabilityBindings.filter(
    (binding) => binding.capabilityId === "decision-hub",
  );
  if (draft.capabilityIds.includes("decision-hub") && decisionHubBindings.length !== 1) {
    throw new Error("Choose exactly one Decision Hub connection for this Luma.");
  }
  return {
    id: WorkjetWorkerProfileId.make(draft.id),
    name,
    ...(instructions ? { instructions } : {}),
    computerId: WorkjetComputerId.make(draft.computerId),
    harness: draft.harness,
    llmRouteId: WorkjetLlmRouteId.make(draft.llmRouteId),
    modelId,
    reasoning: draft.reasoning,
    role: draft.role,
    capabilityIds: [...draft.capabilityIds],
    capabilityBindings: draft.capabilityIds.includes("decision-hub")
      ? [...decisionHubBindings]
      : [],
    personalization: draft.personalization,
  };
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/**
 * The segmented control the Swift Workjet worker panel uses for harness,
 * reasoning and target computer. A dropdown hides the option set behind a
 * click; with three to six choices the whole set fits on one line, and seeing
 * every option at once is the difference between picking and guessing.
 */
function ChoiceButton({
  title,
  selected,
  disabled,
  onClick,
}: {
  readonly title: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
        selected
          ? "border-primary bg-primary/20 text-foreground"
          : "border-border/60 bg-muted/20 text-muted-foreground hover:text-foreground",
        disabled ? "cursor-not-allowed opacity-40" : "",
      )}
    >
      {title}
    </button>
  );
}

function SectionHeader({ title, action }: { readonly title: string; readonly action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {action}
    </div>
  );
}

/** New Claude choices require the exact account's live list and enabled model selection.
 * Unchanged saved choices remain editable during an outage; they gain no health claim. */
export function assertLumaLiveModelChoice(
  draft: WorkjetWorkerDraft,
  prior: WorkjetWorkerProfile | null,
  account: WorkjetGatewayAccountSummary | undefined,
  catalog: WorkjetGatewayAccountModels | null,
): void {
  if (account?.provider !== "claude") return;
  const model = draft.modelId.trim();
  if (prior?.modelId === model && prior.llmRouteId === draft.llmRouteId) return;
  if (!account.enabled) throw new Error("Enable this account in Settings → Models.");
  if (catalog?.accountId !== account.id || catalog.state !== "observed" || catalog.reason !== null)
    throw new Error("Refresh this account's live model list before choosing a new model.");
  if (!catalog.modelIds.includes(model))
    throw new Error("Choose a model from this account's live list.");
  if (!account.modelIds.includes(model) || account.excludedModelIds?.includes(model))
    throw new Error(`Enable ${model} for this account in Settings → Models first.`);
}

export function WorkjetWorkerEditor({
  worker = null,
  draftScopeKey,
  computers,
  routes,
  gatewayAccounts = [],
  gatewayEnvironmentId = null,
  nativeAccounts = [],
  nativeModelsBusy = false,
  nativeModelsError,
  onRefreshNativeModels,
  onValidateNativeModel,
  onSave,
  onCancel,
  onAddRoute,
  initialDraft,
  onDraftChange,
  compact = false,
}: {
  readonly worker?: WorkjetWorkerProfile | null;
  /** Prevents an unfinished worker from one Business OS leaking into another. */
  readonly draftScopeKey: string;
  readonly computers: ReadonlyArray<WorkjetComputer>;
  readonly routes: ReadonlyArray<WorkjetLlmRoute>;
  /** The account holder, independent of the worker's target computer. */
  readonly gatewayEnvironmentId?: EnvironmentId | null;
  readonly gatewayAccounts?: ReadonlyArray<WorkjetGatewayAccountSummary>;
  readonly nativeAccounts?: readonly WorkjetNativeProviderAccount[];
  readonly nativeModelsBusy?: boolean;
  readonly nativeModelsError?: string | undefined;
  readonly onRefreshNativeModels?: (account: WorkjetNativeProviderAccount) => void;
  readonly onValidateNativeModel?: (
    account: WorkjetNativeProviderAccount,
    model: string,
  ) => Promise<void>;
  readonly onSave: (worker: WorkjetWorkerProfile) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly initialDraft?: WorkjetWorkerDraft | undefined;
  readonly onDraftChange?: ((draft: WorkjetWorkerDraft) => void) | undefined;
  readonly compact?: boolean;
  /** Opens the place where an access is created. Optional so existing callers keep working. */
  readonly onAddRoute?: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState(() => {
    if (initialDraft) return initialDraft;
    // "Add LLM route…" navigates AWAY to the Models page; without this stash
    // every typed field died with the unmount (Befund K-A7). The stash is
    // per-worker-identity, read once, and cleared immediately.
    const stashKey = `workjet-worker-draft:${encodeURIComponent(draftScopeKey)}:${worker?.id ?? "new"}`;
    try {
      const raw = window.sessionStorage.getItem(stashKey);
      if (raw !== null) {
        window.sessionStorage.removeItem(stashKey);
        const stashed = JSON.parse(raw) as Partial<WorkjetWorkerDraft>;
        return { ...createWorkjetWorkerDraft({ worker, computers, routes }), ...stashed };
      }
    } catch {
      // Blocked storage falls back to a fresh draft.
    }
    return createWorkjetWorkerDraft({ worker, computers, routes });
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [decisionHubInstances, setDecisionHubInstances] = useState<
    ReadonlyArray<CtoxManagedInstance>
  >([]);
  const [provisioningTenantId, setProvisioningTenantId] = useState<string | null>(null);
  const [disconnectingConnectionId, setDisconnectingConnectionId] = useState<string | null>(null);
  const warning = useMemo(
    () => workjetHarnessAvailabilityWarning(draft, computers),
    [computers, draft],
  );
  const harnessLabel =
    WORKJET_HARNESS_OPTIONS.find((option) => option.id === draft.harness)?.label ?? draft.harness;
  const chosenComputer = computers.find((computer) => computer.id === draft.computerId) ?? null;
  const chosenRoute = routes.find((route) => route.id === draft.llmRouteId);
  const chosenNativeAccount = nativeAccountForRoute(chosenRoute, nativeAccounts);
  const chosenAccount = gatewayAccounts.find(
    (account) => account.id === chosenRoute?.gatewayAccountId,
  );
  const liveModels = useEnvironmentQuery(
    gatewayEnvironmentId === null || chosenAccount?.provider !== "claude"
      ? null
      : serverEnvironment.workjetGatewayAccountModels({
          environmentId: gatewayEnvironmentId,
          input: { accountId: chosenAccount.id },
        }),
  );
  const choiceCatalog = !liveModels.isPending && liveModels.error === null ? liveModels.data : null;
  const decisionHubConnections = useEnvironmentQuery(
    chosenComputer === null
      ? null
      : serverEnvironment.workjetDecisionHubConnections({
          environmentId: chosenComputer.environmentId,
          input: {},
        }),
  );
  const connections = decisionHubConnections.data?.connections ?? [];
  useEffect(() => {
    const bridge = window.desktopBridge?.ctox;
    if (bridge === undefined) return;
    let cancelled = false;
    void bridge
      .refresh()
      .then((result) => {
        if (!cancelled && result._tag === "ready") {
          setDecisionHubInstances(
            result.instances.filter(
              (instance) =>
                (instance.source === "ctox_dev" && instance.decisionHub !== undefined) ||
                instance.source === "local_daemon",
            ),
          );
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const decisionHubBinding = draft.capabilityBindings.find(
    (binding) => binding.capabilityId === "decision-hub",
  );
  const selectedDecisionHubConnection =
    connections.find(
      (connection) => connection.connectionId === decisionHubBinding?.target.connectionId,
    ) ?? null;
  const harnessStatusLine =
    chosenComputer === null
      ? "No target computer chosen."
      : (warning ?? `${harnessLabel}: reported available on ${chosenComputer.label}.`);
  const patchDraft = (patch: Partial<WorkjetWorkerDraft>) => {
    const next = updateWorkjetWorkerDraft(draft, patch);
    setDraft(next);
    onDraftChange?.(next);
    try {
      window.sessionStorage.setItem(
        `workjet-worker-draft:${encodeURIComponent(draftScopeKey)}:${worker?.id ?? "new"}`,
        JSON.stringify(next),
      );
    } catch {
      // The popup still retains its in-memory draft when storage is blocked.
    }
    setError(null);
  };
  const clearDraftStash = () => {
    try {
      window.sessionStorage.removeItem(
        `workjet-worker-draft:${encodeURIComponent(draftScopeKey)}:${worker?.id ?? "new"}`,
      );
    } catch {
      // Storage may be unavailable.
    }
  };

  return (
    <form
      data-settings-inline-editor=""
      className={cn(
        "space-y-4",
        !compact && "rounded-xl border border-border/60 bg-muted/15 p-3 sm:p-4",
      )}
      aria-label={worker ? `Edit Luma ${worker.name}` : "Add Luma"}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (saving) return;
        setSaving(true);
        setError(null);
        void (async () => {
          try {
            if (chosenRoute?.nativeAccountReference) {
              requireNativeLumaModel(chosenNativeAccount, draft.modelId.trim());
              if (onValidateNativeModel === undefined || chosenNativeAccount === undefined)
                throw new Error("Refresh the instance account before saving this Luma.");
              await onValidateNativeModel(chosenNativeAccount, draft.modelId.trim());
            } else assertLumaLiveModelChoice(draft, worker, chosenAccount, choiceCatalog);
            await onSave(saveWorkjetWorkerDraft(draft));
            clearDraftStash();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The Luma could not be saved.");
          } finally {
            setSaving(false);
          }
        })();
      }}
    >
      <fieldset disabled={saving} className="min-w-0 space-y-4">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="workjet-worker-name">Name</Label>
            <Input
              id="workjet-worker-name"
              nativeInput
              value={draft.name}
              onChange={(event) => patchDraft({ name: event.target.value })}
              placeholder="e.g. Completion engine"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workjet-worker-instructions">Task</Label>
            <Textarea
              id="workjet-worker-instructions"
              value={draft.instructions}
              onChange={(event) => patchDraft({ instructions: event.target.value })}
              placeholder="What should this Luma take on?"
              rows={5}
            />
          </div>
        </div>

        <section aria-label="Luma personality" className="space-y-2">
          <SectionHeader title="Personality profile" />
          <div className="pt-3">
            <WorkjetWorkerPersonalizationEditor
              value={draft.personalization}
              onChange={(personalization) => patchDraft({ personalization })}
            />
          </div>
        </section>

        <div className="space-y-1.5">
          <SectionHeader title="Harness" />
          <div className="flex flex-wrap gap-2">
            {WORKJET_HARNESS_OPTIONS.map((option) => (
              <ChoiceButton
                key={option.id}
                title={option.label}
                selected={draft.harness === option.id}
                onClick={() => patchDraft({ harness: option.id })}
              />
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <SectionHeader title="LLM route" />
          <div className="flex flex-wrap items-center gap-2">
            {routes.map((route) => (
              <ChoiceButton
                key={route.id}
                title={route.label}
                selected={draft.llmRouteId === route.id}
                onClick={() => patchDraft({ llmRouteId: route.id })}
              />
            ))}
            {onAddRoute ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  try {
                    window.sessionStorage.setItem(
                      `workjet-worker-draft:${encodeURIComponent(draftScopeKey)}:${worker?.id ?? "new"}`,
                      JSON.stringify(draft),
                    );
                  } catch {
                    // Without storage the navigation still works; only the
                    // stash is lost.
                  }
                  onAddRoute?.();
                }}
              >
                <PlusIcon className="size-3.5" />
                Add LLM route…
              </Button>
            ) : null}
          </div>
          {draft.llmRouteId ? (
            <p className="text-[11px] text-muted-foreground">
              Route: {routes.find((route) => route.id === draft.llmRouteId)?.label}
            </p>
          ) : (
            // Amber, not grey, and it names the consequence: a worker without a
            // route cannot run at all.
            <p className="text-[11px] text-amber-500">
              No LLM route chosen yet. Pick one to make this Luma usable.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="workjet-worker-model">Model</Label>
          {chosenRoute?.nativeAccountReference ? (
            <>
              <Select
                value={draft.modelId || null}
                onValueChange={(model) => {
                  if (model !== null) patchDraft({ modelId: model });
                }}
              >
                <SelectTrigger id="workjet-worker-model" className="w-full">
                  <SelectValue placeholder="Choose a live instance account model" />
                </SelectTrigger>
                <SelectPopup>
                  {(chosenNativeAccount?.modelCatalog.fresh
                    ? chosenNativeAccount.effectiveModels
                    : []
                  ).map((model) => (
                    <SelectItem key={model} value={model}>
                      <span className="break-all whitespace-normal">{model}</span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span role={nativeModelsError ? "alert" : "status"} className={nativeModelsError ? "text-destructive" : undefined}>
                  {nativeModelsError ?? (chosenNativeAccount?.modelCatalog.fresh
                    ? "Live instance account models. Execution availability is checked by CTOX."
                    : "Refresh this instance account in Settings → Models before choosing a model.")}
                </span>
                {onRefreshNativeModels && chosenNativeAccount && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={nativeModelsBusy}
                    onClick={() => onRefreshNativeModels(chosenNativeAccount)}
                  >
                    Refresh models
                  </Button>
                )}
              </div>
            </>
          ) : chosenAccount?.provider === "claude" ? (
            <>
              <Select
                value={draft.modelId || null}
                onValueChange={(model) => {
                  if (model !== null) patchDraft({ modelId: model });
                }}
              >
                <SelectTrigger id="workjet-worker-model" className="w-full">
                  <SelectValue placeholder="Choose a live account model" />
                </SelectTrigger>
                <SelectPopup>
                  {choiceCatalog?.accountId === chosenAccount.id &&
                  choiceCatalog.state === "observed" ? (
                    choiceCatalog.modelIds.map((model) => (
                      <SelectItem key={model} value={model}>
                        <span className="break-all whitespace-normal">{model}</span>
                      </SelectItem>
                    ))
                  ) : draft.modelId ? (
                    <SelectItem value={draft.modelId}>{draft.modelId} · saved</SelectItem>
                  ) : null}
                </SelectPopup>
              </Select>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span role="status">
                  {liveModels.isPending
                    ? "Reading this account's live model list…"
                    : choiceCatalog?.state !== "observed"
                      ? "Live model list unavailable. Check this account in Settings → Models."
                      : `Live list · ${chosenAccount.label}. This does not replace a model check.`}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={liveModels.isPending}
                  onClick={liveModels.refresh}
                >
                  Refresh models
                </Button>
              </div>
            </>
          ) : (
            <Input
              id="workjet-worker-model"
              nativeInput
              value={draft.modelId}
              onChange={(event) => patchDraft({ modelId: event.target.value })}
              placeholder="Model ID"
            />
          )}
        </div>

        <div className="space-y-1.5">
          <SectionHeader title="Reasoning" />
          <div className="flex flex-wrap gap-2">
            {REASONING_OPTIONS.map((option) => (
              <ChoiceButton
                key={option.id}
                title={option.label}
                selected={draft.reasoning === option.id}
                onClick={() => patchDraft({ reasoning: option.id })}
              />
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <SectionHeader title="Root role" />
          <div className="flex flex-wrap gap-2">
            <ChoiceButton
              title="Standard"
              selected={draft.role === "standard"}
              onClick={() => patchDraft({ role: "standard" })}
            />
            <ChoiceButton
              title="Orchestrator"
              selected={draft.role === "orchestrator"}
              onClick={() => patchDraft({ role: "orchestrator" })}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Orchestrator Lumas coordinate child Lumas. Child Lumas never inherit Decision Hub.
          </p>
        </div>

        <div className="space-y-1.5">
          <SectionHeader title="Tools" />
          <div className="space-y-2">
            {CAPABILITY_OPTIONS.map((capability) => {
              const checked = draft.capabilityIds.includes(capability.id);
              return (
                <div
                  key={capability.id}
                  className="flex items-start justify-between gap-3 rounded-lg bg-muted/25 p-2.5"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-xs font-medium">{capability.label}</p>
                    <p className="text-[11px] text-muted-foreground">{capability.description}</p>
                  </div>
                  <Switch
                    checked={checked}
                    onCheckedChange={(next) => {
                      const capabilityIds = next
                        ? [
                            ...draft.capabilityIds.filter((id) => id !== capability.id),
                            capability.id,
                          ]
                        : draft.capabilityIds.filter((id) => id !== capability.id);
                      if (capability.id !== "decision-hub") {
                        patchDraft({ capabilityIds });
                        return;
                      }
                      const automatic = connections.filter(
                        (connection) => connection.status === "ready",
                      )[0];
                      patchDraft({
                        capabilityIds,
                        capabilityBindings: next
                          ? automatic === undefined
                            ? []
                            : [
                                {
                                  capabilityId: "decision-hub",
                                  target: {
                                    kind: "ctox-connection",
                                    connectionId: automatic.connectionId,
                                  },
                                },
                              ]
                          : draft.capabilityBindings.filter(
                              (binding) => binding.capabilityId !== "decision-hub",
                            ),
                      });
                    }}
                    aria-label={`Tool ${capability.label}`}
                  />
                </div>
              );
            })}
          </div>
          {draft.capabilityIds.includes("decision-hub") ? (
            <div className="space-y-1.5 rounded-lg border border-border/60 p-2.5">
              <Label htmlFor="workjet-decision-hub-connection">CTOX connection</Label>
              <Select
                value={decisionHubBinding?.target.connectionId ?? ""}
                onValueChange={(connectionId) => {
                  if (connectionId === null) return;
                  patchDraft({
                    capabilityBindings: [
                      {
                        capabilityId: "decision-hub",
                        target: {
                          kind: "ctox-connection",
                          connectionId: WorkjetConnectionId.make(connectionId),
                        },
                      },
                    ],
                  });
                }}
              >
                <SelectTrigger id="workjet-decision-hub-connection">
                  <SelectValue placeholder="Choose a CTOX instance" />
                </SelectTrigger>
                <SelectPopup>
                  {connections.map((connection) => (
                    <SelectItem key={connection.connectionId} value={connection.connectionId}>
                      {connection.displayName} · {connection.status}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {decisionHubInstances.map((instance) => {
                const availability = instance.decisionHub;
                const local = instance.source === "local_daemon";
                const tenantId = instance.id.startsWith("managed:")
                  ? instance.id.slice("managed:".length)
                  : "";
                const canProvision =
                  (local
                    ? instance.status === "available"
                    : tenantId.length > 0 &&
                      availability?.eligible === true &&
                      availability.mcpEnabled &&
                      availability.instanceId !== null &&
                      availability.reason === null) &&
                  chosenComputer !== null &&
                  window.desktopBridge?.ctox?.provisionDecisionHub !== undefined;
                return (
                  <div
                    key={instance.id}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="truncate text-muted-foreground">
                      {local ? instance.displayName : availability?.displayName}
                      {local || availability?.reason === null ? "" : ` · ${availability?.reason}`}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!canProvision || provisioningTenantId !== null}
                      onClick={() => {
                        if (!canProvision || chosenComputer === null) return;
                        setProvisioningTenantId(instance.id);
                        void window.desktopBridge!.ctox!.provisionDecisionHub!({
                          environmentId: chosenComputer.environmentId,
                          target: local
                            ? { _tag: "local_ctox", instanceId: instance.id }
                            : { _tag: "ctox_dev", tenantId },
                        })
                          .then(async (result) => {
                            if (result._tag !== "completed") {
                              setError(`Decision Hub connection failed: ${result.code}.`);
                              return;
                            }
                            patchDraft({
                              capabilityBindings: [
                                {
                                  capabilityId: "decision-hub",
                                  target: {
                                    kind: "ctox-connection",
                                    connectionId: result.connection.connectionId,
                                  },
                                },
                              ],
                            });
                            decisionHubConnections.refresh();
                          })
                          .catch(() => setError("Decision Hub connection failed."))
                          .finally(() => setProvisioningTenantId(null));
                      }}
                    >
                      {provisioningTenantId === instance.id ? "Connecting…" : "Connect"}
                    </Button>
                  </div>
                );
              })}
              {connections.length === 0 ? (
                <p role="alert" className="text-[11px] text-amber-500">
                  No MCP-capable CTOX connection is provisioned on this target computer.
                </p>
              ) : selectedDecisionHubConnection === null ? (
                <p role="alert" className="text-[11px] text-amber-500">
                  Choose a connection before saving.
                </p>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <p
                    role="status"
                    className={cn(
                      "text-[11px]",
                      selectedDecisionHubConnection.status === "ready"
                        ? "text-emerald-500"
                        : "text-amber-500",
                    )}
                  >
                    MCP: {selectedDecisionHubConnection.status}
                    {selectedDecisionHubConnection.reason
                      ? ` — ${selectedDecisionHubConnection.reason}`
                      : ""}
                  </p>
                  {chosenComputer !== null &&
                  window.desktopBridge?.ctox?.disconnectDecisionHub !== undefined ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disconnectingConnectionId !== null}
                      onClick={() => {
                        const connectionId = selectedDecisionHubConnection.connectionId;
                        setDisconnectingConnectionId(connectionId);
                        void window.desktopBridge!.ctox!.disconnectDecisionHub!({
                          environmentId: chosenComputer.environmentId,
                          connectionId,
                        })
                          .then((result) => {
                            if (result._tag !== "completed") {
                              setError(`Decision Hub disconnect failed: ${result.code}.`);
                              return;
                            }
                            patchDraft({
                              capabilityBindings: draft.capabilityBindings.filter(
                                (binding) => binding.capabilityId !== "decision-hub",
                              ),
                            });
                            decisionHubConnections.refresh();
                          })
                          .catch(() => setError("Decision Hub disconnect failed."))
                          .finally(() => setDisconnectingConnectionId(null));
                      }}
                    >
                      {disconnectingConnectionId === selectedDecisionHubConnection.connectionId
                        ? "Disconnecting…"
                        : "Disconnect"}
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <SectionHeader title="Target computer" />
          <div className="flex flex-wrap gap-2">
            {computers.map((computer) => (
              <ChoiceButton
                key={computer.id}
                title={computer.label}
                selected={draft.computerId === computer.id}
                onClick={() =>
                  patchDraft({
                    computerId: computer.id,
                    capabilityBindings: draft.capabilityBindings.filter(
                      (binding) => binding.capabilityId !== "decision-hub",
                    ),
                  })
                }
              />
            ))}
          </div>
          {/* The harness status for the CHOSEN computer, on the same screen as
            the choice. Swift puts it here because the answer to "can this
            worker actually run" belongs beside the machine, not on another
            page. */}
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                warning === null ? "bg-emerald-500" : "bg-amber-500",
              )}
            />
            {harnessStatusLine}
          </p>
        </div>

        {/* Native <details>: the direct analogue of Swift's DisclosureGroup,
          keyboard- and screen-reader-correct without a library. */}
        <details className="group">
          <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
            <span aria-hidden className="mr-1 inline-block group-open:rotate-90">
              &#9656;
            </span>
            Technical details
          </summary>
          <div>
            <dl className="mt-2 space-y-1 rounded-lg bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
              <div className="flex gap-2">
                <dt className="w-28 shrink-0">Harness</dt>
                <dd className="font-mono">{draft.harness}</dd>
              </div>
              {/* Labels, not raw catalog ids: the operator recognises "gpu3",
                not a UUID. The id stays reachable as the hover title. */}
              <div className="flex gap-2">
                <dt className="w-28 shrink-0">Computer</dt>
                <dd title={draft.computerId || undefined}>
                  {chosenComputer?.label ?? (draft.computerId ? "Missing computer" : "—")}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0">Access</dt>
                <dd title={draft.llmRouteId || undefined}>
                  {routes.find((route) => route.id === draft.llmRouteId)?.label ??
                    (draft.llmRouteId ? "Missing route" : "—")}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-28 shrink-0">Model</dt>
                <dd className="font-mono">{draft.modelId || "—"}</dd>
              </div>
            </dl>
          </div>
        </details>

        {warning ? (
          <p role="alert" className="text-xs text-warning-foreground">
            {warning}
          </p>
        ) : null}
        {routes.length === 0 ? (
          <p role="status" className="text-xs text-muted-foreground">
            Add an LLM route in Settings → Models before saving this Luma.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Computer targets and remote environments are managed in Settings → Computers. This profile
          stores the selected target and declared harness availability.
        </p>
        <div className="sticky bottom-0 flex justify-end gap-2 bg-popover py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              clearDraftStash();
              onCancel();
            }}
          >
            {compact ? "Discard changes" : "Cancel"}
          </Button>
          <Button type="submit" size="sm" disabled={computers.length === 0 || routes.length === 0}>
            {saving ? "Saving…" : "Save Luma"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
