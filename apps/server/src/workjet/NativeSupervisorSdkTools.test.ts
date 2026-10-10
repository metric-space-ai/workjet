// @effect-diagnostics nodeBuiltinImport:off -- Isolated SDK hook fixtures, never native execution authority.
import * as Crypto from "node:crypto";
import { tool, type HookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createNativeSupervisorSdkTools } from "./NativeSupervisorSdkTools.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (actual) => {
  const sdk = await actual<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...sdk, tool: vi.fn(sdk.tool) };
});
const owned: Array<ReturnType<typeof createNativeSupervisorSdkTools>> = [];
afterEach(async () => {
  await Promise.allSettled(owned.splice(0).map((bridge) => bridge.close()));
  vi.clearAllMocks();
});
function fixture(request?: (id: string, operation: Record<string, unknown>) => Promise<unknown>) {
  const offerId = Crypto.randomUUID();
  const controllerId = Crypto.randomUUID();
  const calls: Record<string, unknown>[] = [];
  const transport = { request: vi.fn(request ?? (async (_id, operation) => {
    calls.push(operation);
    return { version: 1, state: "tool_result", operation_id: operation.operation_id,
      native_tool: "worker_dispatch", result: { intent: { intentId: "fixture-intent" } },
      execution_ready: false };
  })) };
  const bridge = createNativeSupervisorSdkTools({
    offerId, controllerId, transport, currentSdkSessionId: () => "fixture-sdk-session",
  });
  owned.push(bridge);
  const handler = vi.mocked(tool).mock.calls.at(-1)?.[3];
  if (!handler) throw new Error("SDK tool was not registered.");
  const hook = (change: Partial<HookInput> = {}) => ({
    hook_event_name: "PreToolUse" as const, session_id: "fixture-sdk-session",
    cwd: "/isolated-fixture", transcript_path: "/isolated-fixture/transcript",
    tool_name: "mcp__workjet_native__worker_dispatch", tool_use_id: "fixture-tool-use",
    tool_input: { task: "Perform the bounded fixture task" }, ...change,
  });
  const before = (input: HookInput) =>
    bridge.beforeTool(input, undefined, { signal: AbortSignal.timeout(1000) });
  return { bridge, handler, before, hook, transport, calls, offerId, controllerId };
}
it.each([
  { tool_name: "Bash" }, { tool_name: "Read" }, { tool_name: "mcp__other__worker_dispatch" },
  { session_id: "foreign-session" }, { agent_id: "subagent" },
])("denies tools outside the actual parent session: %o", async (change) => {
  const { before, hook, transport } = fixture();
  expect(await before(hook(change))).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
  expect(transport.request).not.toHaveBeenCalled();
});
it("does not trust a model nonce or an MCP call without the actual SDK hook", async () => {
  const { handler, before, hook, transport } = fixture();
  expect(await handler({ task: "Perform the bounded fixture task" }, {})).toMatchObject({ isError: true });
  expect(await before(hook({ tool_input: { task: "fixture", _workjet_sdk_call: Crypto.randomUUID() } })))
    .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(transport.request).not.toHaveBeenCalled();
});
it("joins the actual hook to one immutable original operation and deduplicates SDK re-entry", async () => {
  const { handler, before, hook, transport, offerId, controllerId } = fixture();
  const input = hook();
  const allowed = await before(input);
  const updated = "hookSpecificOutput" in allowed && allowed.hookSpecificOutput?.hookEventName === "PreToolUse"
    ? allowed.hookSpecificOutput.updatedInput : undefined;
  expect(updated).toBeDefined();
  const first = await handler(updated!, {});
  expect(first).toMatchObject({ content: [{ type: "text" }] });
  await handler(updated!, { toolUseID: "untrusted-extra" });
  const again = await before({ ...input, tool_input: updated });
  expect(again).toEqual(allowed);
  expect(transport.request).toHaveBeenCalledTimes(1);
  const operation = transport.request.mock.calls[0]?.[1];
  expect(operation).toMatchObject({ offer_id: offerId, controller_id: controllerId,
    native_tool: "worker_dispatch", execution_ready: undefined });
  expect(JSON.parse(String(operation?.tool_arguments_json))).toEqual(input.tool_input);
  expect(await before({ ...input, tool_input: { task: "Changed task" } }))
    .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
});
it.each(["eof", "wrong-operation", "execution-ready", "extra-field"])(
  "retires the same controller tool on %s without a replacement dispatch", async (mode) => {
    const { handler, before, hook, transport, bridge } = fixture(async (_id, operation) => {
      if (mode === "eof") throw new Error("isolated post-write EOF fixture");
      return { version: 1, state: "tool_result",
        operation_id: mode === "wrong-operation" ? Crypto.randomUUID() : operation.operation_id,
        native_tool: "worker_dispatch", result: {},
        execution_ready: mode === "execution-ready",
        ...(mode === "extra-field" ? { authority: true } : {}) };
    });
    const allowed = await before(hook());
    const updated = "hookSpecificOutput" in allowed && allowed.hookSpecificOutput?.hookEventName === "PreToolUse"
      ? allowed.hookSpecificOutput.updatedInput : undefined;
    expect(await handler(updated!, {})).toMatchObject({ isError: true });
    expect(await bridge.failure).toBeInstanceOf(Error);
    expect(await handler(updated!, {})).toMatchObject({ isError: true });
    expect(transport.request).toHaveBeenCalledTimes(1);
  },
);
it("rejects actor/root fields and limits one controller to 32 actual calls", async () => {
  const { before, hook } = fixture();
  expect(await before(hook({ tool_input: { task: "fixture", actor: "owner" } })))
    .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  for (let index = 0; index < 32; index++)
    expect(await before(hook({ tool_use_id: `fixture-tool-${index}` })))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  expect(await before(hook({ tool_use_id: "over-budget" })))
    .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
});
