import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import {
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResponse,
  isWorkjetSupervisorReceiptForRequest,
} from "./ctox.ts";
import { DEFAULT_WORKJET_THREAD_CONFIG, normalizeWorkjetThreadConfig } from "./workjet.ts";
import { retainWorkjetCtoxBinding } from "./workjetCtoxBinding.ts";
import { WorkjetSupervisorTurnIntent } from "./workjetSupervisor.ts";

const intent = {
  instanceId: "managed:acceptance",
  projectId: ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7"),
  threadId: "e28290b0-7b0a-4d19-a242-f27041fadb84",
  commandId: CommandId.make("kind-submit-1"),
  goal: "Explain the current project status.",
  createdAt: "2026-10-09T15:00:00.000Z",
};
const capability = {
  action: "project.supervisor.turn.capabilities",
  commandId: CommandId.make("capabilities-1"),
  projectId: intent.projectId,
  contract: "ctox.workjet.supervisor_turn_capabilities.v1",
  binding: {
    contract: "ctox.workjet.supervisor_binding.v1",
    projectId: intent.projectId,
    threadId: intent.threadId,
    threadKey: `business-os/threads/${intent.threadId}`,
  },
  turnKinds: ["work", "conversation"],
  defaultTurnKind: "work",
} as const;

describe("explicit Supervisor turn intent", () => {
  it("retains legacy work and rejects malformed or guessed kinds", () => {
    const decode = Schema.decodeUnknownSync(WorkjetSupervisorTurnIntent, {
      onExcessProperty: "error",
    });
    expect(decode(intent)).toEqual(intent);
    for (const turnKind of ["work", "conversation"])
      expect(decode({ ...intent, turnKind }).turnKind).toBe(turnKind);
    const decodeRequest = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, {
      onExcessProperty: "error",
    });
    const request = {
      action: "project.supervisor.turn.submit",
      commandId: intent.commandId,
      projectId: intent.projectId,
      threadId: intent.threadId,
      goal: intent.goal,
    };
    for (const turnKind of [null, "chat", "", {}, true]) {
      expect(() => decode({ ...intent, turnKind })).toThrow();
      expect(() => decodeRequest({ ...request, turnKind })).toThrow();
    }
  });

  it("requires the scoped current capability and preserves the legacy work default", () => {
    const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
      onExcessProperty: "error",
    });
    expect(decode(capability)).toEqual(capability);
    for (const changed of [
      { ...capability, turnKinds: ["conversation", "work"] },
      { ...capability, turnKinds: ["work"] },
      { ...capability, defaultTurnKind: "conversation" },
      { ...capability, contract: "ctox.workjet.supervisor_turn.v1" },
      { ...capability, binding: { ...capability.binding, projectId: ProjectId.make("foreign") } },
      { ...capability, turn: {} },
    ])
      expect(() => decode(changed)).toThrow();
    const request = {
      action: capability.action,
      commandId: capability.commandId,
      projectId: intent.projectId,
      threadId: intent.threadId,
    } as const;
    expect(isWorkjetSupervisorReceiptForRequest(request, capability)).toBe(true);
    expect(
      isWorkjetSupervisorReceiptForRequest(
        { ...request, commandId: CommandId.make("other") },
        capability,
      ),
    ).toBe(false);
    expect(
      isWorkjetSupervisorReceiptForRequest(
        { ...request, threadId: "6f688cca-f01b-4e08-ac6e-d91c9c512d5b" },
        capability,
      ),
    ).toBe(false);
  });

  it("cannot reclassify a saved command before or after dispatch", () => {
    const initial = normalizeWorkjetThreadConfig(DEFAULT_WORKJET_THREAD_CONFIG);
    for (const submission of ["awaiting-receipt", "prepared"] as const) {
      const previous = { ...initial, ctoxSupervisorTurn: { intent, turn: null, submission } };
      expect(
        retainWorkjetCtoxBinding(previous, {
          ...previous,
          ctoxSupervisorTurn: {
            ...previous.ctoxSupervisorTurn,
            intent: { ...intent, turnKind: "conversation" },
          },
        }).error,
      ).not.toBeNull();
      expect(
        retainWorkjetCtoxBinding(previous, {
          ...previous,
          ctoxSupervisorTurn: {
            ...previous.ctoxSupervisorTurn,
            intent: { ...intent, turnKind: "work" },
          },
        }).error,
      ).toBeNull();
    }
    const previous = {
      ...initial,
      ctoxSupervisorTurn: {
        intent: { ...intent, turnKind: "conversation" as const },
        turn: null,
        submission: "awaiting-receipt" as const,
      },
    };
    expect(
      retainWorkjetCtoxBinding(previous, {
        ...previous,
        ctoxSupervisorTurn: { ...previous.ctoxSupervisorTurn, intent },
      }).error,
    ).not.toBeNull();
  });
});
