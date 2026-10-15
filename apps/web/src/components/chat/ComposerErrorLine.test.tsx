import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerErrorLine } from "./ComposerErrorLine";
import { composerErrorLine } from "./composerErrorLineLogic";

describe("ComposerErrorLine", () => {
  it("zeigt eine Zeile, genau eine Aktion und nie den Rohtext", () => {
    const line = composerErrorLine("Request failed with status 401", { fallback: "x" })!;
    const html = renderToStaticMarkup(<ComposerErrorLine line={line} onAction={() => {}} />);
    expect(html).toContain("Anmeldung der Instanz abgelaufen</span>");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Neu verbinden</button>");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("401");
  });

  it("zeigt nach 2 min Ausfall die Zeile mit „Erneut versuchen“", () => {
    const line = composerErrorLine("HTTP 503 Service Unavailable", {
      fallback: "x",
      unreachableForMs: 120_000,
    })!;
    const html = renderToStaticMarkup(<ComposerErrorLine line={line} onAction={() => {}} />);
    expect(html).toContain("Instanz nicht erreichbar</span>");
    expect(html).toContain("Erneut versuchen</button>");
  });

  it("eine deutsche Kurzzeile hat keine Details", () => {
    const line = composerErrorLine("Presets nicht verbunden", { fallback: "x" })!;
    const html = renderToStaticMarkup(<ComposerErrorLine line={line} onAction={() => {}} />);
    expect(html).not.toContain("<details");
  });
});
