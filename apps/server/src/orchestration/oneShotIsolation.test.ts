// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { CommandId, MessageId, ThreadId } from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { requireOneShotIsolation } from "./oneShotIsolation.ts";
import { readModelForTest } from "./oneShotTestFixture.ts";

it.layer(NodeServices.layer)("one-shot execution and title ownership", (it) => {
  it.effect("rejects shared roots, shared worker paths and unprepared project chats", () =>
    Effect.gen(function* () {
      const valid = readModelForTest();
      const worker = valid.threads[0]!;
      const start = {
        type: "thread.turn.start" as const,
        commandId: CommandId.make("start-worker"),
        threadId: worker.id,
        message: {
          messageId: MessageId.make("first"),
          role: "user" as const,
          text: "Implement the task",
          attachments: [],
        },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdAt: valid.updatedAt,
      };
      yield* decideOrchestrationCommand({ command: start, readModel: valid });
      for (const patch of [
        { worktreePath: valid.projects[0]!.workspaceRoot },
        { branch: "main" },
        { worktreePath: null },
        {
          workjetConfig: {
            schemaVersion: 2 as const,
            role: "standard" as const,
            parent: null,
            managedInstructions: "",
            enabledCapabilityIds: [],
            capabilityBindings: [],
            ctoxSession: null,
          },
        },
      ]) {
        const error = yield* decideOrchestrationCommand({
          command: start,
          readModel: { ...valid, threads: [{ ...worker, ...patch }, valid.threads[1]!] },
        }).pipe(Effect.flip);
        expect(error.message).toContain("worktree");
      }
      const error = yield* decideOrchestrationCommand({
        command: start,
        readModel: {
          ...valid,
          threads: [
            ...valid.threads,
            {
              ...worker,
              id: ThreadId.make("another-worker"),
            },
          ],
        },
      }).pipe(Effect.flip);
      expect(error.message).toContain("exclusively owned");
    }),
  );
  it.effect("blocks unprepared registered project starts even when its supervisor is missing", () =>
    Effect.gen(function* () {
      const model = readModelForTest();
      const original = model.threads[0]!;
      const thread = {
        ...original,
        workjetConfig: {
          schemaVersion: 2 as const,
          role: "standard" as const,
          parent: null,
          managedInstructions: "",
          enabledCapabilityIds: [],
          capabilityBindings: [],
        },
      };
      const registered = {
        ...model,
        projects: model.projects.map((project) => ({
          ...project,
          ctoxRegistration: {
            instanceId: "isolated-project",
            commandId: CommandId.make("registration"),
            status: "confirmed" as const,
          },
        })),
        threads: [thread],
      };
      const result = yield* requireOneShotIsolation(thread, registered).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      yield* requireOneShotIsolation(thread, { ...model, threads: [thread] });
    }),
  );
  it.effect("rejects moving a worker onto another checkout or branch", () =>
    Effect.gen(function* () {
      const model = readModelForTest();
      for (const patch of [
        { branch: "main" },
        { worktreePath: "/source/project" },
        { worktreePath: null },
      ]) {
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("worker-move"),
            threadId: model.threads[0]!.id,
            ...patch,
          },
          readModel: model,
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }),
  );
  it.effect("protects worker titles against provider renaming before and after PR submission", () =>
    Effect.gen(function* () {
      const model = readModelForTest();
      for (const submitted of [false, true]) {
        const worker = model.threads[0]!;
        if (worker.workjetConfig.schemaVersion !== 2) throw new Error("fixture");
        const current = submitted
          ? {
              ...worker,
              workjetConfig: {
                ...worker.workjetConfig,
                pullRequest: {
                  provider: "github" as const,
                  number: 305,
                  url: "https://github.com/metric-space-ai/workjet/pull/305",
                  branch: worker.branch!,
                },
              },
            }
          : worker;
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("provider-title"),
            threadId: worker.id,
            title: "Task text from provider",
            regenerateTitle: true,
          },
          readModel: { ...model, threads: [current, model.threads[1]!] },
        });
        const event = Array.isArray(result) ? result[0]! : result;
        expect(event.type).toBe("thread.meta-updated");
        if (event.type !== "thread.meta-updated") throw new Error("event");
        expect(event.payload.title).toBe(
          submitted ? `#305: ${worker.modelSelection.model}` : worker.title,
        );
        expect(event.payload.regenerateTitle).toBeUndefined();
      }
    }),
  );
});
