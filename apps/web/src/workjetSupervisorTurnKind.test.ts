import { describe, expect, it } from "vite-plus/test";
import { CommandId, ProjectId, type CtoxWorkjetProjectControlRequest, type WorkjetSupervisorJournal, type WorkjetSupervisorTurnIntent } from "@workjet/contracts";
import { readWorkjetSupervisorTurnCapabilities, resumeWorkjetSupervisorTurn, submitWorkjetSupervisorTurn } from "./workjetSupervisorControl";
import type { WorkjetProjectControlPort } from "./workjetProjectControl";

const intent: WorkjetSupervisorTurnIntent = {
  instanceId: "managed:acceptance", projectId: ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7"),
  threadId: "e28290b0-7b0a-4d19-a242-f27041fadb84", commandId: CommandId.make("kind-submit-1"),
  goal: "Explain the current project status.", createdAt: "2026-10-09T15:00:00.000Z", turnKind: "conversation",
};
const binding = { contract: "ctox.workjet.supervisor_binding.v1",
  projectId: intent.projectId, threadId: intent.threadId, threadKey: `business-os/threads/${intent.threadId}` } as const;
const turn = { commandId: "actual-native-turn-1", taskId: "actual-native-task-1",
  threadId: intent.threadId, threadKey: binding.threadKey, executionPhase: "running",
  status: "running", queueStatus: "running", attempt: 1, terminal: false, result: null,
  resultTruncated: false, errorCode: null, errorMessage: null } as const;

function fixture() {
  const state: { saved: WorkjetSupervisorJournal | null } = { saved: null };
  const requests: CtoxWorkjetProjectControlRequest[] = [];
  const journal = { save: async (saved: WorkjetSupervisorJournal) => { state.saved = structuredClone(saved); } };
  const port: WorkjetProjectControlPort = async (_instance, request) => {
    requests.push(request);
    if (request.action === "project.supervisor.bind")
      return { _tag: "completed", response: { action: request.action, commandId: request.commandId, projectId: request.projectId, binding } };
    if (request.action === "project.supervisor.turn.capabilities")
      return { _tag: "completed", response: { action: request.action, commandId: request.commandId, projectId: request.projectId,
        contract: "ctox.workjet.supervisor_turn_capabilities.v1", binding, turnKinds: ["work", "conversation"], defaultTurnKind: "work" } };
    if (request.action === "project.supervisor.turn.submit") {
      expect(state.saved?.submission).toBe("awaiting-receipt");
      expect(state.saved?.intent).toEqual({ ...intent, turnKind: request.turnKind });
      return { _tag: "completed", response: { action: request.action, commandId: request.commandId, projectId: request.projectId,
        contract: "ctox.workjet.supervisor_turn.v1", binding, turn, messageId: "actual-message-1" } };
    }
    return { _tag: "failed", code: "unsupported" };
  };
  return { state, requests, journal, port };
}

describe("capability checked Supervisor conversations", () => {
  it("checks native support after binding, persists kind before submit, then confirms the actual turn", async () => {
    const f = fixture();
    expect((await submitWorkjetSupervisorTurn(intent, f.journal, f.port))._tag).toBe("completed");
    expect(f.requests.map(r => r.action)).toEqual(["project.supervisor.bind", "project.supervisor.turn.capabilities", "project.supervisor.turn.submit"]);
    expect(f.requests[2]).toMatchObject({ commandId: intent.commandId, turnKind: "conversation", goal: intent.goal });
    expect(f.state.saved).toEqual({ intent, turn, submission: "confirmed" });
  });

  it.each(["unsupported", "authentication_required", "guest_failed", "not_active", "timeout"] as const)(
    "preserves a %s capability failure without submitting a conversation", async code => {
      const f = fixture();
      const port: WorkjetProjectControlPort = async (instance, request) => {
        if (request.action === "project.supervisor.turn.capabilities") { f.requests.push(request); return { _tag: "failed", code }; }
        return f.port(instance, request);
      };
      expect(await submitWorkjetSupervisorTurn(intent, f.journal, port)).toEqual({ _tag: "failed", code });
      expect(f.requests.map(r => r.action)).toEqual(["project.supervisor.bind", "project.supervisor.turn.capabilities"]);
      expect(f.state.saved).toEqual({ intent, turn: null,
        submission: code === "not_active" || code === "timeout" ? "prepared" : "not-submitted", submissionError: code });
    });

  it("replays a lost receipt with the original conversation command and kind without a new preflight", async () => {
    const f = fixture();
    const saved: WorkjetSupervisorJournal = { intent, turn: null, submission: "awaiting-receipt" };
    expect((await resumeWorkjetSupervisorTurn(saved, CommandId.make("unused-observation"), f.journal, f.port))._tag).toBe("completed");
    expect(f.requests).toEqual([{ action: "project.supervisor.turn.submit", commandId: intent.commandId,
      projectId: intent.projectId, threadId: intent.threadId, goal: intent.goal, turnKind: "conversation" }]);
    expect(f.state.saved).toEqual({ intent, turn, submission: "confirmed" });
  });

  it.each([undefined, "work"] as const)("keeps legacy/default work compatible with a native without the new capability (%s)", async turnKind => {
    const f = fixture();
    const work = { ...intent, turnKind };
    const port: WorkjetProjectControlPort = async (instance, request) => {
      if (request.action === "project.supervisor.turn.submit") {
        f.requests.push(request);
        expect(Object.hasOwn(request, "turnKind")).toBe(false);
        return { _tag: "failed", code: "timeout" };
      }
      return f.port(instance, request);
    };
    expect(await submitWorkjetSupervisorTurn(work, f.journal, port)).toEqual({ _tag: "failed", code: "timeout" });
    expect(f.requests.map(r => r.action)).toEqual(["project.supervisor.bind", "project.supervisor.turn.submit"]);
    expect(f.state.saved).toEqual({ intent: work, turn: null, submission: "awaiting-receipt" });
  });

  it("refuses a capability confirmation for another command or thread", async () => {
    for (const wrong of ["command", "thread"] as const) {
      const f = fixture();
      const result = await readWorkjetSupervisorTurnCapabilities(intent, CommandId.make("capability-1"), async (_instance, request) => ({
        _tag: "completed", response: { action: "project.supervisor.turn.capabilities", commandId: wrong === "command" ? CommandId.make("foreign") : request.commandId,
          projectId: intent.projectId, contract: "ctox.workjet.supervisor_turn_capabilities.v1",
          binding: { ...binding, threadId: wrong === "thread" ? "6f688cca-f01b-4e08-ac6e-d91c9c512d5b" : binding.threadId },
          turnKinds: ["work", "conversation"], defaultTurnKind: "work" },
      }));
      expect(result).toEqual({ _tag: "failed", code: "guest_failed" });
    }
  });
});
