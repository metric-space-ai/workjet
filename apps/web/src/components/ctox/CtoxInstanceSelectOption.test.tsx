import type { CtoxManagedInstance } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { CtoxInstanceSelectOption } from "./CtoxInstanceSelectOption";

function instance(
  source: CtoxManagedInstance["source"],
  status: CtoxManagedInstance["status"],
): CtoxManagedInstance {
  return {
    id: "fixture",
    displayName: "Fixture",
    source,
    status,
    healthSummary: {
      dataPlane: "rxdb-webrtc",
      dataPlaneReady: true,
      httpDataProxy: false,
      nativePeerObserved: true,
    },
  };
}

describe("CtoxInstanceSelectOption", () => {
  it("explains why an expired pairing cannot be selected", () => {
    const markup = renderToStaticMarkup(
      <CtoxInstanceSelectOption instance={instance("pairing_invite", "pairing_expired")} />,
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("Fixture");
    expect(markup).toContain("Verbindung abgelaufen");
    expect(markup).toContain("neue Einladung erforderlich");
  });

  it.each(["pairing_invite", "local_daemon"] as const)(
    "keeps usable %s instances selectable",
    (source) => {
      const markup = renderToStaticMarkup(
        <CtoxInstanceSelectOption
          instance={instance(source, source === "pairing_invite" ? "paired" : "available")}
        />,
      );
      expect(markup).not.toContain("disabled");
      expect(markup).not.toContain("abgelaufen");
      expect(markup).toContain("Fixture");
    },
  );
});
