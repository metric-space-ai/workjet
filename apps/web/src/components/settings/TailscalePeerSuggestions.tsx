import type { DesktopBridge, DesktopTailscalePeers } from "@workjet/contracts";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";

export function TailscalePeerSuggestions({
  bridge,
  disabled,
  onSelect,
}: {
  bridge: Pick<DesktopBridge, "discoverTailscalePeers"> | undefined;
  disabled: boolean;
  onSelect: (hostname: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<DesktopTailscalePeers | null>(null);
  useEffect(() => {
    let current = true;
    setResult(null);
    const unavailable: DesktopTailscalePeers = { status: "unavailable", peers: [] };
    void Promise.resolve()
      .then(() => bridge?.discoverTailscalePeers())
      .then(
        (value) => {
          if (current) setResult(value ?? unavailable);
        },
        () => {
          if (current) setResult(unavailable);
        },
      );
    return () => {
      current = false;
    };
  }, [bridge, revision]);
  const online = result?.peers.filter((peer) => peer.online) ?? [];
  return (
    <section
      className="space-y-3 rounded-lg border border-border/60 p-3"
      aria-label="Tailscale-Rechner"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium">Tailscale-Rechner</p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          disabled={result === null || disabled}
          onClick={() => setRevision((value) => value + 1)}
        >
          Aktualisieren
        </Button>
      </div>
      <div role="status" className="text-xs text-muted-foreground">
        {result === null
          ? "Tailscale wird geprüft …"
          : result.status === "unavailable"
            ? "Tailscale nicht verfügbar"
            : online.length === 0
              ? "Keine Rechner online"
              : null}
      </div>
      {result?.status === "available"
        ? online.map((peer) => (
            <div key={peer.id} className="flex items-center justify-between gap-3">
              <span className="text-sm">{peer.name}</span>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                onClick={() => onSelect(peer.hostname)}
              >
                Übernehmen
              </Button>
            </div>
          ))
        : null}
    </section>
  );
}
