// @effect-diagnostics nodeBuiltinImport:off -- Mock SDK messages with actual owned Node children; not real model/native acceptance.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { query, type SDKMessage, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_MODEL } from "@workjet/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { runNextNativeSupervisorSdkTurn } from "./NativeSupervisorSdkExecutor.ts";
import type { NativeSupervisorSourceTransport } from "./NativeSupervisorSourceTransport.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (actual) => {
  const sdk = await actual<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...sdk, query: vi.fn() };
});
const directories: string[] = [];
const children: SpawnedProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(directories.splice(0).map((directory) => Fs.rm(directory, { recursive: true, force: true })));
  vi.clearAllMocks();
});
async function fixture(change?: (operation: Record<string, unknown>) => unknown) {
  const directory = await Fs.mkdtemp(Path.join(process.env.TMPDIR ?? Os.tmpdir(), "sdk-executor-"));
  directories.push(directory);
  const offerId = Crypto.randomUUID();
  const controllerId = Crypto.randomUUID();
  const deadline = Date.now() + 60000;
  const operations: Record<string, unknown>[] = [];
  const source: NativeSupervisorSourceTransport = {
    processId: process.pid, endpoint: "/isolated-fixture-not-live",
    startup: { protocolVersion: 1, endpoint: "/isolated-fixture-not-live",
      transportReady: true, executionReady: false },
    executionReady: false, close: async () => ({ exitCode: 0, signal: null }),
    request: async (_id, operation) => {
      operations.push(operation);
      const changed = change?.(operation);
      if (changed !== undefined) return changed;
      if (operation.action === "poll") return {
        version: 1, state: "offered", execution_ready: false,
        offer: { offer_id: offerId, execution_key: "fixture-native-execution",
          deadline_ms: deadline, state: "offered",
          route: { project_id: "fixture-project", supervisor_thread_id: "fixture-supervisor",
            luma_id: "fixture-luma", configuration_revision: 1, computer_id: "fixture-computer",
            harness: "claude-code", model: DEFAULT_MODEL } },
      };
      if (operation.action === "claim") return {
        version: 1, state: "claimed", offer_id: offerId, controller_id: controllerId,
        execution_key: "fixture-native-execution", prompt: "Original fixture assignment",
        deadline_ms: deadline, native_tools: [{ name: "worker_dispatch", description: "fixture",
          inputSchema: {} }], execution_ready: false,
      };
      if (operation.action === "sdk_observe") {
        const observation = operation.sdk_observation as { sequence: number };
        return { version: 1, state: "sdk_observed", sequence: observation.sequence, execution_ready: false };
      }
      throw new Error("Unexpected fixture native operation");
    },
  };
  return {
    source, directory, operations, offerId, controllerId,
    options: { source, privateStateDirectory: directory, sdkExecutable: process.execPath,
      serviceSignal: new AbortController().signal },
  };
}
function sdkFixture(mode: "result" | "missing-result" | "foreign-parent" | "await-stop" = "result") {
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  vi.mocked(query).mockImplementationOnce(({ prompt, options }) => {
    if (!options?.spawnClaudeCodeProcess || typeof prompt === "string")
      throw new Error("Genuine query options/input were not supplied.");
    const child = options.spawnClaudeCodeProcess({
      command: process.execPath, args: ["-e", 'process.stdin.resume();'],
      cwd: options.cwd ?? "", env: options.env, signal: options.abortController?.signal,
    });
    children.push(child);
    const session = "fixture-original-sdk-session";
    let finish!: () => void;
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    const stream = (async function* () {
      yield { type: "system", subtype: "init", uuid: Crypto.randomUUID(), session_id: session } as SDKMessage;
      for await (const message of prompt) {
        expect(message.message.content).toBe("Original fixture assignment");
        started();
        if (mode === "await-stop") { await stopped; return; }
        yield { type: "assistant", uuid: Crypto.randomUUID(),
          session_id: mode === "foreign-parent" ? "fixture-foreign-session" : session,
          parent_tool_use_id: null,
          message: { id: "fixture-native-message", model: DEFAULT_MODEL, content: [] },
        } as SDKMessage;
        if (mode !== "missing-result") yield {
          type: "result", subtype: "success", is_error: false,
          uuid: Crypto.randomUUID(), session_id: session,
        } as SDKMessage;
        return;
      }
    })();
    return {
      [Symbol.asyncIterator]: () => stream,
      close: () => { finish(); child.stdin.end(); },
    } as ReturnType<typeof query>;
  });
  return startedPromise;
}
it("reads and claims the same native offer and joins actual SDK child/query/journal drains", async () => {
  const { options, operations, offerId, controllerId, directory } = await fixture();
  sdkFixture();
  const result = await runNextNativeSupervisorSdkTurn(options);
  expect(result).toEqual({
    offerId, controllerId, executionKey: "fixture-native-execution",
    localSdkDrained: true, localModelRequestsDrained: true, executionReady: false,
  });
  expect(operations.slice(0, 2).map((op) => op.action)).toEqual(["poll", "claim"]);
  const observations = operations.filter((op) => op.action === "sdk_observe")
    .map((op) => op.sdk_observation as { kind: string; sequence: number });
  expect(observations.map((op) => op.sequence)).toEqual(observations.map((_, index) => index));
  expect(observations.map((op) => op.kind)).toEqual(expect.arrayContaining([
    "child-spawned", "sdk-init", "turn-submitted", "parent-assistant",
    "sdk-result", "sdk-stream-joined", "sdk-query-close-returned", "child-closed",
  ]));
  expect(await Fs.readdir(directory)).toEqual([]);
  expect(operations.every((op) => op.actual_json === undefined && op.reply_text === undefined)).toBe(true);
});
it("replaces the complete child environment and exposes only the native tool bridge", async () => {
  const { options } = await fixture();
  sdkFixture();
  await runNextNativeSupervisorSdkTurn(options);
  const config = vi.mocked(query).mock.calls[0]?.[0].options;
  expect(config).toMatchObject({ tools: [], allowedTools: [], permissionMode: "default",
    settingSources: [], additionalDirectories: [], persistSession: false });
  expect(Object.keys(config?.env ?? {}).sort()).toEqual([
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "HOME", "LANG", "PATH", "TMPDIR",
  ]);
  expect(config?.env?.HOME).not.toBe(process.env.HOME);
  expect(config?.env?.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(Object.keys(config?.mcpServers ?? {})).toEqual(["workjet_native"]);
  expect(config?.allowDangerouslySkipPermissions).toBeUndefined();
  expect(config?.resume).toBeUndefined();
  expect(config?.extraArgs).toBeUndefined();
  expect(config?.systemPrompt).toContain("## Workjet Role: Supervisor");
  expect(config?.systemPrompt).toContain("Do not maintain your own mini-kanban.");
});
it("does not start a query or create state when the native Source is waiting", async () => {
  const { options, directory } = await fixture((op) => op.action === "poll"
    ? { version: 1, state: "waiting", offer: null, execution_ready: false } : undefined);
  expect(await runNextNativeSupervisorSdkTurn(options)).toBeNull();
  expect(query).not.toHaveBeenCalled();
  expect(await Fs.readdir(directory)).toEqual([]);
});
it("does not replay an ambiguous claim on the same retained Source", async () => {
  const { options, operations } = await fixture((op) => {
    if (op.action === "claim") throw new Error("isolated post-write EOF fixture");
  });
  await expect(runNextNativeSupervisorSdkTurn(options)).rejects.toThrow("EOF");
  await expect(runNextNativeSupervisorSdkTurn(options)).rejects.toThrow("no claim replay");
  expect(operations.filter((op) => op.action === "claim")).toHaveLength(1);
  expect(query).not.toHaveBeenCalled();
});
it.each(["missing-result", "foreign-parent"] as const)("rejects %s without completion authority", async (mode) => {
  const { options, directory } = await fixture();
  sdkFixture(mode);
  await expect(runNextNativeSupervisorSdkTurn(options)).rejects.toThrow();
  expect(await Fs.readdir(directory)).toEqual([]);
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
});
it("service-owner cancellation stops only the actual captured child and joins its stream", async () => {
  const { options, directory } = await fixture();
  const owner = new AbortController();
  const started = sdkFixture("await-stop");
  const run = runNextNativeSupervisorSdkTurn({ ...options, serviceSignal: owner.signal });
  const observed = run.catch((cause) => cause);
  await started;
  owner.abort(new Error("fixture service owner closed"));
  expect(await observed).toBeInstanceOf(Error);
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  expect(await Fs.readdir(directory)).toEqual([]);
});
it("a failed original durable sink cannot become a successful local drain", async () => {
  const { options, directory } = await fixture((op) => {
    if (op.action === "sdk_observe" &&
        (op.sdk_observation as { kind: string }).kind === "parent-assistant")
      throw new Error("fixture original sink unavailable");
  });
  sdkFixture();
  await expect(runNextNativeSupervisorSdkTurn(options)).rejects.toThrow("sink unavailable");
  expect(await Fs.readdir(directory)).toEqual([]);
  expect(children.every((child) => child.exitCode !== null || child.signalCode !== null)).toBe(true);
});
