import type { ProviderOptionDescriptor, RuntimeMode } from "@workjet/contracts";

/**
 * Desktop-oriented effort keywords that don't belong in the phone picker.
 * Prompt-injected values (ultrathink and friends) are filtered from the
 * descriptor metadata; ultracode is a real option but a workflow trigger, not
 * a reasoning level. A value set elsewhere still displays, it just isn't
 * offered.
 */
const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

export const RUNTIME_MODE_CHOICES: ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    mode: "approval-required",
    label: "Überwacht",
    description: "Vor Befehlen und Änderungen fragen.",
  },
  {
    mode: "auto-accept-edits",
    label: "Änderungen automatisch annehmen",
    description: "Änderungen automatisch, sonst fragen.",
  },
  {
    mode: "auto",
    label: "Automatisch",
    description: "Routine automatisch, sonst fragen.",
  },
  {
    mode: "full-access",
    label: "Vollzugriff",
    description: "Befehle und Änderungen ohne Rückfrage.",
  },
];

export function selectableChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !injected.has(option.id) && !HIDDEN_EFFORT_OPTION_IDS.has(option.id),
  );
}
