import { renderToStaticMarkup } from "react-dom/server";
import { CommandId } from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
const fixture = vi.hoisted(() => ({
  state: undefined as "disabled" | "removed" | undefined,
  language: "en" as "en" | "de",
}));
vi.mock("./components/ctox/CtoxModeShell", () => ({ useCtoxInstanceState: () => fixture.state }));
vi.mock("./hooks/useProjectOverviewLanguage", () => ({
  useProjectOverviewLanguage: () => fixture.language,
}));
import { ProjectNativeSyncStatus } from "./localProjectRegistration";
const project = {
  ctoxRegistration: {
    instanceId: "managed:fixture",
    commandId: CommandId.make("fixture"),
    status: "confirmed" as const,
  },
};
describe("retained project instance status", () => {
  it.each(["disabled", "removed"] as const)(
    "shows %s calmly for a retained confirmed project",
    (state) => {
      fixture.state = state;
      fixture.language = "en";
      const markup = renderToStaticMarkup(<ProjectNativeSyncStatus project={project} />);
      expect(markup).toContain('data-workjet-project-instance-state="' + state + '"');
      expect(markup).toContain("The project and its history stay saved.");
      expect(markup).not.toContain("text-destructive");
      expect(markup).not.toContain("Erneut versuchen");
    },
  );
  it.each(["disabled", "removed"] as const)(
    "uses the configured German UI language for %s",
    (state) => {
      fixture.state = state;
      fixture.language = "de";
      const markup = renderToStaticMarkup(<ProjectNativeSyncStatus project={project} />);
      expect(markup).toContain(state === "disabled" ? "Instanz deaktiviert." : "Instanz entfernt.");
      expect(markup).not.toContain("Instance disabled");
    },
  );
  it("keeps a connected confirmed project quiet", () => {
    fixture.state = undefined;
    expect(renderToStaticMarkup(<ProjectNativeSyncStatus project={project} />)).toBe("");
  });
});
