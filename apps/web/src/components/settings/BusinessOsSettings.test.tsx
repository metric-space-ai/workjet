import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...original,
    useNavigate: () => () => Promise.resolve(),
    useLocation: ({ select }: { select: (location: { hash: string }) => unknown }) =>
      select({ hash: "" }),
  };
});

import { BusinessOsSettingsView, resolveActiveBusinessOsInstanceId } from "./BusinessOsSettings";

describe("Business OS settings scope", () => {
  it("uses only an explicitly selected Business OS instance", () => {
    expect(
      resolveActiveBusinessOsInstanceId({
        mode: "business-os",
        ctoxInstanceId: "local:backend-alpha",
      }),
    ).toBe("local:backend-alpha");
    expect(
      resolveActiveBusinessOsInstanceId({ mode: "code", environmentId: "environment-alpha" }),
    ).toBeNull();
    expect(resolveActiveBusinessOsInstanceId(null)).toBeNull();
  });

  it("fails closed when no active instance exists", () => {
    const markup = renderToStaticMarkup(<BusinessOsSettingsView activeInstanceId={null} />);
    expect(markup).toContain("Keine Business-OS-Instanz ausgewählt");
    expect(markup).toContain("keine Daten verschiedener Instanzen vermischt");
    expect(markup).not.toContain("environment-alpha");
    expect(markup).not.toContain("Primary");
  });

  it("renders one active instance scope and the three user-facing areas", () => {
    const markup = renderToStaticMarkup(
      <BusinessOsSettingsView activeInstanceId="paired:backend-alpha" />,
    );
    expect(markup).toContain('data-active-ctox-instance="paired:backend-alpha"');
    expect(markup).toContain("paired:backend-alpha");
    expect(markup).toContain("Instanz ausgewählt");
    expect(markup).toContain("Workjet-Geräte");
    expect(markup).toContain("Rechner für Code");
    expect(markup).toContain("Diagnose");
    expect(markup.indexOf("Workjet-Geräte")).toBeLessThan(markup.indexOf("Rechner für Code"));
    expect(markup.indexOf("Rechner für Code")).toBeLessThan(markup.indexOf("Diagnose"));
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain("Choose backend");
    expect(markup).not.toContain("Active CTOX backend");
  });
});
