import type { CtoxManagedInstance } from "@workjet/contracts";

import { canActivateCtoxInstance } from "./CtoxModeShell";
import { ctoxInstanceDisplayTitle } from "./ctoxInstanceDisplayTitle";

export function CtoxInstanceSelectOption({ instance }: { instance: CtoxManagedInstance }) {
  const available = canActivateCtoxInstance(instance);
  const reason =
    instance.status === "pairing_expired"
      ? "Verbindung abgelaufen – neue Einladung erforderlich"
      : "Nicht verfügbar";

  return (
    <option value={instance.id} disabled={!available}>
      {ctoxInstanceDisplayTitle(instance)}
      {available ? "" : ` — ${reason}`}
    </option>
  );
}
