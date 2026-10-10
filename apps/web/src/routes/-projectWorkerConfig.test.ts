import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, WorkjetThreadConfig } from "@workjet/contracts";
import { createPersistentWorkerConfig } from "./-projectWorkerConfig";

const isThreadConfig = Schema.is(WorkjetThreadConfig);
const supervisorId = ThreadId.make("11111111-1111-4111-8111-111111111111");
const projectId = ProjectId.make("molecularity-fixture");
const createdAt = "2026-10-10T20:00:00.000Z";
const supervisorConfig = Schema.decodeUnknownSync(WorkjetThreadConfig)({
  schemaVersion: 2,
  role: "standard",
  parent: null,
  team: {
    role: "supervisor",
    projectId,
    threadId: supervisorId,
    parentThreadId: null,
    goal: "Coordinate the project",
    createdAt,
  },
  managedInstructions: "Project instructions",
  enabledCapabilityIds: ["ctox-business-os"],
  capabilityBindings: [
    {
      capabilityId: "ctox-business-os",
      target: {
        kind: "ctox-connection",
        instanceId: "fixture.ctox.dev",
        connectionId: "source-fixture",
      },
    },
  ],
  ctoxCrewChat: {
    instanceId: "fixture.ctox.dev",
    connectionId: "source-fixture",
    chatId: "workjet_private_supervisor",
  },
  ctoxSession: { instanceId: "fixture.ctox.dev", sessionId: "parent-session", fenceEpoch: 4 },
  ctoxProject: {
    codeProjectId: projectId,
    codeThreadId: supervisorId,
    presentationInstanceId: "fixture.ctox.dev",
    businessOsInstanceId: "fixture.ctox.dev",
    nativeProjectId: "native-project",
    workingCopyId: "parent-copy",
    nativeSessionId: "parent-session",
  },
  ctoxSupervisorTurn: {
    intent: {
      instanceId: "fixture.ctox.dev",
      projectId,
      threadId: supervisorId,
      commandId: "parent-command",
      goal: "Parent turn",
      createdAt,
    },
    turn: null,
    submission: "awaiting-receipt",
  },
  ctoxSupervisorPreviousTurns: [
    {
      intent: {
        instanceId: "fixture.ctox.dev",
        projectId,
        threadId: supervisorId,
        commandId: "prior-command",
        goal: "Prior turn",
        createdAt,
      },
      turn: null,
      submission: "awaiting-receipt",
    },
  ],
  goal: {
    objective: "Parent objective",
    status: "paused",
    revision: 9,
    continuationCount: 7,
    lastCompletedTurnId: null,
    lastVerifiedProgress: null,
    pendingContinuation: null,
    reason: "Owner paused",
    updatedAt: createdAt,
  },
});

describe("Persistent Worker creation settings", () => {
  it("inherits project settings but no supervisor journal, receipt, chat, session or loop state", () => {
    const threadId = ThreadId.make("22222222-2222-4222-8222-222222222222");
    const config = createPersistentWorkerConfig({
      supervisorConfig,
      projectId,
      supervisorThreadId: supervisorId,
      threadId,
      domain: "Pinball World Engine",
      goal: "Build the world engine",
      createdAt,
    });
    expect(config).toMatchObject({
      managedInstructions: supervisorConfig.managedInstructions,
      enabledCapabilityIds: supervisorConfig.enabledCapabilityIds,
      capabilityBindings:
        supervisorConfig.schemaVersion === 2 ? supervisorConfig.capabilityBindings : [],
      ctoxSession: null,
      team: {
        role: "specialist",
        threadId,
        parentThreadId: supervisorId,
        domain: "Pinball World Engine",
        goal: "Build the world engine",
      },
    });
    for (const field of [
      "ctoxSupervisorTurn",
      "ctoxSupervisorPreviousTurns",
      "ctoxCrewChat",
      "ctoxProject",
      "goal",
      "pullRequest",
    ])
      expect(config).not.toHaveProperty(field);
    expect(isThreadConfig(config)).toBe(true);
    expect(supervisorConfig).toHaveProperty("ctoxSupervisorTurn");
  });
});
