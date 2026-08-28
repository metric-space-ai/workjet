// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The composer bar's Workjet TARGET controls — where and on what the next
 * turn runs (docs → chat-composer two-mode rework).
 *
 * Worker mode bar:  Worker · Computer · Context · Tools · Upload. Nothing else.
 * Manual mode bar:  Worker/Manual · Computer · Harness · Model · Effort/Context
 *                   · System Prompt · Tools · Upload.
 *
 * The computer ("Rechner") control is SELECTABLE in both modes: on a draft it
 * moves the draft to the chosen computer's environment through the existing
 * draft environment-change path; on a started server thread it is disabled
 * with a stated reason, because mid-session migration is a separate project.
 * It never silently no-ops — a computer where this logical project is not
 * available renders as a disabled option that says so. This is deliberately
 * not described as device pairing: a Workjet installation can be connected
 * while a particular project is absent there.
 */
import type {
  EnvironmentId,
  WorkjetComputer,
  WorkjetGatewayModelSummary,
  WorkjetGatewayProvider,
  WorkjetHarness,
  WorkjetLlmRoute,
  WorkjetWorkerProfile,
} from "@t3tools/contracts";
import { Fragment, memo, useState, type ReactNode } from "react";
import { CpuIcon, FileTextIcon, MonitorIcon, TerminalIcon, TriangleAlertIcon } from "lucide-react";

import { WORKJET_HARNESS_OPTIONS } from "../settings/WorkjetWorkerEditor";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  ComposerControl,
  ComposerControlIcon,
  ComposerSelectControl,
  ComposerControlChevron,
} from "./ComposerControl";
import { MANUAL_WORKER_VALUE, providerInstanceIdForHarness } from "./ComposerWorkerControl";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import {
  AntigravityIcon,
  ClaudeAI,
  KimiIcon,
  MiniMaxIcon,
  OpenAI,
  XaiIcon,
  ZaiIcon,
} from "../Icons";
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

/** The option hint for a connected computer this project has no environment on. */
export const COMPOSER_COMPUTER_PROJECT_UNAVAILABLE_HINT =
  "This project is not available on this computer.";

const NO_COMPUTER_VALUE = "__no_computer__";

/**
 * Whether the current draft could move to this computer's environment — the
 * same logical project must exist there. Shared by the wide select and the
 * compact menu so both refuse identically, with the reason on the option.
 */
export function isProjectAvailableOnComputer(
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
                className="min-w-0 max-w-52 font-medium"
                aria-label="Computer"
                {...(props.mismatchNote === null ? {} : { "data-computer-mismatch": "true" })}
              />
            }
          >
            <ComposerControlIcon icon={MonitorIcon} />
            {/* An id whose computer was deleted must not masquerade as the
                neutral placeholder (Befund K-AH4). */}
            <SelectValue className="min-w-0">
              {selected?.label ??
                (props.selectedComputerId !== null ? "Missing computer" : "Computer")}
            </SelectValue>
            {props.mismatchNote === null &&
            !(props.selectedComputerId !== null && selected === null) ? null : (
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
                    ? "No computers — add one in Settings → Computers"
                    : "Not bound to a Workjet computer"}
                </span>
              </SelectItem>
            )}
            {props.computers.map((computer) => {
              const projectAvailable = isProjectAvailableOnComputer(
                computer,
                props.activeEnvironmentId,
                selectable,
              );
              return (
                <SelectItem
                  key={computer.id}
                  value={computer.id}
                  disabled={!projectAvailable}
                  hideIndicator
                  className="min-w-64 py-2"
                >
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-medium text-foreground">{computer.label}</span>
                    <span className="truncate text-xs leading-4 text-muted-foreground">
                      {projectAvailable
                        ? workjetComputerKindLabel(computer.presentationKind)
                        : COMPOSER_COMPUTER_PROJECT_UNAVAILABLE_HINT}
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
const GATEWAY_PROVIDER_RAIL_ICONS: Readonly<
  Record<string, React.FC<React.SVGProps<SVGSVGElement>>>
> = {
  // The provider marks the Swift app already shipped, ported to Icons.tsx.
  claude: ClaudeAI,
  codex: OpenAI,
  xai: XaiIcon,
  zai: ZaiIcon,
  kimi: KimiIcon,
  minimax: MiniMaxIcon,
  antigravity: AntigravityIcon,
};

const GATEWAY_PROVIDER_GROUP_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex (OpenAI)",
  antigravity: "Antigravity",
  zai: "Z.ai (GLM)",
  minimax: "MiniMax",
  xai: "xAI (Grok)",
  kimi: "Kimi (Moonshot)",
};

/**
 * The provider rail is product navigation, not a projection of the latest
 * catalog response. Keeping it stable prevents the whole mini menu from
 * collapsing into an oversized empty-state panel while discovery refreshes.
 */
export const COMPOSER_GATEWAY_PROVIDER_RAIL: ReadonlyArray<WorkjetGatewayProvider> = [
  "claude",
  "codex",
  "xai",
  "zai",
  "kimi",
  "minimax",
  "antigravity",
];

/**
 * Group by the model's FIRST provider; a model served by several accounts
 * still appears once, under its primary provider. Shared by the wide mini
 * menu and the compact overflow menu so both group identically.
 */
function groupGatewayModelsByProvider(
  models: ReadonlyArray<WorkjetGatewayModelSummary>,
): Map<string, WorkjetGatewayModelSummary[]> {
  const groups = new Map<string, WorkjetGatewayModelSummary[]>();
  for (const model of models) {
    const key = model.providers[0] ?? "other";
    const list = groups.get(key) ?? [];
    list.push(model);
    groups.set(key, list);
  }
  return groups;
}

export function composerGatewayModelMenuGroups(
  models: ReadonlyArray<WorkjetGatewayModelSummary>,
): ReadonlyArray<readonly [string, ReadonlyArray<WorkjetGatewayModelSummary>]> {
  const grouped = groupGatewayModelsByProvider(models);
  const stable = COMPOSER_GATEWAY_PROVIDER_RAIL.map(
    (provider) => [provider, grouped.get(provider) ?? []] as const,
  );
  const additional = [...grouped.entries()].filter(
    ([provider]) => !COMPOSER_GATEWAY_PROVIDER_RAIL.includes(provider as WorkjetGatewayProvider),
  );
  return [...stable, ...additional];
}

export function inferGatewayProviderFromModelId(modelId: string): WorkjetGatewayProvider | null {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.startsWith("claude")) return "claude";
  if (/^(gpt|o[134]|codex)/u.test(normalized)) return "codex";
  if (normalized.startsWith("grok")) return "xai";
  if (/^(glm|zai)/u.test(normalized)) return "zai";
  if (/^(kimi|moonshot)/u.test(normalized)) return "kimi";
  if (normalized.startsWith("minimax")) return "minimax";
  if (/^(gemini|antigravity)/u.test(normalized)) return "antigravity";
  return null;
}

/**
 * Presentation-kind wording — the raw enum ("t3-connect") leaked into the
 * computer dropdown and the settings rows (K-B5).
 */
export const WORKJET_COMPUTER_KIND_LABELS: Readonly<Record<string, string>> = {
  local: "This computer",
  "t3-connect": "Workjet Connect",
  ssh: "SSH",
  tailscale: "Tailscale",
  remote: "Remote",
};

export function workjetComputerKindLabel(kind: string): string {
  return WORKJET_COMPUTER_KIND_LABELS[kind] ?? kind;
}

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
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelProviderChoice, setModelProviderChoice] = useState<string | null>(null);
  const placeModelMenuBesideComposer = useMediaQuery("(max-width: 700px)");

  const harnessOptions = composerHarnessOptions(props.configuredInstanceIds);
  const selectedHarnessOption =
    harnessOptions.find((option) => option.id === props.selectedHarness) ?? null;
  const selectedModelSummary = props.models.find((model) => model.id === props.selectedModelId);
  const modelInCatalog = selectedModelSummary !== undefined;
  const modelGroups = composerGatewayModelMenuGroups(props.models);
  const selectedModelProvider =
    props.models.find((model) => model.id === props.selectedModelId)?.providers[0] ??
    inferGatewayProviderFromModelId(props.selectedModelId);
  // The rail's active provider: the explicit pick, else the provider of the
  // current model, else the first group.
  const activeModelProvider =
    modelProviderChoice ??
    selectedModelProvider ??
    modelGroups.find(([, models]) => models.length > 0)?.[0] ??
    COMPOSER_GATEWAY_PROVIDER_RAIL[0];
  const activeProviderModels =
    modelGroups.find(([provider]) => provider === activeModelProvider)?.[1] ?? [];
  const showCurrentCustomModel =
    !modelInCatalog &&
    props.selectedModelId.length > 0 &&
    (selectedModelProvider ?? activeModelProvider) === activeModelProvider;

  const commitCustomModel = () => {
    const next = customModelDraft?.trim() ?? "";
    setCustomModelDraft(null);
    if (next.length > 0 && next !== props.selectedModelId) props.onSelectModel(next);
  };

  return (
    <span
      className="flex min-w-0 max-w-full shrink-0 items-center gap-1"
      data-composer-manual-target-controls="true"
    >
      {/* Harness */}
      <Tooltip>
        <Select
          value={props.selectedHarness ?? NO_HARNESS_VALUE}
          onValueChange={(value) => {
            if (typeof value !== "string" || value === NO_HARNESS_VALUE) return;
            props.onSelectHarness(value as WorkjetHarness);
          }}
        >
          <TooltipTrigger
            render={<ComposerSelectControl className="min-w-0 max-w-32" aria-label="Harness" />}
          >
            <ComposerControlIcon icon={TerminalIcon} />
            <SelectValue className="min-w-0">
              {selectedHarnessOption?.label ?? "Harness"}
            </SelectValue>
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

      {/* Model — the T3-style mini menu: a provider rail on the left, the
          selected provider's models on the right, plus the free-text escape
          hatch. Data source is the Workjet gateway catalog. */}
      {customModelDraft === null ? (
        <Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
          <Tooltip disabled={modelMenuOpen}>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <ComposerControl
                      className="min-w-0 max-w-56"
                      aria-label="Model"
                      type="button"
                    />
                  }
                >
                  <ComposerControlIcon icon={CpuIcon} />
                  <span className="min-w-0 truncate">
                    {selectedModelSummary?.displayName ??
                      (props.selectedModelId.length > 0 ? props.selectedModelId : "Model")}
                  </span>
                  <ComposerControlChevron />
                </PopoverTrigger>
              }
            />
            <TooltipPopup side="top">
              Model — served by the Workjet gateway; the model decides which provider account
              answers
            </TooltipPopup>
          </Tooltip>
          <PopoverPopup
            side={placeModelMenuBesideComposer ? "right" : "top"}
            align={placeModelMenuBesideComposer ? "center" : "start"}
            className="w-[19rem] max-w-[calc(100vw-1rem)] overflow-hidden p-0"
            // Children render inside the popup's inner VIEWPORT, not the popup
            // itself — flex on the popup silently stacked rail and list
            // vertically (measured: rail above, models below).
            viewportClassName="p-0"
          >
            {/* Own flex wrapper: the popup viewport nests children inside a
                transition pane, so flex on the viewport never reaches them. */}
            <div className="flex min-w-0 flex-row" data-composer-model-mini-menu="true">
              <div className="flex shrink-0 flex-col gap-1 border-r border-border/60 bg-muted/30 p-1.5">
                {modelGroups.map(([provider]) => {
                  const RailIcon = GATEWAY_PROVIDER_RAIL_ICONS[provider];
                  const active = provider === activeModelProvider;
                  return (
                    <button
                      key={provider}
                      type="button"
                      aria-label={GATEWAY_PROVIDER_GROUP_LABELS[provider] ?? provider}
                      className={
                        "inline-flex size-8 items-center justify-center rounded-md text-foreground/80 transition-colors " +
                        (active ? "bg-accent text-accent-foreground" : "hover:bg-muted")
                      }
                      onClick={() => setModelProviderChoice(provider)}
                    >
                      {RailIcon ? (
                        <RailIcon className="size-4" />
                      ) : (
                        <span className="text-[11px] font-semibold uppercase">
                          {(GATEWAY_PROVIDER_GROUP_LABELS[provider] ?? provider).slice(0, 1)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="flex max-h-80 min-w-0 flex-1 flex-col overflow-y-auto p-1.5">
                <div className="px-2 pt-1 pb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {GATEWAY_PROVIDER_GROUP_LABELS[activeModelProvider ?? ""] ??
                    activeModelProvider ??
                    "Models"}
                </div>
                {activeProviderModels.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    className={
                      "rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted " +
                      (model.id === props.selectedModelId
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground")
                    }
                    onClick={() => {
                      setModelMenuOpen(false);
                      props.onSelectModel(model.id);
                    }}
                  >
                    <span className="block truncate font-medium">{model.displayName}</span>
                    {model.displayName === model.id ? null : (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {model.id}
                      </span>
                    )}
                  </button>
                ))}
                {showCurrentCustomModel ? (
                  <button
                    type="button"
                    className="rounded-md bg-accent px-2 py-1.5 text-left text-[13px] text-accent-foreground"
                    onClick={() => setModelMenuOpen(false)}
                  >
                    <span className="block truncate font-medium">{props.selectedModelId}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      Current custom model
                    </span>
                  </button>
                ) : null}
                {activeProviderModels.length === 0 && !showCurrentCustomModel ? (
                  <div
                    className="px-2 py-1.5 text-xs leading-4 text-muted-foreground"
                    title={props.modelsUnavailableReason ?? undefined}
                  >
                    No models reported for this provider.
                  </div>
                ) : null}
                <button
                  type="button"
                  className="mt-1 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted"
                  onClick={() => {
                    setModelMenuOpen(false);
                    setCustomModelDraft(props.selectedModelId);
                  }}
                >
                  Custom model id…
                </button>
              </div>
            </div>
          </PopoverPopup>
        </Popover>
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
  /**
   * Manual-mode Harness and Model choices for the compact menu. Without
   * them, narrow windows silently fell back to the retired provider picker
   * and offered no harness at all (Befund K-A2). Null while a worker is
   * selected — a worker bundles harness and model.
   */
  readonly manualTarget?: {
    readonly configuredInstanceIds: ReadonlySet<string>;
    readonly selectedHarness: WorkjetHarness | null;
    readonly onSelectHarness: (harness: WorkjetHarness) => void;
    readonly models: ReadonlyArray<WorkjetGatewayModelSummary>;
    readonly modelsUnavailableReason: string | null;
    readonly selectedModelId: string;
    readonly onSelectModel: (modelId: string) => void;
  } | null;
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
            No computers — add one in Settings → Computers
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
              const projectAvailable = isProjectAvailableOnComputer(
                computer,
                props.activeEnvironmentId,
                selectable,
              );
              return (
                <MenuRadioItem
                  key={computer.id}
                  value={computer.id}
                  disabled={!projectAvailable}
                  // Same reason as the wide control's hint, surfaced where a
                  // short suffix has no room for it (Befund K-B17).
                  title={projectAvailable ? undefined : COMPOSER_COMPUTER_PROJECT_UNAVAILABLE_HINT}
                >
                  {computer.label}
                  {projectAvailable ? "" : " — project unavailable"}
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        )}
      </MenuGroup>
      {props.selectedWorkerId === null && props.manualTarget ? (
        <>
          <MenuGroup>
            <MenuGroupLabel>Harness</MenuGroupLabel>
            <MenuRadioGroup
              value={props.manualTarget.selectedHarness ?? ""}
              onValueChange={(value) => {
                if (typeof value !== "string" || value.length === 0) return;
                props.manualTarget?.onSelectHarness(value as WorkjetHarness);
              }}
            >
              {composerHarnessOptions(props.manualTarget.configuredInstanceIds).map((option) => (
                <MenuRadioItem key={option.id} value={option.id} disabled={!option.configured}>
                  {option.label}
                  {option.configured ? "" : " — not configured"}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          <MenuGroup>
            <MenuGroupLabel>Model</MenuGroupLabel>
            {props.manualTarget.models.length === 0 ? (
              <p className="max-w-72 px-2 pt-1 pb-1.5 text-xs leading-4 text-muted-foreground">
                {props.manualTarget.modelsUnavailableReason ?? "No gateway models available."}
              </p>
            ) : (
              <MenuRadioGroup
                value={props.manualTarget.selectedModelId}
                onValueChange={(value) => {
                  if (typeof value !== "string" || value.length === 0) return;
                  props.manualTarget?.onSelectModel(value);
                }}
              >
                {[...groupGatewayModelsByProvider(props.manualTarget.models).entries()].map(
                  ([provider, models]) => (
                    <Fragment key={provider}>
                      <MenuGroupLabel>
                        {GATEWAY_PROVIDER_GROUP_LABELS[provider] ?? provider}
                      </MenuGroupLabel>
                      {models.map((model) => (
                        <MenuRadioItem key={model.id} value={model.id}>
                          {model.id}
                        </MenuRadioItem>
                      ))}
                    </Fragment>
                  ),
                )}
              </MenuRadioGroup>
            )}
          </MenuGroup>
        </>
      ) : null}
    </>
  );
}
