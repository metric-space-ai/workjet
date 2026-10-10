// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off -- Correlate actual SDK hooks with the original native controller.
import * as NodeCrypto from "node:crypto";
import { createSdkMcpServer, tool, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";
import * as z from "zod";
import type { NativeSupervisorSourceTransport } from "./NativeSupervisorSourceTransport.ts";

const WORKER_NAME = "mcp__workjet_native__worker_dispatch";
const GOAL_NAME = "mcp__workjet_native__confirmed_goal_read";
const NONCE = "_workjet_sdk_call";
type NativeTool = "worker_dispatch" | "confirmed_goal_read";
const Id = Schema.String.check(Schema.isPattern(/^[!-~]{1,256}$/));
const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
const Arguments = Schema.Struct({
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384)),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  computer_id: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  worker_profile_id: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
const HookArguments = Schema.Struct({ ...Arguments.fields, [NONCE]: Schema.optional(Uuid) });
const GoalHookArguments = Schema.Struct({ [NONCE]: Schema.optional(Uuid) });
const ToolReply = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literal("tool_result"),
  operation_id: Uuid,
  native_tool: Schema.Literals(["worker_dispatch", "confirmed_goal_read"]),
  result: Schema.Unknown,
  execution_ready: Schema.Literal(false),
});
const decodeArguments = Schema.decodeUnknownPromise(HookArguments, { onExcessProperty: "error" });
const decodeGoalArguments = Schema.decodeUnknownPromise(GoalHookArguments, {
  onExcessProperty: "error",
});
const decodeId = Schema.decodeUnknownSync(Id);
const decodeBinding = Schema.decodeUnknownSync(
  Schema.Struct({ offerId: Uuid, controllerId: Uuid }),
);
const decodeReply = Schema.decodeUnknownPromise(ToolReply, { onExcessProperty: "error" });

/** One original SDK/controller tool bridge. Only real SDK PreToolUse callbacks
 * register calls; neither MCP extra metadata nor a model-selected nonce does.
 * Native rechecks the original peer, lease, project, role and physical consumer. */
export function createNativeSupervisorSdkTools(options: {
  readonly offerId: string;
  readonly controllerId: string;
  readonly transport: Pick<NativeSupervisorSourceTransport, "request">;
  readonly currentSdkSessionId: () => string | undefined;
  /** True only when this original native claim advertised the fixed reader. */
  readonly includeConfirmedGoalRead?: boolean;
}) {
  decodeBinding(options);
  const request = options.transport.request.bind(options.transport);
  const calls = new Map<
    string,
    {
      readonly nativeTool: NativeTool;
      readonly nonce: string;
      readonly operationId: string;
      readonly argumentsJson: string;
      response?: Promise<Awaited<ReturnType<typeof decodeReply>>>;
    }
  >();
  let fault: Error | undefined;
  let retired = false;
  let resolveFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => {
    resolveFailure = resolve;
  });
  const fail = () => {
    if (!fault) {
      fault = new Error("Original native Supervisor tool is unavailable; outcome may be unknown.");
      resolveFailure(fault);
    }
    return fault;
  };
  const deny = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: "This Supervisor can use only its original admitted native tools.",
    },
  };
  const beforeTool: HookCallback = async (input) => {
    if (
      input.hook_event_name !== "PreToolUse" ||
      input.agent_id !== undefined ||
      fault ||
      retired ||
      !options.currentSdkSessionId() ||
      input.session_id !== options.currentSdkSessionId()
    )
      return deny;
    const nativeTool: NativeTool | undefined =
      input.tool_name === WORKER_NAME
        ? "worker_dispatch"
        : input.tool_name === GOAL_NAME && options.includeConfirmedGoalRead === true
          ? "confirmed_goal_read"
          : undefined;
    if (nativeTool === undefined) return deny;
    try {
      decodeId(input.tool_use_id);
      const args = await (nativeTool === "worker_dispatch" ? decodeArguments : decodeGoalArguments)(
        input.tool_input,
      );
      const { [NONCE]: suppliedNonce, ...nativeArgs } = args;
      const json = JSON.stringify(nativeArgs);
      if (Buffer.byteLength(json) > 65536) return deny;
      const previous = calls.get(input.tool_use_id);
      if (previous) {
        if (
          previous.nativeTool !== nativeTool ||
          previous.argumentsJson !== json ||
          (suppliedNonce !== undefined && suppliedNonce !== previous.nonce)
        )
          return deny;
      } else {
        if (suppliedNonce !== undefined || calls.size >= 32) return deny;
        calls.set(input.tool_use_id, {
          nativeTool,
          nonce: NodeCrypto.randomUUID(),
          operationId: NodeCrypto.randomUUID(),
          argumentsJson: json,
        });
      }
      const captured = calls.get(input.tool_use_id)!;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...nativeArgs, [NONCE]: captured.nonce },
        },
      };
    } catch {
      return deny;
    }
  };
  const execute = async (nativeTool: NativeTool, input: Readonly<Record<string, unknown>>) => {
    const unavailable = {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "Original native Supervisor tool is unavailable. No replacement operation was attempted.",
        },
      ],
    };
    if (fault || retired || !options.currentSdkSessionId()) return unavailable;
    const { [NONCE]: nonce, ...args } = input;
    const captured = [...calls.values()].find((call) => call.nonce === nonce);
    if (
      !captured ||
      captured.nativeTool !== nativeTool ||
      captured.argumentsJson !== JSON.stringify(args)
    )
      return unavailable;
    captured.response ??= (async () => {
      const reply = await decodeReply(
        await request(NodeCrypto.randomUUID(), {
          version: 1,
          action: "tool_call",
          offer_id: options.offerId,
          controller_id: options.controllerId,
          operation_id: captured.operationId,
          native_tool: captured.nativeTool,
          tool_arguments_json: captured.argumentsJson,
        }),
      );
      if (
        reply.operation_id !== captured.operationId ||
        reply.native_tool !== captured.nativeTool ||
        Buffer.byteLength(JSON.stringify(reply.result)) > 65536
      )
        throw fail();
      return reply;
    })();
    try {
      const reply = await captured.response;
      return { content: [{ type: "text" as const, text: JSON.stringify(reply.result) }] };
    } catch {
      fail();
      return unavailable;
    }
  };
  const worker = tool(
    "worker_dispatch",
    "Request one owned worker through the registered project Source. Startup is not completed work.",
    {
      task: z.string().min(1).max(16384),
      title: z.string().max(200).optional(),
      computer_id: z.string().max(256).optional(),
      worker_profile_id: z.string().max(256).optional(),
      [NONCE]: z.string().uuid().optional(),
    },
    (input) => execute("worker_dispatch", input),
    { alwaysLoad: true },
  );
  const goal =
    options.includeConfirmedGoalRead === true
      ? tool(
          "confirmed_goal_read",
          "Read the Owner-confirmed project goal and saved Core step progress. Partial results are not completed work.",
          { [NONCE]: z.string().uuid().optional() },
          (input) => execute("confirmed_goal_read", input),
          { alwaysLoad: true },
        )
      : undefined;
  const admitted = goal === undefined ? [worker] : [worker, goal];
  const instructions =
    options.includeConfirmedGoalRead === true
      ? "Use mcp__workjet_native__confirmed_goal_read with empty arguments before acting to read the Owner-confirmed project goal and actual saved Core step progress. A null confirmed_goal means no goal is confirmed; do not invent one. Partial results are not completed work. Request workers through mcp__workjet_native__worker_dispatch."
      : "The available native tool is mcp__workjet_native__worker_dispatch.";
  const server = createSdkMcpServer({
    name: "workjet_native",
    version: "1.0.0",
    tools: admitted,
    alwaysLoad: true,
    instructions,
  });
  return {
    server,
    instructions,
    beforeTool,
    failure,
    async close() {
      retired = true;
      await Promise.allSettled(
        [...calls.values()].flatMap((call) => (call.response ? [call.response] : [])),
      );
      await server.instance.close();
      if (fault) throw fault;
    },
  };
}
