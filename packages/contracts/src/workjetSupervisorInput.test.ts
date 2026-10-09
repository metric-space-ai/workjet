import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import {
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResponse,
  isWorkjetSupervisorReceiptForRequest,
} from "./ctox.ts";
import { WorkjetSupervisorJournal } from "./workjetSupervisor.ts";
import { DEFAULT_WORKJET_THREAD_CONFIG, normalizeWorkjetThreadConfig } from "./workjet.ts";
import { retainWorkjetCtoxBinding } from "./workjetCtoxBinding.ts";
const projectId = ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7");
const threadId = "e28290b0-7b0a-4d19-a242-f27041fadb84";
const binding = {
  contract: "ctox.workjet.supervisor_binding.v1",
  projectId,
  threadId,
  threadKey: `business-os/threads/${threadId}`,
} as const;
const turn = {
  commandId: "native-command",
  taskId: "native-task",
  threadId,
  threadKey: binding.threadKey,
  executionPhase: "running",
  status: "accepted",
  queueStatus: "retry_wait",
  attempt: 4,
  terminal: false,
  result: null,
  resultTruncated: false,
  errorCode: null,
  errorMessage: null,
} as const;
const request = {
  action: "project.supervisor.turn.input",
  commandId: CommandId.make("saved-input"),
  projectId,
  threadId,
  targetCommandId: turn.commandId,
  body: "Checked PR source.",
} as const;
const response = {
  action: request.action,
  commandId: request.commandId,
  projectId,
  contract: "ctox.workjet.supervisor_input.v1",
  binding,
  turn,
  input: {
    inputId: "native-input",
    sequence: 1,
    body: request.body,
    createdAt: "2026-10-09T19:00:00.000Z",
  },
  delivery: "next_slice",
  workerInterrupted: false,
} as const;
const input = {
  intent: {
    instanceId: "managed:acceptance",
    projectId,
    threadId,
    commandId: request.commandId,
    targetCommandId: request.targetCommandId,
    body: request.body,
    createdAt: response.input.createdAt,
  },
  receipt: response,
  submission: "confirmed",
} as const;
const saved = {
  intent: {
    instanceId: input.intent.instanceId,
    projectId,
    threadId,
    commandId: CommandId.make("original-submit"),
    goal: "Review the PR.",
    createdAt: input.intent.createdAt,
  },
  turn,
  inputs: [input],
  submission: "confirmed",
} as const;

describe("same-task Owner input contract", () => {
  it("uses one stable wire command ID and accepts only a correlated next-slice receipt", () => {
    const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, {
      onExcessProperty: "error",
    });
    expect(decode(request)).toEqual(request);
    expect(() => decode({ ...request, operationId: "second-identity" })).toThrow();
    const decodeResponse = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
      onExcessProperty: "error",
    });
    expect(decodeResponse(response)).toEqual(response);
    expect(() => decodeResponse({ ...response, workerInterrupted: true })).toThrow();
    expect(() => decodeResponse({ ...response, delivery: "immediate" })).toThrow();
    expect(isWorkjetSupervisorReceiptForRequest(request, response)).toBe(true);
    expect(isWorkjetSupervisorReceiptForRequest({ ...request, body: "different" }, response)).toBe(
      false,
    );
    expect(
      isWorkjetSupervisorReceiptForRequest({ ...request, targetCommandId: "different" }, response),
    ).toBe(false);
  });

  it("keeps the default capability response unchanged and rejects partial input support", () => {
    const base = {
      action: "project.supervisor.turn.capabilities",
      commandId: CommandId.make("cap"),
      projectId,
      contract: "ctox.workjet.supervisor_turn_capabilities.v1",
      binding,
      turnKinds: ["work", "conversation"],
      defaultTurnKind: "work",
    } as const;
    const capabilityRequest = {
      action: base.action,
      commandId: base.commandId,
      projectId,
      threadId,
    };
    const optIn = {
      ...base,
      inputContract: "ctox.workjet.supervisor_input.v1",
      inputDelivery: "next_slice",
      maxInputChars: 4096,
    } as const;
    const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
      onExcessProperty: "error",
    });
    expect(decode(base)).toEqual(base);
    expect(decode(optIn)).toEqual(optIn);
    expect(() => decode({ ...base, inputContract: optIn.inputContract })).toThrow();
    expect(isWorkjetSupervisorReceiptForRequest(capabilityRequest, base)).toBe(true);
    expect(isWorkjetSupervisorReceiptForRequest(capabilityRequest, optIn)).toBe(false);
    expect(
      isWorkjetSupervisorReceiptForRequest({ ...capabilityRequest, includeInput: true }, base),
    ).toBe(false);
    expect(
      isWorkjetSupervisorReceiptForRequest({ ...capabilityRequest, includeInput: true }, optIn),
    ).toBe(true);
  });

  it("refuses a journal from another task or a duplicate input identity", () => {
    const decode = Schema.decodeUnknownSync(WorkjetSupervisorJournal, {
      onExcessProperty: "error",
    });
    expect(decode(saved)).toEqual(saved);
    expect(() => decode({ ...saved, inputs: [input, input] })).toThrow();
    expect(() =>
      decode({
        ...saved,
        inputs: [{ ...input, intent: { ...input.intent, targetCommandId: "foreign" } }],
      }),
    ).toThrow();
  });

  it("cannot erase, alter or downgrade an admitted input through thread configuration", () => {
    const config = {
      ...normalizeWorkjetThreadConfig(DEFAULT_WORKJET_THREAD_CONFIG),
      ctoxSupervisorTurn: saved,
    };
    for (const inputs of [
      [],
      [{ ...input, receipt: null, submission: "awaiting-receipt" as const }],
    ])
      expect(
        retainWorkjetCtoxBinding(config, { ...config, ctoxSupervisorTurn: { ...saved, inputs } })
          .error,
      ).not.toBeNull();
  });
});
