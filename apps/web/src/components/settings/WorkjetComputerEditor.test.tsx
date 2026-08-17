import { EnvironmentId, WorkjetComputerId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkjetComputerDraft,
  saveWorkjetComputerDraft,
  WorkjetComputerEditor,
  type WorkjetEnvironmentTargetOption,
} from "./WorkjetComputerEditor";

const remoteEnvironment: WorkjetEnvironmentTargetOption = {
  environmentId: EnvironmentId.make("environment-remote"),
  label: "Remote devbox",
  presentationKind: "tailscale",
  detail: "Tailscale",
};

describe("WorkjetComputerEditor", () => {
  it("saves a configured remote environment as a computer target", () => {
    const draft = createWorkjetComputerDraft({
      environments: [remoteEnvironment],
      id: "computer-remote",
    });
    const saved = saveWorkjetComputerDraft({
      ...draft,
      harnesses: draft.harnesses.map((configuration) =>
        configuration.harness === "codex-cli"
          ? {
              ...configuration,
              available: true,
              executableOverride: " /opt/workjet/bin/codex ",
            }
          : configuration,
      ),
    });

    expect(saved.id).toBe(WorkjetComputerId.make("computer-remote"));
    expect(saved.environmentId).toBe(EnvironmentId.make("environment-remote"));
    expect(saved.presentationKind).toBe("tailscale");
    expect(saved.harnesses.find((item) => item.harness === "codex-cli")).toEqual({
      harness: "codex-cli",
      available: true,
      executableOverride: "/opt/workjet/bin/codex",
    });
    expect(saved).not.toHaveProperty("host");
    expect(saved).not.toHaveProperty("credentials");
  });

  it("renders all supported harnesses and explains connection authority", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputerEditor
        environments={[remoteEnvironment]}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    for (const label of [
      "Claude Code",
      "Codex CLI",
      "OpenCode",
      "Grok CLI",
      "Cursor Agent",
      "Pi Code",
    ]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("existing environment");
    expect(markup).toContain("does not store SSH");
  });
});
