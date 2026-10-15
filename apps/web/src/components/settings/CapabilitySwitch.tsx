import { cn } from "~/lib/utils";

import { Switch } from "../ui/switch";

/**
 * Das eine Bedienelement für Rechner-Fähigkeiten (Build, Speicher, GPU):
 * ein kleiner Schalter mit Text, in der Rechnerliste und in der grünen Zeile
 * nach dem Beitritt gleich (D05, D54). Fakten (CPUs, Werkzeuge) bleiben Chips.
 */
export function CapabilitySwitch({
  capability,
  label,
  title,
  checked,
  disabled = false,
  onCheckedChange,
}: {
  readonly capability: "build" | "storage" | "gpu";
  readonly label: string;
  readonly title?: string | undefined;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 text-[11px] leading-none whitespace-nowrap",
        checked ? "text-foreground" : "text-muted-foreground",
        disabled && "cursor-default opacity-64",
      )}
      title={title}
      data-workjet-capability={capability}
      data-on={checked ? "true" : "false"}
    >
      <Switch
        className="[--thumb-size:--spacing(3)] sm:[--thumb-size:--spacing(3)]"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      {label}
    </label>
  );
}
