import { useSyncExternalStore } from "react";

import {
  getV4InstanceDirectoryEntry,
  subscribeV4InstanceDirectory,
} from "../../ctox/v4InstanceDirectory";
import { requestInstanceAdd } from "../../instanceSetup";
import { Button } from "../ui/button";

export const V4_DEVICE_UNPAIRED_TEXT = "Gerät nicht mehr gekoppelt";
export const V4_DEVICE_UNPAIRED_ACTION = "Neuer Link";

/** E54.5: after `device_revoked`/`device_unknown` one line with exactly one action. */
export function V4DeviceUnpairedLineView({ onNewLink }: { readonly onNewLink: () => void }) {
  return (
    <div
      className="flex min-h-7 items-center justify-between gap-2 px-3 text-destructive text-xs sm:px-4"
      data-workjet-v4-device="unpaired"
      role="alert"
    >
      <span className="min-w-0 truncate">{V4_DEVICE_UNPAIRED_TEXT}</span>
      <Button size="xs" type="button" variant="outline" onClick={onNewLink}>
        {V4_DEVICE_UNPAIRED_ACTION}
      </Button>
    </div>
  );
}

/** Shown for the selected instance only while this device is no longer paired with it. */
export function V4DeviceUnpairedLine({ instanceId }: { readonly instanceId: string | null }) {
  const unpaired = useSyncExternalStore(
    subscribeV4InstanceDirectory,
    () => instanceId !== null && getV4InstanceDirectoryEntry(instanceId)?.state === "unpaired",
    () => false,
  );
  if (!unpaired) return null;
  return <V4DeviceUnpairedLineView onNewLink={() => requestInstanceAdd("link")} />;
}
