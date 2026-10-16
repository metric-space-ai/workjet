import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import rowSource from "./row.tsx?raw";
import { Row } from "./row";

describe("Row delete control", () => {
  it("shows the trash as a bare icon with tooltip, without a visible word (Audit C#11)", () => {
    const html = renderToStaticMarkup(
      <Row
        name="michael@metric-space.ai"
        onDelete={() => {}}
        deleteLabel="Konto entfernen"
        menuActions={[{ label: "Entfernen", onSelect: () => {}, destructive: true }]}
      />,
    );
    expect(html).toContain('aria-label="Konto entfernen"');
    expect(html).not.toContain(">Konto entfernen<");
    expect(html).toContain("lucide-trash");
  });

  it("lays the inline confirmation over the row instead of reflowing it (Audit C#48)", () => {
    expect(rowSource).toContain('className="absolute inset-0');
    expect(rowSource).toContain(
      "data-[confirming=true]:[&>*:not([data-slot=row-confirm])]:invisible",
    );
  });
});
