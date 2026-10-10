// @effect-diagnostics nodeBuiltinImport:off -- Isolated SDK hook fixtures, never native execution authority.
import * as NodeCrypto from "node:crypto";
import { tool, type HookInput, type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, it, vi } from "vite-plus/test";
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
function fixture(
  request?: (id: string, operation: Record<string, unknown>) => Promise<unknown>,
  includeConfirmedGoalRead = false,
) {
  const offerId = NodeCrypto.randomUUID();
  const controllerId = NodeCrypto.randomUUID();
  const calls: Record<string, unknown>[] = [];
  const transport = {
    request: vi.fn(
      request ??
        (async (_id, operation) => {
          calls.push(operation);
          return {
            version: 1,
            state: "tool_result",
            operation_id: operation.operation_id,
            native_tool: operation.native_tool,
            result:
              operation.native_tool === "confirmed_goal_read"
                ? { confirmed_goal: null }
                : { intent: { intentId: "fixture-intent" } },
            execution_ready: false,
          };
        }),
    ),
  };
  const registrationStart = vi.mocked(tool).mock.calls.length;
  const bridge = createNativeSupervisorSdkTools({
    offerId,
    controllerId,
    transport,
    currentSdkSessionId: () => "fixture-sdk-session",
    includeConfirmedGoalRead,
  });
  owned.push(bridge);
  // Capture the actual registered handler; erase only the SDK generic-schema inference in this fixture.
  type Handler = (
    args: Record<string, unknown>,
    extra: unknown,
  ) => ReturnType<ReturnType<typeof tool>["handler"]>;
  const registrations = vi.mocked(tool).mock.calls.slice(registrationStart);
  const handler = registrations.find((call) => call[0] === "worker_dispatch")?.[3] as
    | Handler
    | undefined;
  const goalHandler = registrations.find((call) => call[0] === "confirmed_goal_read")?.[3] as
    | Handler
    | undefined;
  if (!handler) throw new Error("SDK tool was not registered.");
  const hook = (change: Partial<PreToolUseHookInput> = {}) => ({
    hook_event_name: "PreToolUse" as const,
    session_id: "fixture-sdk-session",
    cwd: "/isolated-fixture",
    transcript_path: "/isolated-fixture/transcript",
    tool_name: "mcp__workjet_native__worker_dispatch",
    tool_use_id: "fixture-tool-use",
    tool_input: { task: "Perform the bounded fixture task" },
    ...change,
  });
  const before = (input: HookInput) =>
    bridge.beforeTool(input, undefined, { signal: AbortSignal.timeout(1000) });
  return {
    bridge,
    handler,
    goalHandler,
    registrations,
    before,
    hook,
    transport,
    calls,
    offerId,
    controllerId,
  };
}
it.each([
  { tool_name: "Bash" },
  { tool_name: "Read" },
  { tool_name: "mcp__other__worker_dispatch" },
  { session_id: "foreign-session" },
  { agent_id: "subagent" },
])("denies tools outside the actual parent session: %o", async (change) => {
  const { before, hook, transport } = fixture();
  expect(await before(hook(change))).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
  expect(transport.request).not.toHaveBeenCalled();
});
it("does not trust a model nonce or an MCP call without the actual SDK hook", async () => {
  const { handler, before, hook, transport } = fixture();
  expect(await handler({ task: "Perform the bounded fixture task" }, {})).toMatchObject({
    isError: true,
  });
  expect(
    await before(
      hook({ tool_input: { task: "fixture", _workjet_sdk_call: NodeCrypto.randomUUID() } }),
    ),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(transport.request).not.toHaveBeenCalled();
});
it("joins the actual hook to one immutable original operation and deduplicates SDK re-entry", async () => {
  const { handler, before, hook, transport, offerId, controllerId } = fixture();
  const input = hook();
  const allowed = await before(input);
  const updated =
    "hookSpecificOutput" in allowed && allowed.hookSpecificOutput?.hookEventName === "PreToolUse"
      ? allowed.hookSpecificOutput.updatedInput
      : undefined;
  expect(updated).toBeDefined();
  const first = await handler(updated!, {});
  expect(first).toMatchObject({ content: [{ type: "text" }] });
  await handler(updated!, { toolUseID: "untrusted-extra" });
  const again = await before({ ...input, tool_input: updated });
  expect(again).toEqual(allowed);
  expect(transport.request).toHaveBeenCalledTimes(1);
  const operation = transport.request.mock.calls[0]?.[1];
  expect(operation).toMatchObject({
    offer_id: offerId,
    controller_id: controllerId,
    native_tool: "worker_dispatch",
  });
  expect(JSON.parse(String(operation?.tool_arguments_json))).toEqual(input.tool_input);
  expect(await before({ ...input, tool_input: { task: "Changed task" } })).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
});
it.each(["eof", "wrong-operation", "wrong-tool", "execution-ready", "extra-field"])(
  "retires the same controller tool on %s without a replacement dispatch",
  async (mode) => {
    const { handler, before, hook, transport, bridge } = fixture(async (_id, operation) => {
      if (mode === "eof") throw new Error("isolated post-write EOF fixture");
      return {
        version: 1,
        state: "tool_result",
        operation_id: mode === "wrong-operation" ? NodeCrypto.randomUUID() : operation.operation_id,
        native_tool: mode === "wrong-tool" ? "confirmed_goal_read" : "worker_dispatch",
        result: {},
        execution_ready: mode === "execution-ready",
        ...(mode === "extra-field" ? { authority: true } : {}),
      };
    });
    const allowed = await before(hook());
    const updated =
      "hookSpecificOutput" in allowed && allowed.hookSpecificOutput?.hookEventName === "PreToolUse"
        ? allowed.hookSpecificOutput.updatedInput
        : undefined;
    expect(await handler(updated!, {})).toMatchObject({ isError: true });
    expect(await bridge.failure).toBeInstanceOf(Error);
    expect(await handler(updated!, {})).toMatchObject({ isError: true });
    expect(transport.request).toHaveBeenCalledTimes(1);
  },
);
it("rejects actor/root fields and limits one controller to 32 actual calls", async () => {
  const { before, hook } = fixture();
  expect(await before(hook({ tool_input: { task: "fixture", actor: "owner" } }))).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
  for (let index = 0; index < 32; index++)
    expect(await before(hook({ tool_use_id: `fixture-tool-${index}` }))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  expect(await before(hook({ tool_use_id: "over-budget" }))).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
});

function updatedInput(output: Awaited<ReturnType<ReturnType<typeof fixture>["before"]>>) {
  return "hookSpecificOutput" in output && output.hookSpecificOutput?.hookEventName === "PreToolUse"
    ? output.hookSpecificOutput.updatedInput
    : undefined;
}
it("does not register or admit the confirmed-goal reader without native admission", async () => {
  const { before, hook, goalHandler, registrations, transport } = fixture();
  expect(registrations.map((call) => call[0])).toEqual(["worker_dispatch"]);
  expect(goalHandler).toBeUndefined();
  expect(
    await before(hook({ tool_name: "mcp__workjet_native__confirmed_goal_read", tool_input: {} })),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(transport.request).not.toHaveBeenCalled();
});
it.each([
  { confirmed_goal: null },
  {
    confirmed_goal: {
      revision: 3,
      status: "active",
      steps: [{ status: "running", result: "Saved partial evidence" }],
    },
  },
])("returns the actual confirmed-goal result without inventing completion: %o", async (result) => {
  const { before, hook, goalHandler, transport, offerId, controllerId } = fixture(
    async (_id, operation) => ({
      version: 1,
      state: "tool_result",
      operation_id: operation.operation_id,
      native_tool: "confirmed_goal_read",
      result,
      execution_ready: false,
    }),
    true,
  );
  expect(await goalHandler!({}, {})).toMatchObject({ isError: true });
  const input = hook({ tool_name: "mcp__workjet_native__confirmed_goal_read", tool_input: {} });
  const admitted = updatedInput(await before(input));
  expect(admitted).toBeDefined();
  expect(await goalHandler!(admitted!, {})).toEqual({
    content: [{ type: "text", text: JSON.stringify(result) }],
  });
  await goalHandler!(admitted!, { toolUseID: "untrusted-extra" });
  expect(await before({ ...input, tool_input: admitted })).toMatchObject({
    hookSpecificOutput: { permissionDecision: "allow", updatedInput: admitted },
  });
  expect(transport.request).toHaveBeenCalledTimes(1);
  expect(transport.request.mock.calls[0]?.[1]).toEqual({
    version: 1,
    action: "tool_call",
    offer_id: offerId,
    controller_id: controllerId,
    operation_id: expect.any(String),
    native_tool: "confirmed_goal_read",
    tool_arguments_json: "{}",
  });
});
it.each([
  { project_id: "foreign-project" },
  { actor: "owner" },
  { root: "/foreign-root" },
  { controller_id: NodeCrypto.randomUUID() },
  { action: "confirm_goal" },
  { _workjet_sdk_call: NodeCrypto.randomUUID() },
])("rejects caller-selected goal authority or correlation: %o", async (tool_input) => {
  const { before, hook, transport } = fixture(undefined, true);
  expect(
    await before(hook({ tool_name: "mcp__workjet_native__confirmed_goal_read", tool_input })),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect(transport.request).not.toHaveBeenCalled();
});
it("does not reuse one hook or nonce across the two fixed native tools", async () => {
  const { before, hook, handler, goalHandler, transport } = fixture(undefined, true);
  const workerInput = updatedInput(await before(hook()));
  expect(await goalHandler!(workerInput!, {})).toMatchObject({ isError: true });
  expect(
    await before(hook({ tool_name: "mcp__workjet_native__confirmed_goal_read", tool_input: {} })),
  ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  const goalInput = updatedInput(
    await before(
      hook({
        tool_name: "mcp__workjet_native__confirmed_goal_read",
        tool_input: {},
        tool_use_id: "goal-use",
      }),
    ),
  );
  expect(await handler(goalInput!, {})).toMatchObject({ isError: true });
  expect(transport.request).not.toHaveBeenCalled();
});
it.each([{ session_id: "foreign-session" }, { agent_id: "subagent" }])(
  "rejects goal reads outside the observed parent session: %o",
  async (change) => {
    const { before, hook, transport } = fixture(undefined, true);
    expect(
      await before(
        hook({
          tool_name: "mcp__workjet_native__confirmed_goal_read",
          tool_input: {},
          ...change,
        }),
      ),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(transport.request).not.toHaveBeenCalled();
  },
);
it("retires a goal read with a foreign tool reply without replacing its operation", async () => {
  const { before, hook, goalHandler, transport, bridge } = fixture(
    async (_id, operation) => ({
      version: 1,
      state: "tool_result",
      operation_id: operation.operation_id,
      native_tool: "worker_dispatch",
      result: {},
      execution_ready: false,
    }),
    true,
  );
  const input = updatedInput(
    await before(
      hook({
        tool_name: "mcp__workjet_native__confirmed_goal_read",
        tool_input: {},
      }),
    ),
  );
  expect(await goalHandler!(input!, {})).toMatchObject({ isError: true });
  expect(await bridge.failure).toBeInstanceOf(Error);
  expect(await goalHandler!(input!, {})).toMatchObject({ isError: true });
  expect(transport.request).toHaveBeenCalledTimes(1);
});
it("shares the existing 32-call budget across both native tools", async () => {
  const { before, hook } = fixture(undefined, true);
  for (let index = 0; index < 32; index++)
    expect(
      await before(
        hook({
          tool_use_id: `mixed-tool-${index}`,
          ...(index % 2 === 0
            ? { tool_name: "mcp__workjet_native__confirmed_goal_read", tool_input: {} }
            : {}),
        }),
      ),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
  expect(await before(hook({ tool_use_id: "over-budget" }))).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
});
