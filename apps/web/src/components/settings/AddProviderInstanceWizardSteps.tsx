/**
 * Harness-Auswahl oben im Inline-Panel „Harness hinzufügen“. Ersetzt den
 * früheren dreistufigen Assistenten (Driver/Identity/Config): eine Ebene,
 * oben die Auswahl, darunter nur die Felder des gewählten Harness.
 */
import { ProviderDriverKind } from "@workjet/contracts";

import { ACPRegistryIcon, Gemini, GithubCopilotIcon, type Icon } from "../Icons";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";

interface ComingSoonDriverOption {
  readonly value: ProviderDriverKind;
  readonly label: string;
  readonly icon: Icon;
}

export const COMING_SOON_DRIVER_OPTIONS: readonly ComingSoonDriverOption[] = [
  {
    value: ProviderDriverKind.make("githubCopilot"),
    label: "GitHub Copilot",
    icon: GithubCopilotIcon,
  },
  {
    value: ProviderDriverKind.make("gemini"),
    label: "Gemini",
    icon: Gemini,
  },
  {
    value: ProviderDriverKind.make("acpRegistry"),
    label: "ACP Registry",
    icon: ACPRegistryIcon,
  },
  // Pi is NOT coming soon: Pi Code is already listed as a usable runtime on
  // the Harnesses page. Advertising it here again — under a second name with
  // a second icon — split one product into two brands (Befund K-B7).
];

interface AddProviderInstanceDriverSelectProps {
  readonly driver: ProviderDriverKind;
  readonly onDriverChange: (driver: ProviderDriverKind) => void;
}

export function AddProviderInstanceDriverSelect({
  driver,
  onDriverChange,
}: AddProviderInstanceDriverSelectProps) {
  const selected = DRIVER_OPTION_BY_VALUE[driver];
  const SelectedIcon = selected?.icon;
  return (
    <Select
      value={driver}
      onValueChange={(value) => {
        const next = DRIVER_OPTIONS.find((option) => option.value === value)?.value;
        if (next !== undefined) onDriverChange(next);
      }}
    >
      <SelectTrigger className="w-full sm:w-64" aria-label="Harness">
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            {SelectedIcon ? <SelectedIcon className="size-4 shrink-0" aria-hidden /> : null}
            <span className="truncate">{selected?.label ?? String(driver)}</span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {DRIVER_OPTIONS.map((option) => {
          const OptionIcon = option.icon;
          return (
            <SelectItem key={option.value} hideIndicator value={option.value}>
              <span className="flex min-w-0 items-center gap-2">
                <OptionIcon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{option.label}</span>
                {option.badgeLabel ? (
                  <span className="text-[11px] text-muted-foreground">{option.badgeLabel}</span>
                ) : null}
              </span>
            </SelectItem>
          );
        })}
        {COMING_SOON_DRIVER_OPTIONS.map((option) => {
          const OptionIcon = option.icon;
          return (
            <SelectItem key={option.value} hideIndicator disabled value={option.value}>
              <span className="flex min-w-0 items-center gap-2">
                <OptionIcon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{option.label}</span>
                <span className="text-[11px] text-muted-foreground">Bald</span>
              </span>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}
