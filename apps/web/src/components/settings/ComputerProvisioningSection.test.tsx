import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComputerProvisioningSection } from "./ComputerProvisioningSection";

afterEach(() => vi.unstubAllGlobals());

describe("ComputerProvisioningSection", () => {
  it("stays absent in web-only clients", () => {
    vi.stubGlobal("window", { desktopBridge: undefined });
    expect(renderToStaticMarkup(<ComputerProvisioningSection />)).toBe("");
  });

  it("presents local and SSH provisioning without manual signaling fields", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        inspectProvisioningHostKey: vi.fn(),
        preflightProvisioningTarget: vi.fn(),
        startProvisioningOperation: vi.fn(),
        getProvisioningOperation: vi.fn(),
      },
    });
    const markup = renderToStaticMarkup(<ComputerProvisioningSection />);
    expect(markup).toContain("Provision CTOX and Workjet");
    expect(markup).toContain("This computer");
    expect(markup).toContain("Remote over SSH");
    expect(markup).toContain("checksum-verified");
    expect(markup).not.toContain("Signaling server");
    expect(markup).not.toContain("Room password");
  });
});
