import { Fragment } from "react";
import { workjetUiLanguage } from "../../workjetProjectControl";
import { InstanceProviderSection } from "./InstanceProviderSection";
import { useInstanceProviders } from "./useInstanceProviders";
import { useAtomValue } from "@effect/atom-react";
import { connectionStatusText } from "@workjet/client-runtime/connection";
import { safeErrorLogAttributes } from "@workjet/client-runtime/errors";
import { ChevronDownIcon } from "lucide-react";
import { Switch } from "../ui/switch";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@workjet/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@workjet/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@workjet/contracts/settings";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@workjet/shared/backgroundActivitySettings";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import {
  CloudIcon,
  LaptopIcon,
  LoaderIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  useBusinessOsScopedEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { PiCodeIcon } from "../Icons";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { Button } from "../ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstancePanel } from "./AddProviderInstancePanel";
import { providerCheckedAgeLabel } from "./providerStatus";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import { searchableSetting } from "./settingsSearch";
import {
  backgroundActivityOverrideSettings,
  buildProviderInstanceUpdatePatch,
  durationToSeconds,
  normalizeIntervalSeconds,
  PROVIDER_HEALTH_INTERVAL_STEP_SECONDS,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { WorkjetModelsProviders } from "./WorkjetModelsProviders";
import { useInstanceGrokAccount } from "./useInstanceGrokAccount";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { SessionImportSection } from "./SessionImportSection";
import { useWorkjetGatewaySection } from "./useWorkjetGatewaySection";
import {
  buildProviderEnvironmentOptions,
  classifyProviderEnvironmentAccess,
  type ProviderEnvironmentAccess,
  type ProviderOperateAccess,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";
import { TextGenerationModelSection } from "./SettingsPanels";

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

const PROVIDER_SETTINGS = DRIVER_OPTIONS.map((definition) => ({
  provider: definition.value,
}));

/**
 * A cached health claim ages badly: "Authenticated" from an hour ago survives
 * an expired CLI login. Opening the page therefore re-probes, but navigation
 * spam must not hammer the harness CLIs, so a per-environment cooldown gates
 * the automatic probe. The manual refresh button is never gated.
 */
export const PROVIDER_AUTO_REFRESH_COOLDOWN_MS = 30_000;

/**
 * Last automatic probe per environment. Module-level so it survives the
 * remount that every settings navigation performs — that remount is exactly
 * what the cooldown has to absorb. Exported so tests can start from a known
 * state; nothing else writes it.
 */
export const providerAutoRefreshTracker = new Map<EnvironmentId, number>();

export function shouldAutoRefreshProviders(
  lastAutoRefreshAtMs: number | undefined,
  nowMs: number,
): boolean {
  return (
    lastAutoRefreshAtMs === undefined ||
    nowMs - lastAutoRefreshAtMs >= PROVIDER_AUTO_REFRESH_COOLDOWN_MS
  );
}

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  useRelativeTimeTick();
  if (lastCheckedAt === null) return null;
  const label = providerCheckedAgeLabel(lastCheckedAt);
  return (
    <span className="text-[11px] text-muted-foreground/60">
      {label.charAt(0).toUpperCase() + label.slice(1)}
    </span>
  );
}

/** Ein Laden endet (UI-Vertrag §1.3): nach 10 s Statuszeile mit Wiederholen. */
export const PROVIDER_LOADING_TIMEOUT_MS = 10_000;

/** „Rechner hinzufügen“ führt auf Einstellungen › Rechner. */
function AddComputerLinkButton() {
  return (
    <Button size="sm" render={<Link to="/settings/computers" />}>
      Rechner hinzufügen
    </Button>
  );
}

function LoadingStatusRow({
  title,
  slowStatus,
  onRetry,
  slowAction,
}: {
  readonly title: string;
  readonly slowStatus: string;
  readonly onRetry: () => void;
  /** Zweiter Knopf neben „Erneut versuchen“, sobald das Laden endet. */
  readonly slowAction?: ReactNode;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), PROVIDER_LOADING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <SettingsRow
      title={slow ? slowStatus : title}
      control={
        slow ? (
          <span className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RefreshCwIcon className="size-3.5" />
              Erneut versuchen
            </Button>
            {slowAction}
          </span>
        ) : (
          <LoaderIcon className="size-4 animate-spin text-muted-foreground" aria-hidden />
        )
      }
    />
  );
}

function providerEnvironmentIcon(environment: EnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  if (environment.entry.target._tag === "RelayConnectionTarget") return CloudIcon;
  if (environment.entry.target._tag === "SshConnectionTarget") return TerminalIcon;
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return LaptopIcon;
  return CloudIcon;
}

function providerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Dieser Rechner";
  if (environment.relayManaged) return "Workjet Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Lokaler Rechner";
  return "Entfernter Rechner";
}

function EnvironmentUnavailableRow({
  environment,
  access,
  onRetry,
}: {
  readonly environment: EnvironmentPresentation;
  readonly access: Exclude<ProviderEnvironmentAccess, { kind: "editable" | "read-only" }>;
  readonly onRetry: () => void;
}) {
  return (
    // Titled like the section it stands in for, so the placeholder never
    // reads as a different page than the loaded state.
    <SettingsSection title={codingAgentsTitle()}>
      {access.kind === "loading" ? (
        // A wedged device can keep this state forever, so the load ends after
        // 10 s with a status line and a retry instead of spinning on.
        <LoadingStatusRow
          title={`${environment.label} wird geladen`}
          slowStatus="Keine Antwort vom Rechner"
          onRetry={onRetry}
        />
      ) : (
        <SettingsRow
          title={access.kind === "error" ? "Keine Verbindung" : "Nicht verfügbar"}
          status={connectionStatusText(environment.connection)}
        />
      )}
    </SettingsSection>
  );
}

/**
 * Which half of this surface to render.
 *
 * Harness runtimes and LLM accounts were merged onto one "Providers" page on
 * the theory that one surface is simpler. In practice the page held two
 * unrelated things behind a name that read as one, and the LLM accounts —
 * where Kimi, GLM, MiniMax and the rest are added — sat below the fold with
 * no menu entry of their own. They were, in the owner's words, impossible to
 * find. So the page splits: harnesses are CLI runtimes, models are the LLM
 * accounts, and each gets its own entry in the settings sidebar.
 *
 * The device picker stays on both, because both are per-environment.
 */
export type ProviderSettingsSections = "harnesses" | "models";

/** „Harnesses“ was unclear (#554); the section is named for what it holds. */
function codingAgentsTitle(): string {
  return workjetUiLanguage() === "en" ? "Coding agents" : "Coding-Agenten";
}

export function ProviderSettingsPanel({
  sections = "harnesses",
  embedded = false,
}: {
  readonly sections?: ProviderSettingsSections;
  /** Rendered inside another page (Rechner) instead of as its own page. */
  readonly embedded?: boolean;
} = {}) {
  const { environments, isReady } = useBusinessOsScopedEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const options = useMemo(
    () => buildProviderEnvironmentOptions(environments, primaryEnvironmentId),
    [environments, primaryEnvironmentId],
  );
  // Raw user intent; the effective selection is re-derived every render so a
  // device that drops out of the catalog falls back without erasing the pick —
  // if it reappears (e.g. after a reconnect) the selection is restored.
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId = resolveSelectedProviderEnvironmentId(
    options,
    selectedEnvironmentId,
    primaryEnvironmentId,
  );
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  // Retry for a load that never ends: there is no refetch for the catalog, so
  // the retry re-mounts the device-dependent part of the page.
  const [loadAttempt, setLoadAttempt] = useState(0);
  // The catalog hydrates asynchronously, so an empty list before it is ready
  // means "not loaded yet", not "nothing is connected".
  const devicesLoading = options.length === 0 && !isReady;
  // One block per state (grok-p1-046): loading and an empty catalog each say
  // so once — on the models page inside the model section itself, on the
  // harnesses page here — and the picker only appears when there is something
  // to pick.
  const showDevicePicker = options.length > 0 && !onlyPrimaryDevice;

  const Container = embedded ? Fragment : SettingsPageContainer;
  return (
    <Container>
      {devicesLoading && sections === "harnesses" ? (
        <SettingsSection title={codingAgentsTitle()}>
          <LoadingStatusRow
            key={loadAttempt}
            title="Rechner werden geladen"
            slowStatus="Rechner nicht geladen"
            onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
          />
        </SettingsSection>
      ) : null}
      {!devicesLoading && options.length === 0 && sections === "harnesses" ? (
        <SettingsSection title={codingAgentsTitle()}>
          <SettingsRow title="Kein Rechner" control={<AddComputerLinkButton />} />
        </SettingsSection>
      ) : null}
      {showDevicePicker ? (
        <SettingsSection title="Rechner">
          {
            <div className="grid gap-1 sm:grid-cols-2">
              {options.map((environment) => {
                const Icon = providerEnvironmentIcon(environment);
                const selected = environment.environmentId === effectiveEnvironmentId;
                const statusText = connectionStatusText(environment.connection);
                return (
                  <button
                    key={environment.environmentId}
                    type="button"
                    aria-pressed={selected}
                    className={cn(
                      "flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors sm:px-4",
                      selected
                        ? "bg-primary/8 ring-1 ring-primary/25 dark:bg-primary/12"
                        : "hover:bg-muted/40",
                    )}
                    onClick={() => setSelectedEnvironmentId(environment.environmentId)}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background text-muted-foreground">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <ConnectionStatusDot
                          tooltipText={statusText}
                          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                          pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                        />
                        <span className="truncate text-sm font-medium text-foreground">
                          {environment.label}
                        </span>
                      </span>
                      <span className="block truncate pl-[18px] text-xs text-muted-foreground">
                        {providerEnvironmentDetail(environment)} · {statusText}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          }
        </SettingsSection>
      ) : null}

      {sections === "harnesses" && selectedEnvironment ? (
        <SelectedEnvironmentProviderSettings
          key={`${selectedEnvironment.environmentId}:${loadAttempt}`}
          environment={selectedEnvironment}
          onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
        />
      ) : null}

      {sections === "models" ? (
        <>
          <WorkjetGatewayAccountsSection
            environmentId={effectiveEnvironmentId}
            devicesLoading={devicesLoading}
          />
          <TextGenerationModelSection />
        </>
      ) : null}
    </Container>
  );
}

export function WorkjetGatewayAccountsSection({
  environmentId,
  devicesLoading = false,
}: {
  readonly environmentId: EnvironmentId | null;
  /** The device catalog has not hydrated yet: "no Code computer" is not known. */
  readonly devicesLoading?: boolean;
}) {
  const { selectedId } = useCtoxMode();
  const [loadAttempt, setLoadAttempt] = useState(0);
  if (environmentId === null && selectedId)
    return <InstanceOnlyModels key={selectedId} instanceId={selectedId} />;
  if (environmentId === null) {
    return (
      <SettingsSection title="Modelle">
        {devicesLoading ? (
          <LoadingStatusRow
            key={loadAttempt}
            title="Rechner werden geladen"
            slowStatus="Rechner nicht geladen"
            onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
          />
        ) : (
          <SettingsRow title="Kein Code-Rechner" control={<AddComputerLinkButton />} />
        )}
      </SettingsSection>
    );
  }
  return <ScopedWorkjetGatewayAccountsSection key={environmentId} environmentId={environmentId} />;
}

function ScopedWorkjetGatewayAccountsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gateway = useWorkjetGatewaySection(environmentId);
  const { selectedId } = useCtoxMode();
  return (
    <>
      {selectedId ? (
        <InstanceGatewayModels key={selectedId} instanceId={selectedId} gateway={gateway} />
      ) : (
        <WorkjetModelsProviders {...gateway} />
      )}
      {/* Verbrauch has its own page (Einstellungen › Verbrauch); no second copy here. */}
    </>
  );
}

function InstanceOnlyModels({ instanceId }: { readonly instanceId: string }) {
  const { discovery } = useCtoxMode();
  const instance =
    discovery !== "loading" && discovery._tag === "ready"
      ? discovery.instances.find((item) => item.id === instanceId)
      : undefined;
  const label = instance?.displayName ?? "Instanz";
  const grok = useInstanceGrokAccount(instanceId, label);
  const providers = useInstanceProviders(instanceId);
  return (
    <section aria-label="Modellkonten" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13.5px] font-semibold">Modellkonten</h2>
        <Button size="sm" disabled={grok.checking || grok.installed} onClick={grok.start}>
          <PlusIcon className="size-3.5" />
          Grok-Konto hinzufügen
        </Button>
      </div>
      <div className="overflow-x-auto">
        <div role="table" aria-label="Modellkonten" className="min-w-[34rem]">
          <div
            role="row"
            className="grid grid-cols-[minmax(9rem,1.15fr)_minmax(0,2fr)_minmax(6rem,.7fr)_2rem_4rem] items-center gap-x-3 border-b border-border py-2 text-[11px] text-muted-foreground"
          >
            <span role="columnheader">Anbieter / Konto</span>
            <span role="columnheader">Modelle</span>
            <span role="columnheader">Limits</span>
            <span role="columnheader">Aktiv</span>
            <span role="columnheader" className="sr-only">
              Aktionen
            </span>
          </div>
          <InstanceProviderSection label={label} grok={grok} providers={providers} />
        </div>
      </div>
    </section>
  );
}

function InstanceGatewayModels({
  instanceId,
  gateway,
}: {
  readonly instanceId: string;
  readonly gateway: ReturnType<typeof useWorkjetGatewaySection>;
}) {
  const { discovery } = useCtoxMode();
  const instance =
    discovery !== "loading" && discovery._tag === "ready"
      ? discovery.instances.find((item) => item.id === instanceId)
      : undefined;
  const label = instance?.displayName ?? "Instanz";
  const instanceGrok = useInstanceGrokAccount(instanceId, label);
  const providers = useInstanceProviders(instanceId);
  return (
    <WorkjetModelsProviders
      {...gateway}
      instanceGrok={instanceGrok}
      nativeProviderRows={
        <InstanceProviderSection label={label} grok={instanceGrok} providers={providers} />
      }
    />
  );
}

function SelectedEnvironmentProviderSettings({
  environment,
  onRetry,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onRetry: () => void;
}) {
  const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
  if (isPrimary) {
    // The desktop app owns its primary server outright; a browser session
    // checks the scopes its cookie session was granted.
    if (isElectron) {
      return (
        <AccessGatedProviderSettings
          environment={environment}
          operateAccess="granted"
          onRetry={onRetry}
        />
      );
    }
    return <PrimarySessionGatedProviderSettings environment={environment} onRetry={onRetry} />;
  }
  return <RemoteSessionGatedProviderSettings environment={environment} onRetry={onRetry} />;
}

function PrimarySessionGatedProviderSettings({
  environment,
  onRetry,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onRetry: () => void;
}) {
  const primarySessionState = usePrimarySessionState();
  const operateAccess = resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: primarySessionState.data,
    isPending: primarySessionState.isPending,
    hasError: primarySessionState.error !== null,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      onRetry={onRetry}
    />
  );
}

function RemoteSessionGatedProviderSettings({
  environment,
  onRetry,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onRetry: () => void;
}) {
  const sessionState = useEnvironmentSessionState(environment.environmentId);
  const operateAccess = resolveRemoteOperateAccess({
    session: sessionState.data,
    isPending: sessionState.isPending,
    hasError: sessionState.hasError,
  });
  return (
    <AccessGatedProviderSettings
      environment={environment}
      operateAccess={operateAccess}
      onRetry={onRetry}
    />
  );
}

function AccessGatedProviderSettings({
  environment,
  operateAccess,
  onRetry,
}: {
  readonly environment: EnvironmentPresentation;
  readonly operateAccess: ProviderOperateAccess;
  readonly onRetry: () => void;
}) {
  const access = classifyProviderEnvironmentAccess({
    connectionPhase: environment.connection.phase,
    hasServerConfig: environment.serverConfig !== null,
    operateAccess,
  });
  if (access.kind !== "editable" && access.kind !== "read-only") {
    return (
      <EnvironmentUnavailableRow environment={environment} access={access} onRetry={onRetry} />
    );
  }
  return (
    <EnvironmentProviderSettings
      environmentId={environment.environmentId}
      environmentLabel={environment.label}
      readOnly={access.kind === "read-only"}
    />
  );
}

export function EnvironmentProviderSettings({
  environmentId,
  environmentLabel,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /**
   * Render the full provider layout, greyed out and inert, when this session's
   * credential lacks `orchestration:operate` on the environment. Showing the
   * real configuration keeps the view honest; disabling interaction keeps
   * every one of its writes from being offered and then rejected.
   */
  readonly readOnly?: boolean;
}) {
  const developerMode = useClientSettings((settings) => settings.developerMode);
  const sessionImportVisible = developerMode;
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  // Report Pi's installed state before the operator adds a chat instance.
  const workjetHarnessProbe = useEnvironmentQuery(
    serverEnvironment.workjetHarnessInspect({ environmentId, input: {} }),
  );
  const piCodeProbe =
    workjetHarnessProbe.data?.harnesses.find((entry) => entry.harness === "pi-code") ?? null;
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstancePanelOpen, setIsAddInstancePanelOpen] = useState(false);
  const [showNotInstalled, setShowNotInstalled] = useState(false);
  const [updatingProviderDrivers, setUpdatingProviderDrivers] = useState<
    ReadonlySet<ProviderDriverKind>
  >(() => new Set());
  // Immer nur eine Harness-Karte offen.
  const [openInstanceId, setOpenInstanceId] = useState<string | null>(null);
  const refreshingRef = useRef(false);
  const updatingDriversRef = useRef<Set<ProviderDriverKind>>(new Set());

  const providerUpdateCandidates = useMemo(
    () => collectProviderUpdateCandidates(serverProviders),
    [serverProviders],
  );
  const providerUpdateCandidateByInstanceId = useMemo(
    () => new Map(providerUpdateCandidates.map((candidate) => [candidate.instanceId, candidate])),
    [providerUpdateCandidates],
  );
  const visibleProviderSettings = PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider !== "cursor" ||
      serverProviders.some(
        (provider) =>
          provider.instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make("cursor")),
      ),
  );
  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const providerHealthPreset = getBackgroundActivityPresetSettings(
    resolvedBackgroundActivity.profile,
  ).providerHealthRefreshInterval;
  const providerHealthRefreshIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.providerHealthRefreshInterval,
  );
  const defaultProviderHealthRefreshIntervalSeconds = durationToSeconds(providerHealthPreset);
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void (async () => {
      const result = await refreshServerProviders({
        environmentId,
        input: {},
      });
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  }, [environmentId, refreshServerProviders]);

  useEffect(() => {
    // A read-only session cannot act on the result and must not spend the
    // remote host's probe budget on a page view.
    if (readOnly) return;
    const nowMs = Date.now();
    if (!shouldAutoRefreshProviders(providerAutoRefreshTracker.get(environmentId), nowMs)) {
      return;
    }
    providerAutoRefreshTracker.set(environmentId, nowMs);
    refreshProviders();
  }, [environmentId, readOnly, refreshProviders]);

  const runProviderUpdate = useCallback(
    async (candidate: Pick<ProviderUpdateCandidate, "driver" | "instanceId">) => {
      // Ref-based re-entry guard, mirroring refreshProviders: a state updater
      // may run after this function returns, so it cannot gate the dispatch.
      if (updatingDriversRef.current.has(candidate.driver)) {
        return;
      }
      updatingDriversRef.current.add(candidate.driver);
      setUpdatingProviderDrivers((previous) => new Set(previous).add(candidate.driver));

      const result = await updateProvider({
        environmentId,
        input: {
          provider: candidate.driver,
          instanceId: candidate.instanceId,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `${PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver}: Update fehlgeschlagen`,
            ...(error instanceof Error ? { description: error.message } : {}),
          }),
        );
      }
      updatingDriversRef.current.delete(candidate.driver);
      setUpdatingProviderDrivers((previous) => {
        if (!previous.has(candidate.driver)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(candidate.driver);
        return next;
      });
    },
    [environmentId, updateProvider],
  );

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    // A remote device may run a server version whose settings predate this
    // driver, so the legacy mirror can be absent. Without either an explicit
    // instance or a legacy blob there is nothing to render for the slot.
    const legacyConfig = legacyProviders[providerSettings.provider];
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider];
    const effectiveInstance: ProviderInstanceConfig | undefined =
      explicitInstance ??
      (legacyConfig !== undefined
        ? ({
            driver,
            enabled: legacyConfig.enabled,
            config: legacyConfig,
          } satisfies ProviderInstanceConfig)
        : undefined);
    // Only the default slot depends on the legacy blob; custom instances for
    // the driver must still render even when the slot has nothing to show.
    if (effectiveInstance !== undefined) {
      const isDirty =
        explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
      rows.push({
        instanceId: defaultInstanceId,
        instance: effectiveInstance,
        driver,
        isDefault: true,
        isDirty,
      });
    }
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault: defaultSlotIdsBySource.has(String(id)),
      });
    }
  }

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(
        Arr.filterMap(nextFavoriteModels, (slug) => {
          const trimmedSlug = slug.trim();
          return trimmedSlug.length > 0 ? Result.succeed(trimmedSlug) : Result.failVoid;
        }),
      ),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (defaultLegacyProvider === undefined) return;
    updateSettings({
      providers: {
        ...settings.providers,
        [driverKind]: defaultLegacyProvider,
      } as typeof settings.providers,
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
    });
  };

  // Installed agents first; the rest collapse under one „Nicht installiert (n)“
  // instead of repeating „Nicht installiert · Nicht im PATH“ on every row.
  const isRowNotInstalled = (row: InstanceRow) =>
    serverProviders.find((candidate) => candidate.instanceId === row.instanceId)?.installed ===
    false;
  const installedRows = rows.filter((row) => !isRowNotInstalled(row));
  const notInstalledRows = rows.filter(isRowNotInstalled);
  const piNotInstalled =
    !serverProviders.some((provider) => provider.driver === "pi") &&
    piCodeProbe?.availability !== "available";
  const notInstalledCount = notInstalledRows.length + (piNotInstalled ? 1 : 0);
  const showPiCodeRow =
    !serverProviders.some((provider) => provider.driver === "pi") &&
    (showNotInstalled || piCodeProbe?.availability === "available");
  const renderProviderRow = (row: InstanceRow) => {
    const driverOption = getDriverOption(row.driver);
    const liveProvider = serverProviders.find(
      (candidate) => candidate.instanceId === row.instanceId,
    );
    const updateCandidate = liveProvider
      ? providerUpdateCandidateByInstanceId.get(liveProvider.instanceId)
      : undefined;
    const isDriverUpdateRunning =
      updateCandidate !== undefined &&
      (updatingProviderDrivers.has(updateCandidate.driver) ||
        serverProviders.some(
          (provider) =>
            provider.driver === updateCandidate.driver && isProviderUpdateActive(provider),
        ));
    const showInlineUpdateButton =
      updateCandidate !== undefined &&
      hasOneClickUpdateProviderCandidate(updateCandidate, serverProviders);
    const canRunInlineUpdate =
      updateCandidate !== undefined &&
      canOneClickUpdateProviderCandidate(updateCandidate, serverProviders) &&
      !updatingProviderDrivers.has(updateCandidate.driver);
    const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    const favoriteModels = Arr.filterMap(settings.favorites ?? [], (favorite) =>
      favorite.provider === row.instanceId ? Result.succeed(favorite.model) : Result.failVoid,
    );
    const resetLabel = driverOption?.label ?? String(row.driver);
    const headerAction =
      row.isDefault && row.isDirty ? (
        <SettingResetButton
          label={`${resetLabel}-Einstellungen`}
          onClick={() => resetDefaultInstance(row.driver)}
        />
      ) : null;
    return (
      <ProviderInstanceCard
        key={row.instanceId}
        instanceId={row.instanceId}
        instance={row.instance}
        driverOption={driverOption}
        liveProvider={liveProvider}
        // This list IS the harness runtimes section, so every card here
        // describes a CLI runtime and never a login. LLM account state
        // lives on Settings → Models.
        runtimeOnly
        isExpanded={openInstanceId === row.instanceId}
        onExpandedChange={(open) =>
          setOpenInstanceId((current) =>
            open ? row.instanceId : current === row.instanceId ? null : current,
          )
        }
        onUpdate={(next) => {
          const wasEnabled = row.instance.enabled ?? true;
          const isDisabling = next.enabled === false && wasEnabled;
          const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
          if (shouldClearTextGen) {
            updateProviderInstance(row, next, {
              textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
            });
          } else {
            updateProviderInstance(row, next);
          }
        }}
        onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
        headerAction={headerAction}
        hiddenModels={modelPreferences.hiddenModels}
        favoriteModels={favoriteModels}
        modelOrder={modelPreferences.modelOrder}
        onHiddenModelsChange={(hiddenModels) =>
          updateProviderModelPreferences(row.instanceId, {
            ...modelPreferences,
            hiddenModels,
          })
        }
        onFavoriteModelsChange={(favoriteModels) =>
          updateProviderFavoriteModels(row.instanceId, favoriteModels)
        }
        onModelOrderChange={(modelOrder) =>
          updateProviderModelPreferences(row.instanceId, {
            ...modelPreferences,
            modelOrder,
          })
        }
        onRunUpdate={
          showInlineUpdateButton && updateCandidate
            ? () => {
                if (!canRunInlineUpdate) {
                  return;
                }
                void runProviderUpdate(updateCandidate);
              }
            : undefined
        }
        onInstallPinnedRuntime={
          row.driver === "minimax" &&
          !row.instance.routeViaGateway &&
          !readOnly &&
          liveProvider?.versionAdvisory?.updateCommand &&
          (!liveProvider.installed || liveProvider.version !== "0.6.2")
            ? () => {
                void runProviderUpdate({ driver: row.driver, instanceId: row.instanceId });
              }
            : undefined
        }
        isUpdating={
          row.driver === "minimax"
            ? updatingProviderDrivers.has(row.driver) ||
              serverProviders.some(
                (provider) => provider.driver === row.driver && isProviderUpdateActive(provider),
              )
            : showInlineUpdateButton
              ? isDriverUpdateRunning
              : undefined
        }
      />
    );
  };

  return (
    <>
      <SettingsSection
        id={searchableSetting("harnesses").id}
        // Named for what these actually are — harness CLI runtimes — so the
        // gateway account section on Modelle can never read as a rival list.
        title={codingAgentsTitle()}
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            {!readOnly ? (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        disabled={isRefreshingProviders}
                        onClick={() => void refreshProviders()}
                        aria-label="Neu prüfen"
                      >
                        {isRefreshingProviders ? (
                          <LoaderIcon className="size-3 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-3" />
                        )}
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Neu prüfen</TooltipPopup>
                </Tooltip>
              </>
            ) : null}
          </div>
        }
      >
        {readOnly ? <SettingsRow title="Nur Ansicht" status={environmentLabel} /> : null}
        <div
          // `inert` blocks focus and interaction in one attribute, so the
          // read-only view stays byte-for-byte the editable layout without
          // threading a disabled flag through every control.
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "space-y-1 opacity-50 select-none" : "space-y-1"}
        >
          {/* Prüfintervall is tuning, not a user setting (#617). */}
          {developerMode ? (
            <SettingsRow
              title="Prüfintervall"
              resetAction={
                providerHealthRefreshIntervalSeconds !==
                defaultProviderHealthRefreshIntervalSeconds ? (
                  <SettingResetButton
                    label="Prüfintervall"
                    onClick={() =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          {
                            providerHealthRefreshInterval: undefined,
                          },
                        ),
                      )
                    }
                  />
                ) : null
              }
              control={
                <div className="flex shrink-0 items-center gap-2">
                  <NumberField
                    value={providerHealthRefreshIntervalSeconds}
                    min={0}
                    step={PROVIDER_HEALTH_INTERVAL_STEP_SECONDS}
                    size="sm"
                    className="w-32"
                    onValueChange={(value) =>
                      updateSettings(
                        backgroundActivityOverrideSettings(
                          settings.backgroundActivity,
                          resolvedBackgroundActivity,
                          {
                            providerHealthRefreshInterval: Duration.seconds(
                              normalizeIntervalSeconds(value),
                            ),
                          },
                        ),
                      )
                    }
                  >
                    <NumberFieldGroup>
                      <NumberFieldDecrement aria-label="Prüfintervall verringern" />
                      <NumberFieldInput aria-label="Prüfintervall (Sekunden)" />
                      <NumberFieldIncrement aria-label="Prüfintervall erhöhen" />
                    </NumberFieldGroup>
                  </NumberField>
                  <span className="text-xs text-muted-foreground">Sekunden</span>
                </div>
              }
            />
          ) : null}

          {installedRows.map(renderProviderRow)}
          {notInstalledCount > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="-ms-1 self-start text-muted-foreground"
              aria-expanded={showNotInstalled}
              onClick={() => setShowNotInstalled((value) => !value)}
              data-workjet-not-installed-toggle=""
            >
              <ChevronDownIcon
                aria-hidden
                className={cn("size-3.5 transition-transform", !showNotInstalled && "-rotate-90")}
              />
              {workjetUiLanguage() === "en" ? "Not installed" : "Nicht installiert"} (
              {notInstalledCount})
            </Button>
          ) : null}
          {showNotInstalled ? notInstalledRows.map(renderProviderRow) : null}
          {showPiCodeRow ? (
            <div className="rounded-lg transition-colors hover:bg-muted/20" data-slot="row">
              <div className="flex min-w-0 items-center gap-3 px-3 py-2 sm:px-4">
                <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                  <PiCodeIcon className="size-4 text-foreground/80" aria-hidden />
                  <span
                    className={cn(
                      "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card",
                      // Green = probed available, muted = not probed yet,
                      // red = probe answered "not available" — two greys made
                      // failure indistinguishable from unknown (Befund K-B16).
                      piCodeProbe === null || piCodeProbe.availability === "available"
                        ? "hidden"
                        : "bg-destructive",
                    )}
                    aria-hidden
                  />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex min-w-0 items-center gap-2">
                    <h3
                      className="truncate text-[13.5px] font-medium text-foreground"
                      data-slot="row-name"
                    >
                      Pi Code
                    </h3>
                    {piCodeProbe?.availability === "available" &&
                    "version" in piCodeProbe &&
                    piCodeProbe.version ? (
                      <code className="shrink-0 text-xs text-muted-foreground">
                        v{piCodeProbe.version}
                      </code>
                    ) : null}
                  </div>
                  <span className="truncate text-xs text-muted-foreground" data-slot="row-meta">
                    {piCodeProbe === null
                      ? "Wird geprüft"
                      : piCodeProbe.availability === "available"
                        ? "Installiert · nicht eingerichtet"
                        : "Nicht installiert"}
                  </span>
                </div>
                {/* Same controls as every harness row (#617): the switch sets Pi Code up. */}
                <div className="flex shrink-0 items-center gap-1" data-slot="row-actions">
                  <Switch
                    checked={false}
                    disabled={readOnly || piCodeProbe?.availability !== "available"}
                    onCheckedChange={(checked) => {
                      if (checked) setIsAddInstancePanelOpen(true);
                    }}
                    aria-label="Pi Code aktiv"
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label="Pi Code Details"
                    aria-expanded={false}
                    disabled={readOnly}
                    onClick={() => setIsAddInstancePanelOpen(true)}
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        {!readOnly ? (
          <AddProviderInstancePanel
            installedDrivers={new Set(rows.map((row) => row.driver))}
            open={isAddInstancePanelOpen}
            environmentId={environmentId}
            onOpenChange={setIsAddInstancePanelOpen}
          />
        ) : null}
      </SettingsSection>

      {/* Session import is a developer tool until it moves to the project list (#619). */}
      {readOnly || !sessionImportVisible ? null : (
        <SessionImportSection environmentId={environmentId} readOnly={false} />
      )}
    </>
  );
}
