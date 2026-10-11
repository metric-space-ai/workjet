import type { ServerConfigStreamEvent } from "@workjet/contracts";

export const KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS = 2_000;

/**
 * Toast-Texte (UI-Vertrag: eine Zeile, höchstens eine Aktion, keine
 * Erklärzeile). Der Aufrufer in `__root.tsx` rendert sie als Titel ohne
 * `description`; die Fehlermeldung der Konfiguration gehört nach Diagnose.
 */
export const KEYBINDINGS_UPDATE_TOAST_COPY = {
  success: { title: "Tastenkürzel neu geladen" },
  invalid: { title: "Tastenkürzel ungültig", action: "keybindings.json öffnen" },
} as const;

export type KeybindingsUpdateToastDecision =
  | { readonly _tag: "Success" }
  | { readonly _tag: "InvalidConfiguration"; readonly message: string };

export interface KeybindingsUpdateToastController {
  readonly handle: (event: ServerConfigStreamEvent | null) => KeybindingsUpdateToastDecision | null;
}

export function createKeybindingsUpdateToastController(input: {
  readonly now?: () => number;
}): KeybindingsUpdateToastController {
  const now = input.now ?? Date.now;
  let lastSuccessToastAt: number | null = null;

  return {
    handle: (event) => {
      if (event?.type !== "keybindingsUpdated") {
        return null;
      }

      const issue = event.payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (issue) {
        return {
          _tag: "InvalidConfiguration",
          message: issue.message,
        };
      }

      const currentTime = now();
      if (
        lastSuccessToastAt !== null &&
        currentTime - lastSuccessToastAt < KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS
      ) {
        return null;
      }

      lastSuccessToastAt = currentTime;
      return { _tag: "Success" };
    },
  };
}
