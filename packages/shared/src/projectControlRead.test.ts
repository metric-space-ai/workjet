import { describe, expect, it } from "vite-plus/test";
import { CommandId, ProjectId } from "@workjet/contracts";
import { projectControlReadKey } from "./projectControlRead.ts";

describe("project read identity", () => {
  it("canonicalizes parameter order and keeps correlation IDs distinct", () => {
    const request = {
      action: "project.kpis.read",
      commandId: CommandId.make("first"),
      projectId: ProjectId.make("a"),
    } as const;
    expect(projectControlReadKey(request)).toBe(
      projectControlReadKey({
        projectId: request.projectId,
        action: request.action,
        commandId: request.commandId,
      }),
    );
    expect(projectControlReadKey(request)).not.toBe(
      projectControlReadKey({ ...request, commandId: CommandId.make("second") }),
    );
  });
  it("never shares mutation commands", () => {
    expect(
      projectControlReadKey({
        action: "project.kpis.configure",
        commandId: CommandId.make("write"),
        projectId: ProjectId.make("a"),
        operationId: "save",
        expectedRevision: 0,
        prompts: [],
      }),
    ).toBeNull();
  });
});
