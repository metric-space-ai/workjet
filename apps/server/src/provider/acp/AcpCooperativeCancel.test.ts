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
  "../../../scripts/acp-cooperative-cancel-mock.mjs",
);

describe("ACP cooperative cancellation", () => {
  it.effect("keeps a prompt pending until the agent responds, then accepts a follow-up", () =>
    Effect.gen(function* () {
      const permissionReceived = yield* Deferred.make<void>();
      const cancelReceived = yield* Deferred.make<void>();
      const permissionResponse = yield* Deferred.make<{
        readonly outcome: { readonly outcome: "cancelled" };
      }>();
      const settled = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        yield* runtime.handleRequestPermission(() =>
          Deferred.succeed(permissionReceived, undefined).pipe(
            Effect.andThen(Deferred.await(permissionResponse)),
          ),
        );
        yield* runtime.handleReadTextFile(() =>
          Deferred.succeed(cancelReceived, undefined).pipe(Effect.as({ content: "receipt" })),
        );
        yield* runtime.start();
        const prompt = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "first" }] })
          .pipe(
            Effect.ensuring(Deferred.succeed(settled, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.await(permissionReceived);
        yield* runtime.cancel;
        yield* Deferred.await(cancelReceived);
        expect(yield* Deferred.isDone(settled)).toBe(false);
        yield* Deferred.succeed(permissionResponse, { outcome: { outcome: "cancelled" } } as const);
        expect(yield* Fiber.join(prompt)).toMatchObject({ stopReason: "cancelled" });
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
            },
            cwd: process.cwd(),
            clientInfo: { name: "workjet-test", version: "0" },
            authMethodId: "test",
            cancelPromptMode: "await-response",
            clientCapabilities: { fs: { readTextFile: true } },
          }),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
