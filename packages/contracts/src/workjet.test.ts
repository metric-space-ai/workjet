import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationThread,
  ThreadCreateCommand,
  ThreadCreatedPayload,
  ThreadTurnStartCommand,
} from "./orchestration.ts";
import { DEFAULT_WORKJET_THREAD_CONFIG, WorkjetThreadConfig } from "./workjet.ts";

const decodeWorkjetThreadConfig = Schema.decodeUnknownSync(WorkjetThreadConfig);
const decodeOrchestrationCommand = Schema.decodeUnknownSync(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownSync(OrchestrationEvent);

const standardConfig = {
  schemaVersion: 1,
  role: "standard",
  parent: null,
  managedInstructions: "",
  enabledCapabilityIds: [],
} as const;

const orchestratorConfig = {
  schemaVersion: 1,
  role: "orchestrator",
  parent: null,
  managedInstructions: "Coordinate the work.",
  enabledCapabilityIds: ["greppy", "web-search"],
} as const;

const workerConfig = {
  schemaVersion: 1,
  role: "worker",
  parent: {
    environmentId: "environment-1",
    threadId: "thread-parent",
  },
  managedInstructions: "Implement the assigned slice.",
  enabledCapabilityIds: ["greppy"],
} as const;

const historicalThread = {
  id: "thread-1",
  projectId: "project-1",
  title: "Historical thread",
  modelSelection: {
    instanceId: "codex",
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  updatedAt: "2026-08-14T00:00:00.000Z",
  deletedAt: null,
  messages: [],
  activities: [],
  checkpoints: [],
  session: null,
} as const;

const eventBase = {
  sequence: 1,
  eventId: "event-1",
  aggregateKind: "thread",
  aggregateId: "thread-1",
  occurredAt: "2026-08-14T00:00:00.000Z",
  commandId: "command-1",
  causationEventId: null,
  correlationId: "command-1",
  metadata: {},
} as const;

const threadCreateCommand = {
  type: "thread.create",
  commandId: "command-create",
  threadId: "thread-1",
  projectId: "project-1",
  title: "New thread",
  modelSelection: {
    instanceId: "codex",
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  createdAt: "2026-08-14T00:00:00.000Z",
} as const;

describe("WorkjetThreadConfig", () => {
  it.each([
    ["standard", standardConfig],
    ["orchestrator", orchestratorConfig],
    ["worker", workerConfig],
  ])("decodes a valid %s configuration", (_role, config) => {
    expect(decodeWorkjetThreadConfig(config)).toEqual(config);
  });

  it("rejects a worker without a parent", () => {
    expect(() =>
      decodeWorkjetThreadConfig({
        ...workerConfig,
        parent: null,
      }),
    ).toThrow();
  });

  it.each(["standard", "orchestrator"] as const)("rejects a %s thread with a parent", (role) => {
    expect(() =>
      decodeWorkjetThreadConfig({
        ...standardConfig,
        role,
        parent: workerConfig.parent,
      }),
    ).toThrow();
  });

  it("rejects unknown capability IDs", () => {
    expect(() =>
      decodeWorkjetThreadConfig({
        ...standardConfig,
        enabledCapabilityIds: ["unknown-capability"],
      }),
    ).toThrow();
  });
});

describe("orchestration Workjet configuration compatibility", () => {
  it("decodes a historical orchestration thread to the canonical default", () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationThread)(historicalThread);

    expect(decoded.workjetConfig).toEqual(DEFAULT_WORKJET_THREAD_CONFIG);
  });

  it("decodes missing thread creation configuration to the canonical default", () => {
    expect(
      Schema.decodeUnknownSync(ThreadCreateCommand)(threadCreateCommand).workjetConfig,
    ).toEqual(DEFAULT_WORKJET_THREAD_CONFIG);

    const bootstrapCommand = Schema.decodeUnknownSync(ThreadTurnStartCommand)({
      type: "thread.turn.start",
      commandId: "command-turn",
      threadId: "thread-1",
      message: {
        messageId: "message-1",
        role: "user",
        text: "Start",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "New thread",
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      },
      createdAt: "2026-08-14T00:00:00.000Z",
    });

    expect(bootstrapCommand.bootstrap?.createThread?.workjetConfig).toEqual(
      DEFAULT_WORKJET_THREAD_CONFIG,
    );
  });

  it("decodes a historical thread.created payload to the canonical default", () => {
    const decoded = Schema.decodeUnknownSync(ThreadCreatedPayload)({
      ...threadCreateCommand,
      updatedAt: threadCreateCommand.createdAt,
    });

    expect(decoded.workjetConfig).toEqual(DEFAULT_WORKJET_THREAD_CONFIG);
  });
});

describe("Workjet configuration replace-all wire contracts", () => {
  it("decodes the command", () => {
    const decoded = decodeOrchestrationCommand({
      type: "thread.workjet-config.set",
      commandId: "command-1",
      threadId: "thread-1",
      workjetConfig: workerConfig,
      createdAt: "2026-08-14T00:00:00.000Z",
    });

    expect(decoded.type).toBe("thread.workjet-config.set");
    if (decoded.type === "thread.workjet-config.set") {
      expect(decoded.workjetConfig).toEqual(workerConfig);
    }
  });

  it("decodes the event", () => {
    const decoded = decodeOrchestrationEvent({
      ...eventBase,
      type: "thread.workjet-config-set",
      payload: {
        threadId: "thread-1",
        workjetConfig: orchestratorConfig,
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
    });

    expect(decoded.type).toBe("thread.workjet-config-set");
    if (decoded.type === "thread.workjet-config-set") {
      expect(decoded.payload.workjetConfig).toEqual(orchestratorConfig);
    }
  });

  it("rejects a command with an invalid role/parent combination", () => {
    expect(() =>
      decodeOrchestrationCommand({
        type: "thread.workjet-config.set",
        commandId: "command-1",
        threadId: "thread-1",
        workjetConfig: {
          ...workerConfig,
          parent: null,
        },
        createdAt: "2026-08-14T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects an event with an invalid role/parent combination", () => {
    expect(() =>
      decodeOrchestrationEvent({
        ...eventBase,
        type: "thread.workjet-config-set",
        payload: {
          threadId: "thread-1",
          workjetConfig: {
            ...standardConfig,
            parent: workerConfig.parent,
          },
          updatedAt: "2026-08-14T00:00:00.000Z",
        },
      }),
    ).toThrow();
  });
});
