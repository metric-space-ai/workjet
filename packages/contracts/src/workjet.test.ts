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
  activeWorkjetWorkerPersonaPrompt,
  compileWorkjetWorkerPersonaPrompt,
  composeWorkjetWorkerManagedInstructions,
  createDefaultWorkjetWorkerPersonalization,
  GreppyRuntimeSnapshot,
  WorkjetConfiguration,
  WORKJET_GATEWAY_API_KEY_MAX_LENGTH,
  WorkjetGatewayAddApiKeyAccountInput,
  WorkjetGatewayAddApiKeyAccountResult,
  WorkjetGatewayCatalog,
  WorkjetGatewayOauthStartInput,
  WorkjetGatewayOperationError,
  WorkjetGatewayStatus,
  WorkjetGreppyOperationError,
  WorkjetLlmRouteId,
  WorkjetThreadConfig,
  WorkjetWorkerProfileId,
  migrateWorkjetLlmRouteV1ToV2,
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
  it("builds the complete six-by-three persona prompt and dispatches it only when enabled", () => {
    const personalization = createDefaultWorkjetWorkerPersonalization();
    expect(personalization.groups).toHaveLength(6);
    expect(personalization.groups.flatMap((group) => group.details)).toHaveLength(18);
    expect(personalization.metaToDetailWeights).toHaveLength(18);
    expect(personalization.detailInfluenceWeights).toHaveLength(18);

    const localizedPersonalization = {
      ...personalization,
      groups: personalization.groups.map((group, groupIndex) =>
        groupIndex === 0
          ? {
              ...group,
              title: "Rahmen & Alltag",
              meta: {
                ...group.meta,
                left: "Konstanter, verlässlicher Rahmen",
                right: "Gestaltbarer, beweglicher Spielraum",
              },
              details: group.details.map((detail, detailIndex) =>
                detailIndex === 0
                  ? {
                      ...detail,
                      left: "Fester, gut planbarer Alltag",
                      right: "Situativ anpassbarer Alltag",
                    }
                  : detail,
              ),
            }
          : group,
      ),
    };
    const worker = {
      name: "Research partner",
      instructions: "Check evidence before recommending a decision.",
      personalization: localizedPersonalization,
    };
    const leadId = WorkjetWorkerProfileId.make("worker-lead");
    const workerId = WorkjetWorkerProfileId.make("worker-research");
    const readable = compileWorkjetWorkerPersonaPrompt(worker, {
      currentWorkerId: workerId,
      workers: [
        { id: leadId, name: "Research lead", role: "orchestrator" },
        { id: workerId, name: worker.name, role: "standard" },
      ],
      graph: {
        positions: [],
        dependencies: [{ fromWorkerId: leadId, toWorkerId: workerId }],
      },
    });
    const json = JSON.parse(readable.slice(readable.indexOf("{"))) as {
      readonly personalization: {
        readonly enabled: boolean;
        readonly groups: ReadonlyArray<{
          readonly meta: unknown;
          readonly details: unknown[];
        }>;
      };
    };
    expect(json.personalization.enabled).toBe(false);
    expect(json.personalization.groups).toHaveLength(6);
    expect(json.personalization.groups.flatMap((group) => group.details)).toHaveLength(18);
    expect(readable).toContain("Your name is Research partner.");
    expect(readable).toContain('worker_1["Research partner (you)<br/>standard"]');
    expect(readable).toContain("worker_0 --> worker_1");
    expect(readable).toContain("Detail axes define the concrete behavior");
    expect(readable).toContain('"title": "Framework & Daily Work"');
    expect(readable).toContain('"left": "Stable, reliable framework"');
    expect(readable).toContain('"left": "Structured, predictable routine"');
    expect(readable).not.toContain("Rahmen & Alltag");
    expect(readable).not.toContain("Fester, gut planbarer Alltag");
    expect(activeWorkjetWorkerPersonaPrompt(worker)).toBe("");
    expect(
      activeWorkjetWorkerPersonaPrompt({
        ...worker,
        personalization: { ...personalization, enabled: true },
      }),
    ).toContain('"enabled": true');
    const composed = composeWorkjetWorkerManagedInstructions(
      { ...worker, personalization: { ...personalization, enabled: true } },
      "Model rule",
    );
    expect(composed.indexOf("Model rule")).toBeLessThan(
      composed.indexOf("Your name is Research partner."),
    );
    expect(composed.indexOf("Your name is Research partner.")).toBeLessThan(
      composed.lastIndexOf("Check evidence"),
    );
    expect(composed.match(/Check evidence/g)).toHaveLength(1);
  });

  it("decodes missing legacy catalog data to a valid empty configuration", () => {
    expect(Schema.decodeUnknownSync(WorkjetConfiguration)({})).toEqual(
      DEFAULT_WORKJET_CONFIGURATION,
    );
    expect(DEFAULT_WORKJET_CONFIGURATION).toEqual({
      schemaVersion: 4,
      computers: [],
      llmRoutes: [],
      modelPrompts: [],
      workerProfiles: [],
      workerGraph: { positions: [], dependencies: [] },
      managedSystemPrompt: "",
      managerThreadReference: "",
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
      schemaVersion: 3,
      llmRoutes: [
        {
          id: "route-main",
          label: "Main account",
          gatewayAccountId: "account-codex-personal",
          modelId: "must-not-persist-here",
          apiKey: "must-not-persist-here",
        },
      ],
    });

    expect(decoded.llmRoutes).toEqual([
      {
        id: "route-main",
        label: "Main account",
        gatewayAccountId: "account-codex-personal",
      },
    ]);
    expect(JSON.stringify(decoded.llmRoutes)).not.toContain("must-not-persist-here");
  });

  it("normalizes and re-encodes a v2 configuration as v4", () => {
    const encodedInput = {
      schemaVersion: 2,
      computers: [],
      llmRoutes: [
        {
          id: "route-main",
          label: "Main account",
          gatewayAccountId: "account-codex-personal",
        },
      ],
      workerProfiles: [],
      modelPrompts: [],
      managedSystemPrompt: "",
      managerThreadReference: "",
      telemetry: { claudeCodeEvents: true, sidecarEvents: true, retentionDays: 14 },
      execution: { probeTimeoutSeconds: 120, turnTimeoutSeconds: 5_400, degradationAllowed: true },
    };

    const decoded = Schema.decodeUnknownSync(WorkjetConfiguration)(encodedInput);
    expect(Schema.encodeUnknownSync(WorkjetConfiguration)(decoded)).toEqual({
      ...encodedInput,
      schemaVersion: 4,
      workerGraph: { positions: [], dependencies: [] },
    });
  });

  it("persists the provider-neutral Workjet Manager thread reference", () => {
    const managerThreadReference = "workjet://app/threads/ctox-main/workjet-manager";
    const decoded = Schema.decodeUnknownSync(WorkjetConfiguration)({ managerThreadReference });
    expect(decoded.managerThreadReference).toBe(managerThreadReference);
    expect(Schema.encodeUnknownSync(WorkjetConfiguration)(decoded)).toMatchObject({
      managerThreadReference,
    });
  });
});

describe("Workjet configuration migration step 2 (LLM route reference retype)", () => {
  it("maps a v1 route providerInstanceId to a v2 gatewayAccountId verbatim", () => {
    expect(
      migrateWorkjetLlmRouteV1ToV2({
        id: WorkjetLlmRouteId.make("route-main"),
        label: "Main account",
        providerInstanceId: "account-codex-personal",
      }),
    ).toEqual({
      id: "route-main",
      label: "Main account",
      gatewayAccountId: "account-codex-personal",
    });
  });

  it("upgrades a persisted v1 configuration to v2 while carrying route ids over", () => {
    const decoded = Schema.decodeUnknownSync(WorkjetConfiguration)({
      schemaVersion: 1,
      llmRoutes: [
        { id: "route-main", label: "Main account", providerInstanceId: "account-codex-personal" },
        { id: "route-legacy", label: "Legacy driver", providerInstanceId: "codex_personal" },
      ],
    });

    expect(decoded.schemaVersion).toBe(4);
    expect(decoded.llmRoutes).toEqual([
      { id: "route-main", label: "Main account", gatewayAccountId: "account-codex-personal" },
      // A genuinely historical driver-instance id migrates as-is and simply
      // will not resolve against the gateway catalog. That is accepted.
      { id: "route-legacy", label: "Legacy driver", gatewayAccountId: "codex_personal" },
    ]);
  });

  it("re-encodes a migrated configuration in the v2 shape only", () => {
    const decoded = Schema.decodeUnknownSync(WorkjetConfiguration)({
      schemaVersion: 1,
      llmRoutes: [
        { id: "route-main", label: "Main account", providerInstanceId: "account-codex-personal" },
      ],
    });
    const encoded = Schema.encodeUnknownSync(WorkjetConfiguration)(decoded) as {
      readonly schemaVersion: number;
      readonly llmRoutes: ReadonlyArray<Record<string, unknown>>;
    };

    expect(encoded.schemaVersion).toBe(4);
    expect(encoded.llmRoutes[0]).toEqual({
      id: "route-main",
      label: "Main account",
      gatewayAccountId: "account-codex-personal",
    });
    expect(JSON.stringify(encoded)).not.toContain("providerInstanceId");
  });

  it("accepts an id that no gateway account resolves without failing the whole document", () => {
    const decoded = Schema.decodeUnknownSync(WorkjetConfiguration)({
      schemaVersion: 1,
      llmRoutes: [{ id: "route-x", label: "Unresolvable", providerInstanceId: "1-not-a-slug" }],
    });

    expect(decoded.llmRoutes[0]?.gatewayAccountId).toBe("1-not-a-slug");
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
          gatewayAccountId: "account-codex-work",
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

describe("WorkjetGateway API-key providers", () => {
  it("round-trips every API-key provider through the account summary", () => {
    for (const provider of ["zai", "minimax", "xai", "kimi"] as const) {
      const catalog = Schema.decodeUnknownSync(WorkjetGatewayCatalog)({
        schemaVersion: 1,
        accounts: [
          {
            id: `account-${provider}`,
            label: `${provider} key`,
            provider,
            enabled: true,
            priority: 0,
            weight: 1,
            modelIds: [],
            credentialSuffix: "9xyz",
          },
        ],
        pools: [],
        routes: [],
        models: [],
      });
      expect(catalog.accounts[0]?.provider).toBe(provider);
      expect(catalog.accounts[0]?.credentialSuffix).toBe("9xyz");
    }
  });

  it("defaults credentialSuffix to null so an OAuth account carries nothing", () => {
    const catalog = Schema.decodeUnknownSync(WorkjetGatewayCatalog)({
      schemaVersion: 1,
      accounts: [
        {
          id: "account-1",
          label: "Primary",
          provider: "codex",
          enabled: true,
          priority: 0,
          weight: 1,
          modelIds: [],
        },
      ],
      pools: [],
      routes: [],
      models: [],
    });
    expect(catalog.accounts[0]?.credentialSuffix).toBeNull();
  });

  it("accepts a bounded key on the add input and rejects anything outside the bound", () => {
    const accepted = Schema.decodeUnknownSync(WorkjetGatewayAddApiKeyAccountInput)({
      provider: "zai",
      label: "Z.ai key",
      // Obviously fake.
      apiKey: "zk-test-not-a-real-key",
    });
    expect(accepted.provider).toBe("zai");
    expect(WORKJET_GATEWAY_API_KEY_MAX_LENGTH).toBe(512);
    for (const invalid of [
      { provider: "openrouter", label: "x", apiKey: "k" },
      { provider: "zai", label: "x", apiKey: "" },
      { provider: "zai", label: "x", apiKey: "k".repeat(513) },
      { provider: "zai", label: "", apiKey: "k" },
      // An OAuth provider can never be added with a key.
      { provider: "claude", label: "x", apiKey: "k" },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(WorkjetGatewayAddApiKeyAccountInput)(invalid),
      ).toThrow();
    }
  });

  it("keeps the OAuth start input restricted to providers that have a login", () => {
    expect(
      Schema.decodeUnknownSync(WorkjetGatewayOauthStartInput)({ provider: "claude" }).provider,
    ).toBe("claude");
    // xAI joined the login-capable providers with the Grok device flow; it is
    // deliberately BOTH an OAuth provider and an API-key provider.
    expect(
      Schema.decodeUnknownSync(WorkjetGatewayOauthStartInput)({ provider: "xai" }).provider,
    ).toBe("xai");
    for (const provider of ["zai", "minimax", "kimi"]) {
      expect(() => Schema.decodeUnknownSync(WorkjetGatewayOauthStartInput)({ provider })).toThrow();
    }
  });

  it("returns only the account identity from the add result", () => {
    const result = Schema.decodeUnknownSync(WorkjetGatewayAddApiKeyAccountResult)({
      schemaVersion: 1,
      accountId: "zai-primary",
      apiKey: "must-not-escape",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });
});
