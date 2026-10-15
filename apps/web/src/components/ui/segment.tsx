"use client";

import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

/** Gemeinsame Optik der gewählten Segment-Option (UI-Vertrag §1.1: ein Segment). */
export const SEGMENT_TOGGLE_CLASS =
  "text-muted-foreground data-pressed:bg-primary/15 data-pressed:text-foreground dark:data-pressed:bg-primary/20";

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  /** Zusätzliche data-/aria-Attribute je Option (z. B. für Tests). */
  readonly attributes?: Readonly<Record<`data-${string}`, string>>;
}

/**
 * Die eine Segment-Steuerung der App (D09): Auswahl genau einer Option aus
 * wenigen, auf ToggleGroup gebaut. Ersetzt rohe role=radio-Knöpfe und
 * Button-Reihen mit default/outline.
 */
export function Segment<T extends string>({
  value,
  onValueChange,
  options,
  disabled = false,
  className,
  "aria-label": ariaLabel,
}: {
  readonly value: T;
  readonly onValueChange: (value: T) => void;
  readonly options: ReadonlyArray<SegmentOption<T>>;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly "aria-label": string;
}) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      className={cn("flex-wrap", className)}
      size="sm"
      variant="outline"
      value={[value]}
      onValueChange={(next) => {
        const selected = options.find((option) => option.value === next[0]);
        if (selected !== undefined && !disabled) onValueChange(selected.value);
      }}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          disabled={disabled || option.disabled === true}
          className={SEGMENT_TOGGLE_CLASS}
          {...option.attributes}
        >
          {option.icon}
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
