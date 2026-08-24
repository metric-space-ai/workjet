// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The composer bar's Workjet TARGET controls — where and on what the next
 * turn runs (docs → chat-composer two-mode rework).
 *
 * Worker mode bar:  Worker · Computer · Extras. Nothing else.
 * Manual mode bar:  Harness · Provider · Model · Computer · Extras, plus a
 *                   custom-system-prompt affordance.
 *
 * The computer ("Rechner") control is SELECTABLE in both modes: on a draft it
 * moves the draft to the chosen computer's environment through the existing
 * draft environment-change path; on a started server thread it is disabled
 * with a stated reason, because mid-session migration is a separate project.
 * It never silently no-ops — a computer whose environment this project is not
 * paired with renders as a disabled option that says so.
 */
import type {
  EnvironmentId,
  WorkjetComputer,
  WorkjetGatewayModelSummary,
  WorkjetHarness,
  WorkjetLlmRoute,
  WorkjetWorkerProfile,
} from "@t3tools/contracts";
import { Fragment, memo, useState, type ReactNode } from "react";
import { CpuIcon, FileTextIcon, MonitorIcon, TerminalIcon, TriangleAlertIcon } from "lucide-react";

import { WORKJET_HARNESS_OPTIONS } from "../settings/WorkjetWorkerEditor";
import { ComposerControl, ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { MANUAL_WORKER_VALUE, providerInstanceIdForHarness } from "./ComposerWorkerControl";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Why the computer control refuses on a started thread. Mid-session migration
 * means moving a live provider session between machines — a separate project,
 * not a dropdown.
 */
export const COMPOSER_COMPUTER_LOCKED_REASON =
  "This thread already runs on its computer. Moving a started session to another computer is a separate project.";

/** The option hint for a computer this project has no environment on. */
export const COMPOSER_COMPUTER_NOT_PAIRED_HINT =
  "Not paired — this project has no environment on this computer.";

const NO_COMPUTER_VALUE = "__no_computer__";

/**
 * Whether the current draft could move to this computer's environment — the
 * same logical project must exist there. Shared by the wide select and the
 * compact menu so both refuse identically, with the reason on the option.
 */
export function isComputerPaired(
  computer: WorkjetComputer,
  activeEnvironmentId: EnvironmentId,
  selectableEnvironmentIds: ReadonlySet<EnvironmentId>,
): boolean {
  return (
    computer.environmentId === activeEnvironmentId ||
    selectableEnvironmentIds.has(computer.environmentId)
  );
}

/**
 * The reverse of {@link providerInstanceIdForHarness}: which harness the
 * composer's current provider instance belongs to, `null` for an instance no
 * harness maps to (e.g. a custom instance).
 */
export function harnessForProviderInstanceId(instanceId: string): WorkjetHarness | null {
  for (const option of WORKJET_HARNESS_OPTIONS) {
    if (providerInstanceIdForHarness(option.id) === instanceId) return option.id;
  }
  return null;
}

/**
 * The harness choices the manual bar offers. A harness this build has no
 * provider instance for is HIDDEN (there is nothing to run it on, so listing
 * it would be a dead control); one whose instance exists but is not configured
 * is disabled with the reason on the option.
 */
export function composerHarnessOptions(configuredInstanceIds: ReadonlySet<string>): ReadonlyArray<{
  readonly id: WorkjetHarness;
  readonly label: string;
  readonly instanceId: string;
  readonly configured: boolean;
}> {
  const options: Array<{
    id: WorkjetHarness;
    label: string;
    instanceId: string;
    configured: boolean;
  }> = [];
  for (const option of WORKJET_HARNESS_OPTIONS) {
    const instanceId = providerInstanceIdForHarness(option.id);
    if (instanceId === null) continue;
    options.push({
      id: option.id,
      label: option.label,
      instanceId,
      configured: configuredInstanceIds.has(instanceId),
    });
  }
  return options;
}

/** Gateway catalog models narrowed to the accounts behind one LLM route. */
export function gatewayModelsForRoute(
  models: ReadonlyArray<WorkjetGatewayModelSummary>,
  route: WorkjetLlmRoute | null,
): ReadonlyArray<WorkjetGatewayModelSummary> {
  if (route === null) return models;
  const scoped = models.filter((model) => model.accountIds.includes(route.gatewayAccountId));
  // A catalog that does not link this route's account to any model would
  // leave the control empty and lie about the gateway offering nothing;
  // fall back to the whole catalog instead.
  return scoped.length > 0 ? scoped : models;
}

// ---------------------------------------------------------------------------
// Computer ("Rechner")
// ---------------------------------------------------------------------------

export interface ComposerComputerControlProps {
  readonly computers: ReadonlyArray<WorkjetComputer>;
  /** The computer whose environment the composer currently targets, if any. */
  readonly selectedComputerId: string | null;
  readonly activeEnvironmentId: EnvironmentId;
  /** Environments the current draft can actually move to (same logical project). */
  readonly selectableEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** Non-null disables the whole control and states why (started threads). */
  readonly disabledReason: string | null;
  /** Worker-mode mismatch, e.g. the worker's computer is not paired here. */
  readonly mismatchNote: string | null;
  readonly onSelectComputer: (computerId: string) => void;
  /** Jump to Settings → Computers to create one (operator request). */
  readonly onAddComputer?: (() => void) | undefined;
}

/** Exported unwrapped so a test can call it; `memo` returns an object. */
export function ComposerComputerControlView(props: ComposerComputerControlProps) {
  const selected = props.computers.find((c) => c.id === props.selectedComputerId) ?? null;
  const selectable = new Set(props.selectableEnvironmentIds);
  const disabled = props.disabledReason !== null;
  const tooltip =
    props.disabledReason ??
    props.mismatchNote ??
    (selected === null
      ? "Computer — choose where this thread runs"
      : `Computer: ${selected.label}`);

  return (
    // The wrapping span keeps a NATIVE title on the disabled state: the
    // disabled trigger swallows pointer events, so the tooltip alone would
    // leave the refusal reasonless.
    <span
      className="inline-flex shrink-0 items-center"
      {...(disabled ? { title: props.disabledReason ?? undefined } : {})}
      data-composer-computer-control="true"
    >
      <Tooltip>
        <Select
          value={props.selectedComputerId ?? NO_COMPUTER_VALUE}
          disabled={disabled}
          onValueChange={(value) => {
            if (typeof value !== "string" || value === NO_COMPUTER_VALUE) return;
            if (value === "__add_computer__") {
              props.onAddComputer?.();
              return;
            }
            props.onSelectComputer(value);
          }}
        >
          <TooltipTrigger
            render={
              <ComposerSelectControl
                className="font-medium"
                aria-label="Computer"
                {...(props.mismatchNote === null ? {} : { "data-computer-mismatch": "true" })}
              />
            }
          >
            <ComposerControlIcon icon={MonitorIcon} />
            <SelectValue>{selected?.label ?? "Computer"}</SelectValue>
            {props.mismatchNote === null ? null : (
              <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
            )}
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {props.selectedComputerId !== null && selected !== null ? null : (
              <SelectItem
                value={NO_COMPUTER_VALUE}
                disabled
                hideIndicator
                className="min-w-64 py-2"
              >
                <span className="text-xs text-muted-foreground">
                  {props.computers.length === 0
                    ? "No computers — set one up in Workjet settings"
                    : "Not bound to a Workjet computer"}
                </span>
              </SelectItem>
            )}
            {props.computers.map((computer) => {
              const paired = isComputerPaired(computer, props.activeEnvironmentId, selectable);
              return (
                <SelectItem
                  key={computer.id}
                  value={computer.id}
                  disabled={!paired}
                  hideIndicator
                  className="min-w-64 py-2"
                >
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-medium text-foreground">{computer.label}</span>
                    <span className="truncate text-xs leading-4 text-muted-foreground">
                      {paired ? computer.presentationKind : COMPOSER_COMPUTER_NOT_PAIRED_HINT}
                    </span>
                  </div>
                </SelectItem>
              );
            })}
            {props.onAddComputer === undefined ? null : (
              <SelectItem value="__add_computer__" hideIndicator className="min-w-56 py-2">
                <span className="text-xs text-muted-foreground">+ Add computer…</span>
              </SelectItem>
            )}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
    </span>
  );
}

export const ComposerComputerControl = memo(ComposerComputerControlView);

// ---------------------------------------------------------------------------
// Manual mode: Harness · Model. There is NO separate provider chip — with
// the Workjet gateway the MODEL determines the serving account (accounts
// route by model pattern), so a provider select was a redundant third field;
// the model menu groups by provider instead.
// ---------------------------------------------------------------------------

const CUSTOM_MODEL_VALUE = "__custom_model__";
const NO_HARNESS_VALUE = "__no_harness__";

/**
 * Group headers for the model menu. Kept as a local map instead of importing
 * the settings page's label table — pulling a settings component into the
 * composer chunk for seven strings would be the heavier coupling.
 */
const GATEWAY_PROVIDER_GROUP_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex (OpenAI)",
  antigravity: "Antigravity",
  zai: "Z.ai (GLM)",
  minimax: "MiniMax",
  xai: "xAI (Grok)",
  kimi: "Kimi (Moonshot)",
};

export interface ComposerManualTargetControlsProps {
  /** Provider instance ids this turn may actually target. */
  readonly configuredInstanceIds: ReadonlySet<string>;
  /** Why an instance outside that set is refused; defaults to "not configured". */
  readonly unavailableHint?: string | undefined;
  readonly selectedHarness: WorkjetHarness | null;
  readonly onSelectHarness: (harness: WorkjetHarness) => void;
  /** The FULL gateway catalog; the menu groups the models by provider. */
  readonly models: ReadonlyArray<WorkjetGatewayModelSummary>;
  /** Why the model list may be empty; shown instead of a silent blank. */
  readonly modelsUnavailableReason: string | null;
  readonly selectedModelId: string;
  readonly onSelectModel: (modelId: string) => void;
}

/** Exported unwrapped so a test can call it; `memo` returns an object. */
export function ComposerManualTargetControlsView(props: ComposerManualTargetControlsProps) {
  // Free-text fallback: the gateway catalog is a discovery aid, not an
  // authority — any model id the gateway accepts may be typed directly.
  const [customModelDraft, setCustomModelDraft] = useState<string | null>(null);

  const harnessOptions = composerHarnessOptions(props.configuredInstanceIds);
  const selectedHarnessOption =
    harnessOptions.find((option) => option.id === props.selectedHarness) ?? null;
  const modelInCatalog = props.models.some((model) => model.id === props.selectedModelId);
  // Group by the model's FIRST provider; a model served by several accounts
  // still appears once, under its primary provider.
  const modelGroups = (() => {
    const groups = new Map<string, WorkjetGatewayModelSummary[]>();
    for (const model of props.models) {
      const key = model.providers[0] ?? "other";
      const list = groups.get(key) ?? [];
      list.push(model);
      groups.set(key, list);
    }
    return [...groups.entries()];
  })();

  const commitCustomModel = () => {
    const next = customModelDraft?.trim() ?? "";
    setCustomModelDraft(null);
    if (next.length > 0 && next !== props.selectedModelId) props.onSelectModel(next);
  };

  return (
    <span className="flex shrink-0 items-center gap-1" data-composer-manual-target-controls="true">
      {/* Harness */}
      <Tooltip>
        <Select
          value={props.selectedHarness ?? NO_HARNESS_VALUE}
          onValueChange={(value) => {
            if (typeof value !== "string" || value === NO_HARNESS_VALUE) return;
            props.onSelectHarness(value as WorkjetHarness);
          }}
        >
          <TooltipTrigger render={<ComposerSelectControl aria-label="Harness" />}>
            <ComposerControlIcon icon={TerminalIcon} />
            <SelectValue>{selectedHarnessOption?.label ?? "Harness"}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {props.selectedHarness === null ? (
              <SelectItem value={NO_HARNESS_VALUE} disabled hideIndicator className="min-w-56 py-2">
                <span className="text-xs text-muted-foreground">
                  The current provider matches no Workjet harness
                </span>
              </SelectItem>
            ) : null}
            {harnessOptions.map((option) => (
              <SelectItem
                key={option.id}
                value={option.id}
                disabled={!option.configured}
                hideIndicator
                className="min-w-56 py-2"
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="font-medium text-foreground">{option.label}</span>
                  {option.configured ? null : (
                    <span className="truncate text-xs leading-4 text-muted-foreground">
                      {props.unavailableHint ?? "Not configured in this build"}
                    </span>
                  )}
                </div>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">
          Harness — the agent runtime that drives the turn. Any harness combines with any model.
        </TooltipPopup>
      </Tooltip>

      {/* Model */}
      {customModelDraft === null ? (
        <Tooltip>
          <Select
            value={modelInCatalog || props.selectedModelId.length > 0 ? props.selectedModelId : ""}
            onValueChange={(value) => {
              if (typeof value !== "string" || value.length === 0) return;
              if (value === CUSTOM_MODEL_VALUE) {
                setCustomModelDraft(props.selectedModelId);
                return;
              }
              props.onSelectModel(value);
            }}
          >
            <TooltipTrigger render={<ComposerSelectControl aria-label="Model" />}>
              <ComposerControlIcon icon={CpuIcon} />
              <SelectValue>
                {props.selectedModelId.length > 0 ? props.selectedModelId : "Model"}
              </SelectValue>
            </TooltipTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {modelInCatalog || props.selectedModelId.length === 0 ? null : (
                <SelectItem value={props.selectedModelId} hideIndicator className="min-w-64 py-2">
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-medium text-foreground">{props.selectedModelId}</span>
                    <span className="truncate text-xs leading-4 text-muted-foreground">
                      Current selection — not in the gateway catalog
                    </span>
                  </div>
                </SelectItem>
              )}
              {modelGroups.map(([provider, models]) => (
                <Fragment key={provider}>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                    {GATEWAY_PROVIDER_GROUP_LABELS[provider] ?? provider}
                  </div>
                  {models.map((model) => (
                    <SelectItem
                      key={model.id}
                      value={model.id}
                      hideIndicator
                      className="min-w-64 py-2"
                    >
                      <div className="grid min-w-0 gap-0.5">
                        <span className="font-medium text-foreground">{model.displayName}</span>
                        {model.displayName === model.id ? null : (
                          <span className="truncate text-xs leading-4 text-muted-foreground">
                            {model.id}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </Fragment>
              ))}
              {props.models.length === 0 && props.modelsUnavailableReason !== null ? (
                <SelectItem
                  value="__models_unavailable__"
                  disabled
                  hideIndicator
                  className="min-w-64 py-2"
                >
                  <span className="text-xs text-muted-foreground">
                    {props.modelsUnavailableReason}
                  </span>
                </SelectItem>
              ) : null}
              <SelectItem value={CUSTOM_MODEL_VALUE} hideIndicator className="min-w-64 py-2">
                <span className="text-xs text-muted-foreground">Custom model id…</span>
              </SelectItem>
            </SelectPopup>
          </Select>
          <TooltipPopup side="top">
            Model — served by the Workjet gateway; the model decides which provider account answers
          </TooltipPopup>
        </Tooltip>
      ) : (
        <Input
          autoFocus
          value={customModelDraft}
          aria-label="Custom model id"
          placeholder="model id"
          className="h-7 w-44 text-xs"
          onChange={(event) => setCustomModelDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitCustomModel();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setCustomModelDraft(null);
            }
          }}
          onBlur={commitCustomModel}
        />
      )}
    </span>
  );
}

export const ComposerManualTargetControls = memo(ComposerManualTargetControlsView);

// ---------------------------------------------------------------------------
// Custom system prompt (manual mode)
// ---------------------------------------------------------------------------

export interface ComposerSystemPromptControlProps {
  readonly value: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  /** On a draft the edit is held locally and applied when the thread starts. */
  readonly draftPending: boolean;
  readonly onApply: (text: string) => void;
}

/** Exported unwrapped so a test can call it; `memo` returns an object. */
export function ComposerSystemPromptControlView(props: ComposerSystemPromptControlProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(props.value);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setText(props.value);
      }}
    >
      <PopoverTrigger
        disabled={props.disabled}
        render={
          <ComposerControl
            type="button"
            className="shrink-0 whitespace-nowrap"
            aria-label="System prompt"
            title="Custom system prompt for this thread"
          />
        }
      >
        <ComposerControlIcon icon={FileTextIcon} />
        <span className="sr-only sm:not-sr-only">System prompt</span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-96 p-3">
        <div className="grid gap-2">
          <span className="text-xs font-medium text-muted-foreground">Custom system prompt</span>
          <Textarea
            value={text}
            rows={6}
            aria-label="Custom system prompt"
            placeholder="Managed instructions prepended to this thread's system prompt"
            onChange={(event) => setText(event.target.value)}
          />
          <p className="text-xs leading-4 text-muted-foreground">
            {props.draftPending
              ? "Held locally and applied when this draft becomes a thread."
              : "Takes effect for the next provider session started in this thread."}
          </p>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={props.busy || text === props.value}
              onClick={() => {
                props.onApply(text);
                setOpen(false);
              }}
            >
              {props.busy ? "Applying…" : "Apply"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export const ComposerSystemPromptControl = memo(ComposerSystemPromptControlView);

// ---------------------------------------------------------------------------
// Compact footer: Worker + Computer inside the overflow menu
// ---------------------------------------------------------------------------

export interface ComposerWorkjetCompactMenuContentProps {
  readonly workers: ReadonlyArray<WorkjetWorkerProfile>;
  readonly selectedWorkerId: string | null;
  readonly onSelectWorker: (workerId: string | null) => void;
  readonly computers: ReadonlyArray<WorkjetComputer>;
  readonly selectedComputerId: string | null;
  readonly activeEnvironmentId: EnvironmentId;
  readonly selectableEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly computerDisabledReason: string | null;
  readonly onSelectComputer: (computerId: string) => void;
  /** Accepted for call-site symmetry with the wide control; the compact
      overflow menu offers no add entry (navigation from inside a nested
      menu closes over the draft state mid-gesture). */
  readonly onAddComputer?: (() => void) | undefined;
}

/**
 * The Worker and Computer choices, folded into the compact footer's overflow
 * menu so both exist below the breakpoint — the wide bar's selects rendered as
 * the menu's native radio groups.
 */
export function ComposerWorkjetCompactMenuContent(
  props: ComposerWorkjetCompactMenuContentProps,
): ReactNode {
  const selectable = new Set(props.selectableEnvironmentIds);
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>Worker</MenuGroupLabel>
        <MenuRadioGroup
          value={props.selectedWorkerId ?? MANUAL_WORKER_VALUE}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            props.onSelectWorker(value === MANUAL_WORKER_VALUE ? null : value);
          }}
        >
          <MenuRadioItem value={MANUAL_WORKER_VALUE}>Manual</MenuRadioItem>
          {props.workers.map((worker) => (
            <MenuRadioItem key={worker.id} value={worker.id}>
              {worker.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
      <MenuGroup>
        <MenuGroupLabel>Computer</MenuGroupLabel>
        {props.computerDisabledReason !== null ? (
          <p className="max-w-72 px-2 pt-1 pb-1.5 text-xs leading-4 text-muted-foreground">
            {props.computerDisabledReason}
          </p>
        ) : props.computers.length === 0 ? (
          <p className="max-w-72 px-2 pt-1 pb-1.5 text-xs leading-4 text-muted-foreground">
            No computers — set one up in Workjet settings
          </p>
        ) : (
          <MenuRadioGroup
            value={props.selectedComputerId ?? ""}
            onValueChange={(value) => {
              if (typeof value !== "string" || value.length === 0) return;
              props.onSelectComputer(value);
            }}
          >
            {props.computers.map((computer) => {
              const paired = isComputerPaired(computer, props.activeEnvironmentId, selectable);
              return (
                <MenuRadioItem key={computer.id} value={computer.id} disabled={!paired}>
                  {computer.label}
                  {paired ? "" : " — not paired"}
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        )}
      </MenuGroup>
    </>
  );
}
