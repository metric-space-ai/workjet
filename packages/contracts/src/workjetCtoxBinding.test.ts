import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  normalizeWorkjetThreadConfig,
  WorkjetConnectionId,
} from "./workjet.ts";
import { retainWorkjetCtoxBinding } from "./workjetCtoxBinding.ts";
import { WorkjetCtoxBusinessOsInput } from "./workjetCtoxBusinessOs.ts";

const original = {
  ...normalizeWorkjetThreadConfig(DEFAULT_WORKJET_THREAD_CONFIG),
  enabledCapabilityIds: ["ctox-business-os"] as const,
  capabilityBindings: [
    {
      capabilityId: "ctox-business-os" as const,
      target: {
        kind: "ctox-connection" as const,
        connectionId: WorkjetConnectionId.make("connection-a"),
        instanceId: "instance-a",
      },
    },
  ],
};

describe("CTOX thread identity and typed app access", () => {
  const tenant = "322084e5-8239-48d7-b3c5-c5178fbe5822";
  const oldId = WorkjetConnectionId.make(
    `ctox-dev-worker-source:${tenant}:c1728006-7dcd-4c64-a0b7-e800251eb9a1`,
  );
  const newId = WorkjetConnectionId.make(
    `ctox-dev-worker-source:${tenant}:41e130aa-2b02-46fe-953d-37e74a97f05a`,
  );
  const sourceConfig = (connectionId: WorkjetConnectionId, instanceId = "welsch.ctox.dev") => ({
    ...original,
    capabilityBindings: [
      {
        ...original.capabilityBindings[0]!,
        target: { kind: "ctox-connection" as const, connectionId, instanceId },
      },
    ],
  });

  it("allows credential rotation within the original worker-source tenant and instance", () => {
    expect(retainWorkjetCtoxBinding(sourceConfig(oldId), sourceConfig(newId)).error).toBeNull();
  });

  it("rejects another tenant, instance, malformed grant, local connection and duplicate binding", () => {
    const before = sourceConfig(oldId);
    for (const next of [
      sourceConfig(
        WorkjetConnectionId.make(newId.replace(tenant, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
      ),
      sourceConfig(newId, "foreign.ctox.dev"),
      sourceConfig(WorkjetConnectionId.make(`ctox-dev-worker-source:${tenant}:invalid`)),
      sourceConfig(WorkjetConnectionId.make("local-ctox")),
      {
        ...sourceConfig(newId),
        capabilityBindings: [
          ...before.capabilityBindings,
          ...sourceConfig(newId).capabilityBindings,
        ],
      },
    ])
      expect(retainWorkjetCtoxBinding(before, next).error).not.toBeNull();
    expect(
      retainWorkjetCtoxBinding(sourceConfig(WorkjetConnectionId.make("local-ctox")), before).error,
    ).not.toBeNull();
  });

  it("rotates private Crew credentials while retaining chat and instance identity", () => {
    const before = {
      ...sourceConfig(oldId),
      ctoxCrewChat: { connectionId: oldId, instanceId: "welsch.ctox.dev", chatId: "private-chat" },
    };
    const next = {
      ...sourceConfig(newId),
      ctoxCrewChat: { ...before.ctoxCrewChat, connectionId: newId },
    };
    expect(retainWorkjetCtoxBinding(before, next).error).toBeNull();
    for (const connectionId of [
      WorkjetConnectionId.make("local-ctox"),
      WorkjetConnectionId.make(newId.replace(tenant, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
    ])
      expect(
        retainWorkjetCtoxBinding(before, {
          ...next,
          ctoxCrewChat: { ...next.ctoxCrewChat, connectionId },
        }).error,
      ).not.toBeNull();
    expect(
      retainWorkjetCtoxBinding(before, {
        ...next,
        ctoxCrewChat: { ...next.ctoxCrewChat, chatId: "another-chat" },
      }).error,
    ).not.toBeNull();
    expect(
      retainWorkjetCtoxBinding(before, {
        ...next,
        ctoxCrewChat: { ...next.ctoxCrewChat, instanceId: "another-instance" },
      }).error,
    ).not.toBeNull();
  });

  it("retains identity when tools are disabled and rejects retargeting after reenabling", () => {
    const disabled = retainWorkjetCtoxBinding(original, {
      ...original,
      enabledCapabilityIds: [],
      capabilityBindings: [],
    });
    expect(disabled.error).toBeNull();
    expect(normalizeWorkjetThreadConfig(disabled.config).capabilityBindings).toEqual(
      original.capabilityBindings,
    );
    const different = {
      ...original,
      capabilityBindings: [
        {
          ...original.capabilityBindings[0]!,
          target: {
            kind: "ctox-connection" as const,
            connectionId: WorkjetConnectionId.make("connection-b"),
            instanceId: "instance-b",
          },
        },
      ],
    };
    expect(retainWorkjetCtoxBinding(disabled.config, different).error).not.toBeNull();
    expect(retainWorkjetCtoxBinding(disabled.config, original).error).toBeNull();
  });

  it("rejects a tool binding outside the registered CTOX session", () => {
    const session = {
      ...original,
      ctoxSession: { instanceId: "instance-b", sessionId: "session-b", fenceEpoch: 1 },
    };
    expect(retainWorkjetCtoxBinding(DEFAULT_WORKJET_THREAD_CONFIG, session).error).not.toBeNull();
  });

  it("requires bounded portable retry keys for native delegation", () => {
    const decode = Schema.decodeUnknownSync(WorkjetCtoxBusinessOsInput, {
      onExcessProperty: "error",
    });
    for (const operation of ["create_app", "modify_app", "delegate_task"]) {
      const request = {
        operation,
        module_id: "app-a",
        ...(operation === "delegate_task"
          ? { title: "Review", objective: "Review inventory" }
          : { instruction: "Update the app" }),
      };
      expect(() => decode({ request })).toThrow();
      expect(
        decode({ request: { ...request, idempotency_key: "workjet:thread-1.turn-2" } }).request,
      ).toMatchObject({ idempotency_key: "workjet:thread-1.turn-2" });
      for (const idempotency_key of ["", "a b", "a\nb", "é", "a".repeat(257)]) {
        expect(() => decode({ request: { ...request, idempotency_key } })).toThrow();
      }
    }
    expect(() =>
      decode({
        request: {
          operation: "write_app_file",
          module_id: "app-a",
          path: "index.js",
          content: "",
          idempotency_key: "key",
        },
      }),
    ).toThrow();
  });

  it("allows typed source editing and skill retrieval while rejecting routing and identity overrides", () => {
    const decode = Schema.decodeUnknownSync(WorkjetCtoxBusinessOsInput, {
      onExcessProperty: "error",
    });
    expect(
      decode({
        request: {
          operation: "write_app_file",
          module_id: "app-a",
          path: "index.js",
          content: "export {};",
        },
      }).request.operation,
    ).toBe("write_app_file");
    expect(
      decode({
        request: {
          operation: "read_app_skill_resource",
          resource: "references/shell-v2-contract.md",
        },
      }).request.operation,
    ).toBe("read_app_skill_resource");
    for (const request of [
      { operation: "run_shell", command: "whoami" },
      {
        operation: "delegate_task",
        module_id: "app-a",
        title: "Review",
        objective: "Review inventory",
        idempotency_key: "key",
        action_id: "external_sql.write",
      },
      {
        operation: "delegate_task",
        module_id: "app-a",
        title: "Review",
        objective: "Review inventory",
        idempotency_key: "key",
        _context: { role: "chef" },
      },
      { operation: "get_module", module_id: "app-a", endpoint: "https://other.example/mcp" },
      { operation: "get_module", module_id: "app-a", _context: { role: "chef" } },
      { operation: "write_app_file", module_id: "app-a", path: "index.js" },
    ])
      expect(() => decode({ request })).toThrow();
  });
});
