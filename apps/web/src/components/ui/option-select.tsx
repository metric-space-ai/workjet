import type { ReactNode } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";

export interface OptionSelectOption<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

/**
 * Styled replacement for a native `<select>` with a flat option list (#563).
 * `placeholder` shows while `value` matches no option (e.g. "" = nothing chosen).
 */
export function OptionSelect<Value extends string>({
  value,
  options,
  onValueChange,
  placeholder,
  disabled,
  className,
  size = "sm",
  "aria-label": ariaLabel,
}: {
  value: Value | "";
  options: ReadonlyArray<OptionSelectOption<Value>>;
  onValueChange: (value: Value) => void;
  placeholder?: ReactNode;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "default";
  "aria-label": string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <Select
      value={selected ? selected.value : null}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as Value);
      }}
      disabled={disabled}
    >
      <SelectTrigger size={size} className={className} aria-label={ariaLabel}>
        <SelectValue>{selected ? selected.label : placeholder}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem
            hideIndicator
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
