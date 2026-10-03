// Run through the shared heavy-job gate with the pinned official CLI and an explicit native profile.
// This checks real Workjet session/model discovery and strict reload without sending a model prompt.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MiniMaxSettings, ProviderInstanceId, ThreadId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeMiniMaxAdapter } from "../src/provider/Layers/MiniMaxAdapter.ts";
import {
  MINIMAX_CODE_RELEASE,
  MINIMAX_PREVIEW_MODEL,
} from "../src/provider/minimax/MiniMaxProtocol.ts";

const [binaryPath, dataDir, cwd, recordPath] = process.argv.slice(2);
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
const modelSelection = { instanceId, model: MINIMAX_PREVIEW_MODEL };
const start = { threadId, cwd, modelSelection, runtimeMode: "approval-required" };
const config = decodeSettings({ enabled: true, binaryPath, dataDir });

await Effect.runPromise(
  Effect.gen(function* () {
    const adapter = yield* makeMiniMaxAdapter(config, {
      instanceId,
      resolveSessionEnvironment: () =>
        Effect.succeed({
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
        }),
    });
    const first = yield* adapter.startSession(start);
    NodeAssert.equal(first.model, MINIMAX_PREVIEW_MODEL);
    NodeAssert.equal(first.resumeCursor?.protocol, "minimax-acp");
    NodeAssert.ok(first.resumeCursor.sessionId);
    NodeAssert.equal((yield* adapter.listSessions()).length, 1);
    yield* adapter.stopSession(threadId);
    NodeAssert.equal((yield* adapter.listSessions()).length, 0);
    const resumed = yield* adapter.startSession({
      ...start,
      resumeCursor: first.resumeCursor,
      resumePolicy: "require-existing",
    });
    NodeAssert.deepEqual(resumed.resumeCursor, first.resumeCursor);
    NodeAssert.equal(resumed.model, MINIMAX_PREVIEW_MODEL);
    NodeAssert.equal((yield* adapter.listSessions()).length, 1);
    yield* adapter.stopSession(threadId);
    NodeAssert.equal((yield* adapter.listSessions()).length, 0);
    const receipt = {
      status: "passed",
      workflow: "minimax-official-cli-workjet-session",
      pinnedIdentityValidatedByAdapter: MINIMAX_CODE_RELEASE,
      model: resumed.model,
      resumeCursor: resumed.resumeCursor,
      gates: [
        "native-session-start",
        "exact-preview-model",
        "stop",
        "strict-same-cursor-load",
        "stop-after-reload",
      ],
      modelPromptSent: false,
      modelRouteExecution: "not-run",
      sourceEditAcceptance: "not-run",
      cancellationAcceptance: "not-run",
      uiAcceptance: "not-run",
    };
    yield* Effect.promise(() =>
      NodeFSP.writeFile(recordPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("90 seconds")),
);
process.stdout.write(
  `${JSON.stringify({ status: "passed", workflow: "minimax-official-cli-workjet-session", model: MINIMAX_PREVIEW_MODEL, receipt: recordPath, uiAcceptance: "not-run" })}\n`,
);
