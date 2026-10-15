import { WifiOffIcon } from "lucide-react";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { ComposerErrorLine } from "./composerErrorLineLogic";

/**
 * Der Banner „Umgebung nicht erreichbar“ über dem Composer (UI-Vertrag §1 Banner):
 * eine deutsche Zeile, genau eine Aktion; der Rohtext erscheint nie im Chat.
 */
export function environmentUnavailableBannerItem(input: {
  readonly environmentId: string;
  readonly line: ComposerErrorLine;
  readonly reconnecting: boolean;
  readonly onReconnect: () => void;
}): ComposerBannerStackItem {
  const { line } = input;
  return {
    id: `environment-unavailable:${input.environmentId}`,
    variant: line.kind === "authentication" ? "warning" : "error",
    icon: <WifiOffIcon />,
    title: line.text,
    actions: (
      <Button
        size="xs"
        variant="outline"
        disabled={input.reconnecting}
        onClick={input.onReconnect}
      >
        {input.reconnecting ? "Verbinde …" : line.actionLabel}
      </Button>
    ),
  };
}
