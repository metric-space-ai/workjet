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
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import {
  DEFAULT_WORKJET_CONFIGURATION,
  DEFAULT_WORKJET_THREAD_CONFIG,
  GreppyRuntimeSnapshot,
  WorkjetConfiguration,
  WorkjetGatewayCatalog,
  WorkjetGatewayOperationError,
  WorkjetGatewayStatus,
  WorkjetGreppyOperationError,
  WorkjetThreadConfig,
  WorktreeStorageInspection,
  WorktreeStorageInspectionInput,
} from "./workjet.ts";

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
  enabledCapabilityIds: ["greppy", "web-search", "web-stack-browser"],
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

describe("Greppy runtime RPC contract", () => {
  it("decodes portable snapshots without exposing a server path", () => {
    const decoded = Schema.decodeUnknownSync(GreppyRuntimeSnapshot)({
      availability: "available",
      source: "managed",
      version: "0.3.1",
      installSupported: true,
      storeDir: "/private/server/state/greppy",
    });

    expect(decoded).toEqual({
      availability: "available",
      source: "managed",
      version: "0.3.1",
      installSupported: true,
    });
  });

  it("registers stable inspect and install method names", () => {
    expect(WS_METHODS.workjetGreppyInspect).toBe("workjet.greppy.inspect");
    expect(WS_METHODS.workjetGreppyInstall).toBe("workjet.greppy.install");
    expect(WsRpcGroup.requests.has(WS_METHODS.workjetGreppyInspect)).toBe(true);
    expect(WsRpcGroup.requests.has(WS_METHODS.workjetGreppyInstall)).toBe(true);
  });

  it("limits public operation failures to a bounded reason", () => {
    const decoded = Schema.decodeUnknownSync(WorkjetGreppyOperationError)({
      _tag: "WorkjetGreppyOperationError",
      reason: "install-failed",
      message: "secret server output",
      stderr: "credential=value",
      path: "/private/server/state",
    });

    expect(decoded.reason).toBe("install-failed");
    expect(JSON.stringify(decoded)).not.toContain("secret");
    expect(() =>
      Schema.decodeUnknownSync(WorkjetGreppyOperationError)({
        _tag: "WorkjetGreppyOperationError",
        reason: "arbitrary-server-message",
      }),
    ).toThrow();
  });
});

describe("automatic worktree storage RPC contract", () => {
  it("registers inspection on the selected server RPC group", () => {
    expect(WS_METHODS.workjetWorktreesInspect).toBe("workjet.worktrees.inspect");
    expect(WsRpcGroup.requests.has(WS_METHODS.workjetWorktreesInspect)).toBe(true);
    expect(
      Schema.decodeUnknownSync(WorktreeStorageInspectionInput)({ root: "  /srv/worktrees  " }),
    ).toEqual({
      root: "/srv/worktrees",
    });
  });

  it("decodes valid health and bounded invalid diagnostics", () => {
    expect(
      Schema.decodeUnknownSync(WorktreeStorageInspection)({
        status: "valid",
        requestedRoot: "/srv/worktrees",
        configuredRoot: "/srv/worktrees",
        defaultRoot: "/var/lib/workjet/worktrees",
        effectiveRoot: "/srv/worktrees",
        canonicalRoot: "/srv/worktrees",
        writable: true,
        availableBytes: 123_456,
      }),
    ).toMatchObject({ status: "valid", availableBytes: 123_456 });

    const invalid = Schema.decodeUnknownSync(WorktreeStorageInspection)({
      status: "invalid",
      requestedRoot: "relative",
      configuredRoot: "",
      defaultRoot: "/var/lib/workjet/worktrees",
      effectiveRoot: "/var/lib/workjet/worktrees",
      canonicalRoot: null,
      writable: false,
      availableBytes: null,
      reason: "absolute-path-required",
      message: "Enter an absolute path on the selected server.",
      internalCause: "must not survive decoding",
    });
    expect(invalid.status).toBe("invalid");
    if (invalid.status !== "invalid") throw new Error("expected an invalid inspection");
    expect(invalid.reason).toBe("absolute-path-required");
    expect(invalid).not.toHaveProperty("internalCause");
  });
});

describe("Workjet provider gateway RPC contract", () => {
  it("registers stable inspect and lifecycle method names", () => {
    expect(WS_METHODS.workjetGatewayStatus).toBe("workjet.providerGateway.status");
    expect(WS_METHODS.workjetGatewayCatalog).toBe("workjet.providerGateway.catalog");
    expect(WS_METHODS.workjetGatewayStart).toBe("workjet.providerGateway.start");
    expect(WS_METHODS.workjetGatewayStop).toBe("workjet.providerGateway.stop");
    for (const method of [
      WS_METHODS.workjetGatewayStatus,
      WS_METHODS.workjetGatewayCatalog,
      WS_METHODS.workjetGatewayStart,
      WS_METHODS.workjetGatewayStop,
    ]) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it("drops plaintext secrets and secret references from public payloads", () => {
    const status = Schema.decodeUnknownSync(WorkjetGatewayStatus)({
      schemaVersion: 1,
      phase: "ready",
      pid: 123,
      providerEndpoint: "http://127.0.0.1:41000",
      managementEndpoint: "http://127.0.0.1:41001",
      failureReason: null,
      configuredAccountCount: 1,
      configuredModelCount: 1,
      apiKey: "must-not-escape",
      secretRef: { scope: "workjet-provider-gateway", name: "provider.secret" },
    });
    const catalog = Schema.decodeUnknownSync(WorkjetGatewayCatalog)({
      schemaVersion: 1,
      accounts: [
        {
          id: "account-1",
          label: "Primary",
          provider: "codex",
          enabled: true,
          priority: 10,
          weight: 1,
          modelIds: ["gpt-5.6"],
          accessToken: "must-not-escape",
        },
      ],
      pools: [
        {
          id: "pool-1",
          label: "Codex pool",
          provider: "codex",
          accountIds: ["account-1"],
          modelIds: ["gpt-5.6"],
        },
      ],
      routes: [
        {
          id: "route-1",
          label: "Default",
          poolId: "pool-1",
          provider: "codex",
          modelIds: ["gpt-5.6"],
        },
      ],
      models: [
        {
          id: "gpt-5.6",
          displayName: "GPT-5.6",
          providers: ["codex"],
          accountIds: ["account-1"],
        },
      ],
    });

    expect(JSON.stringify({ status, catalog })).not.toContain("must-not-escape");
    expect(JSON.stringify({ status, catalog })).not.toContain("secretRef");
  });

  it("limits operation failures to typed redacted reasons", () => {
    const decoded = Schema.decodeUnknownSync(WorkjetGatewayOperationError)({
      _tag: "WorkjetGatewayOperationError",
      reason: "process-exit",
      stderr: "Authorization: Bearer secret",
      configPath: "/private/path",
    });
    expect(decoded.reason).toBe("process-exit");
    expect(JSON.stringify(decoded)).not.toContain("Bearer");
  });
});

describe("WorkjetConfiguration", () => {
  it("decodes missing legacy catalog data to a valid empty configuration", () => {
    expect(Schema.decodeUnknownSync(WorkjetConfiguration)({})).toEqual(
      DEFAULT_WORKJET_CONFIGURATION,
    );
    expect(DEFAULT_WORKJET_CONFIGURATION).toEqual({
      schemaVersion: 1,
      computers: [],
      llmRoutes: [],
      workerProfiles: [],
      managedSystemPrompt: "",
      telemetry: {
        claudeCodeEvents: true,
        sidecarEvents: true,
        retentionDays: 14,
      },
      execution: {
        probeTimeoutSeconds: 120,
        turnTimeoutSeconds: 5_400,
        degradationAllowed: true,
      },
    });
  });

  it("keeps reusable routes model-free and credential-free", () => {
    const decoded = Schema.decodeUnknownSync(WorkjetConfiguration)({
      llmRoutes: [
        {
          id: "route-main",
          label: "Main account",
          providerInstanceId: "codex_personal",
          modelId: "must-not-persist-here",
          apiKey: "must-not-persist-here",
        },
      ],
    });

    expect(decoded.llmRoutes).toEqual([
      {
        id: "route-main",
        label: "Main account",
        providerInstanceId: "codex_personal",
      },
    ]);
    expect(JSON.stringify(decoded.llmRoutes)).not.toContain("must-not-persist-here");
  });

  it("decodes missing per-computer harnesses and worker capabilities safely", () => {
    const decoded = Schema.decodeUnknownSync(WorkjetConfiguration)({
      computers: [
        {
          id: "computer-1",
          label: "Remote devbox",
          environmentId: "environment-remote",
          presentationKind: "ssh",
        },
      ],
      llmRoutes: [
        {
          id: "route-1",
          label: "Codex work",
          providerInstanceId: "codex_work",
        },
      ],
      workerProfiles: [
        {
          id: "worker-1",
          name: "Completion",
          computerId: "computer-1",
          harness: "codex-cli",
          llmRouteId: "route-1",
          modelId: "gpt-5.6-sol",
          reasoning: "high",
        },
      ],
    });

    expect(decoded.computers[0]?.harnesses).toEqual([]);
    expect(decoded.workerProfiles[0]?.capabilityIds).toEqual([]);
  });
});

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
