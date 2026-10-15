import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { MeetingPreparationField } from "./ProjectMeetingPreparationField";
describe("meeting preparation configuration", () => {
  it("shows Claude Code, the requested Grok model, two lead times, and missing route explicitly", () => {
    const markup = renderToStaticMarkup(
      <MeetingPreparationField
        id="preparation"
        value={undefined}
        disabled={false}
        onChange={() => {}}
      />,
    );
    expect(markup).toContain("Regeltermin-Vorbereitung");
    expect(markup).toContain('data-value="claude-code"');
    expect(markup).toContain('data-value="grok-4.7"');
    expect(markup).toContain('value="24"');
    expect(markup).toContain('value="2"');
    expect(markup).toContain("Keine passende Luma");
    for (const harness of ["grok-cli", "opencode", "pi-code"])
      expect(markup).toContain(`data-option="${harness}" data-disabled`);
    expect(markup).toContain("Worktree-Begrenzung fehlt");
  });
});
