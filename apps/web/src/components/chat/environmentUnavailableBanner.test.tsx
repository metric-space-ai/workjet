import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { environmentUnavailableBannerItem } from "./environmentUnavailableBanner";
import { composerErrorLine, composerToastDescription } from "./composerErrorLineLogic";

const RAW_503 = "Relay request failed (HTTP 503)";

function renderBanner(raw: string, unreachableForMs: number | null) {
  const line = composerErrorLine(raw, { fallback: "Instanz nicht erreichbar", unreachableForMs });
  if (line === null) return "";
  return renderToStaticMarkup(
    <ComposerBannerStack
      items={[
        environmentUnavailableBannerItem({
          environmentId: "environment-gpu3",
          line,
          reconnecting: false,
          onReconnect: () => {},
        }),
      ]}
    />,
  );
}

describe("environmentUnavailableBannerItem", () => {
  it("bleibt bei 503 still, solange der Ausfall kürzer als 2 min ist", () => {
    expect(renderBanner(RAW_503, null)).toBe("");
    expect(renderBanner(RAW_503, 119_999)).toBe("");
  });

  it("zeigt nach 2 min „Instanz nicht erreichbar · Erneut“, Rohtext nur hinter Details", () => {
    const html = renderBanner(RAW_503, 120_000);
    expect(html).toContain("Instanz nicht erreichbar");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Erneut</button>");
    expect(html).toMatch(
      /<summary[^>]*>Details<\/summary><pre[^>]*>Relay request failed \(HTTP 503\)<\/pre>/,
    );
    expect(html.replace(/<details[\s\S]*<\/details>/, "")).not.toMatch(
      /503|Failed to connect|Reconnecting/,
    );
  });

  it("zeigt 401 sofort als abgelaufene Anmeldung mit „Neu verbinden“", () => {
    const html = renderBanner("HTTP 401 Unauthorized", null);
    expect(html).toContain("Anmeldung der Instanz abgelaufen");
    expect(html).toContain("Neu verbinden</button>");
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe("composerToastDescription", () => {
  it("lässt Rohtext im Toast weg", () => {
    expect(composerToastDescription(new Error("Clipboard write failed: NotAllowedError"))).toBe(
      undefined,
    );
    expect(composerToastDescription("TypeError: x is undefined")).toBe(undefined);
    expect(composerToastDescription(undefined)).toBe(undefined);
  });

  it("übersetzt Anmeldung und Erreichbarkeit in eine deutsche Kurzzeile", () => {
    expect(composerToastDescription("Request failed with status 401")).toBe(
      "Anmeldung der Instanz abgelaufen",
    );
    expect(composerToastDescription(new Error("HTTP 503 Service Unavailable"))).toBe(
      "Instanz nicht erreichbar",
    );
  });

  it("behält eine deutsche Kurzzeile ohne Satzpunkt", () => {
    expect(composerToastDescription("Titel bereits vergeben.")).toBe("Titel bereits vergeben");
  });
});
