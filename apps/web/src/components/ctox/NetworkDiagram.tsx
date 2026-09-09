import { useEffect, useRef, useState } from "react";
import {
  LaptopIcon,
  MaximizeIcon,
  MinusIcon,
  PlusIcon,
  ServerIcon,
  SmartphoneIcon,
} from "lucide-react";
import "./networkDiagram.css";

export interface NetworkComputerNode {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
}

export interface NetworkDiagramProps {
  readonly name: string;
  readonly host: string;
  readonly ready: boolean;
  readonly satellites: readonly NetworkComputerNode[] | null;
  readonly registeredClients: number | null;
  readonly selected: string | null;
  readonly empty?: boolean;
  readonly canAdd?: boolean;
  readonly onInspect: (node: string) => void;
  readonly onAdd: () => void;
}

/** Edges describe membership. Only an observed connection receives a live marker. */
export function NetworkDiagram({
  name,
  host,
  ready,
  satellites,
  registeredClients,
  selected,
  empty = false,
  canAdd = true,
  onInspect,
  onAdd,
}: NetworkDiagramProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(720);
  const [zoom, setZoom] = useState<number | null>(null);
  const count = (satellites?.length ?? 0) + 1;
  const width = Math.max(720, count * 224 + 64);
  const scale = zoom ?? Math.min(1, Math.max(0.45, (viewportWidth - 40) / width));
  const center = width / 2;
  const start = center - ((count - 1) * 224) / 2;
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="network-diagram" aria-label={`Netzwerkdiagramm: ${name}`}>
      <div
        className="network-viewport"
        ref={viewport}
        tabIndex={0}
        aria-label="Netzwerkkarte, bei Vergrößerung scrollbar"
      >
        <div
          className="network-stage"
          style={{ width: Math.max(viewportWidth, width * scale), height: 570 * scale }}
        >
          <div
            className="network-scene"
            style={{
              width,
              height: 570,
              transform: `scale(${scale})`,
              left: Math.max(0, (viewportWidth - width * scale) / 2),
            }}
          >
            <svg className="network-edges" width={width} height="570" aria-hidden="true">
              <path className="network-edge network-edge-pending" d={`M ${center} 120 V 228`} />
              {(satellites ?? []).map((computer, index) => {
                const x = start + index * 224;
                return (
                  <path
                    key={computer.id}
                    className={`network-edge ${selected === computer.id ? "network-edge-selected" : ""}`}
                    d={`M ${center} 322 C ${center} 385, ${x} 365, ${x} 426`}
                  />
                );
              })}
              <path
                className="network-edge network-edge-pending"
                d={`M ${center} 322 C ${center} 385, ${start + (count - 1) * 224} 365, ${start + (count - 1) * 224} 426`}
              />
              <circle className="network-port" cx={center} cy="228" r="3" />
              <circle className="network-port" cx={center} cy="322" r="3" />
            </svg>
            <button
              type="button"
              className={`network-node network-client ${selected === "clients" ? "is-selected" : ""}`}
              style={{ left: center - 100, top: 42 }}
              disabled={empty}
              aria-pressed={selected === "clients"}
              onClick={() => onInspect("clients")}
            >
              <span className="network-node-icon">
                <SmartphoneIcon size={21} />
              </span>
              <span className="network-node-copy">
                <strong>App-Clients</strong>
                <small>
                  {empty
                    ? "Desktop · Mobil"
                    : registeredClients === null
                      ? "Präsenz unbekannt"
                      : `${registeredClients} registriert`}
                </small>
              </span>
              <i className="network-port-top" />
            </button>
            <span className="network-edge-label" style={{ left: center + 14, top: 160 }}>
              Zugriff
            </span>
            <button
              type="button"
              className={`network-node network-master ${empty ? "network-placeholder" : ""} ${selected === "master" ? "is-selected" : ""}`}
              style={{ left: center - 122, top: 228 }}
              aria-pressed={!empty && selected === "master"}
              onClick={() => (empty ? onAdd() : onInspect("master"))}
            >
              <span className="network-node-icon">
                {empty ? <PlusIcon size={25} /> : <ServerIcon size={25} />}
              </span>
              <span className="network-node-copy">
                <small className="network-node-role">
                  {empty ? "DEIN ERSTES NETZWERK" : "CTOX · ZENTRALRECHNER"}
                </small>
                <strong>{empty ? "Instanz hinzufügen" : host}</strong>
                <small>{empty ? "Erstellen oder verbinden" : "Sync & Ops"}</small>
              </span>
              {!empty && (
                <span
                  className={`network-status ${ready ? "is-ready" : ""}`}
                  title={ready ? "Datenverbindung bestätigt" : "Datenverbindung nicht bestätigt"}
                />
              )}
            </button>
            <span className="network-edge-label" style={{ left: center + 14, top: 353 }}>
              Sync
            </span>
            {(satellites ?? []).map((computer, index) => (
              <button
                key={computer.id}
                type="button"
                className={`network-node network-satellite ${selected === computer.id ? "is-selected" : ""}`}
                style={{ left: start + index * 224 - 100, top: 426 }}
                aria-pressed={selected === computer.id}
                onClick={() => onInspect(computer.id)}
              >
                <span className="network-node-icon">
                  <LaptopIcon size={22} />
                </span>
                <span className="network-node-copy">
                  <strong>{computer.name}</strong>
                  <small>Satellit</small>
                </span>
                <span
                  className={`network-status ${computer.connected ? "is-ready" : ""}`}
                  title={
                    computer.connected ? "Mit dieser App verbunden" : "Verbindung nicht bestätigt"
                  }
                />
              </button>
            ))}
            <button
              type="button"
              className="network-node network-placeholder network-add"
              style={{ left: start + (count - 1) * 224 - 100, top: 426 }}
              disabled={empty || !canAdd}
              onClick={onAdd}
              aria-label="Satelliten-PC hinzufügen"
            >
              <span className="network-node-icon">
                <PlusIcon size={22} />
              </span>
              <span className="network-node-copy">
                <strong>Computer hinzufügen</strong>
                <small>Local · SSH · Tailscale</small>
              </span>
            </button>
          </div>
        </div>
      </div>
      <div className="network-map-controls" aria-label="Kartenansicht">
        <button
          type="button"
          aria-label="Verkleinern"
          disabled={scale <= 0.45}
          onClick={() => setZoom(Math.max(0.45, scale - 0.15))}
        >
          <MinusIcon size={15} />
        </button>
        <output aria-label="Zoom">{Math.round(scale * 100)}%</output>
        <button
          type="button"
          aria-label="Vergrößern"
          disabled={scale >= 1.6}
          onClick={() => setZoom(Math.min(1.6, scale + 0.15))}
        >
          <PlusIcon size={15} />
        </button>
        <button type="button" aria-label="Netzwerk einpassen" onClick={() => setZoom(null)}>
          <MaximizeIcon size={15} />
        </button>
      </div>
    </div>
  );
}
