import { workjetUiLanguage } from "../../workjetProjectControl";
import { GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import { useEffect, useState, type ReactNode } from "react";
import type {
  BackgroundActivitySettings,
  SourceControlProviderKind,
  SourceControlDiscoveryResult,
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  VcsDriverKind,
  VcsDiscoveryItem,
} from "@workjet/contracts";
import {
  getBackgroundActivityBaseProfile,
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@workjet/shared/backgroundActivitySettings";

import {
  useClientSettings,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AzureDevOpsIcon,
  BitbucketIcon,
  GitHubIcon,
  GitIcon,
  GitLabIcon,
  JujutsuIcon,
  type Icon,
} from "../Icons";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SourceControlWritingSettingsSection } from "./SourceControlWritingSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useActiveBusinessOsSettingsEnvironment } from "./businessOsSettingsScope";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

const SOURCE_CONTROL_PROVIDER_ICONS: Partial<Record<SourceControlProviderKind, Icon>> = {
  github: GitHubIcon,
  gitlab: GitLabIcon,
  "azure-devops": AzureDevOpsIcon,
  bitbucket: BitbucketIcon,
};

const VCS_ICONS: Partial<Record<VcsDriverKind, Icon>> = {
  git: GitIcon,
  jj: JujutsuIcon,
};

const SOURCE_CONTROL_SKELETON_ROWS = ["primary", "secondary"] as const;
const GIT_FETCH_INTERVAL_STEP_SECONDS = 5;
type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

function normalizeFetchIntervalSeconds(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
}

function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    ...current.overrides,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

function optionLabel(value: Option.Option<string>): string | null {
  return Option.getOrNull(value);
}

function isProviderDiscoveryItem(
  item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem,
): item is SourceControlProviderDiscoveryItem {
  return "auth" in item;
}

function isVcsNotReady(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): boolean {
  return !isProviderDiscoveryItem(item) && !item.implemented;
}

function authPresentation(auth: SourceControlProviderAuth): {
  readonly label: string;
  readonly badge: "warning" | null;
} {
  if (auth.status === "authenticated") {
    return { label: "Angemeldet", badge: null };
  }
  if (auth.status === "unauthenticated") {
    return { label: "Nicht angemeldet", badge: "warning" };
  }
  return { label: "Status unbekannt", badge: null };
}

function RedactedAccount(props: { readonly account: string | null }) {
  return (
    <RedactedSensitiveText
      value={props.account}
      ariaLabel="Konto zeigen oder verbergen"
      revealTooltip="Konto zeigen"
      hideTooltip="Konto verbergen"
    />
  );
}

function itemStatusDot(item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem): string {
  if (isVcsNotReady(item)) return "bg-muted-foreground/35";
  if (item.status !== "available") return "bg-warning";
  if (isProviderDiscoveryItem(item) && item.auth.status !== "authenticated") return "bg-warning";
  return "bg-success";
}

function SourceControlItemMark({
  item,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const dotClassName = itemStatusDot(item);
  const Icon = isProviderDiscoveryItem(item)
    ? SOURCE_CONTROL_PROVIDER_ICONS[item.kind]
    : VCS_ICONS[item.kind];

  if (!Icon) {
    return <span className={cn("size-2 shrink-0 rounded-full", dotClassName)} aria-hidden />;
  }

  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <Icon className="size-4.5 text-foreground/80" aria-hidden />
    </span>
  );
}

function itemSummary({
  item,
  auth,
  authAccount,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  readonly auth: SourceControlProviderAuth | null;
  readonly authAccount: string | null;
}) {
  // The „Bald“ badge already says it; a second caption is slop (QA 0.0.95 E).
  if (isVcsNotReady(item)) return null;

  if (item.status !== "available") {
    return <span>Auf diesem Server nicht verfügbar</span>;
  }

  if (auth) {
    if (auth.status === "authenticated") {
      return (
        <>
          <span>Angemeldet</span>
          {authAccount ? (
            <>
              <span aria-hidden>als</span>
              <RedactedAccount account={authAccount} />
            </>
          ) : null}
        </>
      );
    }

    // „Nicht angemeldet“ is the badge; „Verfügbar“ next to it contradicted it.
    if (auth.status === "unauthenticated") return null;

    if (!item.executable) {
      return <span>Verfügbar</span>;
    }
    return <span>Nicht geprüft</span>;
  }

  return <span>Verfügbar</span>;
}

function DiscoveryItemRow({
  item,
  control,
}: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
  /** A single setting sits directly in the row; no expand for one field (#601). */
  readonly control?: ReactNode;
}) {
  // Versionsstrings („git version 2.47.3“) sind Entwicklerdetail (Audit F67, #729).
  const developerMode = useClientSettings((settings) => settings.developerMode);
  const version = developerMode ? optionLabel(item.version) : null;
  const auth = isProviderDiscoveryItem(item) ? item.auth : null;
  const authStatus = auth ? authPresentation(auth) : null;
  const authAccount = auth ? optionLabel(auth.account) : null;

  return (
    <div
      className={cn(
        "rounded-xl transition-colors hover:bg-muted/20",
        isVcsNotReady(item) && "opacity-80",
      )}
    >
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <SourceControlItemMark item={item} />
              <span className="truncate text-sm font-medium tracking-[-0.005em] text-foreground">
                {item.label}
              </span>
              {version ? <code className="text-xs text-muted-foreground">{version}</code> : null}
              {isVcsNotReady(item) ? (
                <Badge variant="warning" size="sm">
                  Bald
                </Badge>
              ) : null}
              {authStatus?.badge ? (
                <Badge variant={authStatus.badge} size="sm">
                  {authStatus.label}
                </Badge>
              ) : null}
            </div>
            <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-[13px] leading-[1.45] text-muted-foreground/80">
              {itemSummary({ item, auth, authAccount })}
            </p>
          </div>
          {/* No read-only switch: the summary already says whether it is usable (#601). */}
          {control ? (
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
              {control}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GitFetchIntervalSettings({
  environmentId,
}: {
  readonly environmentId: import("@workjet/contracts").EnvironmentId;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const resolvedBackgroundActivity = resolveServerBackgroundActivitySettings(settings);
  const automaticGitFetchIntervalSeconds = durationToSeconds(
    resolvedBackgroundActivity.automaticGitFetchInterval,
  );
  const defaultAutomaticGitFetchIntervalSeconds = durationToSeconds(
    getBackgroundActivityPresetSettings(
      getBackgroundActivityBaseProfile(settings.backgroundActivity),
    ).automaticGitFetchInterval,
  );
  const canResetFetchInterval =
    automaticGitFetchIntervalSeconds !== defaultAutomaticGitFetchIntervalSeconds;

  const en = workjetUiLanguage() === "en";
  const label = en ? "Fetch interval" : "Abrufintervall";
  return (
    <div className="flex shrink-0 items-center gap-2">
      {canResetFetchInterval ? (
        <SettingResetButton
          label={label}
          onClick={() =>
            updateSettings(
              backgroundActivityOverrideSettings(settings.backgroundActivity, {
                automaticGitFetchInterval: undefined,
              }),
            )
          }
        />
      ) : null}
      <span className="text-xs text-muted-foreground">{label}</span>
      <NumberField
        value={automaticGitFetchIntervalSeconds}
        min={0}
        step={GIT_FETCH_INTERVAL_STEP_SECONDS}
        size="sm"
        className="w-28"
        onValueChange={(value) =>
          updateSettings(
            backgroundActivityOverrideSettings(settings.backgroundActivity, {
              automaticGitFetchInterval: Duration.seconds(normalizeFetchIntervalSeconds(value)),
            }),
          )
        }
      >
        <NumberFieldGroup>
          <NumberFieldDecrement
            aria-label={en ? "Decrease fetch interval" : "Abrufintervall verringern"}
          />
          <NumberFieldInput
            aria-label={en ? "Fetch interval (seconds)" : "Abrufintervall (Sekunden)"}
          />
          <NumberFieldIncrement
            aria-label={en ? "Increase fetch interval" : "Abrufintervall erhöhen"}
          />
        </NumberFieldGroup>
      </NumberField>
      <span className="text-xs text-muted-foreground">s</span>
    </div>
  );
}

function SourceControlSectionSkeleton({
  title,
  headerAction,
}: {
  readonly title: string;
  readonly headerAction?: ReactNode;
}) {
  return (
    <SettingsSection title={title} headerAction={headerAction}>
      {SOURCE_CONTROL_SKELETON_ROWS.map((row) => (
        <div key={row} className="rounded-xl px-3 py-3 sm:px-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
                  <Skeleton className="size-4.5 rounded-md" />
                  <Skeleton
                    className="pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background"
                    aria-hidden
                  />
                </span>
                <Skeleton className="h-4 w-28 rounded-full" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
              <Skeleton className="h-3 w-full max-w-xs rounded-full" />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Skeleton className="size-7 rounded-md" />
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          </div>
        </div>
      ))}
    </SettingsSection>
  );
}

function EmptySourceControlDiscovery({
  error,
  isPending,
  onScan,
}: {
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onScan: () => void;
}) {
  const hasError = error !== null;

  return (
    <SettingsSection id={searchableSetting("source-control").id} title="Server">
      <Empty className="min-h-88">
        <EmptyMedia variant="icon">
          <GitPullRequestIcon />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{hasError ? "Scan fehlgeschlagen" : "Nichts gefunden"}</EmptyTitle>
          {hasError ? <EmptyDescription>{error}</EmptyDescription> : null}
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 px-3 text-xs"
            onClick={onScan}
            disabled={isPending}
          >
            <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
            Erneut scannen
          </Button>
        </EmptyContent>
      </Empty>
    </SettingsSection>
  );
}

export function SourceControlSettingsPanel() {
  const target = useActiveBusinessOsSettingsEnvironment();
  // Ein Laden endet immer: nach 10 s Statuszeile mit einer Aktion.
  const resolving = target.phase === "resolving";
  const [resolvingSlow, setResolvingSlow] = useState(false);
  useEffect(() => {
    if (!resolving) {
      setResolvingSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setResolvingSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [resolving]);
  if (target.phase !== "ready") {
    const showInstanceAction = !resolving || resolvingSlow;
    return (
      <SettingsPageContainer>
        <SettingsSection title="Versionsverwaltung">
          <SettingsRow
            title={
              resolving
                ? resolvingSlow
                  ? "Keine Instanz erreichbar"
                  : "Instanz lädt …"
                : "Kein Code-Rechner"
            }
            control={
              showInstanceAction ? (
                <Button size="sm" variant="outline" render={<Link to="/settings/business-os" />}>
                  Instanzen öffnen
                </Button>
              ) : undefined
            }
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <ScopedSourceControlSettingsPanel
      key={target.environment.environmentId}
      environmentId={target.environment.environmentId}
    />
  );
}

function ScopedSourceControlSettingsPanel({
  environmentId,
}: {
  readonly environmentId: import("@workjet/contracts").EnvironmentId;
}) {
  const discovery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({
      environmentId,
      input: {},
    }),
  );
  const result = discovery.data ?? EMPTY_DISCOVERY_RESULT;
  const hasVersionControlSystems = result.versionControlSystems.length > 0;
  const hasDiscoveryItems = hasVersionControlSystems || result.sourceControlProviders.length > 0;
  const isInitialScanPending = discovery.isPending && discovery.data === null;
  // Ein Laden endet immer: nach 10 s Statuszeile mit „Erneut versuchen“.
  const [scanSlow, setScanSlow] = useState(false);
  useEffect(() => {
    if (!isInitialScanPending) {
      setScanSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setScanSlow(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [isInitialScanPending]);
  const handleScan = () => {
    discovery.refresh();
  };
  const scanButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={handleScan}
            disabled={discovery.isPending}
            aria-label="Erneut scannen"
          >
            <RefreshCwIcon className={cn("size-3", discovery.isPending && "animate-spin")} />
          </Button>
        }
      />
      <TooltipPopup side="top">Erneut scannen</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsPageContainer>
      {isInitialScanPending ? (
        <>
          <SourceControlSectionSkeleton title="Versionsverwaltung" headerAction={scanButton} />
          {scanSlow ? (
            <div
              role="status"
              className="flex items-center gap-3 px-3 text-sm text-muted-foreground sm:px-4"
            >
              <span>Scan dauert länger</span>
              <Button size="sm" variant="outline" onClick={handleScan}>
                Erneut versuchen
              </Button>
            </div>
          ) : null}
        </>
      ) : hasDiscoveryItems ? (
        <>
          {hasVersionControlSystems ? (
            <SettingsSection
              id={searchableSetting("source-control").id}
              title="Versionsverwaltung"
              headerAction={scanButton}
            >
              {/* Only usable systems: „Bald“/unavailable entries are not choices (#627). */}
              {result.versionControlSystems
                .filter((item) => item.implemented && item.status === "available")
                .map((item) => (
                  <DiscoveryItemRow
                    key={`vcs:${item.kind}`}
                    item={item}
                    control={
                      item.kind === "git" ? (
                        <GitFetchIntervalSettings environmentId={environmentId} />
                      ) : undefined
                    }
                  />
                ))}
            </SettingsSection>
          ) : null}

          {result.sourceControlProviders.length > 0 ? (
            <SettingsSection
              id={hasVersionControlSystems ? undefined : searchableSetting("source-control").id}
              title="Hosting-Anbieter"
              headerAction={hasVersionControlSystems ? null : scanButton}
            >
              {result.sourceControlProviders
                .filter((item) => item.status === "available")
                .map((item) => (
                  <DiscoveryItemRow key={`provider:${item.kind}`} item={item} />
                ))}
            </SettingsSection>
          ) : null}
        </>
      ) : (
        <EmptySourceControlDiscovery
          error={discovery.error}
          isPending={discovery.isPending}
          onScan={handleScan}
        />
      )}

      <SourceControlWritingSettingsSection environmentId={environmentId} />
    </SettingsPageContainer>
  );
}
