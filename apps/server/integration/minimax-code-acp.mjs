// Run through the shared heavy-job gate with the pinned official CLI and an explicit native profile.
// Default mode checks sessions without a prompt; workflow mode exercises the bounded native fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MiniMaxSettings, ProviderInstanceId, ThreadId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeMiniMaxAdapter } from "../src/provider/Layers/MiniMaxAdapter.ts";
import { makeMiniMaxWorkflowProbe } from "./minimax-code-workflow.mjs";
import {
  MINIMAX_CODE_RELEASE,
  MINIMAX_PREVIEW_MODEL,
} from "../src/provider/minimax/MiniMaxProtocol.ts";

const [binaryPath, dataDir, cwd, recordPath, mode] = process.argv.slice(2);
NodeAssert.ok(mode === undefined || mode === "workflow", "Optional mode must be workflow.");
const workflowName =
  mode === "workflow"
    ? "minimax-official-cli-workjet-workflow"
    : "minimax-official-cli-workjet-session";
for (const value of [binaryPath, dataDir, cwd, recordPath]) {
  NodeAssert.ok(
    value && NodePath.isAbsolute(value),
    "Pass explicit absolute binary, native profile, fixture and receipt paths.",
  );
}
NodeAssert.ok(
  process.env.TMPDIR?.startsWith("/Volumes/tmp/"),
  "Use the shared admission gate and tmp volume.",
);
NodeAssert.ok(
  cwd.startsWith("/Volumes/tmp/dev-artifacts/"),
  "The probe workspace must be disposable.",
);
NodeAssert.ok(
  recordPath.startsWith("/Volumes/tmp/dev-artifacts/"),
  "The receipt must use the owned tmp output directory.",
);
NodeAssert.equal((await NodeFSP.stat(cwd)).isDirectory(), true);
NodeAssert.equal((await NodeFSP.stat(dataDir)).isDirectory(), true);
const decodeSettings = Schema.decodeUnknownSync(MiniMaxSettings);
const instanceId = ProviderInstanceId.make("minimax-native-acceptance");
const threadId = ThreadId.make("minimax-native-session-probe");
const modelSelection = {
  instanceId,
  model: MINIMAX_PREVIEW_MODEL,
  ...(mode === "workflow" ? { options: [{ id: "thinkingEffort", value: "high" }] } : {}),
};
const start = { threadId, cwd, modelSelection, runtimeMode: "approval-required" };
const config = decodeSettings({ enabled: true, binaryPath, dataDirectory: dataDir });

await Effect.runPromise(
  Effect.gen(function* () {
    const adapter = yield* makeMiniMaxAdapter(config, {
      instanceId,
      protocolLogging: {
        logOutgoing: true,
        logger: (event) =>
          Effect.sync(() => {
            if (event.direction === "incoming") {
              if (event.stage !== "raw") return;
              const frame = JSON.parse(event.payload);
              const permission = frame.result?.configOptions?.find(
                (option) => option.id === "permissionMode",
              );
              process.stdout.write(
                `NATIVE_INCOMING_FRAME ${JSON.stringify({
                  id: frame.id,
                  method: frame.method,
                  sessionUpdate: frame.params?.update?.sessionUpdate,
                  ...(permission ? { permissionMode: permission.currentValue } : {}),
                })}\n`,
              );
              return;
            }
            if (event.direction !== "outgoing") return;
            const frame = event.stage === "raw" ? JSON.parse(event.payload) : event.payload;
            const value = event.stage === "raw" ? frame?.result : frame?.exit?.value;
            if (value && ["accept", "decline", "cancel"].includes(value.action)) {
              process.stdout.write(
                `NATIVE_QUESTION_RESPONSE ${JSON.stringify({ stage: event.stage, id: frame?.id ?? frame?.requestId, value })}\n`,
              );
            }
          }),
      },
      resolveSessionEnvironment: () =>
        Effect.succeed({
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
        }),
    });
    const workflow =
      mode === "workflow" ? yield* makeMiniMaxWorkflowProbe(adapter, { threadId, cwd }) : undefined;
    process.stdout.write("NATIVE_STAGE start-session\n");
    const first = yield* adapter.startSession(start);
    process.stdout.write("NATIVE_STAGE session-ready\n");
    const stopResults = [];
    const stop = Effect.gen(function* () {
      const result = yield* adapter.stopSession(threadId);
      NodeAssert.equal(result?.terminated, true, "Native process shutdown must complete.");
      for (const pid of result.pids) {
        NodeAssert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      stopResults.push(result);
      process.stdout.write(`NATIVE_CLEANUP ${JSON.stringify(result)}\n`);
    });
    yield* Effect.addFinalizer(() =>
      adapter
        .listSessions()
        .pipe(Effect.flatMap((sessions) => (sessions.length > 0 ? stop : Effect.void))),
    );
    NodeAssert.equal(first.model, MINIMAX_PREVIEW_MODEL);
    NodeAssert.equal(first.resumeCursor?.protocol, "minimax-acp");
    NodeAssert.ok(first.resumeCursor.sessionId);
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        `${recordPath}.started.json`,
        `${JSON.stringify({
          status: "started",
          workflow: workflowName,
          model: first.model,
          resumeCursor: first.resumeCursor,
          acceptance: "pending",
        }, null, 2)}\n`,
        { mode: 0o600 },
      ),
    );
    NodeAssert.equal((yield* adapter.listSessions()).length, 1);
    if (workflow) {
      process.stdout.write("NATIVE_STAGE edit-and-cancel\n");
      yield* workflow.editAndCancel;
    }
    yield* stop;
    NodeAssert.equal((yield* adapter.listSessions()).length, 0);
    const resumed = yield* adapter.startSession({
      ...start,
      resumeCursor: first.resumeCursor,
      resumePolicy: "require-existing",
    });
    NodeAssert.deepEqual(resumed.resumeCursor, first.resumeCursor);
    NodeAssert.equal(resumed.model, MINIMAX_PREVIEW_MODEL);
    NodeAssert.equal((yield* adapter.listSessions()).length, 1);
    if (workflow) yield* workflow.afterReload;
    const workflowReceipt = workflow ? yield* workflow.receipt : undefined;
    yield* stop;
    NodeAssert.equal((yield* adapter.listSessions()).length, 0);
    const receipt = {
      status: "passed",
      workflow: workflowName,
      pinnedIdentityValidatedByAdapter: MINIMAX_CODE_RELEASE,
      model: resumed.model,
      requestedThinkingEffort: mode === "workflow" ? "high" : "automatic",
      resumeCursor: resumed.resumeCursor,
      processCleanup: { status: "passed", stopResults },
      modelPromptSent: false,
      modelRouteExecution: "not-run",
      sourceEditAcceptance: "not-run",
      cancellationAcceptance: "not-run",
      uiAcceptance: "not-run",
      ...workflowReceipt,
      gates: [
        "native-session-start",
        "exact-preview-model",
        "stop",
        "strict-same-cursor-load",
        "stop-after-reload",
        "native-owned-processes-absent",
        ...(workflowReceipt?.gates ?? []),
      ],
    };
    yield* Effect.promise(() =>
      NodeFSP.writeFile(recordPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.timeout(mode === "workflow" ? "4 minutes" : "90 seconds"),
  ),
);
process.stdout.write(
  `${JSON.stringify({ status: "passed", workflow: workflowName, model: MINIMAX_PREVIEW_MODEL, receipt: recordPath, uiAcceptance: "not-run" })}\n`,
);
