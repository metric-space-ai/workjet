// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics globalDate:off nodeBuiltinImport:off globalTimers:off -- Native lease deadlines use the host wall clock; own the SDK child and bounded timers at the private Node boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  query,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { compileWorkjetTeamRolePrompt } from "@metric-space-ai/workjet-capabilities";
import { ProjectId, ThreadId } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { openNativeSupervisorModelBroker } from "./NativeSupervisorModelBroker.ts";
import { createNativeSupervisorSdkSourceJournal } from "./NativeSupervisorSdkSourceJournal.ts";
import { createNativeSupervisorSdkTools } from "./NativeSupervisorSdkTools.ts";
import type { NativeSupervisorSourceTransport } from "./NativeSupervisorSourceTransport.ts";

const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
);
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const ExecutionKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const Deadline = Schema.Int.check(Schema.isGreaterThan(0));
const Route = Schema.Struct({
  project_id: Id,
  supervisor_thread_id: Id,
  luma_id: Id,
  configuration_revision: Schema.Int.check(Schema.isGreaterThan(0)),
  computer_id: Id,
  harness: Schema.Literal("claude-code"),
  model: Id,
});
const Offer = Schema.Struct({
  offer_id: Uuid,
  execution_key: ExecutionKey,
  deadline_ms: Deadline,
  state: Schema.Literal("offered"),
  route: Route,
});
const Poll = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("waiting"),
    offer: Schema.Null,
    execution_ready: Schema.Literal(false),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    state: Schema.Literal("offered"),
    offer: Offer,
    execution_ready: Schema.Literal(false),
  }),
]);
const Claim = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literal("claimed"),
  offer_id: Uuid,
  execution_key: ExecutionKey,
  controller_id: Uuid,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536)),
  deadline_ms: Deadline,
  native_tools: Schema.Array(
    Schema.Struct({
      name: Schema.Literals(["worker_dispatch", "confirmed_goal_read"]),
      description: Schema.String,
      inputSchema: Schema.Unknown,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
  execution_ready: Schema.Literal(false),
});
const decodePoll = Schema.decodeUnknownPromise(Poll, { onExcessProperty: "error" });
const decodeClaim = Schema.decodeUnknownPromise(Claim, { onExcessProperty: "error" });
const claimedOffers = new WeakMap<NativeSupervisorSourceTransport, Map<string, number>>();

export interface NativeSupervisorSdkTurnDrain {
  readonly offerId: string;
  readonly controllerId: string;
  readonly executionKey: string;
  readonly localSdkDrained: true;
  readonly localModelRequestsDrained: true;
  readonly executionReady: false;
}

/** Only the retained original-Source service calls this function. It reads and
 * claims its own offer; there is no caller-created controller, query override,
 * account credential, reported result, PID list or execution permission input.
 * UI connections never supply or abort this service-lifetime signal. */
export async function runNextNativeSupervisorSdkTurn(options: {
  readonly source: NativeSupervisorSourceTransport;
  readonly sdkExecutable: string;
  readonly privateStateDirectory: string;
  readonly serviceSignal: AbortSignal;
  /** Private opt-in only for a qualified native with the confirmed-goal contract. */
  readonly includeConfirmedGoalRead?: boolean;
}): Promise<NativeSupervisorSdkTurnDrain | null> {
  options.serviceSignal.throwIfAborted();
  const request = options.source.request.bind(options.source);
  const poll = await decodePoll(
    await request(NodeCrypto.randomUUID(), { version: 1, action: "poll" }),
  );
  if (poll.state === "waiting") return null;
  const offer = poll.offer;
  if (offer.deadline_ms <= Date.now()) throw new Error("Original Supervisor offer expired.");
  const attempted = claimedOffers.get(options.source) ?? new Map<string, number>();
  for (const [id, deadline] of attempted) if (deadline <= Date.now()) attempted.delete(id);
  if (attempted.has(offer.offer_id) || attempted.size >= 32)
    throw new Error("Original Supervisor offer was already attempted; no claim replay.");
  attempted.set(offer.offer_id, offer.deadline_ms);
  claimedOffers.set(options.source, attempted);
  const claim = await decodeClaim(
    await request(NodeCrypto.randomUUID(), {
      version: 1,
      action: "claim",
      offer_id: offer.offer_id,
      ...(options.includeConfirmedGoalRead === true ? { include_confirmed_goal_read: true } : {}),
    }),
  );
  if (
    claim.offer_id !== offer.offer_id ||
    claim.execution_key !== offer.execution_key ||
    claim.deadline_ms !== offer.deadline_ms
  )
    throw new Error("Original Supervisor offer changed during claim.");
  const toolNames = claim.native_tools.map((descriptor) => descriptor.name);
  if (
    toolNames.filter((name) => name === "worker_dispatch").length !== 1 ||
    new Set(toolNames).size !== toolNames.length ||
    (toolNames.includes("confirmed_goal_read") && options.includeConfirmedGoalRead !== true) ||
    (options.includeConfirmedGoalRead === true && !toolNames.includes("confirmed_goal_read"))
  )
    throw new Error("Original Supervisor claim has an unsupported native tool set.");
  const includeConfirmedGoalRead = toolNames.includes("confirmed_goal_read");
  const lifetime = Math.min(claim.deadline_ms - Date.now(), 300000);
  if (lifetime <= 0) throw new Error("Original Supervisor claim expired.");
  if (
    !NodePath.isAbsolute(options.sdkExecutable) ||
    !NodePath.isAbsolute(options.privateStateDirectory)
  )
    throw new Error("Private SDK runtime paths must be absolute.");
  const executable = await NodeFSP.stat(options.sdkExecutable);
  if (!executable.isFile()) throw new Error("Selected SDK executable is unavailable.");
  await NodeFSP.mkdir(options.privateStateDirectory, { recursive: true, mode: 0o700 });
  const parent = await NodeFSP.lstat(options.privateStateDirectory);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    (process.getuid && parent.uid !== process.getuid())
  )
    throw new Error("Private SDK state directory is not protected.");
  const directory = await NodeFSP.mkdtemp(NodePath.join(options.privateStateDirectory, "sdk-"));
  await NodeFSP.chmod(directory, 0o700);
  const config = NodePath.join(directory, "config");
  const tmp = NodePath.join(directory, "tmp");
  await NodeFSP.mkdir(config, { mode: 0o700 });
  await NodeFSP.mkdir(tmp, { mode: 0o700 });
  const journal = createNativeSupervisorSdkSourceJournal({
    offerId: claim.offer_id,
    controllerId: claim.controller_id,
    transport: options.source,
  });
  const tools = createNativeSupervisorSdkTools({
    offerId: claim.offer_id,
    controllerId: claim.controller_id,
    transport: options.source,
    currentSdkSessionId: () => journal.currentSdkSessionId(),
    includeConfirmedGoalRead,
    ...(includeConfirmedGoalRead
      ? {
          goalScope: {
            projectId: offer.route.project_id,
            supervisorThreadId: offer.route.supervisor_thread_id,
          },
        }
      : {}),
  });
  let broker: Awaited<ReturnType<typeof openNativeSupervisorModelBroker>>;
  try {
    broker = await openNativeSupervisorModelBroker({
      offerId: claim.offer_id,
      controllerId: claim.controller_id,
      transport: options.source,
      currentSdkSessionId: () => journal.currentSdkSessionId(),
    });
  } catch (cause) {
    await tools.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw cause;
  }
  const sdkEnvironment = {
    PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: directory,
    TMPDIR: tmp,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: broker.baseUrl,
    ANTHROPIC_API_KEY: broker.authToken,
    LANG: "en_US.UTF-8",
  };
  const children: Array<{ child: NodeChildProcess.ChildProcess; closed: Promise<void> }> = [];
  const abortController = new AbortController();
  let inputFinished!: () => void;
  const inputEnd = new Promise<void>((resolve) => {
    inputFinished = resolve;
  });
  const turnId = NodeCrypto.randomUUID();
  let childCaptured!: () => void;
  const firstChild = new Promise<void>((resolve) => {
    childCaptured = resolve;
  });
  const input = async function* (): AsyncGenerator<SDKUserMessage> {
    await Promise.race([firstChild, inputEnd]);
    if (children.length === 0 || abortController.signal.aborted)
      throw new Error("Original SDK child is unavailable before prompt submission.");
    await journal.turnSubmitted(turnId);
    yield {
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      uuid: turnId,
      message: { role: "user", content: claim.prompt },
    };
    // SDK MCP requires streaming input. Keep only this original turn open until
    // its actual result/stop; do not turn UI disconnects into prompt EOF.
    await inputEnd;
  };
  const spawn = (spawnOptions: SpawnOptions): SpawnedProcess => {
    const sdkVersion = spawnOptions.env.CLAUDE_AGENT_SDK_VERSION;
    if (sdkVersion !== undefined && !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(sdkVersion))
      throw new Error("Original SDK protocol version marker is invalid.");
    const child = NodeChildProcess.spawn(spawnOptions.command, spawnOptions.args, {
      cwd: directory,
      // Enforce the retained private map at the actual child boundary. Only
      // SDK protocol markers may be added; no profile/account/tracing inheritance.
      env: {
        ...sdkEnvironment,
        ...(spawnOptions.env.CLAUDE_CODE_ENTRYPOINT === "sdk-ts"
          ? { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" }
          : {}),
        ...(sdkVersion === undefined ? {} : { CLAUDE_AGENT_SDK_VERSION: sdkVersion }),
      },
      signal: spawnOptions.signal,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    children.push({ child, closed });
    child.once("error", () => {});
    if (child.pid !== undefined) {
      journal.captureOwnedSdkChild(child);
      childCaptured();
    }
    return child as SpawnedProcess;
  };
  const onAbort = () => abortController.abort(options.serviceSignal.reason);
  options.serviceSignal.addEventListener("abort", onAbort, { once: true });
  if (options.serviceSignal.aborted) onAbort();
  const timer = setTimeout(
    () => abortController.abort(new Error("Original SDK turn deadline reached.")),
    lifetime,
  );
  timer.unref();
  let runtime: ReturnType<typeof query> | undefined;
  let consumer: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let fault: unknown;
  let resultSeen = false;
  let localSdkDrained = false;
  let modelDrained = false;
  const closeQuery = () =>
    (closePromise ??= (async () => {
      if (!runtime) return;
      runtime.close();
      await journal.sdkQueryCloseReturned();
    })());
  const bounded = async <A>(promise: Promise<A>, milliseconds: number): Promise<A> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Owned SDK drain is incomplete.")),
            milliseconds,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  try {
    runtime = query({
      prompt: input(),
      options: {
        cwd: directory,
        model: offer.route.model,
        pathToClaudeCodeExecutable: options.sdkExecutable,
        systemPrompt: [
          compileWorkjetTeamRolePrompt({
            projectId: ProjectId.make(offer.route.project_id),
            threadId: ThreadId.make(offer.route.supervisor_thread_id),
            role: "supervisor",
            parentThreadId: null,
            goal: "Carry out the original native Supervisor assignment and preserve its confirmed project goal.",
            createdAt: new Date().toISOString(),
          }),
          tools.instructions,
          "Other operations are unsupported on this controller; report that explicitly. Never reconstruct native authority or claim completed work from a startup acknowledgement.",
        ].join("\n\n"),
        tools: [],
        allowedTools: [],
        permissionMode: "default",
        canUseTool: async () => ({
          behavior: "deny",
          message: "Use the admitted native tool bridge.",
        }),
        hooks: { PreToolUse: [{ hooks: [tools.beforeTool] }] },
        mcpServers: { workjet_native: tools.server },
        strictMcpConfig: true,
        plugins: [],
        agents: {},
        settingSources: [],
        additionalDirectories: [],
        persistSession: false,
        enableFileCheckpointing: false,
        maxTurns: 32,
        includePartialMessages: true,
        abortController,
        spawnClaudeCodeProcess: spawn,
        // Give the SDK a copy; its child callback retains the original private map.
        env: { ...sdkEnvironment },
      },
    });
    const actualRuntime = runtime;
    consumer = (async () => {
      try {
        for await (const message of actualRuntime) {
          await journal.observeSdkMessage(message, turnId);
          if (message.type === "result") {
            resultSeen = true;
            break;
          }
        }
      } finally {
        await journal.sdkStreamJoined();
      }
      if (!resultSeen) throw new Error("Original SDK stream ended without its result.");
    })();
    void consumer.catch(() => {});
    const abort = new Promise<never>((_, reject) => {
      const rejectAbort = () => reject(abortController.signal.reason);
      if (abortController.signal.aborted) rejectAbort();
      else abortController.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    await Promise.race([
      consumer,
      abort,
      journal.failure.then((cause) => {
        throw cause;
      }),
      broker.failure.then((cause) => {
        throw cause;
      }),
      tools.failure.then((cause) => {
        throw cause;
      }),
    ]);
  } catch (cause) {
    fault = cause;
  } finally {
    clearTimeout(timer);
    options.serviceSignal.removeEventListener("abort", onAbort);
    inputFinished();
    if (fault) abortController.abort(fault);
    try {
      await bounded(closeQuery(), 10000);
    } catch (cause) {
      fault ??= cause;
    }
    // Only child objects captured by this genuine SDK spawn callback are stopped.
    // Closing a query or a transport alone is never accepted as their stop proof.
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try {
      await bounded(Promise.all(children.map((child) => child.closed)), 5000);
    } catch {
      for (const { child } of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      try {
        await bounded(Promise.all(children.map((child) => child.closed)), 5000);
      } catch (cause) {
        fault ??= cause;
      }
    }
    try {
      if (consumer) await bounded(consumer, 10000);
    } catch (cause) {
      fault ??= cause;
    }
    try {
      if (children.length > 0) {
        await journal.drain(AbortSignal.timeout(10000));
        localSdkDrained = true;
      } else {
        fault ??= new Error("Original SDK did not spawn an owned child.");
      }
    } catch (cause) {
      fault ??= cause;
    }
    try {
      await tools.close();
      const drain = await broker.close();
      modelDrained = drain.outcomeUnknownOperationIds.length === 0;
      if (!modelDrained) fault ??= new Error("Original model operation outcome remains unknown.");
    } catch (cause) {
      fault ??= cause;
      try {
        await broker.close();
      } catch {
        /* Preserve original failure; no authority result. */
      }
    }
    if (children.every(({ child }) => child.exitCode !== null || child.signalCode !== null))
      await NodeFSP.rm(directory, { recursive: true, force: true });
  }
  if (fault) throw fault;
  if (!localSdkDrained || !modelDrained) throw new Error("Original SDK drain is incomplete.");
  return {
    offerId: claim.offer_id,
    controllerId: claim.controller_id,
    executionKey: claim.execution_key,
    localSdkDrained: true,
    localModelRequestsDrained: true,
    executionReady: false,
  };
}
