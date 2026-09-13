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
  const offline = result?.peers.filter((peer) => !peer.online) ?? [];
  return (
    <section
      className="space-y-3 rounded-lg border border-border/60 p-3"
      aria-label="Tailscale computers"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium">Tailscale computers</p>
          <p className="text-xs text-muted-foreground">
            From Tailscale on this computer. Online status does not guarantee SSH access.
          </p>
        </div>
        <Button
          size="xs"
          variant="ghost"
          disabled={result === null || disabled}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh
        </Button>
      </div>
      <div role="status" className="text-xs text-muted-foreground">
        {result === null
          ? "Checking Tailscale…"
          : result.status === "unavailable"
            ? "Tailscale discovery is unavailable. Start Tailscale and sign in on this computer, then refresh."
            : online.length === 0
              ? "No online Tailscale computers found."
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
                Use computer
              </Button>
            </div>
          ))
        : null}
      {result?.status === "available" && offline.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Offline: {offline.map((peer) => peer.name).join(", ")}
        </p>
      ) : null}
    </section>
  );
}
