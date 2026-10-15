import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@workjet/contracts";
import { Fragment, memo, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import { ComposerControl, ComposerControlChevron } from "./ComposerControl";

/** Trennt Instanz und Modell im Wert der Auswahl; kommt in keiner Instanz-ID vor. */
const VALUE_SEPARATOR = "\u0000";

/**
 * Modellwahl (drei Orte, keine Popups): ein reines Auswahlmenü, gruppiert
 * nach Harness-Instanz. Ein Eintrag je Modell, das aktive ist markiert.
 */
export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  activeInstanceId: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  terminalOpen?: boolean;
  open?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  triggerAriaLabel?: string;
  onOpenChange?: (open: boolean) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;

  const activeEntry = useMemo(
    () =>
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null,
    [props.activeInstanceId, props.instanceEntries],
  );

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  // Gehört der Slug zu einer anderen Instanz, zeigt der Auslöser das erste
  // Modell der aktiven Instanz statt eines veralteten fremden Namens.
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === props.model) ??
    selectedInstanceOptions[0];
  const triggerTitle = selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model;
  const triggerLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : props.model;
  const duplicateDriverCount = props.instanceEntries.filter(
    (entry) => activeEntry !== null && entry.driverKind === activeEntry.driverKind,
  ).length;
  const showInstanceBadge = Boolean(activeEntry?.accentColor) || duplicateDriverCount > 1;

  const groups = useMemo(() => {
    const out: Array<{ entry: ProviderInstanceEntry; models: ReadonlyArray<ModelEsque> }> = [];
    for (const entry of props.instanceEntries) {
      if (!isProviderInstancePickerReady(entry)) continue;
      if (props.lockedProvider !== null) {
        if (entry.driverKind !== props.lockedProvider) continue;
        if (
          props.lockedContinuationGroupKey &&
          entry.continuationGroupKey !== props.lockedContinuationGroupKey
        )
          continue;
      }
      const models = props.modelOptionsByInstance.get(entry.instanceId) ?? [];
      if (models.length > 0) out.push({ entry, models });
    }
    return out;
  }, [
    props.instanceEntries,
    props.lockedContinuationGroupKey,
    props.lockedProvider,
    props.modelOptionsByInstance,
  ]);

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) setUncontrolledIsMenuOpen(open);
  };

  const currentValue = `${activeInstanceId}${VALUE_SEPARATOR}${selectedModel?.slug ?? props.model}`;

  return (
    <Menu open={isMenuOpen} onOpenChange={(open) => setIsMenuOpen(props.disabled ? false : open)}>
      <MenuTrigger
        render={
          <ComposerControl
            aria-label={props.triggerAriaLabel}
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-between whitespace-nowrap",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {activeEntry ? (
            <ProviderInstanceIcon
              driverKind={activeEntry.driverKind}
              displayName={activeEntry.displayName}
              accentColor={activeEntry.accentColor}
              showBadge={showInstanceBadge}
              className="size-4"
              iconClassName={cn("size-4", props.activeProviderIconClassName)}
              indicatorBackground="var(--input)"
              badgeClassName={cn(
                "right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3",
                "px-0.5 text-[7px]",
              )}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0 flex-1 overflow-hidden truncate" />}>
              {triggerTitle}
            </TooltipTrigger>
            <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
          </Tooltip>
        </span>
        <span aria-hidden="true" className="flex items-center">
          <ComposerControlChevron />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="max-w-80" data-model-picker-content="">
        <MenuRadioGroup
          value={currentValue}
          onValueChange={(value: string) => {
            if (props.disabled) return;
            const [instanceId, model] = value.split(VALUE_SEPARATOR);
            if (!instanceId || !model) return;
            props.onInstanceModelChange(instanceId as ProviderInstanceId, model);
            setIsMenuOpen(false);
          }}
        >
          {groups.map(({ entry, models }, index) => (
            <Fragment key={entry.instanceId}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuGroup>
                {groups.length > 1 ? <MenuGroupLabel>{entry.displayName}</MenuGroupLabel> : null}
                {models.map((model) => (
                  <MenuRadioItem
                    key={model.slug}
                    value={`${entry.instanceId}${VALUE_SEPARATOR}${model.slug}`}
                    disabled={Boolean(props.getModelDisabledReason?.(entry.instanceId, model.slug))}
                  >
                    {getTriggerDisplayModelName(model)}
                  </MenuRadioItem>
                ))}
              </MenuGroup>
            </Fragment>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
