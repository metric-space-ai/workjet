import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CtoxMainShell,
  CtoxManagedInstanceList,
  CtoxModeProvider,
  releaseCtoxGuest,
} from "./CtoxModeShell";

describe("CtoxMainShell", () => {
  it("renders an honest empty state without a guest surface", () => {
    const markup = renderToStaticMarkup(
      <CtoxModeProvider initialDiscovery={{ _tag: "signed_out" }}>
        <CtoxMainShell />
      </CtoxModeProvider>,
    );

    expect(markup).toContain('data-ctox-main-shell=""');
    expect(markup).toContain("No instance selected");
    expect(markup).toContain("Select an available managed instance");
    expect(markup).not.toContain("iframe");
    expect(markup).not.toContain("webview");
  });

  it("renders renderer-safe managed instance metadata and selection controls", () => {
    const markup = renderToStaticMarkup(
      <CtoxModeProvider
        initialDiscovery={{
          _tag: "ready",
          instances: [],
        }}
      >
        <CtoxManagedInstanceList
          instances={[
            {
              id: "managed:tenant_skf",
              source: "ctox_dev",
              displayName: "SKF",
              status: "available",
              domain: "skf.ctox.dev",
              role: "owner",
              healthSummary: {
                dataPlane: "rxdb-webrtc",
                dataPlaneReady: true,
                httpDataProxy: false,
                nativePeerObserved: true,
              },
            },
          ]}
        />
      </CtoxModeProvider>,
    );

    expect(markup).toContain("Managed CTOX instances");
    expect(markup).toContain("SKF");
    expect(markup).toContain("owner · skf.ctox.dev");
    expect(markup).toContain("WebRTC ready");
    expect(markup).not.toContain("ctox_config");
    expect(markup).not.toContain("sessionPartition");
  });

  it("uses the desktop bridge cleanup for CTOX mode unmount", async () => {
    const deactivate = vi.fn(async () => ({ _tag: "completed" as const }));
    releaseCtoxGuest({ deactivate } as never);
    await vi.waitFor(() => expect(deactivate).toHaveBeenCalledOnce());
  });
});
