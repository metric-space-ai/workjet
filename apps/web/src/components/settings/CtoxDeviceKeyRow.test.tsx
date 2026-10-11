import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { CtoxDeviceKeyRow } from "./CtoxDeviceKeyRow";

describe("ctox.dev device key settings row", () => {
  it("shows the active lifecycle without exposing credential material", () => {
    const html = renderToStaticMarkup(
      <CtoxDeviceKeyRow
        status={{
          state: "active",
          createdAt: "2026-10-11T17:00:00Z",
          lastUsedAt: null,
          expiresAt: "2026-11-10T17:00:00Z",
        }}
        onReset={() => undefined}
      />,
    );
    expect(html).toContain("Geräteschlüssel: aktiv seit");
    expect(html).toContain("zuletzt genutzt");
    expect(html).toContain("läuft ab");
    expect(html).toContain("Geräteschlüssel-Menü");
    expect(html).not.toContain("thumbprint");
    expect(html).not.toContain("pkcs8");
  });
  it("shows a quota notice in the settings row", () => {
    const html = renderToStaticMarkup(
      <CtoxDeviceKeyRow status={{ state: "not_configured", notice: "DEVICE_KEY_LIMIT_REACHED" }} />,
    );
    expect(html).toContain("nicht eingerichtet");
    expect(html).toContain("Geräteschlüssel-Limit erreicht");
    expect(html).not.toContain('role="dialog"');
  });
});
