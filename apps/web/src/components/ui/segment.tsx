"use client";

import type { ComponentType } from "react";

import { cn } from "~/lib/utils";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

export type SegmentOption<T extends string> = {
  readonly value: T;
  readonly label: string;
  readonly icon?: ComponentType<{ readonly className?: string; readonly "aria-hidden"?: boolean }>;
};

/**
 * One segmented choice (tabs, view switchers). The active entry carries the
 * primary border and tint so it reads clearly in light and dark (Audit A-43).
 */
export function Segment<T extends string>(props: {
  readonly value: T;
  readonly options: readonly SegmentOption<T>[];
  readonly onChange: (value: T) => void;
  readonly "aria-label": string;
  /** Spread the entries over the full width. */
  readonly fill?: boolean;
  readonly className?: string;
}) {
  return (
    <ToggleGroup
      aria-label={props["aria-label"]}
      className={cn(props.fill ? "flex w-full" : "flex w-fit", "gap-1", props.className)}
      size="xs"
      variant="outline"
      value={[props.value]}
      onValueChange={(value) => {
        const next = props.options.find((option) => option.value === value[0]);
        if (next) props.onChange(next.value);
      }}
    >
      {props.options.map((option) => {
        const Icon = option.icon;
        return (
          <Toggle
            key={option.value}
            value={option.value}
            data-workjet-segment={option.value}
            className={cn(
              "text-[12px] text-muted-foreground data-pressed:border-primary data-pressed:bg-primary/10 data-pressed:font-semibold data-pressed:text-foreground dark:data-pressed:bg-primary/20",
              props.fill && "min-w-0 flex-1",
            )}
          >
            {Icon ? <Icon aria-hidden className="size-3.5" /> : null}
            <span className="truncate">{option.label}</span>
          </Toggle>
        );
      })}
    </ToggleGroup>
  );
}
