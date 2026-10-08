import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { NoInstanceHero } from "./NoInstanceHero";

describe("no instance hero", () => {
  it("explains what is missing and offers one clear action to connect an instance", () => {
    const html = renderToStaticMarkup(<NoInstanceHero />);
    expect(html).toContain("No CTOX instance is connected");
    expect(html).toContain("Connect an instance");
    expect(html).toContain('data-workjet-action="instance.connect.empty"');
    expect(html).toContain('data-workjet-no-instance=""');
  });
});
