import { useEffect, useRef, useState, type ReactNode } from "react";
import { MonitorIcon, MonitorSmartphoneIcon, PlusIcon, ServerIcon } from "lucide-react";
import "./networkDiagram.css";
import {
  layoutNetwork,
  type NetworkClientNode,
  type NetworkComputerNode,
  type NetworkLayoutNode,
  type NetworkPlatform,
} from "./networkTopology";

export type { NetworkClientNode, NetworkComputerNode } from "./networkTopology";

const NARROW_NETWORK_WIDTH = 520;

export interface NetworkDiagramProps {
  readonly name: string;
  /** Fehlt der Host, steht der Instanzname im Knoten. */
  readonly host: string | null;
  readonly ready: boolean;
  readonly clients: readonly NetworkClientNode[];
  readonly computers: readonly NetworkComputerNode[];
  readonly selected: string | null;
  readonly empty?: boolean;
  readonly canAdd?: boolean;
  readonly onInspect: (node: string) => void;
  readonly onAdd: () => void;
}

/** Rechner = Monitor (UI-Vertrag §5, Audit D25); die Plattform steht im Inspektor. */
function PlatformIcon(_props: { readonly platform: NetworkPlatform }) {
  return <MonitorIcon size={19} />;
}

function Status({ connected }: { readonly connected: boolean }) {
  return (
    <span
      className={`network-status ${connected ? "is-ready" : ""}`}
      title={connected ? "Verbunden" : "Getrennt"}
      aria-label={connected ? "Verbunden" : "Getrennt"}
    />
  );
}

/**
 * Echte Topologie einer Instanz: jeder Client und jeder registrierte Rechner
 * ist ein eigener Knoten. Durchgezogene Kante = verbunden, gestrichelt =
 * getrennt. Die Karte bricht in die verfügbare Breite um und scrollt nie quer.
 */
export function NetworkDiagram({
  name,
  host,
  ready,
  clients,
  computers,
  selected,
  empty = false,
  canAdd = true,
  onInspect,
  onAdd,
}: NetworkDiagramProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(720);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    setViewportWidth(element.clientWidth || 720);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = layoutNetwork({
    width: viewportWidth,
    clients: empty ? [] : clients,
    computers: empty ? [] : computers,
    showAdd: !empty,
  });
  const place = (node: NetworkLayoutNode) => ({
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
  });
  const render = (node: NetworkLayoutNode): ReactNode => {
    if (node.role === "instance")
      return (
        <button
          key={node.id}
          type="button"
          className={`network-node network-master ${empty ? "network-placeholder" : ""} ${selected === "master" ? "is-selected" : ""}`}
          style={place(node)}
          aria-pressed={!empty && selected === "master"}
          data-network-node="instance"
          onClick={() => (empty ? onAdd() : onInspect("master"))}
        >
          <span className="network-node-icon">
            {empty ? <PlusIcon size={25} /> : <ServerIcon size={25} />}
          </span>
          <span className="network-node-copy">
            <strong>{empty ? "Instanz hinzufügen" : (host ?? name)}</strong>
          </span>
          {!empty && <Status connected={ready} />}
        </button>
      );
    if (node.role === "add")
      return (
        <button
          key={node.id}
          type="button"
          className="network-node network-placeholder network-add"
          style={place(node)}
          disabled={!canAdd}
          data-network-node="add"
          onClick={onAdd}
          aria-label="Rechner hinzufügen"
        >
          <span className="network-node-icon">
            <PlusIcon size={20} />
          </span>
          <span className="network-node-copy">
            <strong>Rechner hinzufügen</strong>
          </span>
        </button>
      );
    if (node.role === "client") {
      const client = clients.find((entry) => entry.id === node.id);
      if (!client) return null;
      return (
        <button
          key={node.id}
          type="button"
          className={`network-node network-client ${selected === client.id ? "is-selected" : ""}`}
          style={place(node)}
          aria-pressed={selected === client.id}
          data-network-node="client"
          data-network-connected={String(client.connected)}
          onClick={() => onInspect(client.id)}
        >
          <span className="network-node-icon">
            {client.kind === "this-device" ? (
              <MonitorIcon size={18} />
            ) : (
              <MonitorSmartphoneIcon size={18} />
            )}
          </span>
          <span className="network-node-copy">
            <strong title={client.kind === "this-device" ? "Dieses Gerät" : client.name}>
              {client.name}
            </strong>
          </span>
          <Status connected={client.connected} />
        </button>
      );
    }
    const computer = computers.find((entry) => entry.id === node.id);
    if (!computer) return null;
    return (
      <button
        key={node.id}
        type="button"
        className={`network-node network-satellite ${selected === computer.id ? "is-selected" : ""}`}
        style={place(node)}
        aria-pressed={selected === computer.id}
        data-network-node="computer"
        data-network-connected={String(computer.connected)}
        onClick={() => onInspect(computer.id)}
      >
        <span className="network-node-head">
          <span className="network-node-icon">
            <PlatformIcon platform={computer.platform} />
          </span>
          <strong title={computer.name}>{computer.name}</strong>
        </span>
        {computer.tags.length > 0 ? (
          <span className="network-tags">
            {computer.tags.map((tag) => (
              <span
                key={tag.kind}
                className="network-tag"
                data-network-capability={tag.kind}
                title={tag.title ?? tag.label}
              >
                {tag.label}
              </span>
            ))}
          </span>
        ) : null}
        <Status connected={computer.connected} />
      </button>
    );
  };
  return (
    <div className="network-diagram" aria-label={`Netzwerkdiagramm: ${name}`}>
      <div className="network-viewport" ref={viewport} aria-label="Netzwerkkarte">
        <div className="network-stage" style={{ width: layout.width, height: layout.height }}>
          <svg
            className="network-edges"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            {/* D31: schmal keine Kanten, sie laufen sonst zwischen den Karten durch. */}
            {(layout.width < NARROW_NETWORK_WIDTH ? [] : layout.edges).map((edge) => (
              <path
                key={edge.id}
                className={`network-edge ${edge.connected ? "is-live" : "network-edge-pending"} ${selected === edge.id ? "network-edge-selected" : ""}`}
                d={edge.d}
              />
            ))}
          </svg>
          {layout.nodes.map(render)}
        </div>
      </div>
    </div>
  );
}
