// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const mockAgentPath = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);

describe("ACP cooperative cancellation", () => {
  it.effect("keeps a prompt pending until the agent responds, then accepts a follow-up", () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        yield* runtime.start();
        const prompt = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "first" }] })
          .pipe(
            Effect.ensuring(Deferred.succeed(settled, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.await(requestStarted);
        yield* runtime.cancel;
        expect(yield* Deferred.isDone(settled)).toBe(false);
        expect(yield* Fiber.join(prompt)).toMatchObject({ stopReason: "end_turn" });
        expect(
          yield* runtime.prompt({ prompt: [{ type: "text", text: "follow-up" }] }),
        ).toMatchObject({
          stopReason: "end_turn",
        });
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: process.execPath,
              args: [mockAgentPath],
              env: { WORKJET_ACP_PROMPT_DELAY_MS: "1000" },
            },
            cwd: process.cwd(),
            clientInfo: { name: "workjet-test", version: "0" },
            authMethodId: "test",
            cancelPromptMode: "await-response",
            requestLogger: (event) =>
              event.method === "session/prompt" && event.status === "started"
                ? Deferred.succeed(requestStarted, undefined).pipe(Effect.asVoid)
                : Effect.void,
          }),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
