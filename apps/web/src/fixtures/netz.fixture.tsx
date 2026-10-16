/**
 * Isolierte Fixture für die Netzwerkkarte (Screenshots, kein Backend): drei
 * Rechner mit gemeldeten Fähigkeiten, ein Rechner ohne Angaben, zwei Clients.
 */
import { createRoot } from "react-dom/client";
import { useState } from "react";

import { NetworkDiagram } from "../components/ctox/NetworkDiagram";
import type { NetworkClientNode, NetworkComputerNode } from "../components/ctox/networkTopology";
import "../index.css";

const computers: NetworkComputerNode[] = [
  { id: "mac", name: "MacBook Pro", platform: "macos", connected: true, tags: [] },
  {
    id: "gpu1",
    name: "gpu1-a6000",
    platform: "linux",
    connected: false,
    tags: [{ kind: "gpu", label: "GPU A6000 · 48 GB" }],
  },
  {
    id: "gpu3",
    name: "gpu3-a4500",
    platform: "linux",
    connected: true,
    tags: [
      { kind: "build", label: "Build" },
      { kind: "storage", label: "Speicher" },
      { kind: "gpu", label: "GPU A4500 · 20 GB" },
    ],
  },
  { id: "box", name: "box 3a650c14", platform: "unknown", connected: false, tags: [] },
];
// Wie im Produkt (D24, D31): Beschriftungen aus networkCapabilityTags; dieses
// Gerät ist schon Rechner der Instanz und steht deshalb nur einmal im Netz.
const clients: NetworkClientNode[] = [
  { id: "device:fold", name: "Fold 8", kind: "device", connected: false },
];

function Fixture() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="network-overview">
      <article className="network-instance">
        <header className="network-instance-header">
          <div className="network-instance-title">
            <h2>welsch</h2>
            <span>welsch.ctox.dev</span>
          </div>
        </header>
        <div className="network-instance-body">
          <NetworkDiagram
            name="welsch"
            host="welsch.ctox.dev"
            ready
            clients={clients}
            computers={computers}
            selected={selected}
            onInspect={setSelected}
            onAdd={() => {}}
          />
        </div>
      </article>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
