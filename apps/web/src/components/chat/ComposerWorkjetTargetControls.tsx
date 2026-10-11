// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Die Ziel-Steuerelemente der Composer-Leiste: wo und womit der nächste Zug
 * läuft (Luma · Rechner · Harness · Modell · Systemprompt).
 *
 * Drei Orte, keine Popups: jedes Steuerelement ist ein schlichtes Dropdown mit
 * einfachen Einträgen (Name plus kurzer Status). Bearbeiten von Rechnern,
 * Lumas und Modellen passiert in den Einstellungen, nicht im Composer; der
 * Composer bietet nur Katalogmodelle an, nie eine getippte Modell-ID. Der
 * Systemprompt wird als Zeile unter dem Composer eingegeben.
 */
import type {
  EnvironmentId,
  CtoxWorkjetComputerProjection,
  WorkjetComputer,
  WorkjetGatewayModelSummary,
  WorkjetGatewayProvider,
  WorkjetHarness,
  WorkjetLlmRoute,
  WorkjetWorkerProfile,
} from "@workjet/contracts";
import { Fragment, memo, useState, type ReactNode } from "react";
import {
  CpuIcon,
  FileTextIcon,
  MonitorIcon,
  SettingsIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { WorkjetComputerDraft } from "../settings/WorkjetComputerEditor";

import { WORKJET_HARNESS_OPTIONS } from "../settings/WorkjetWorkerEditor";
import { ComposerControl, ComposerControlIcon, ComposerControlChevron } from "./ComposerControl";
import {
  MANUAL_WORKER_LABEL,
  MANUAL_WORKER_VALUE,
  providerInstanceIdForHarness,
} from "./ComposerWorkerControl";
import { ComposerInlineRow, useComposerInlineRow } from "./CompactComposerControlsMenu";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";

/**
 * A running turn must finish before a fresh session can continue its history elsewhere.
 */
export const COMPOSER_COMPUTER_LOCKED_REASON = "Erst den laufenden Zug beenden.";

/** The option hint for a connected computer this project has no environment on. */
export const COMPOSER_COMPUTER_PROJECT_UNAVAILABLE_HINT = "Projekt fehlt auf diesem Rechner";

/**
 * Whether the current draft could move to this computer's environment — the
 * same logical project must exist there. Shared by the bar and the compact
 * menu so both refuse identically.
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
 * harness maps to. Named profiles pass their actual driver kind.
 */
export function harnessForProviderInstanceId(
  instanceId: string,
  driverKind?: string,
): WorkjetHarness | null {
  for (const option of WORKJET_HARNESS_OPTIONS) {
    if (providerInstanceIdForHarness(option.id) === (driverKind ?? instanceId)) return option.id;
  }
  return null;
}

/**
 * The harness choices the manual bar offers. A harness this build has no
 * provider instance for is HIDDEN (there is nothing to run it on, so listing
 * it would be a dead control); one whose instance exists but is not configured
 * is disabled with a short status.
 */
export function composerHarnessOptions(
  configuredInstanceIds: ReadonlySet<string>,
  configuredDriverKinds?: ReadonlySet<string>,
): ReadonlyArray<{
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
      configured: configuredDriverKinds?.has(instanceId) ?? configuredInstanceIds.has(instanceId),
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
  const accountId = route.gatewayAccountId;
  if (accountId === undefined) return [];
  const scoped = models.filter((model) => model.accountIds.includes(accountId));
  // A catalog that does not link this route's account to any model would
  // leave the control empty and lie about the gateway offering nothing;
  // fall back to the whole catalog instead.
  return scoped.length > 0 ? scoped : models;
}

/** Kurzer Menü-Status in einer Zeile: grau, rechtsbündig, nie ein Satz. */
function MenuMeta({ children }: { readonly children: ReactNode }) {
  return (
    <span className="ms-auto shrink-0 truncate ps-3 text-muted-foreground text-xs">{children}</span>
  );
}

/**
 * Ein leerer Zustand im Menü als einfacher, gesperrter Eintrag (kein
 * Statussatz); der Grund steht höchstens im Tooltip.
 */
function MenuEmptyItem({
  children,
  reason,
}: {
  readonly children: ReactNode;
  readonly reason?: string | null | undefined;
}) {
  return (
    <MenuItem disabled title={reason ?? undefined}>
      {children}
    </MenuItem>
  );
}

// ---------------------------------------------------------------------------
// Rechner
// ---------------------------------------------------------------------------

export interface ComputerEditorState {
  readonly drafts: Readonly<Record<string, WorkjetComputerDraft>>;
  readonly saving: boolean;
}

export interface ComposerComputerControlProps {
  /**
   * Owned above responsive layouts. The dropdown no longer edits computers;
   * only `saving` is still honoured so a save started elsewhere blocks a switch.
   */
  readonly editor?: {
    readonly state: ComputerEditorState;
    readonly update: (update: (current: ComputerEditorState) => ComputerEditorState) => void;
  };
  readonly computers: ReadonlyArray<WorkjetComputer>;
  readonly registeredComputers?: ReadonlyArray<CtoxWorkjetComputerProjection>;
  readonly computerAvailability?: Readonly<
    Record<string, { readonly status: string; readonly reason: string | null }>
  >;
  /** The computer whose environment the composer currently targets, if any. */
  readonly selectedComputerId: string | null;
  readonly activeEnvironmentId: EnvironmentId;
  /** Environments the current draft can actually move to (same logical project). */
  readonly selectableEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** Non-null prevents selection. */
  readonly disabledReason: string | null;
  /** Worker-mode mismatch, e.g. the worker's computer is not paired here. */
  readonly mismatchNote: string | null;
  readonly onSelectComputer: (computerId: string) => void;
  /** Einstellungen → Rechner öffnen. */
  readonly onAddComputer?: (() => void) | undefined;
}

/**
 * Presentation-kind wording — the raw enum ("workjet-connect") leaked into the
 * computer dropdown and the settings rows (K-B5).
 */
export const WORKJET_COMPUTER_KIND_LABELS: Readonly<Record<string, string>> = {
  local: "Dieser Rechner",
  "workjet-connect": "Workjet Connect",
  ssh: "SSH",
  tailscale: "Tailscale",
  remote: "Entfernt",
};

export function workjetComputerKindLabel(kind: string): string {
  return WORKJET_COMPUTER_KIND_LABELS[kind] ?? kind;
}

/** Verbindungsstatus deutsch und kurz, egal wie der Aufrufer ihn liefert. */
export function composerComputerStatusLabel(status: string | undefined): string | null {
  if (status === undefined || status.length === 0) return null;
  switch (status.trim().toLowerCase()) {
    case "online":
    case "connected":
    case "verbunden":
      return "verbunden";
    case "offline":
    case "not connected":
    case "disconnected":
    case "getrennt":
      return "getrennt";
    default:
      return status;
  }
}

/** One entry per computer, as the dropdown lists it. */
export function composerComputerChoices(
  props: Pick<
    ComposerComputerControlProps,
    | "computers"
    | "computerAvailability"
    | "activeEnvironmentId"
    | "selectableEnvironmentIds"
    | "disabledReason"
  > & { readonly busy?: boolean | undefined },
): ReadonlyArray<{
  readonly computer: WorkjetComputer;
  /** Why the choice is refused; the full text goes into the item's title. */
  readonly reason: string | null;
  /** Short status shown next to the name. */
  readonly meta: string;
}> {
  const selectable = new Set(props.selectableEnvironmentIds);
  return props.computers.map((computer) => {
    const projectAvailable = isProjectAvailableOnComputer(
      computer,
      props.activeEnvironmentId,
      selectable,
    );
    const availability = props.computerAvailability?.[computer.id];
    const reason =
      (props.busy ? "Speichert…" : props.disabledReason) ??
      availability?.reason ??
      (projectAvailable ? null : COMPOSER_COMPUTER_PROJECT_UNAVAILABLE_HINT);
    const status = composerComputerStatusLabel(availability?.status);
    const meta =
      reason === null
        ? (status ?? workjetComputerKindLabel(computer.presentationKind))
        : status !== null && status !== "verbunden"
          ? status
          : !projectAvailable
            ? "Projekt fehlt"
            : "nicht verfügbar";
    return { computer, reason, meta };
  });
}

/** Die Einträge des Rechner-Dropdowns. Hook-frei, damit Tests den Baum prüfen. */
export function ComposerComputerMenuItems(
  props: ComposerComputerControlProps & { readonly busy?: boolean | undefined },
) {
  const choices = composerComputerChoices(props);
  const unconfigured =
    props.registeredComputers?.filter(
      (computer) => !props.computers.some((configured) => configured.id === computer.id),
    ) ?? [];
  return (
    <>
      {choices.length === 0 && unconfigured.length === 0 ? (
        <MenuEmptyItem reason={props.disabledReason}>Keine Rechner</MenuEmptyItem>
      ) : null}
      {choices.length > 0 ? (
        <MenuRadioGroup
          value={props.selectedComputerId ?? ""}
          onValueChange={(value) => {
            if (typeof value !== "string" || value.length === 0) return;
            const choice = choices.find((entry) => entry.computer.id === value);
            if (choice && choice.reason === null) props.onSelectComputer(value);
          }}
        >
          {choices.map(({ computer, reason, meta }) => (
            <MenuRadioItem
              key={computer.id}
              value={computer.id}
              disabled={reason !== null}
              title={reason ?? undefined}
              aria-label={computer.label}
              closeOnClick
            >
              <span className="flex min-w-0 items-baseline">
                <span className="min-w-0 truncate">{computer.label}</span>
                <MenuMeta>{meta}</MenuMeta>
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      ) : null}
      {unconfigured.map((computer) => (
        <MenuItem key={`native-${computer.id}`} disabled>
          <span className="flex min-w-0 flex-1 items-baseline">
            <span className="min-w-0 truncate">{computer.displayName}</span>
            <MenuMeta>getrennt</MenuMeta>
          </span>
        </MenuItem>
      ))}
      {props.onAddComputer ? (
        <>
          <MenuSeparator />
          <MenuItem disabled={props.busy} onClick={props.onAddComputer}>
            <SettingsIcon aria-hidden="true" />
            Rechner verwalten
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

export function ComposerComputerControlView(props: ComposerComputerControlProps) {
  const saving = props.editor?.state.saving ?? false;
  const selected =
    props.computers.find((computer) => computer.id === props.selectedComputerId) ?? null;
  const warn =
    props.mismatchNote !== null || (props.selectedComputerId !== null && selected === null);
  return (
    <span
      className="inline-flex min-w-0 max-w-full shrink-0 items-center"
      data-composer-computer-control="true"
      title={saving ? "Speichert…" : (props.disabledReason ?? props.mismatchNote ?? undefined)}
    >
      <Menu>
        <MenuTrigger
          disabled={saving}
          render={
            <ComposerControl
              type="button"
              className="h-auto min-w-0 max-w-48 font-medium"
              aria-label="Rechner"
              aria-busy={saving}
              {...(props.mismatchNote === null ? {} : { "data-computer-mismatch": "true" })}
            />
          }
        >
          <ComposerControlIcon icon={MonitorIcon} />
          <span className="min-w-0 truncate text-left">
            {selected?.label ?? (props.selectedComputerId !== null ? "Rechner fehlt" : "Rechner")}
          </span>
          {warn ? (
            <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
          ) : null}
          <ComposerControlChevron />
        </MenuTrigger>
        <MenuPopup align="start" side="top" className="max-h-80 min-w-56 max-w-80">
          <ComposerComputerMenuItems {...props} busy={saving} />
        </MenuPopup>
      </Menu>
    </span>
  );
}

export const ComposerComputerControl = memo(ComposerComputerControlView);

// ---------------------------------------------------------------------------
// Manual mode: Harness · Model. There is NO separate provider chip — with
// the Workjet gateway the MODEL determines the serving account (accounts
// route by model pattern); the model menu groups by provider instead.
// ---------------------------------------------------------------------------

const NO_HARNESS_VALUE = "__no_harness__";

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
 * Stable provider order for the model menu, independent of the latest catalog
 * response, so the list does not jump while discovery refreshes.
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
 * still appears once, under its primary provider. Shared by the bar and the
 * compact overflow menu so both group identically.
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

export interface ComposerManualTargetControlsProps {
  readonly disabledReason?: string | null | undefined;
  /** Provider instance ids this turn may actually target. */
  readonly configuredInstanceIds: ReadonlySet<string>;
  /** Enabled driver families, including families represented only by named profiles. */
  readonly configuredDriverKinds?: ReadonlySet<string>;
  /** Why an instance outside that set is refused; shown as the option's title. */
  readonly unavailableHint?: string | undefined;
  readonly selectedHarness: WorkjetHarness | null;
  readonly onSelectHarness: (harness: WorkjetHarness) => void;
  /** Where the model list comes from; every source offers only its catalog entries. */
  readonly modelSource?: "gateway" | "configured" | "native";
  /** Kept for callers; the dropdown shows no explanatory text. */
  readonly configuredModelsHint?: string | null;
  readonly models: ReadonlyArray<WorkjetGatewayModelSummary>;
  /** Why the model list may be empty; shown instead of a silent blank. */
  readonly modelsUnavailableReason: string | null;
  readonly selectedModelId: string;
  readonly onSelectModel: (modelId: string) => void;
}

/** The harness dropdown entries. Hook-free so tests can inspect the tree. */
export function ComposerHarnessMenuItems(
  props: Pick<
    ComposerManualTargetControlsProps,
    | "configuredInstanceIds"
    | "configuredDriverKinds"
    | "unavailableHint"
    | "selectedHarness"
    | "onSelectHarness"
  >,
) {
  const options = composerHarnessOptions(props.configuredInstanceIds, props.configuredDriverKinds);
  return (
    <MenuRadioGroup
      value={props.selectedHarness ?? NO_HARNESS_VALUE}
      onValueChange={(value) => {
        if (typeof value !== "string" || value === NO_HARNESS_VALUE) return;
        props.onSelectHarness(value as WorkjetHarness);
      }}
    >
      {options.map((option) => (
        <MenuRadioItem
          key={option.id}
          value={option.id}
          disabled={!option.configured}
          title={option.configured ? undefined : props.unavailableHint}
          closeOnClick
        >
          <span className="flex min-w-0 items-baseline">
            <span className="min-w-0 truncate">{option.label}</span>
            {option.configured ? null : (
              <MenuMeta>
                {props.unavailableHint === undefined ? "nicht eingerichtet" : "gesperrt"}
              </MenuMeta>
            )}
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

/** The model dropdown entries. Hook-free so tests can inspect the tree. */
export function ComposerModelMenuItems(
  props: Pick<
    ComposerManualTargetControlsProps,
    "modelSource" | "models" | "modelsUnavailableReason" | "selectedModelId" | "onSelectModel"
  >,
) {
  const configuredModels = props.modelSource === "configured";
  const groups: ReadonlyArray<readonly [string, ReadonlyArray<WorkjetGatewayModelSummary>]> =
    configuredModels
      ? [["", props.models]]
      : composerGatewayModelMenuGroups(props.models).filter(([, models]) => models.length > 0);
  return (
    <>
      <MenuRadioGroup
        value={props.selectedModelId}
        onValueChange={(value) => {
          if (typeof value !== "string" || value.length === 0) return;
          if (value !== props.selectedModelId) props.onSelectModel(value);
        }}
      >
        {groups.map(([provider, models]) => (
          <MenuGroup key={provider || "configured"}>
            {provider ? (
              <MenuGroupLabel>{GATEWAY_PROVIDER_GROUP_LABELS[provider] ?? provider}</MenuGroupLabel>
            ) : null}
            {models.map((model) => (
              <MenuRadioItem key={model.id} value={model.id} closeOnClick>
                <span className="block min-w-0 truncate">{model.displayName}</span>
              </MenuRadioItem>
            ))}
          </MenuGroup>
        ))}
      </MenuRadioGroup>
      {props.models.length === 0 ? (
        <MenuEmptyItem reason={props.modelsUnavailableReason}>Keine Modelle</MenuEmptyItem>
      ) : null}
    </>
  );
}

/** Exported unwrapped so a test can call it; `memo` returns an object. */
export function ComposerManualTargetControlsView(props: ComposerManualTargetControlsProps) {
  const nativeModels = props.modelSource === "native";
  const disabled = Boolean(props.disabledReason);

  const harnessOptions = composerHarnessOptions(
    props.configuredInstanceIds,
    props.configuredDriverKinds,
  );
  const selectedHarnessOption =
    harnessOptions.find((option) => option.id === props.selectedHarness) ?? null;
  const selectedModelSummary = props.models.find((model) => model.id === props.selectedModelId);
  const modelLabel =
    selectedModelSummary?.displayName ??
    (nativeModels ? "Modell" : props.selectedModelId.length > 0 ? props.selectedModelId : "Modell");

  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-1"
      data-composer-manual-target-controls="true"
      data-model-catalog-source={props.modelSource ?? "gateway"}
    >
      {/* Harness */}
      <Menu>
        <MenuTrigger
          disabled={disabled}
          render={
            <ComposerControl
              type="button"
              className="min-w-0 max-w-36"
              aria-label="Harness"
              title={props.disabledReason ?? undefined}
            />
          }
        >
          <ComposerControlIcon icon={TerminalIcon} />
          <span className="min-w-0 truncate">{selectedHarnessOption?.label ?? "Harness"}</span>
          <ComposerControlChevron />
        </MenuTrigger>
        <MenuPopup align="start" side="top" className="min-w-48 max-w-72">
          <ComposerHarnessMenuItems {...props} />
        </MenuPopup>
      </Menu>

      {/* Modell */}
      <Menu>
        <MenuTrigger
          disabled={disabled}
          render={
            <ComposerControl
              type="button"
              className="min-w-0 max-w-56"
              aria-label="Modell"
              title={props.disabledReason ?? undefined}
            />
          }
        >
          <ComposerControlIcon icon={CpuIcon} />
          <span className="min-w-0 truncate">{modelLabel}</span>
          <ComposerControlChevron />
        </MenuTrigger>
        <MenuPopup
          align="start"
          side="top"
          className="max-h-80 min-w-56 max-w-80"
          data-composer-model-menu="true"
        >
          <ComposerModelMenuItems {...props} />
        </MenuPopup>
      </Menu>
    </span>
  );
}

export const ComposerManualTargetControls = memo(ComposerManualTargetControlsView);

// ---------------------------------------------------------------------------
// Systemprompt (manual mode): Eintrag im Optionen-Menü, Eingabe als Zeile
// unter dem Composer.
// ---------------------------------------------------------------------------

export interface ComposerSystemPromptControlProps {
  readonly value: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  /**
   * On a draft the edit is held locally and applied when the thread starts.
   * Kept for callers; the row shows no explanation for it.
   */
  readonly draftPending: boolean;
  readonly onApply: (text: string) => void;
}

export const COMPOSER_SYSTEM_PROMPT_ROW = "system-prompt";

/** Die Inline-Zeile: Textfeld, „Abbrechen“, „Übernehmen“. */
export function ComposerSystemPromptRow(
  props: ComposerSystemPromptControlProps & { readonly onClose: () => void },
) {
  const [text, setText] = useState(props.value);
  return (
    <div
      className="flex flex-col gap-2 border-border/60 border-t px-3 py-2 sm:px-4"
      data-composer-inline-row={COMPOSER_SYSTEM_PROMPT_ROW}
    >
      <Textarea
        autoFocus
        value={text}
        rows={3}
        aria-label="Systemprompt"
        placeholder="Systemprompt für diesen Chat"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={props.onClose}>
          Abbrechen
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={props.busy || props.disabled || text === props.value}
          onClick={() => {
            props.onApply(text);
            props.onClose();
          }}
        >
          {props.busy ? "Übernimmt…" : "Übernehmen"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Im Optionen-Menü ein Eintrag „Systemprompt“, der die Inline-Zeile unter dem
 * Composer öffnet. Ohne Menü (eigenständig) ein Leisten-Button, der dieselbe
 * Zeile direkt darunter auf- und zuklappt.
 */
export function ComposerSystemPromptControlView(props: ComposerSystemPromptControlProps) {
  const inlineRow = useComposerInlineRow();
  const [standaloneOpen, setStandaloneOpen] = useState(false);
  const isSet = props.value.trim().length > 0;

  if (inlineRow?.placement === "menu") {
    return (
      <MenuItem
        disabled={props.disabled}
        onClick={() => inlineRow.setOpenRow(COMPOSER_SYSTEM_PROMPT_ROW)}
      >
        <FileTextIcon aria-hidden="true" />
        Systemprompt
        <MenuMeta>{isSet ? "gesetzt" : "—"}</MenuMeta>
      </MenuItem>
    );
  }
  if (inlineRow?.placement === "row") {
    if (inlineRow.openRow !== COMPOSER_SYSTEM_PROMPT_ROW) return null;
    return (
      <ComposerInlineRow>
        <ComposerSystemPromptRow {...props} onClose={() => inlineRow.setOpenRow(null)} />
      </ComposerInlineRow>
    );
  }
  return (
    <>
      <ComposerControl
        type="button"
        className="shrink-0 whitespace-nowrap"
        aria-label="Systemprompt"
        aria-expanded={standaloneOpen}
        disabled={props.disabled}
        onClick={() => setStandaloneOpen((open) => !open)}
      >
        <ComposerControlIcon icon={FileTextIcon} />
        <span className="sr-only sm:not-sr-only">Systemprompt</span>
      </ComposerControl>
      {standaloneOpen ? (
        <ComposerSystemPromptRow {...props} onClose={() => setStandaloneOpen(false)} />
      ) : null}
    </>
  );
}

export const ComposerSystemPromptControl = memo(ComposerSystemPromptControlView);

// ---------------------------------------------------------------------------
// Compact footer: Luma + Rechner inside the overflow menu
// ---------------------------------------------------------------------------

export interface ComposerWorkjetCompactMenuContentProps {
  readonly hideWorkerSelection?: boolean;
  readonly hideComputerSelection?: boolean;
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
   * Manual-mode Harness and Model choices for the compact menu. Null while a
   * worker is selected — a worker bundles harness and model.
   */
  readonly manualTarget?: {
    readonly configuredInstanceIds: ReadonlySet<string>;
    readonly configuredDriverKinds?: ReadonlySet<string>;
    readonly selectedHarness: WorkjetHarness | null;
    readonly onSelectHarness: (harness: WorkjetHarness) => void;
    readonly models: ReadonlyArray<WorkjetGatewayModelSummary>;
    readonly modelsUnavailableReason: string | null;
    readonly selectedModelId: string;
    readonly onSelectModel: (modelId: string) => void;
  } | null;
}

/**
 * Luma, Rechner, Harness und Modell als Radio-Gruppen des Optionen-Menüs,
 * damit alle Ziele auch unterhalb des Umbruchpunkts erreichbar bleiben.
 */
export function ComposerWorkjetCompactMenuContent(
  props: ComposerWorkjetCompactMenuContentProps,
): ReactNode {
  const selectable = new Set(props.selectableEnvironmentIds);
  return (
    <>
      {props.hideWorkerSelection ? null : (
        <MenuGroup>
          <MenuGroupLabel>Luma</MenuGroupLabel>
          <MenuRadioGroup
            value={props.selectedWorkerId ?? MANUAL_WORKER_VALUE}
            onValueChange={(value) => {
              if (typeof value !== "string") return;
              props.onSelectWorker(value === MANUAL_WORKER_VALUE ? null : value);
            }}
          >
            <MenuRadioItem value={MANUAL_WORKER_VALUE}>{MANUAL_WORKER_LABEL}</MenuRadioItem>
            {props.workers.map((worker) => (
              <MenuRadioItem key={worker.id} value={worker.id}>
                {worker.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      )}
      {props.hideComputerSelection ? null : (
        <MenuGroup>
          <MenuGroupLabel>Rechner</MenuGroupLabel>
          {props.computers.length === 0 ? (
            <MenuEmptyItem reason={props.computerDisabledReason}>Keine Rechner</MenuEmptyItem>
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
                    disabled={props.computerDisabledReason !== null || !projectAvailable}
                    title={
                      props.computerDisabledReason ??
                      (projectAvailable ? undefined : COMPOSER_COMPUTER_PROJECT_UNAVAILABLE_HINT)
                    }
                  >
                    <span className="flex min-w-0 items-baseline">
                      <span className="min-w-0 truncate">{computer.label}</span>
                      {projectAvailable ? null : <MenuMeta>Projekt fehlt</MenuMeta>}
                    </span>
                  </MenuRadioItem>
                );
              })}
            </MenuRadioGroup>
          )}
        </MenuGroup>
      )}
      {props.selectedWorkerId === null && props.manualTarget ? (
        <>
          <MenuGroup>
            <MenuGroupLabel>Harness</MenuGroupLabel>
            {/* Hook-frei: direkt aufgerufen, damit der Baum ohne Menü prüfbar bleibt. */}
            {ComposerHarnessMenuItems(props.manualTarget)}
          </MenuGroup>
          <MenuGroup>
            <MenuGroupLabel>Modell</MenuGroupLabel>
            {props.manualTarget.models.length === 0 ? (
              <MenuEmptyItem reason={props.manualTarget.modelsUnavailableReason}>
                Keine Modelle
              </MenuEmptyItem>
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
                          {model.displayName}
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
