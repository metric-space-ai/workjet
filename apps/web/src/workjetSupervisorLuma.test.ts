import {
  CommandId,
  ProjectId,
  ThreadId,
  type CtoxWorkjetProjectProjection,
} from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { saveSupervisorLuma } from "./workjetSupervisorLuma";
import type { WorkjetProjectControlPort } from "./workjetProjectControl";

const scope = {
  instanceId: "managed:acceptance",
  projectId: ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7"),
  threadId: ThreadId.make("e28290b0-7b0a-4d19-a242-f27041fadb84"),
};
const commandId = CommandId.make("choose-supervisor");
const project: CtoxWorkjetProjectProjection = {
  id: scope.projectId,
  title: "Molecularity",
  supervisorLumaId: null,
  workingCopies: [],
};
const receipt = (lumaId: string | null) =>
  ({
    _tag: "completed",
    response: {
      action: "project.configure",
      commandId,
      project: { ...project, supervisorLumaId: lumaId },
    },
  }) as const;
function input(port: WorkjetProjectControlPort, lumaId: string | null = "molecularity-supervisor") {
  return {
    scope,
    project,
    lumaId,
    commandId,
    signal: new AbortController().signal,
    isCurrent: () => true,
    port,
  };
}

describe("native Supervisor Luma selection", () => {
  it("updates only this project's Luma and adopts the native receipt", async () => {
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValue(receipt("molecularity-supervisor"));
    const result = await saveSupervisorLuma(input(port));
    expect(port).toHaveBeenCalledExactlyOnceWith(scope.instanceId, {
      action: "project.configure",
      commandId,
      projectId: scope.projectId,
      title: project.title,
      supervisorLumaId: "molecularity-supervisor",
    });
    expect(result).toEqual({
      phase: "saved",
      project: receipt("molecularity-supervisor").response.project,
    });
  });

  it("clears an explicit project selection through null to preserve the instance-default path", async () => {
    const port = vi.fn<WorkjetProjectControlPort>().mockResolvedValue(receipt(null));
    const result = await saveSupervisorLuma(input(port, null));
    expect(result.phase).toBe("saved");
    expect(port.mock.calls[0]?.[1]).toMatchObject({ supervisorLumaId: null });
  });

  it.each(["command", "project", "luma", "legacy"])(
    "rejects an uncorrelated %s receipt",
    async (kind) => {
      const original = receipt("molecularity-supervisor");
      const response = {
        ...original.response,
        commandId: kind === "command" ? CommandId.make("foreign-command") : commandId,
        project:
          kind === "legacy"
            ? { id: scope.projectId, title: project.title }
            : {
                ...original.response.project,
                id: kind === "project" ? ProjectId.make("foreign-project") : scope.projectId,
                supervisorLumaId: kind === "luma" ? "different-worker" : "molecularity-supervisor",
              },
      };
      const port = vi
        .fn<WorkjetProjectControlPort>()
        .mockResolvedValue({ _tag: "completed", response });
      expect(await saveSupervisorLuma(input(port))).toMatchObject({ phase: "failed" });
    },
  );

  it("keeps a denied native configuration visible as a failure", async () => {
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValue({ _tag: "failed", code: "authentication_required" });
    expect(await saveSupervisorLuma(input(port))).toEqual({
      phase: "failed",
      error: "Sign in to ctox.dev to reconnect this project's instance.",
    });
  });

  it("does not send a change for a foreign project or a stale instance selection", async () => {
    const port = vi.fn<WorkjetProjectControlPort>();
    expect(
      await saveSupervisorLuma({
        ...input(port),
        project: { ...project, id: ProjectId.make("foreign-project") },
      }),
    ).toMatchObject({ phase: "failed" });
    expect(await saveSupervisorLuma({ ...input(port), isCurrent: () => false })).toEqual({
      phase: "canceled",
    });
    expect(port).not.toHaveBeenCalled();
  });

  it.each(["abort", "instance"])("discards a late receipt after %s changes", async (kind) => {
    const controller = new AbortController();
    let current = true;
    const port = vi.fn<WorkjetProjectControlPort>().mockImplementation(async () => {
      if (kind === "abort") controller.abort();
      else current = false;
      return receipt("molecularity-supervisor");
    });
    expect(
      await saveSupervisorLuma({
        ...input(port),
        signal: controller.signal,
        isCurrent: () => current,
      }),
    ).toEqual({ phase: "canceled" });
  });
});
