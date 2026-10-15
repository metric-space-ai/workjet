import type { ComputerMetadata, CtoxWorkjetComputerProjection } from "@workjet/contracts";

import { shortGpuModel } from "../settings/ComputerCapabilitiesEditor";

export type NetworkPlatform = "macos" | "linux" | "windows" | "unknown";

export interface NetworkCapabilityTag {
  readonly kind: "build" | "storage" | "gpu";
  readonly label: string;
  readonly title?: string;
}

/** Ein registrierter Rechner der Instanz, so wie er sich gemeldet hat. */
export interface NetworkComputerNode {
  readonly id: string;
  readonly name: string;
  readonly platform: NetworkPlatform;
  readonly connected: boolean;
  readonly tags: readonly NetworkCapabilityTag[];
}

/** Ein Client der Instanz: diese App oder ein gekoppeltes Gerät. */
export interface NetworkClientNode {
  readonly id: string;
  readonly name: string;
  readonly kind: "this-device" | "device";
  readonly connected: boolean;
}

export function networkPlatform(operatingSystem: string | null | undefined): NetworkPlatform {
  const value = operatingSystem?.toLowerCase() ?? "";
  if (/darwin|mac/.test(value)) return "macos";
  if (/windows|win32|mingw|msys|cygwin/.test(value)) return "windows";
  if (/linux|ubuntu|debian|fedora|steamos|arch|centos|rhel|nixos|alpine/.test(value))
    return "linux";
  return "unknown";
}

/**
 * Fähigkeits-Chips nur aus gemeldeten Angaben: Rollen und erkannte GPU aus der
 * lokalen Erkennung (Einstellungen › Rechner), sonst aus dem Eintrag der
 * Instanz (`computer.list` mit Betriebsdetails). Ohne Angabe kein Chip.
 */
export function networkCapabilityTags(
  metadata: ComputerMetadata | null | undefined,
  native: CtoxWorkjetComputerProjection | null | undefined,
): NetworkCapabilityTag[] {
  const config = native?.capabilityConfig ?? [];
  const declared = (kind: "build" | "storage" | "gpu") =>
    (native?.capabilities.includes(kind) ?? false) || config.some((entry) => entry.kind === kind);
  const roles = metadata?.roles ??
    native?.roles ?? { build: declared("build"), storage: declared("storage") };
  const tags: NetworkCapabilityTag[] = [];
  if (roles.build) tags.push({ kind: "build", label: "Build" });
  if (roles.storage) tags.push({ kind: "storage", label: "Store" });
  const facts = metadata?.facts ?? native?.detectedFacts ?? null;
  const detected = facts?.gpus[0];
  const configured = config.find((entry) => entry.kind === "gpu");
  if (detected) {
    const more = facts!.gpus.length - 1;
    tags.push({
      kind: "gpu",
      label: `GPU · ${shortGpuModel(detected.model)}${more > 0 ? ` +${more}` : ""}`,
      title: facts!.gpus.map((gpu) => gpu.model).join(", "),
    });
  } else if (configured && configured.kind === "gpu") {
    tags.push({
      kind: "gpu",
      label: `GPU · ${shortGpuModel(configured.model)}`,
      title: `${configured.model} · ${configured.vram_gib} GB`,
    });
  } else if (declared("gpu")) {
    tags.push({ kind: "gpu", label: "GPU" });
  }
  return tags;
}

export interface NetworkRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NetworkLayoutNode extends NetworkRect {
  readonly id: string;
  readonly role: "instance" | "client" | "computer" | "add";
}

export interface NetworkLayoutEdge {
  readonly id: string;
  readonly d: string;
  readonly connected: boolean;
}

export interface NetworkLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly NetworkLayoutNode[];
  readonly edges: readonly NetworkLayoutEdge[];
}

export const NETWORK_LAYOUT = {
  padding: 8,
  gap: 12,
  groupGap: 56,
  minNodeWidth: 148,
  maxNodeWidth: 204,
  instanceWidth: 244,
  instanceHeight: 72,
  clientHeight: 56,
  computerHeight: 84,
  /** Schmale Kacheln brechen die Fähigkeits-Chips in zwei Zeilen um. */
  narrowComputerHeight: 104,
  narrowNodeWidth: 200,
} as const;

interface RowItem {
  readonly id: string;
  readonly role: NetworkLayoutNode["role"];
  readonly connected: boolean;
}

function placeRows(
  items: readonly RowItem[],
  width: number,
  top: number,
  rowHeight: number | ((nodeWidth: number) => number),
): { nodes: (NetworkLayoutNode & { connected: boolean })[]; bottom: number } {
  const { padding, gap, minNodeWidth, maxNodeWidth } = NETWORK_LAYOUT;
  if (items.length === 0) return { nodes: [], bottom: top - gap };
  const inner = Math.max(0, width - padding * 2);
  const columns = Math.max(
    1,
    Math.min(items.length, Math.floor((inner + gap) / (minNodeWidth + gap))),
  );
  const nodeWidth = Math.min(maxNodeWidth, (inner - (columns - 1) * gap) / columns);
  const height = typeof rowHeight === "number" ? rowHeight : rowHeight(nodeWidth);
  const nodes: (NetworkLayoutNode & { connected: boolean })[] = [];
  for (let start = 0; start < items.length; start += columns) {
    const row = items.slice(start, start + columns);
    const rowWidth = row.length * nodeWidth + (row.length - 1) * gap;
    const left = (width - rowWidth) / 2;
    const y = top + (start / columns) * (height + gap);
    row.forEach((item, index) =>
      nodes.push({ ...item, x: left + index * (nodeWidth + gap), y, width: nodeWidth, height }),
    );
  }
  const rows = Math.ceil(items.length / columns);
  return { nodes, bottom: top + rows * height + (rows - 1) * gap };
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const middle = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${y2}`;
}

/**
 * Clients oben, Instanz in der Mitte, Rechner unten; jede Reihe bricht in die
 * verfügbare Breite um, damit die Karte nie horizontal scrollt.
 */
export function layoutNetwork(input: {
  readonly width: number;
  readonly clients: readonly Pick<NetworkClientNode, "id" | "connected">[];
  readonly computers: readonly Pick<NetworkComputerNode, "id" | "connected">[];
  readonly showAdd: boolean;
}): NetworkLayout {
  const { padding, groupGap, instanceWidth, instanceHeight, clientHeight, computerHeight } =
    NETWORK_LAYOUT;
  const width = Math.max(input.width, NETWORK_LAYOUT.minNodeWidth + padding * 2);
  const clients = placeRows(
    input.clients.map((client) => ({ id: client.id, role: "client", connected: client.connected })),
    width,
    padding,
    clientHeight,
  );
  const instanceTop = clients.nodes.length > 0 ? clients.bottom + groupGap : padding;
  const instanceW = Math.min(instanceWidth, width - padding * 2);
  const instance: NetworkLayoutNode = {
    id: "instance",
    role: "instance",
    x: (width - instanceW) / 2,
    y: instanceTop,
    width: instanceW,
    height: instanceHeight,
  };
  const computerItems: RowItem[] = input.computers.map((computer) => ({
    id: computer.id,
    role: "computer",
    connected: computer.connected,
  }));
  if (input.showAdd) computerItems.push({ id: "add", role: "add", connected: false });
  const computers = placeRows(
    computerItems,
    width,
    instance.y + instanceHeight + groupGap,
    (nodeWidth) =>
      nodeWidth < NETWORK_LAYOUT.narrowNodeWidth
        ? NETWORK_LAYOUT.narrowComputerHeight
        : computerHeight,
  );
  const bottom = computers.nodes.length > 0 ? computers.bottom : instance.y + instanceHeight;
  const centerX = instance.x + instance.width / 2;
  const edges: NetworkLayoutEdge[] = [
    ...clients.nodes.map((node) => ({
      id: node.id,
      connected: node.connected,
      d: curve(centerX, instance.y, node.x + node.width / 2, node.y + node.height),
    })),
    ...computers.nodes.map((node) => ({
      id: node.id,
      connected: node.connected,
      d: curve(centerX, instance.y + instance.height, node.x + node.width / 2, node.y),
    })),
  ];
  const strip = ({ connected: _connected, ...node }: NetworkLayoutNode & { connected: boolean }) =>
    node;
  return {
    width,
    height: bottom + padding,
    nodes: [...clients.nodes.map(strip), instance, ...computers.nodes.map(strip)],
    edges,
  };
}
