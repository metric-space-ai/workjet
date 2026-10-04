// Actual native model execution only: import from minimax-code-acp.mjs with its workflow argument.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { ApprovalRequestId } from "@workjet/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
export const makeMiniMaxWorkflowProbe = Effect.fn("makeMiniMaxWorkflowProbe")(function* (
  adapter,
  { threadId, cwd },
) {
  const baseline = yield* Effect.promise(() =>
    execute("git", ["rev-parse", "HEAD"], { cwd, timeout: 20_000 }),
  );
  NodeAssert.equal(
    baseline.stdout.trim(),
    "e0d35ac48c29d3986e3db11ed89da780a6c21314",
    "Use the prepared acceptance fixture baseline.",
  );
  const before = yield* Effect.promise(() =>
    execute("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeout: 20_000 }),
  );
  NodeAssert.equal(
    before.stdout.trim(),
    "",
    "Native acceptance requires the clean prepared fixture.",
  );
  const events = [];
  const nonce = `workjet-native-${NodeCrypto.randomUUID()}`;
  const cancelStream = yield* Deferred.make();
  let phase = "edit";
  let choiceResolved = false;
  const safePath = (path) =>
    typeof path === "string" &&
    !path.startsWith("file:") &&
    (NodePath.resolve(cwd, path) === cwd ||
      NodePath.resolve(cwd, path).startsWith(cwd + NodePath.sep));
  const consumer = yield* adapter.streamEvents.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event.threadId !== threadId) return;
        events.push({ phase, event });
        if (event.type === "content.delta" && phase === "cancel" && event.payload.delta.trim())
          yield* Deferred.succeed(cancelStream, undefined);
        if (event.type === "request.opened" && event.requestId) {
          const tool = event.raw?.payload?.toolCall;
          const input = tool?.rawInput;
          const paths = [
            ...(tool?.locations?.map((location) => location.path) ?? []),
            ...[input?.path, input?.file_path, input?.filePath].filter(
              (path) => typeof path === "string",
            ),
          ];
          const command = input?.command ?? input?.cmd;
          const read =
            ["read", "search"].includes(tool?.kind) && paths.length > 0 && paths.every(safePath);
          const edit =
            phase === "edit" &&
            choiceResolved &&
            tool?.kind === "edit" &&
            paths.length > 0 &&
            paths.every(
              (path) =>
                safePath(path) &&
                NodePath.resolve(cwd, path) === NodePath.join(cwd, "src/greet.mjs"),
            );
          const test =
            phase === "edit" &&
            tool?.kind === "execute" &&
            command === "greppy bash-smart -- node --test --test-concurrency=1 test/greet.test.mjs";
          yield* adapter.respondToRequest(
            threadId,
            ApprovalRequestId.make(event.requestId),
            read || edit || test ? "accept" : "decline",
          );
        }
        if (event.type === "user-input.requested" && event.requestId) {
          const answers = {};
          for (const question of event.payload.questions) {
            const guest = question.options.find(
              (option) => option.label === "Guest" || option.label === "Guest (Recommended)",
            );
            if (guest) answers[question.id] = [guest.label];
          }
          NodeAssert.ok(
            Object.keys(answers).length > 0,
            `Native workflow only answers advertised Guest choices: ${JSON.stringify(event.payload.questions)}`,
          );
          yield* adapter.respondToUserInput(
            threadId,
            ApprovalRequestId.make(event.requestId),
            answers,
          );
          choiceResolved = true;
        }
      }),
    ),
    Effect.forkScoped,
  );
  const run = (input) =>
    Effect.raceFirst(adapter.sendTurn({ threadId, input }), Fiber.join(consumer));
  const text = (stage) =>
    events
      .filter(
        ({ phase, event }) =>
          phase === stage &&
          event.type === "content.delta" &&
          event.payload.streamKind !== "reasoning_text",
      )
      .map(({ event }) => event.payload.delta)
      .join("");
  const editAndCancel = Effect.gen(function* () {
    yield* run(
      `Work only in this disposable repository. Remember the nonce ${nonce} for our later conversation. Read README.md, src/greet.mjs and test/greet.test.mjs using file tools. Before editing, use your structured question tool to ask whether blank names should become Guest or Visitor, with those two choices. Wait for its answer. Use a file edit tool to change only src/greet.mjs: trim surrounding spaces and use the chosen default for blank names. Do not change tests, README, dependencies or any other path. To test, the only authorized shell command is exactly: greppy bash-smart -- node --test --test-concurrency=1 test/greet.test.mjs. Report the result briefly.`,
    );
    NodeAssert.ok(
      events.some(({ event }) => event.type === "user-input.resolved"),
      "Native question must resolve before acceptance.",
    );
    NodeAssert.ok(
      events.some(
        ({ event }) => event.type === "request.resolved" && event.payload.decision === "accept",
      ),
      `A real native tool approval must resolve: ${JSON.stringify({
        requests: events
          .filter(({ event }) => event.type.startsWith("request."))
          .map(({ event }) => ({
            type: event.type,
            payload: event.payload,
            toolCall: event.raw?.payload?.toolCall,
            rawPayloadKeys: event.raw?.payload ? Object.keys(event.raw.payload) : [],
          })),
        reply: text("edit"),
      })}`,
    );
    const status = yield* Effect.promise(() =>
      execute("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeout: 20_000 }),
    );
    NodeAssert.deepEqual(
      status.stdout.trim().split("\n"),
      ["M src/greet.mjs"],
      "Only the authorized source file may change.",
    );
    yield* Effect.promise(() =>
      execute(
        "greppy",
        [
          "bash-smart",
          "--",
          process.execPath,
          "--test",
          "--test-concurrency=1",
          "test/greet.test.mjs",
        ],
        { cwd, timeout: 20_000 },
      ),
    );
    NodeAssert.ok(
      events.some(
        ({ event }) =>
          event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      ),
      "Native reasoning must stream through Workjet.",
    );
    NodeAssert.ok(text("edit").trim(), "Native reply must stream through Workjet.");
    NodeAssert.ok(
      events.some(({ event }) =>
        event.raw?.payload?.update?.content?.some((part) => part.type === "diff"),
      ),
      "Native source diff must reach Workjet events.",
    );
    phase = "cancel";
    const prompt = yield* run(
      "Do not use tools or edit files. Explain a thorough test strategy for this greeting function in at least 2000 words, starting with edge cases.",
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Effect.raceFirst(
      Deferred.await(cancelStream),
      Fiber.join(prompt).pipe(
        Effect.andThen(
          Effect.die(new Error("Native turn finished before cancellation could be exercised.")),
        ),
      ),
    );
    yield* adapter.interruptTurn(threadId);
    yield* Fiber.join(prompt);
    NodeAssert.ok(
      events.some(
        ({ phase, event }) =>
          phase === "cancel" &&
          event.type === "turn.completed" &&
          event.payload.state === "cancelled",
      ),
      "Actual native cancellation receipt is required.",
    );
  });
  const afterReload = Effect.gen(function* () {
    phase = "reload";
    yield* run(
      "Do not use tools or edit files. Reply with the exact nonce I asked you to remember in our first task, and the blank-name default chosen through our earlier question.",
    );
    NodeAssert.ok(
      text("reload").includes(nonce),
      "Strict native reload must retain prior user history.",
    );
    NodeAssert.ok(
      text("reload").includes("Guest"),
      "Strict native reload must retain the resolved question.",
    );
  });
  const receipt = Effect.gen(function* () {
    const source = yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(cwd, "src/greet.mjs")),
    );
    const ids = events.map(({ event }) => event.eventId);
    NodeAssert.equal(new Set(ids).size, ids.length, "Canonical event ids must remain unique.");
    return {
      modelPromptSent: true,
      modelRouteExecution: "passed",
      sourceEditAcceptance: "passed",
      cancellationAcceptance: "passed",
      nativeHistoryAcceptance: "passed",
      uiAcceptance: "not-run",
      approvedTools: events.filter(
        ({ event }) => event.type === "request.resolved" && event.payload.decision === "accept",
      ).length,
      sourceSha256: NodeCrypto.createHash("sha256").update(source).digest("hex"),
      streamedEvents: events.filter(({ event }) => event.type === "content.delta").length,
      gates: [
        "native-question",
        "approved-native-tools",
        "real-source-edit",
        "source-tests",
        "streamed-thought-and-reply",
        "streamed-diff",
        "native-cancel-receipt",
        "strict-reload-retains-history",
      ],
    };
  });
  return { editAndCancel, afterReload, receipt };
});
