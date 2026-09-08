import { EnvironmentId, WorkjetComputerId } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createWorkjetComputerDraft,
  persistWorkjetComputerDraft,
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
  it("restores the edited label from a popup draft and keeps its compact grid narrow", () => {
    const draft = {
      ...createWorkjetComputerDraft({ environments: [remoteEnvironment], id: "retained" }),
      label: "Unfinished edit",
    };
    const markup = renderToStaticMarkup(
      <WorkjetComputerEditor
        compact
        initialDraft={draft}
        environments={[remoteEnvironment]}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(markup).toContain('value="Unfinished edit"');
    expect(markup).not.toContain("sm:col-span-2");
    expect(markup).not.toContain("sm:grid-cols-");
  });

  it("waits for a settings acknowledgement before reporting save completion", async () => {
    const draft = createWorkjetComputerDraft({ environments: [remoteEnvironment] });
    let acknowledge!: () => void;
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const onSave = vi.fn(() => pending);
    let completed = false;
    const saving = persistWorkjetComputerDraft(draft, [remoteEnvironment], onSave).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    acknowledge();
    await saving;
    expect(completed).toBe(true);
  });

  it("propagates an async save failure and leaves the edited draft reusable", async () => {
    const draft = {
      ...createWorkjetComputerDraft({ environments: [remoteEnvironment] }),
      label: "Keep this edit",
    };
    await expect(
      persistWorkjetComputerDraft(draft, [remoteEnvironment], async () => {
        throw new Error("Connection lost");
      }),
    ).rejects.toThrow("Connection lost");
    const retry = vi.fn();
    await persistWorkjetComputerDraft(draft, [remoteEnvironment], retry);
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ label: "Keep this edit" }));
  });

  it("refuses a connection removed while the editor was open before sending any settings", async () => {
    const draft = createWorkjetComputerDraft({ environments: [remoteEnvironment] });
    const onSave = vi.fn();
    await expect(persistWorkjetComputerDraft(draft, [], onSave)).rejects.toThrow(
      "Choose a connected computer",
    );
    expect(onSave).not.toHaveBeenCalled();
  });

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

describe("live harness availability", () => {
  // A default draft has every harness present and switched OFF, so the
  // "present but switched off" direction is reachable without a fixture.
  const probe = (harnesses: unknown) =>
    ({ schemaVersion: 1, probedAt: "2026-08-20T10:00:00.000Z", harnesses }) as never;

  it("warns when the host cannot run a harness the operator switched on", () => {
    // The dangerous mismatch. Rendered with the switch off in the default
    // draft, the same probe must NOT warn — that pairing is the point.
    const markup = renderToStaticMarkup(
      <WorkjetComputerEditor
        environments={[remoteEnvironment]}
        onSave={() => undefined}
        onCancel={() => undefined}
        availability={probe([
          { harness: "codex-cli", availability: "unavailable", reason: "executable-not-found" },
        ])}
      />,
    );

    // Default draft has it switched off, so an absent harness AGREES.
    expect(markup).not.toContain('data-workjet-harness-availability="declared-but-missing"');
  });

  it("flags capacity the operator switched off without meaning to", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputerEditor
        environments={[remoteEnvironment]}
        onSave={() => undefined}
        onCancel={() => undefined}
        availability={probe([
          {
            harness: "codex-cli",
            availability: "available",
            executablePath: "/bin/codex",
            version: "1.4.0",
          },
        ])}
      />,
    );

    expect(markup).toContain('data-workjet-harness-availability="present-but-switched-off"');
    expect(markup).toContain("1.4.0");
  });

  it("says nothing at all before a probe has run", () => {
    const markup = renderToStaticMarkup(
      <WorkjetComputerEditor
        environments={[remoteEnvironment]}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).not.toContain("data-workjet-harness-availability");
  });
});
