"use client";

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
import { Button } from "../ui/button";
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

interface AddProviderInstancePanelProps {
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
}: AddProviderInstancePanelProps) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  const [driver, setDriver] = useState<ProviderDriverKind>(DEFAULT_DRIVER_KIND);
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

  const driverOption = DRIVER_OPTION_BY_VALUE[driver] ?? DEFAULT_DRIVER_OPTION;
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
    setDriver(DEFAULT_DRIVER_KIND);
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
        title: `${label.trim() || driverOption.label} hinzugefügt`,
      });
      handleOpenChange(false);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Harness nicht hinzugefügt",
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  return (
    <InlinePanel
      triggerLabel="Harness hinzufügen"
      open={open}
      onOpenChange={handleOpenChange}
      submitLabel="Hinzufügen"
      onSubmit={handleSave}
      status={showInstanceIdError ? instanceIdError : undefined}
      statusTone="error"
      segment={
        <AddProviderInstanceDriverSelect
          driver={driver}
          onDriverChange={(next) => {
            setDriver(next);
          }}
        />
      }
    >
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Name</span>
        <Input
          className="bg-background"
          placeholder={driverOption.label}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          aria-invalid={showInstanceIdError}
        />
      </label>

      <div className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">Farbe</span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <input
            type="color"
            value={normalizeProviderAccentColor(accentColor) ?? PROVIDER_ACCENT_SWATCHES[0]}
            onChange={(event) => setAccentColor(event.target.value)}
            aria-label="Eigene Farbe"
            className="h-8 w-10 cursor-pointer rounded-xl border border-input bg-background p-0.5"
          />
          <div className="flex flex-wrap gap-1.5">
            {PROVIDER_ACCENT_SWATCHES.map((swatch) => {
              const selected = accentColor.toLowerCase() === swatch;
              return (
                <button
                  key={swatch}
                  type="button"
                  className={cn(
                    "size-6 cursor-pointer rounded-full border transition",
                    selected
                      ? "scale-110 border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                      : "border-black/10 hover:scale-105 dark:border-white/20",
                  )}
                  style={{ backgroundColor: swatch }}
                  onClick={() => setAccentColor(swatch)}
                  aria-label={`Farbe ${swatch}`}
                  aria-pressed={selected}
                />
              );
            })}
          </div>
          {accentColor ? (
            <Button type="button" size="xs" variant="outline" onClick={() => setAccentColor("")}>
              Ohne Farbe
            </Button>
          ) : null}
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
