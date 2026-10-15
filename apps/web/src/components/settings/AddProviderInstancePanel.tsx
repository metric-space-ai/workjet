"use client";

import { useUiText } from "../../hooks/useUiText";

import { useMemo, useState } from "react";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@workjet/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { InlinePanel } from "../ui/inline-panel";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import {
  deriveProviderInstanceId,
  newInstanceUsesWorkjetGateway,
  validateProviderInstanceId,
} from "./AddProviderInstancePanel.logic";
import { AddProviderInstanceDriverSelect } from "./AddProviderInstanceDriverSelect";

const PROVIDER_ACCENT_SWATCHES = [
  "#2563eb",
  "#16a34a",
  "#ea580c",
  "#dc2626",
  "#7c3aed",
  "#0891b2",
] as const;

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const DEFAULT_DRIVER_OPTION = DRIVER_OPTIONS[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
const NO_INSTALLED_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set();

interface AddProviderInstancePanelProps {
  /** Harnesses already on the page: the picker never offers them again (#617). */
  readonly installedDrivers?: ReadonlySet<ProviderDriverKind>;
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * „Harness hinzufügen“ inline auf der Harnesses-Seite (drei Orte, keine
 * Popups). Eine Ebene: oben die Harness-Auswahl, darunter Name, Farbe und
 * nur die Felder des gewählten Harness. Die Instanz-ID wird aus Harness und
 * Name abgeleitet statt abgefragt.
 */
export function AddProviderInstancePanel({
  open,
  environmentId,
  onOpenChange,
  installedDrivers = NO_INSTALLED_DRIVERS,
}: AddProviderInstancePanelProps) {
  const t = useUiText();
  const availableDrivers = DRIVER_OPTIONS.filter((option) => {
    return !installedDrivers.has(option.value);
  });
  const firstDriver = availableDrivers[0]?.value ?? DEFAULT_DRIVER_KIND;
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const [driver, setDriver] = useState<ProviderDriverKind>(firstDriver);
  const [label, setLabel] = useState("");
  // Entwürfe je Harness: ein Wechsel der Auswahl verliert keine Eingaben.
  const [accentColor, setAccentColor] = useState("");
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);

  const existingIds = useMemo(
    () => new Set(Object.keys(settings.providerInstances ?? {})),
    [settings.providerInstances],
  );

  const driverOption =
    DRIVER_OPTION_BY_VALUE[installedDrivers.has(driver) ? firstDriver : driver] ??
    DEFAULT_DRIVER_OPTION;
  const instanceId = deriveProviderInstanceId(driver, label, existingIds);
  const driverSettingsFields = useMemo(
    () => deriveProviderSettingsFields(driverOption),
    [driverOption],
  );
  const instanceIdError = validateProviderInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (config === undefined || Object.keys(config).length === 0) {
        delete next[driver];
      } else {
        next[driver] = config;
      }
      return next;
    });
  };

  const resetDraft = () => {
    setDriver(firstDriver);
    setLabel("");
    setAccentColor("");
    setConfigByDriver({});
    setHasAttemptedSubmit(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) resetDraft();
    onOpenChange(next);
  };

  const handleSave = () => {
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null) return;

    const config = configByDriver[driver] ?? {};
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(driver === "pi" ? { routeViaGateway: true } : {}),
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
    };
    // `ProviderInstanceId.make` revalidates the slug; we've already checked
    // it via `validateProviderInstanceId`, but going through the brand
    // constructor keeps the type boundary honest and guards against any
    // future drift in the slug rules.
    const brandedId = ProviderInstanceId.make(instanceId);
    const nextMap = {
      ...settings.providerInstances,
      [brandedId]: {
        ...nextInstance,
        ...(newInstanceUsesWorkjetGateway(driver) ? { routeViaGateway: true } : {}),
      },
    };
    try {
      updateSettings({ providerInstances: nextMap });
      toastManager.add({
        type: "success",
        title: `${label.trim() || driverOption.label} ${t("hinzugefügt", "added")}`,
      });
      handleOpenChange(false);
    } catch {
      toastManager.add({
        type: "error",
        title: t("Harness nicht hinzugefügt", "Harness not added"),
      });
    }
  };

  // Nothing left to add: no add area at all.
  if (availableDrivers.length === 0) return null;
  const activeDriver = installedDrivers.has(driver) ? firstDriver : driver;

  return (
    <InlinePanel
      triggerLabel={t("Harness hinzufügen", "Add harness")}
      open={open}
      onOpenChange={handleOpenChange}
      submitLabel={t("Hinzufügen", "Add")}
      onSubmit={handleSave}
      status={showInstanceIdError ? instanceIdError : undefined}
      statusTone="error"
      segment={
        <AddProviderInstanceDriverSelect
          driver={activeDriver}
          options={availableDrivers}
          onDriverChange={(next) => {
            setDriver(next);
          }}
        />
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Input
          className="w-full bg-background sm:w-56"
          placeholder={driverOption.label}
          aria-label={t("Name", "Name")}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          aria-invalid={showInstanceIdError}
        />
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={t("Farbe", "Color")}
        >
          {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
            const selected = accentColor.toLowerCase() === swatch;
            return (
              <button
                key={swatch}
                type="button"
                className={cn(
                  "size-7 cursor-pointer rounded-full border transition sm:size-6",
                  selected
                    ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                    : "border-black/10 hover:scale-105 dark:border-white/20",
                )}
                style={{ backgroundColor: swatch }}
                onClick={() => setAccentColor(selected ? "" : swatch)}
                aria-label={`${t("Farbe", "Color")} ${swatch}`}
                aria-pressed={selected}
              />
            );
          })}
        </div>
      </div>

      {driverSettingsFields.length > 0 ? (
        <div className="grid gap-4">
          <ProviderSettingsForm
            definition={driverOption}
            value={configDraft}
            idPrefix={`add-provider-${driver}`}
            variant="dialog"
            onChange={setConfigDraft}
          />
        </div>
      ) : null}
    </InlinePanel>
  );
}
