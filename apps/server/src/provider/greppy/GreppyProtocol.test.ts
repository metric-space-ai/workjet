import { GreppySettings, ProviderInstanceId, ServerSettings, WorkjetHarness } from "@workjet/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeGreppyTextGeneration } from "../../textGeneration/GreppyTextGeneration.ts";
import {
  classifyGreppyResult,
  classifyGreppyVersion,
  decodeGreppyResumeCursor,
  encodeGreppyResumeCursor,
  greppyServeArguments,
  mapGreppyStop,
  parseGreppyNdjsonLine,
  plainHttpEndpoint,
  safeGreppyModelId,
} from "./GreppyProtocol.ts";

const sessionLine = JSON.stringify({
  type: "session",
  session_id: "sess-fixture",
  uri: "greppy://sessions/sess-fixture",
  run_id: "run-fixture",
  project: "fixture",
  worktree: "fixture-worktree",
  branch: "main",
  model: "fixture-model",
  endpoint: "http://127.0.0.1:9",
  sandbox: "disabled",
  resumed: false,
  socket: "fixture.sock",
  mode: "serve",
});

describe("Greppy NDJSON", () => {
  it("parses a hosted session line, including the control socket", () => {
    const event = parseGreppyNdjsonLine(sessionLine);
    assert.strictEqual(event?.type, "session");
    if (event?.type !== "session") return;
    assert.strictEqual(event.sessionId, "sess-fixture");
    assert.strictEqual(event.socket, "fixture.sock");
    assert.strictEqual(event.mode, "serve");
    assert.strictEqual(event.resumed, false);
  });

  it("parses a ready turn and a clean result with a null proposal", () => {
    const turn = parseGreppyNdjsonLine(
      JSON.stringify({
        type: "turn_complete",
        stop: "ready",
        usage: { input: 12, output: 2, cache_read: 0, cache_write: 0 },
      }),
    );
    assert.strictEqual(turn?.type, "turn_complete");
    if (turn?.type !== "turn_complete") return;
    assert.deepStrictEqual(turn.usage, { input: 12, output: 2, cacheRead: 0, cacheWrite: 0 });
    assert.deepStrictEqual(mapGreppyStop(turn.stop), {
      state: "completed",
      incomplete: false,
      stopReason: "ready",
    });

    const result = parseGreppyNdjsonLine(
      JSON.stringify({
        type: "result",
        status: "clean",
        exit_code: 0,
        session_id: "sess-fixture",
        run_id: "run-fixture",
        stop: "ready",
        turns: 1,
        proposal_ref: null,
        patch: null,
        stat: null,
        applied: false,
      }),
    );
    assert.strictEqual(result?.type, "result");
    if (result?.type !== "result") return;
    assert.strictEqual(result.proposalRef, undefined);
    assert.strictEqual(result.patch, undefined);
    assert.strictEqual(classifyGreppyResult(result).exitKind, "graceful");
  });

  it("ignores blank and non-JSON lines", () => {
    assert.strictEqual(parseGreppyNdjsonLine(""), null);
    assert.strictEqual(parseGreppyNdjsonLine("error: --model is required"), null);
  });

  it("maps limit, cancel, and incomplete exits without inventing a turn state", () => {
    assert.strictEqual(mapGreppyStop("turn limit reached").incomplete, true);
    assert.strictEqual(mapGreppyStop("turn limit reached").state, "completed");
    assert.strictEqual(mapGreppyStop("token limit reached").incomplete, true);
    assert.strictEqual(mapGreppyStop("deadline reached").incomplete, true);
    assert.strictEqual(mapGreppyStop("stopped after repeated tool failures").incomplete, true);
    assert.strictEqual(mapGreppyStop("cancelled").state, "cancelled");
    assert.strictEqual(mapGreppyStop("ready", 130).state, "cancelled");
    assert.strictEqual(mapGreppyStop("ready", 5).incomplete, true);
    const failed = classifyGreppyResult({
      type: "result",
      status: "error",
      exitCode: 2,
      applied: false,
      stop: "error",
    });
    assert.strictEqual(failed.exitKind, "error");
    assert.strictEqual(failed.turn.state, "failed");
  });
});

describe("Greppy launch arguments", () => {
  it("keeps the API key out of argv and only passes plain HTTP", () => {
    assert.strictEqual(plainHttpEndpoint("https://gateway.example"), null);
    assert.strictEqual(plainHttpEndpoint("http://127.0.0.1:8317/"), "http://127.0.0.1:8317");
    assert.strictEqual(safeGreppyModelId("-injected"), null);
    const args = greppyServeArguments({
      model: "fixture-model",
      endpoint: "http://127.0.0.1:9",
      resumeSessionId: "sess-fixture",
      maxTurns: 40,
      noSandbox: true,
      skipSelfCheck: true,
    });
    assert.deepStrictEqual(args, [
      "agent",
      "serve",
      "--model",
      "fixture-model",
      "--endpoint",
      "http://127.0.0.1:9",
      "--max-turns",
      "40",
      "--resume",
      "sess-fixture",
      "--no-sandbox=true",
      "--skip-selfcheck=true",
    ]);
    assert.strictEqual(args.join(" ").includes("KEY"), false);
  });

  it("accepts 0.4.x, refuses other parsed versions, and round-trips a resume cursor", () => {
    assert.deepStrictEqual(classifyGreppyVersion("greppy 0.4.1\n"), {
      kind: "supported",
      version: "0.4.1",
    });
    assert.deepStrictEqual(classifyGreppyVersion("greppy 0.3.1\n"), {
      kind: "unsupported",
      version: "0.3.1",
    });
    assert.strictEqual(classifyGreppyVersion("greppy dev\n").kind, "unparsed");
    const cursor = encodeGreppyResumeCursor({
      sessionId: "sess-fixture",
      runId: "run-fixture",
      project: "fixture",
    });
    assert.deepStrictEqual(decodeGreppyResumeCursor(cursor), cursor);
    assert.strictEqual(decodeGreppyResumeCursor({ version: 1, kind: "other", sessionId: "x" }), null);
    assert.strictEqual(
      decodeGreppyResumeCursor({ version: 1, kind: "greppy-session", sessionId: "has space" }),
      null,
    );
  });

  it("decodes a default Greppy provider and the greppy harness id", () => {
    const settings = Schema.decodeSync(GreppySettings)({});
    assert.strictEqual(settings.enabled, true);
    assert.strictEqual(settings.endpoint, "http://127.0.0.1:8317");
    assert.strictEqual(settings.model, "");
    assert.strictEqual(settings.maxTurns, 40);
    assert.strictEqual(settings.applyOnSessionStop, false);
    const server = Schema.decodeSync(ServerSettings)({});
    assert.strictEqual(server.providers.greppy.binaryPath, "greppy");
    assert.strictEqual(Schema.decodeSync(WorkjetHarness)("greppy"), "greppy");
  });

  it.effect("refuses commit, pull request, branch, and title generation", () =>
    Effect.gen(function* () {
      const text = yield* makeGreppyTextGeneration;
      const selection = {
        instanceId: ProviderInstanceId.make("greppy"),
        model: "fixture-model",
      };
      const commit = yield* text
        .generateCommitMessage({
          cwd: "/work",
          branch: null,
          stagedSummary: "one line",
          stagedPatch: "diff",
          modelSelection: selection,
        })
        .pipe(Effect.flip);
      const pull = yield* text
        .generatePrContent({
          cwd: "/work",
          baseBranch: "main",
          headBranch: "topic",
          commitSummary: "one",
          diffSummary: "one",
          diffPatch: "diff",
          modelSelection: selection,
        })
        .pipe(Effect.flip);
      const branch = yield* text
        .generateBranchName({ cwd: "/work", message: "rename", modelSelection: selection })
        .pipe(Effect.flip);
      const title = yield* text
        .generateThreadTitle({ cwd: "/work", message: "hello", modelSelection: selection })
        .pipe(Effect.flip);
      for (const error of [commit, pull, branch, title]) {
        expect(error.message).toContain("hosted agent turns");
      }
    }),
  );
});
