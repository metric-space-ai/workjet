import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DeveloperOnlyRoute } from "./DeveloperOnlyRoute";
import { PanelLayoutControls } from "./chat/PanelLayoutControls";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";

vi.mock("@tanstack/react-router", () => ({
  Navigate: ({ to }: { to: string }) => <a data-redirect={to} />,
}));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../hooks/useSettings")>();
  return {
    ...original,
    useClientSettings: vi.fn(),
    useClientSettingsHydrated: vi.fn(() => true),
  };
});

const developerMode = (enabled: boolean) =>
  vi
    .mocked(useClientSettings)
    .mockImplementation(((selector?: (settings: { developerMode: boolean }) => unknown) =>
      selector
        ? selector({ developerMode: enabled })
        : { developerMode: enabled }) as unknown as typeof useClientSettings);

const pullRequestsPage = () =>
  renderToStaticMarkup(
    <DeveloperOnlyRoute>
      <main>Pull Requests</main>
    </DeveloperOnlyRoute>,
  );

describe("/pull-requests without developer mode (#557)", () => {
  it("redirects to the start page", () => {
    developerMode(false);
    const html = pullRequestsPage();
    expect(html).toContain('data-redirect="/"');
    expect(html).not.toContain("Pull Requests");
  });

  it("shows the page in developer mode", () => {
    developerMode(true);
    expect(pullRequestsPage()).toContain("Pull Requests");
  });

  it("waits for persisted settings before deciding", () => {
    developerMode(false);
    vi.mocked(useClientSettingsHydrated).mockReturnValueOnce(false);
    expect(pullRequestsPage()).toBe("");
  });
});

describe("chat header without developer mode (#557)", () => {
  const header = (showTerminalControl: boolean) =>
    renderToStaticMarkup(
      <PanelLayoutControls
        showTerminalControl={showTerminalControl}
        terminalAvailable
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        onToggleTerminal={() => undefined}
        onToggleRightPanel={() => undefined}
      />,
    );

  it("renders no terminal toggle, only the workspace toggle", () => {
    const html = header(false);
    expect(html).not.toContain("Terminal");
    expect(html).toContain("Arbeitsbereich");
    expect(header(true)).toContain("Terminal");
  });
});
