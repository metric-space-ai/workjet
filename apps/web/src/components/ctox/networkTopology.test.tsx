import type { ComputerMetadata, CtoxWorkjetComputerProjection } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { NetworkDiagram } from "./NetworkDiagram";
import {
  layoutNetwork,
  networkCapabilityTags,
  networkPlatform,
  type NetworkClientNode,
  type NetworkComputerNode,
} from "./networkTopology";

const native = (
  id: string,
  extra: Partial<CtoxWorkjetComputerProjection> = {},
): CtoxWorkjetComputerProjection =>
  ({
    id,
    displayName: id,
    hostingMode: "workstation",
    status: "assigned",
    capabilities: [],
    selfHostedColocation: false,
    ...extra,
  }) as CtoxWorkjetComputerProjection;

const facts = (gpus: { model: string }[], operatingSystem = "linux") => ({
  checkedAt: "2026-10-15T17:00:00Z",
  machineId: null,
  operatingSystem,
  architecture: "x86_64",
  cpuCores: 32,
  ramBytes: 128 * 2 ** 30,
  homeDirectory: "/home/deck",
  workDirectory: "/home/deck/work",
  freeBytes: 2 ** 40,
  gpus: gpus.map((gpu) => ({ ...gpu, vramBytes: null, unifiedMemory: false })),
  toolchains: {},
  codingTools: {},
  warnings: [],
});

const computers: NetworkComputerNode[] = [
  {
    id: "mac",
    name: "Mac",
    platform: "macos",
    connected: true,
    tags: networkCapabilityTags(null, native("mac")),
  },
  {
    id: "gpu1",
    name: "gpu1",
    platform: "linux",
    connected: false,
    tags: networkCapabilityTags(
      null,
      native("gpu1", { detectedFacts: facts([{ model: "NVIDIA RTX A6000" }]) }),
    ),
  },
  {
    id: "gpu3",
    name: "gpu3",
    platform: "linux",
    connected: true,
    tags: networkCapabilityTags(
      null,
      native("gpu3", {
        roles: { build: true, storage: true },
        capabilityConfig: [{ kind: "gpu", model: "NVIDIA RTX A4500", vram_gib: 20 }],
      }),
    ),
  },
];
const clients: NetworkClientNode[] = [
  { id: "this-device", name: "Mac", kind: "this-device", connected: true },
  { id: "device:fold", name: "Fold 8", kind: "device", connected: false },
];

describe("layoutNetwork", () => {
  it("places 2 clients, the instance, 3 computers and the add tile as separate nodes", () => {
    const layout = layoutNetwork({ width: 1100, clients, computers, showAdd: true });
    expect(layout.nodes.map((node) => node.role)).toEqual([
      "client",
      "client",
      "instance",
      "computer",
      "computer",
      "computer",
      "add",
    ]);
    // Eine Kante je Client und je Rechner (plus Hinzufügen), Status je Kante.
    expect(layout.edges.map((edge) => [edge.id, edge.connected])).toEqual([
      ["this-device", true],
      ["device:fold", false],
      ["mac", true],
      ["gpu1", false],
      ["gpu3", true],
      ["add", false],
    ]);
    const instance = layout.nodes.find((node) => node.role === "instance")!;
    for (const node of layout.nodes) {
      if (node.role === "client") expect(node.y + node.height).toBeLessThan(instance.y);
      if (node.role === "computer" || node.role === "add")
        expect(node.y).toBeGreaterThan(instance.y + instance.height);
    }
  });

  it("wraps rows instead of overflowing at 360 px", () => {
    const layout = layoutNetwork({ width: 344, clients, computers, showAdd: true });
    expect(layout.width).toBe(344);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x + node.width).toBeLessThanOrEqual(344);
    }
    const computerRows = new Set(
      layout.nodes
        .filter((node) => node.role !== "client" && node.role !== "instance")
        .map((n) => n.y),
    );
    expect(computerRows.size).toBe(2);
  });
});

describe("networkCapabilityTags", () => {
  it("shows chips only for reported capabilities", () => {
    expect(computers[0]!.tags).toEqual([]);
    expect(computers[1]!.tags.map((tag) => tag.label)).toEqual(["GPU · A6000"]);
    expect(computers[2]!.tags.map((tag) => tag.label)).toEqual(["Build", "Store", "GPU · A4500"]);
  });

  it("prefers local detection over the instance entry", () => {
    const metadata = {
      roles: { build: false, storage: true },
      facts: facts([{ model: "Apple M3 Max" }], "darwin"),
    } as unknown as ComputerMetadata;
    const tags = networkCapabilityTags(metadata, native("x", { capabilities: ["build"] }));
    expect(tags.map((tag) => tag.label)).toEqual(["Store", "GPU · M3 Max"]);
  });

  it("maps operating systems to platforms", () => {
    expect(networkPlatform("darwin")).toBe("macos");
    expect(networkPlatform("Linux")).toBe("linux");
    expect(networkPlatform(undefined)).toBe("unknown");
  });
});

describe("NetworkDiagram", () => {
  it("renders one node per client and computer without fake labels", () => {
    const html = renderToStaticMarkup(
      <NetworkDiagram
        name="WELSCH"
        host="welsch.ctox.dev"
        ready
        clients={clients}
        computers={computers}
        selected={null}
        onInspect={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(html.match(/data-network-node="computer"/g)).toHaveLength(3);
    expect(html.match(/data-network-node="client"/g)).toHaveLength(2);
    expect(html.match(/data-network-node="instance"/g)).toHaveLength(1);
    expect(html.match(/data-network-node="add"/g)).toHaveLength(1);
    expect(html.match(/data-network-capability=/g)).toHaveLength(4);
    expect(html).toContain("DIESES GERÄT");
    for (const fake of ["Zugriff", "Abgleich", "gekoppelt", "Lokal · SSH · Tailscale"])
      expect(html).not.toContain(fake);
  });
});
