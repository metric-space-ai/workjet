import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vite-plus/test";
import type { CtoxManagedInstance } from "@workjet/contracts";
import {
  dedupeCtoxInstances,
  instanceRowMeta,
  instanceRowState,
  InstancesTable,
} from "./InstancesTable";
const instance = (
  id: string,
  source: CtoxManagedInstance["source"] = "ctox_dev",
): CtoxManagedInstance => ({
  id,
  source,
  displayName: id,
  status: "available",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: false,
    httpDataProxy: false,
    nativePeerObserved: false,
  },
});
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("Instances table", () => {
  it("distinguishes selected from enabled and locks the selected switch", () => {
    const html = renderToStaticMarkup(
      <InstancesTable
        instances={[instance("selected")]}
        activeInstanceId="selected"
        onStateChange={async () => null}
      />,
    );
    expect(html).toContain("Ausgewählt");
    expect(html).toContain('aria-label="Aktiv · selected"');
    expect(html).toMatch(/role="switch"[^>]*disabled/);
    expect(html).toContain('data-slot="row"');
  });

  it("has trash with inline confirmation for paired and managed connections, only a switch for local", () => {
    const html = renderToStaticMarkup(
      <InstancesTable
        instances={[
          instance("paired", "manual_pairing"),
          instance("managed"),
          instance("local", "local_daemon"),
        ]}
        activeInstanceId={null}
        onStateChange={async () => null}
      />,
    );
    expect(count(html, 'aria-label="Entfernen"')).toBe(2);
    expect(count(html, 'role="switch"')).toBe(3);
    expect(html).toContain('aria-label="Aktiv · local"');
    expect(html).not.toContain('role="dialog"');
  });

  it("shows disabled without a connection error and hides removed rows", () => {
    const html = renderToStaticMarkup(
      <InstancesTable
        instances={[
          { ...instance("disabled"), workjetState: "disabled", status: "error" },
          { ...instance("removed"), workjetState: "removed" },
        ]}
        activeInstanceId={null}
        onStateChange={async () => null}
      />,
    );
    // Deactivated: the switch says it; no extra status dot (one signal).
    expect(html).not.toContain('aria-label="Deaktiviert"');
    expect(html).not.toContain("Fehler");
    expect(html).not.toContain("removed");
    expect(html).toContain('aria-checked="false"');
  });

  it("shows one compact row per instance with the domain as meta and no explanation sentences", () => {
    const html = renderToStaticMarkup(
      <InstancesTable
        instances={[
          { ...instance("welsch"), domain: "welsch.ctox.dev" },
          { ...instance("offline", "pairing_invite"), status: "offline" },
        ]}
        activeInstanceId={null}
        onStateChange={async () => null}
      />,
    );
    expect(html).toContain("welsch.ctox.dev");
    expect(html).toContain("Getrennt");
    for (const english of ["Enabled", "Remove", "Select", "Pair again", "Connected"])
      expect(html).not.toContain(english);
    expect(html).not.toContain("Wechsle zuerst");
    expect(html).not.toContain("Entfernt nur die Verbindung");
  });
});

describe("instance identity", () => {
  it("collapses duplicates of one instance (same id or same domain) into one row", () => {
    const managed = { ...instance("managed:welsch"), domain: "welsch.ctox.dev" };
    const paired = {
      ...instance("paired:welsch", "pairing_invite"),
      domain: "WELSCH.ctox.dev",
      status: "paired" as const,
      healthSummary: { ...instance("x").healthSummary, dataPlaneReady: true },
    };
    const other = instance("other");
    expect(dedupeCtoxInstances([managed, paired, managed, other]).map((row) => row.id)).toEqual([
      "paired:welsch",
      "other",
    ]);
    expect(
      dedupeCtoxInstances([managed, paired, other], "managed:welsch").map((row) => row.id),
    ).toEqual(["managed:welsch", "other"]);
    const html = renderToStaticMarkup(
      <InstancesTable instances={[managed, paired, other]} activeInstanceId="managed:welsch" />,
    );
    expect(count(html, "data-workjet-instance-row=")).toBe(2);
  });

  it("does not conflate equally named instances without a shared domain", () => {
    expect(
      dedupeCtoxInstances([
        { ...instance("one"), displayName: "Welsch" },
        { ...instance("two"), displayName: "Welsch" },
      ]),
    ).toHaveLength(2);
  });

  it("maps states to the row status dot and keeps raw ids out of the meta line", () => {
    expect(
      instanceRowState({
        ...instance("a"),
        healthSummary: { ...instance("a").healthSummary, dataPlaneReady: true },
      }).status,
    ).toBe("ok");
    expect(instanceRowState({ ...instance("a"), status: "needs_auth" }).chip).toBe(
      "Anmeldung nötig",
    );
    expect(instanceRowState({ ...instance("a"), workjetState: "disabled" }).status).toBe("off");
    expect(instanceRowMeta(instance("local:abc", "local_daemon"))).toBe("Dieser Rechner");
    expect(instanceRowMeta(instance("paired:abc", "pairing_invite"))).toBe("—");
  });
});
