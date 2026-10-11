import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vite-plus/test";
import type { CtoxManagedInstance } from "@workjet/contracts";
import { InstancesTable } from "./InstancesTable";
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
describe("Instances table", () => {
  it("distinguishes selected from enabled and locks the selected switch", () => {
    const html = renderToStaticMarkup(
      <InstancesTable
        instances={[instance("selected")]}
        activeInstanceId="selected"
        language="de"
        onStateChange={async () => null}
      />,
    );
    expect(html).toContain("Ausgewählt");
    expect(html).toContain("Aktiv");
    expect(html).toMatch(/role="switch"[^>]*disabled/);
    expect(html).toContain("Wechsle zuerst");
  });
  it("has trash for paired and managed connections, and only a switch for local", () => {
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
    expect(html).toContain("Remove from Workjet · paired");
    expect(html).toContain("Remove from Workjet · managed");
    expect(html).not.toContain("Remove from Workjet · local");
    expect(html).toContain("Enabled · local");
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
    expect(html).toContain("Instance disabled");
    expect(html).not.toContain("connection could not");
    expect(html).not.toContain("removed");
    expect(html).toContain('aria-checked="false"');
  });
});
