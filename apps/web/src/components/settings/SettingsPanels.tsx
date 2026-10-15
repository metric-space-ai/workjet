import { SupportBundleSection } from "./SupportBundleSection";
import { ProjectCheckoutRows } from "./ProjectSettingsPanel";
import { workjetUiLanguage } from "../../workjetProjectControl";
import { useUiText } from "../../hooks/useUiText";
import { ArchiveX } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  type BackgroundActivityProfile,
  type DesktopUpdateChannel,
  type ScopedThreadRef,
} from "@workjet/contracts";
import { scopeThreadRef } from "@workjet/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@workjet/client-runtime/state/runtime";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type EnvironmentIdentificationMode,
  MAX_INTERFACE_FONT_SIZE,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_INTERFACE_FONT_SIZE,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@workjet/contracts/settings";
import * as Equal from "effect/Equal";
import { APP_VERSION, HOSTED_APP_CHANNEL, HOSTED_APP_CHANNEL_LABEL } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { isElectron } from "../../env";
import {
  buildHostedChannelSelectionUrl,
  configuredHostedAppUrl,
  type HostedAppChannel,
} from "../../hostedPairing";
import {
  readAppearanceModePreference,
  readThemeHalves,
  readThemePreference,
  useTheme,
} from "../../hooks/useTheme";
import {
  usePrimarySettings,
  useUpdateClientSettings,
  useUpdatePrimarySettings,
} from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { primaryServerConfigAtom } from "../../state/server";
import { formatVersionChipLabel } from "../VersionChip";
import { useProjects } from "../../state/entities";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { formatRelativeTime } from "../../timestampFormat";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Empty, EmptyContent, EmptyHeader, EmptyLoading, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { clampInterfaceFontSize } from "../../appearanceFonts";
import { Row } from "../ui/row";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getChangedTypographySettingLabels,
  hasChangedBackgroundActivitySettings,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Bild",
  pill: "Versions-Chip",
  none: "Keine",
};

const INTERFACE_LANGUAGE_LABELS = {
  de: "Deutsch",
  en: "English",
} as const;

const BACKGROUND_ACTIVITY_PROFILE_LABELS: Record<BackgroundActivityProfile, string> = {
  balanced: "Ausgewogen",
  performance: "Leistung",
  "battery-saver": "Akku sparen",
};

function archiveText(de: string, en: string): string {
  return workjetUiLanguage() === "en" ? en : de;
}

function resetBackgroundActivitySettings() {
  return {
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  };
}

function backgroundActivityProfileSettings(profile: BackgroundActivityProfile) {
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile,
      overrides: {},
    },
  };
}

/** Dieselbe Versionszeile wie der VersionChip (UI-Vertrag §6), nur lesend. */
function AboutVersionTitle() {
  const environment = useAtomValue(primaryServerConfigAtom)?.environment ?? null;
  const label = formatVersionChipLabel(
    APP_VERSION,
    environment?.serverVersion ?? null,
    environment?.label ?? null,
  );
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2">
      <span>Version</span>
      <span className="text-[12px] font-medium text-muted-foreground tabular-nums">{label}</span>
    </span>
  );
}

function AboutVersionSection() {
  const updateState = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);
  const [isInstallConfirming, setIsInstallConfirming] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  const selectedHostedAppChannel = hasDesktopBridge ? null : HOSTED_APP_CHANNEL;

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Update-Kanal nicht geändert",
              description: error instanceof Error ? error.message : undefined,
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Update nicht geladen",
            description: error instanceof Error ? error.message : undefined,
          }),
        );
      });
      return;
    }

    if (action === "install") {
      if (isUpdateActionPending) return;
      // Inline-Bestätigung statt Dialog: der erste Klick fragt in der Zeile.
      if (!isInstallConfirming) {
        setIsInstallConfirming(true);
        return;
      }
      setIsInstallConfirming(false);
      setIsUpdateActionPending(true);
      void bridge
        .installUpdate()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Update nicht installiert",
              description: error instanceof Error ? error.message : undefined,
            }),
          );
        })
        .finally(() => setIsUpdateActionPending(false));
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Update-Prüfung fehlgeschlagen",
              description: result.state.message ?? undefined,
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Update-Prüfung fehlgeschlagen",
            description: error instanceof Error ? error.message : undefined,
          }),
        );
      });
  }, [isInstallConfirming, isUpdateActionPending, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = {
    download: "Laden",
    install: isInstallConfirming ? "Jetzt neu starten" : "Installieren",
  };
  const statusLabel: Record<string, string> = {
    checking: "Prüft …",
    downloading: "Lädt …",
    "up-to-date": "Aktuell",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Updates prüfen";
  const status =
    action === "install" && isInstallConfirming
      ? "Workjet startet zum Installieren neu."
      : action === "download" || action === "install"
        ? "Update verfügbar"
        : undefined;

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        status={status}
        control={
          <>
            {action === "install" && isInstallConfirming ? (
              <Button size="xs" variant="outline" onClick={() => setIsInstallConfirming(false)}>
                Abbrechen
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant={action === "install" ? "default" : "outline"}
                    disabled={buttonDisabled || isUpdateActionPending}
                    onClick={handleButtonClick}
                  >
                    {buttonLabel}
                  </Button>
                }
              />
              {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
            </Tooltip>
          </>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          title="Update-Kanal"
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-40"
                aria-label="Update-Kanal"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly" ? "Nightly" : "Stabil"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Stabil
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : selectedHostedAppChannel && configuredHostedAppUrl() ? (
        <SettingsRow
          title="Update-Kanal"
          control={
            <Select
              value={selectedHostedAppChannel}
              onValueChange={(value) => {
                if (value === selectedHostedAppChannel) return;
                const channelUrl = buildHostedChannelSelectionUrl({
                  channel: value as HostedAppChannel,
                });
                if (channelUrl) window.location.assign(channelUrl);
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Update-Kanal">
                <SelectValue>{HOSTED_APP_CHANNEL_LABEL}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Latest
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}

export function useSettingsRestore(onRestored?: () => void) {
  const {
    theme,
    setTheme,
    followSystem,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    themeHalves,
  } = useTheme();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );
  const isBackgroundActivityDirty = hasChangedBackgroundActivitySettings(settings);

  const changedSettingLabels = useMemo(
    () => [
      ...(theme !== "system" ? ["Thema"] : []),
      ...(!followSystem ? ["System folgen"] : []),
      ...(themeHalves !== null ? ["Themen-Mix"] : []),
      ...(settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? ["Glas"] : []),
      ...(settings.environmentIdentificationMode !==
      DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode
        ? ["Umgebungskennung"]
        : []),
      ...(settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat
        ? ["Zeitformat"]
        : []),
      ...(settings.calendarWeekStart !== DEFAULT_UNIFIED_SETTINGS.calendarWeekStart
        ? ["Wochenbeginn"]
        : []),
      ...(settings.sidebarThreadPreviewCount !== DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount
        ? ["Sichtbare Unterhaltungen"]
        : []),
      ...(settings.sidebarProjectGroupingMode !==
      DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode
        ? ["Projekte gruppieren"]
        : []),
      ...(settings.sidebarAutoSettleAfterDays !==
      DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays
        ? ["Inaktive ablegen"]
        : []),
      ...(settings.sidebarAutoSettleOnMerge !== DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge
        ? ["Zusammengeführte ablegen"]
        : []),
      ...(settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? ["Zeilenumbruch"] : []),
      ...getChangedTypographySettingLabels(settings),
      ...(settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace
        ? ["Leerraum ausblenden"]
        : []),
      ...(settings.enableLegacyTokenStreaming !==
      DEFAULT_UNIFIED_SETTINGS.enableLegacyTokenStreaming
        ? ["Token-Streaming"]
        : []),
      ...(settings.enableProviderUpdateChecks !==
      DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks
        ? ["Update-Prüfung"]
        : []),
      ...(isBackgroundActivityDirty ? ["Hintergrundaktivität"] : []),
      ...(settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode
        ? ["Neue Unterhaltungen"]
        : []),
      ...(settings.newWorktreesStartFromOrigin !==
      DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin
        ? ["Von origin starten"]
        : []),
      ...(settings.addProjectBaseDirectory !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory
        ? ["Projektordner"]
        : []),
      ...(isTextGenerationModelDirty ? ["Textmodell"] : []),
    ],
    [
      isTextGenerationModelDirty,
      isBackgroundActivityDirty,
      settings.addProjectBaseDirectory,
      settings.defaultThreadEnvMode,
      settings.newWorktreesStartFromOrigin,
      settings.diffIgnoreWhitespace,
      settings.environmentIdentificationMode,
      settings.fontFamilyCode,
      settings.fontFamilyComposer,
      settings.fontFamilySans,
      settings.fontFamilyTerminal,
      settings.fontSizeCode,
      settings.fontSizeInterface,
      settings.fontSizePrompt,
      settings.fontSizeTerminal,
      settings.glassOpacity,
      settings.enableLegacyTokenStreaming,
      settings.enableProviderUpdateChecks,
      settings.sidebarAutoSettleAfterDays,
      settings.sidebarAutoSettleOnMerge,
      settings.sidebarProjectGroupingMode,
      settings.sidebarThreadPreviewCount,
      settings.timestampFormat,
      settings.calendarWeekStart,
      settings.wordWrap,
      followSystem,
      theme,
      themeHalves,
    ],
  );

  /**
   * `confirmed: true` überspringt die Rückfrage: der Aufrufer hat inline
   * bestätigt (drei Orte, keine Popups). Ohne Option bleibt die alte
   * Rückfrage nur für Aufrufer, die noch nicht umgestellt sind.
   */
  const restoreDefaults = useCallback(
    async (options?: { readonly confirmed?: boolean }) => {
      if (changedSettingLabels.length === 0) return;
      if (options?.confirmed !== true) {
        const api = readLocalApi();
        const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm(
          [
            "Standard wiederherstellen?",
            `Zurückgesetzt wird: ${changedSettingLabels.join(", ")}.`,
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) return;
      }

      // Only touch the theme keys that are actually dirty, so a theme-storage
      // failure cannot block restoring unrelated settings. Preferences are
      // re-read after the confirmation dialog: they may have changed (another
      // tab, an OS flip) while it was open, and rollback must restore the live
      // values rather than the ones captured at render time.
      let previousTheme = theme;
      try {
        previousTheme = readThemePreference();
      } catch {
        // Storage is unreadable; the render-time value is the best rollback.
      }
      // The mix may have changed while the confirmation dialog was open; both
      // the dirty check and the rollback must see the live value.
      const liveHalves = readThemeHalves();
      const needsThemeReset = previousTheme !== "system";
      const needsMixReset = liveHalves !== null;
      // Same for the appearance mode: trusting the render-time value would skip
      // the reset and report success while a non-system mode stayed in storage.
      const needsFollowSystemReset = readAppearanceModePreference(previousTheme) !== "system";
      const notifyThemeRestoreFailure = () => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Thema nicht zurückgesetzt",
          }),
        );
      };
      // Rollback restores the base preference first (which clears any mix) and
      // then re-applies the captured mix on top, so no failure path can leave
      // the pair of keys half-restored.
      const previousHalves = liveHalves;
      const rollbackThemeState = () => {
        if (needsThemeReset) setTheme(previousTheme);
        if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
        if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
      };
      if (needsThemeReset && !setTheme("system")) {
        notifyThemeRestoreFailure();
        return;
      }
      if (needsMixReset && !clearThemeHalves()) {
        rollbackThemeState();
        notifyThemeRestoreFailure();
        return;
      }
      if (needsFollowSystemReset && !setFollowSystem(true)) {
        rollbackThemeState();
        notifyThemeRestoreFailure();
        return;
      }
      updateSettings({
        timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
        calendarWeekStart: DEFAULT_UNIFIED_SETTINGS.calendarWeekStart,
        wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
        diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
        environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
        glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
        sidebarThreadPreviewCount: DEFAULT_UNIFIED_SETTINGS.sidebarThreadPreviewCount,
        sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
        sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
        sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
        enableLegacyTokenStreaming: DEFAULT_UNIFIED_SETTINGS.enableLegacyTokenStreaming,
        enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
        defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
        newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
        addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
        confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
        confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
        textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
        fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
        fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
        fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
        fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
        fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
      });
      onRestored?.();
    },
    [
      changedSettingLabels,
      clearThemeHalves,
      onRestored,
      setFollowSystem,
      setTheme,
      setThemeHalf,
      theme,
      themeHalves,
      updateSettings,
    ],
  );

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}

const COLOR_SCHEME_LABELS = { light: "Hell", dark: "Dunkel", system: "System" } as const;
type ColorSchemeChoice = keyof typeof COLOR_SCHEME_LABELS;

function isColorSchemeChoice(value: unknown): value is ColorSchemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/** Darstellung (#553): nur Hell/Dunkel/System und Schriftgröße, als Zeilen in „Allgemein“. */
function AppearanceRows() {
  const { appearanceMode, setAppearanceMode, setTheme } = useTheme();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const colorScheme: ColorSchemeChoice = isColorSchemeChoice(appearanceMode)
    ? appearanceMode
    : "system";
  const fontSize = clampInterfaceFontSize(settings.fontSizeInterface);
  return (
    <>
      <SettingsRow
        {...searchableSetting("color-scheme")}
        control={
          <Select
            value={colorScheme}
            onValueChange={(value) => {
              if (!isColorSchemeChoice(value)) return;
              setTheme(value);
              setAppearanceMode(value);
            }}
          >
            <SelectTrigger aria-label={searchableSetting("color-scheme").title} className="w-40">
              <SelectValue>{COLOR_SCHEME_LABELS[colorScheme]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(COLOR_SCHEME_LABELS) as ColorSchemeChoice[]).map((value) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {COLOR_SCHEME_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("font-size")}
        resetAction={
          fontSize !== DEFAULT_UNIFIED_SETTINGS.fontSizeInterface ? (
            <SettingResetButton
              label={searchableSetting("font-size").title}
              onClick={() =>
                updateSettings({ fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface })
              }
            />
          ) : null
        }
        control={
          <Select
            value={String(fontSize)}
            onValueChange={(next) => {
              const parsed = Number(next);
              if (
                Number.isInteger(parsed) &&
                parsed >= MIN_INTERFACE_FONT_SIZE &&
                parsed <= MAX_INTERFACE_FONT_SIZE
              ) {
                updateSettings({ fontSizeInterface: parsed });
              }
            }}
          >
            <SelectTrigger aria-label={searchableSetting("font-size").title} className="w-40">
              <SelectValue>{fontSize} px</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {Array.from(
                { length: MAX_INTERFACE_FONT_SIZE - MIN_INTERFACE_FONT_SIZE + 1 },
                (_, index) => MIN_INTERFACE_FONT_SIZE + index,
              ).map((px) => (
                <SelectItem hideIndicator key={px} value={String(px)}>
                  {px} px
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </>
  );
}

function EnvironmentIdentificationRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const showEnvironmentIdentification =
    resolveEnvironmentIdentificationPillLabel(environmentStageLabel) !== null;
  return (
    <>
      {showEnvironmentIdentification ? (
        <SettingsRow
          {...searchableSetting("environment-identification")}
          resetAction={
            settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
              <SettingResetButton
                label="Umgebungskennung"
                onClick={() =>
                  updateSettings({
                    environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.environmentIdentificationMode}
              onValueChange={(value) => {
                if (value === "artwork" || value === "pill" || value === "none") {
                  updateSettings({ environmentIdentificationMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Umgebungskennung">
                <SelectValue>
                  {ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                  <SelectItem hideIndicator key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}

function WordWrapRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsRow
      {...searchableSetting("word-wrap")}
      resetAction={
        settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
          <SettingResetButton
            label="Zeilenumbruch"
            onClick={() => updateSettings({ wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wordWrap}
          onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
          aria-label="Zeilenumbruch"
        />
      }
    />
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function AutoSettleDaysInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (days: number) => void;
}) {
  // Local draft so the field can be emptied mid-edit; the setting only moves
  // on valid input and snaps back to the persisted value on blur.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  return (
    <Input
      type="number"
      min={MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      max={MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
      className="w-full sm:w-24"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        // Number(), not parseInt: "3.5" must be rejected (not truncated to a
        // committed 3 while the field shows 3.5) — commit only when the
        // persisted value matches the displayed one.
        const parsed = Number(event.target.value);
        if (
          Number.isInteger(parsed) &&
          parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
          parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
        ) {
          onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(value))}
      aria-label="Tage ohne Aktivität"
    />
  );
}

/**
 * Altfunktionen: drei ruhige Schalterzeilen ohne Aufklapper und ohne
 * Erklärtext. Token-Streaming fragt beim Einschalten inline in der Zeile.
 */
function LegacyFeaturesSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [confirmTokenStreaming, setConfirmTokenStreaming] = useState(false);

  return (
    <SettingsSection title="Altfunktionen">
      <SettingsRow
        {...searchableSetting("legacy-plan-mode")}
        control={
          <Switch
            checked={settings.planModeEnabled}
            onCheckedChange={(checked) => updateSettings({ planModeEnabled: Boolean(checked) })}
            aria-label={searchableSetting("legacy-plan-mode").title}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("legacy-token-streaming")}
        status={confirmTokenStreaming ? "Deutlich langsamer als Standard." : undefined}
        control={
          confirmTokenStreaming ? (
            <>
              <Button size="xs" variant="outline" onClick={() => setConfirmTokenStreaming(false)}>
                Abbrechen
              </Button>
              <Button
                size="xs"
                onClick={() => {
                  setConfirmTokenStreaming(false);
                  updateSettings({ enableLegacyTokenStreaming: true });
                }}
              >
                Einschalten
              </Button>
            </>
          ) : (
            <Switch
              checked={settings.enableLegacyTokenStreaming}
              onCheckedChange={(checked) => {
                if (!checked) {
                  updateSettings({ enableLegacyTokenStreaming: false });
                  return;
                }
                setConfirmTokenStreaming(true);
              }}
              aria-label={searchableSetting("legacy-token-streaming").title}
            />
          )
        }
      />
    </SettingsSection>
  );
}

export function GeneralSettingsPanel() {
  const t = useUiText();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const updateClientSettings = useUpdateClientSettings();

  // Nur die drei Profile; ein gespeichertes „advanced“ zeigt das Standardprofil.
  const resolvedProfileOption = resolveBackgroundActivityProfileOption(settings);
  const backgroundActivityProfile: BackgroundActivityProfile =
    resolvedProfileOption === "advanced" ? "balanced" : resolvedProfileOption;
  const canResetBackgroundActivity = !Equal.equals(
    settings.backgroundActivity,
    DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Allgemein">
        <SettingsRow
          title="Sprache"
          control={
            <Select
              value={settings.interfaceLanguage === "en" ? "en" : "de"}
              onValueChange={(value) => {
                if (value === "de" || value === "en")
                  updateClientSettings({ interfaceLanguage: value });
              }}
            >
              <SelectTrigger aria-label="Sprache" className="w-40">
                <SelectValue>
                  {INTERFACE_LANGUAGE_LABELS[settings.interfaceLanguage === "en" ? "en" : "de"]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="de">Deutsch</SelectItem>
                <SelectItem value="en">English</SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <AppearanceRows />
        <SettingsRow
          {...searchableSetting("developer-mode")}
          control={
            <Switch
              checked={settings.developerMode}
              onCheckedChange={(checked) =>
                updateClientSettings({ developerMode: Boolean(checked) })
              }
              aria-label={searchableSetting("developer-mode").title}
            />
          }
        />
      </SettingsSection>

      {settings.developerMode ? (
        <>
          <SettingsSection title="Entwickler">
            <EnvironmentIdentificationRow />
            <WordWrapRow />
            <SettingsRow
              title={t("Hintergrundaktivität", "Background activity")}
              resetAction={
                canResetBackgroundActivity ? (
                  <SettingResetButton
                    label={t("Hintergrundaktivität", "Background activity")}
                    onClick={() => updateSettings(resetBackgroundActivitySettings())}
                  />
                ) : null
              }
              control={
                <>
                  <Select
                    value={backgroundActivityProfile}
                    onValueChange={(value) => {
                      if (
                        value === "balanced" ||
                        value === "performance" ||
                        value === "battery-saver"
                      ) {
                        updateSettings(backgroundActivityProfileSettings(value));
                      }
                    }}
                  >
                    <SelectTrigger
                      className="w-full sm:w-40"
                      aria-label={t("Hintergrundaktivität", "Background activity")}
                    >
                      <SelectValue>
                        {BACKGROUND_ACTIVITY_PROFILE_LABELS[backgroundActivityProfile]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem hideIndicator value="balanced">
                        {BACKGROUND_ACTIVITY_PROFILE_LABELS.balanced}
                      </SelectItem>
                      <SelectItem hideIndicator value="performance">
                        {BACKGROUND_ACTIVITY_PROFILE_LABELS.performance}
                      </SelectItem>
                      <SelectItem hideIndicator value="battery-saver">
                        {BACKGROUND_ACTIVITY_PROFILE_LABELS["battery-saver"]}
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                </>
              }
            />
            <SettingsRow
              {...searchableSetting("auto-settle-merged-threads")}
              resetAction={
                settings.sidebarAutoSettleOnMerge !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge ? (
                  <SettingResetButton
                    label="Zusammengeführte ablegen"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.sidebarAutoSettleOnMerge}
                  onCheckedChange={(checked) =>
                    updateSettings({ sidebarAutoSettleOnMerge: Boolean(checked) })
                  }
                  aria-label="Zusammengeführte ablegen"
                />
              }
            />

            <SettingsRow
              {...searchableSetting("auto-settle-inactive-threads")}
              resetAction={
                settings.sidebarAutoSettleAfterDays !==
                DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays ? (
                  <SettingResetButton
                    label="Inaktive ablegen"
                    onClick={() =>
                      updateSettings({
                        sidebarAutoSettleAfterDays:
                          DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.sidebarAutoSettleAfterDays !== null}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      sidebarAutoSettleAfterDays: checked ? AUTO_SETTLE_DEFAULT_DAYS : null,
                    })
                  }
                  aria-label="Inaktive ablegen"
                />
              }
            />
            {settings.sidebarAutoSettleAfterDays !== null ? (
              <SettingsRow
                title="Tage ohne Aktivität"
                control={
                  <AutoSettleDaysInput
                    value={settings.sidebarAutoSettleAfterDays}
                    onCommit={(days) => updateSettings({ sidebarAutoSettleAfterDays: days })}
                  />
                }
              />
            ) : null}

            <SettingsRow
              {...searchableSetting("hide-whitespace-changes")}
              resetAction={
                settings.diffIgnoreWhitespace !== DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace ? (
                  <SettingResetButton
                    label="Leerraum ausblenden"
                    onClick={() =>
                      updateSettings({
                        diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.diffIgnoreWhitespace}
                  onCheckedChange={(checked) =>
                    updateSettings({ diffIgnoreWhitespace: Boolean(checked) })
                  }
                  aria-label="Leerraum ausblenden"
                />
              }
            />

            <SettingsRow
              {...searchableSetting("provider-update-checks")}
              resetAction={
                settings.enableProviderUpdateChecks !==
                DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks ? (
                  <SettingResetButton
                    label="Update-Prüfung"
                    onClick={() =>
                      updateSettings({
                        enableProviderUpdateChecks:
                          DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.enableProviderUpdateChecks}
                  onCheckedChange={(checked) =>
                    updateSettings({ enableProviderUpdateChecks: Boolean(checked) })
                  }
                  aria-label="Update-Prüfung"
                />
              }
            />

            <SettingsRow
              {...searchableSetting("new-threads")}
              resetAction={
                settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ||
                settings.newWorktreesStartFromOrigin !==
                  DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
                  <SettingResetButton
                    label="Neue Unterhaltungen"
                    onClick={() =>
                      updateSettings({
                        defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                        newWorktreesStartFromOrigin:
                          DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Select
                  value={settings.defaultThreadEnvMode}
                  onValueChange={(value) => {
                    if (value === "local" || value === "worktree") {
                      updateSettings({ defaultThreadEnvMode: value });
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-44" aria-label="Neue Unterhaltungen">
                    <SelectValue>
                      {settings.defaultThreadEnvMode === "worktree" ? "Neue Arbeitskopie" : "Lokal"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem hideIndicator value="local">
                      Lokal
                    </SelectItem>
                    <SelectItem hideIndicator value="worktree">
                      Neue Arbeitskopie
                    </SelectItem>
                  </SelectPopup>
                </Select>
              }
            />

            {settings.defaultThreadEnvMode === "worktree" ? (
              <SettingsRow
                className="bg-muted/20 sm:pl-9"
                title={searchableSetting("start-from-origin").title}
                resetAction={
                  settings.newWorktreesStartFromOrigin !==
                  DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
                    <SettingResetButton
                      label={searchableSetting("start-from-origin").title}
                      onClick={() =>
                        updateSettings({
                          newWorktreesStartFromOrigin:
                            DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <Switch
                    checked={settings.newWorktreesStartFromOrigin}
                    onCheckedChange={(checked) =>
                      updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
                    }
                    aria-label={searchableSetting("start-from-origin").title}
                  />
                }
              />
            ) : null}
          </SettingsSection>
          <LegacyFeaturesSection />
        </>
      ) : null}

      <SettingsSection title="Über Workjet">
        {isElectron || HOSTED_APP_CHANNEL ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow title={<AboutVersionTitle />} />
        )}
      </SettingsSection>
      {/* Diagnose is a developer tool (#552); end users keep only the support bundle. */}
      {settings.developerMode ? null : <SupportBundleSection />}
    </SettingsPageContainer>
  );
}

/** „vor 3 Std.“ statt „3h ago“; nutzt die gemeinsame Zeitberechnung. */
function formatGermanRelativeTime(isoDate: string): string {
  const relative = formatRelativeTime(isoDate);
  if (!relative) return "—";
  const match = /^(\d+)([mhd])$/.exec(relative.value);
  if (!match) return "gerade eben";
  const amount = Number(match[1]);
  const unit =
    match[2] === "m" ? "Min." : match[2] === "h" ? "Std." : amount === 1 ? "Tag" : "Tagen";
  return `vor ${amount} ${unit}`;
}

export function ArchivedThreadsPanel() {
  const projects = useProjects();
  const { unarchiveThread, confirmAndDeleteThread, deleteThread } = useThreadActions();
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);
  // Ein Laden endet immer: EmptyLoading zeigt nach 10 s „Erneut versuchen“.

  const archivedGroups = useMemo(() => {
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects.map(
          (project) =>
            [
              `${environmentId}:${project.id}`,
              {
                id: project.id,
                environmentId,
                name: project.title,
                cwd: project.workspaceRoot,
                faviconPath: project.faviconPath,
              },
            ] as const,
        ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...thread,
        environmentId,
      })),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups: Array<{
      readonly project: (typeof archivedProjects)[number];
      readonly threads: Array<(typeof threads)[number]>;
    }> = [];
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        groups.push({
          project,
          threads: projectThreads.toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
        });
      }
    }
    return groups;
  }, [archivedSnapshots]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Wiederherstellen" },
          { id: "delete", label: "Löschen", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        const result = await unarchiveThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Nicht wiederhergestellt",
              description: error instanceof Error ? error.message : undefined,
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        const result = await confirmAndDeleteThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Nicht gelöscht",
              description: error instanceof Error ? error.message : undefined,
            }),
          );
        }
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads, unarchiveThread],
  );

  const restore = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await unarchiveThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Nicht wiederhergestellt",
            description: error instanceof Error ? error.message : undefined,
          }),
        );
      }
    })();
  };

  // Die Zeile fragt inline nach (ui/row), daher ohne zweiten Bestätigungsdialog.
  const remove = (threadRef: ScopedThreadRef) => {
    void (async () => {
      const result = await deleteThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Nicht gelöscht",
            description: error instanceof Error ? error.message : undefined,
          }),
        );
      }
    })();
  };

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <div
          {...(isLoadingArchive ? {} : { id: searchableSetting("archive").id })}
          data-slot="archive-empty"
        >
          {isLoadingArchive ? (
            <EmptyLoading
              title={archiveText("Chat-Archiv wird geladen …", "Loading chat archive …")}
              slowMessage={archiveText("Chat-Archiv nicht geladen.", "Chat archive not loaded.")}
              onRetry={refreshArchivedThreads}
            />
          ) : archiveError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle role="alert">
                  {archiveText("Chat-Archiv nicht geladen", "Chat archive not loaded")}
                </EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => refreshArchivedThreads()}>
                  {archiveText("Erneut versuchen", "Retry")}
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  {archiveText("Keine archivierten Unterhaltungen", "No archived conversations")}
                </EmptyTitle>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" render={<Link to="/" />}>
                  {archiveText("Zu den Projekten", "To projects")}
                </Button>
              </EmptyContent>
            </Empty>
          )}
        </div>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }, index) => (
          <SettingsSection
            key={project.id}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={project.name}
            icon={
              <ProjectFavicon
                environmentId={project.environmentId}
                cwd={project.cwd}
                faviconPath={project.faviconPath}
              />
            }
          >
            <ul aria-label={`Archiv ${project.name}`} className="divide-y divide-border/60">
              {projectThreads.map((thread) => {
                const threadRef = scopeThreadRef(thread.environmentId, thread.id);
                return (
                  <li
                    key={thread.id}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      void (async () => {
                        const result = await settlePromise(() =>
                          handleArchivedThreadContextMenu(threadRef, {
                            x: event.clientX,
                            y: event.clientY,
                          }),
                        );
                        if (result._tag === "Failure") {
                          const error = squashAtomCommandFailure(result);
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: "Aktion fehlgeschlagen",
                              description: error instanceof Error ? error.message : undefined,
                            }),
                          );
                        }
                      })();
                    }}
                  >
                    <Row
                      name={thread.title}
                      meta={`Archiviert ${formatGermanRelativeTime(
                        thread.archivedAt ?? thread.createdAt,
                      )} · Erstellt ${formatGermanRelativeTime(thread.createdAt)}`}
                      chips={
                        <Button size="xs" variant="outline" onClick={() => restore(threadRef)}>
                          <ArchiveX className="size-3.5" />
                          Wiederherstellen
                        </Button>
                      }
                      onDelete={() => remove(threadRef)}
                      deleteLabel="Löschen"
                      deleteConfirmTitle="Unterhaltung löschen?"
                    />
                  </li>
                );
              })}
            </ul>
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}

/**
 * Where new projects start on THIS computer. Machine-specific, so it lives on
 * Rechner, not in Allgemein (Michael, 2026-10-13).
 */
export function ProjectFolderSettingRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <>
      <ProjectFolderRow
        value={settings.addProjectBaseDirectory}
        onCommit={(addProjectBaseDirectory) => updateSettings({ addProjectBaseDirectory })}
      />
      {/* Arbeitskopien und Projekt-Skripte: nur im Entwicklermodus (15.10.). */}
      <ProjectCheckoutRows />
    </>
  );
}

function ProjectFolderRow({
  value,
  onCommit,
}: {
  readonly value: string;
  readonly onCommit: (next: string) => void;
}) {
  return (
    <SettingsRow
      {...searchableSetting("add-project-starts-in")}
      resetAction={
        value !== DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
          <SettingResetButton
            label="Projektordner"
            onClick={() => onCommit(DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory)}
          />
        ) : null
      }
      control={
        <DraftInput
          className="w-full sm:w-72"
          value={value}
          onCommit={onCommit}
          placeholder="~/"
          spellCheck={false}
          aria-label={searchableSetting("add-project-starts-in").title}
        />
      }
    />
  );
}
