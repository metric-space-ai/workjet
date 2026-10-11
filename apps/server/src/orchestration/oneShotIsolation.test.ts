// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  CommandId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { requireOneShotIsolation } from "./oneShotIsolation.ts";
import { readModelForTest } from "./oneShotTestFixture.ts";
import {
  manualProjectWorkerParent,
  manualProjectWorkerConfig,
} from "../workjet/ManualProjectWorker.ts";

it.layer(NodeServices.layer)("one-shot execution and title ownership", (it) => {
  it.effect(
    "isolates a roleless agent chat using its explicit creator, but leaves human chats alone",
    () =>
      Effect.gen(function* () {
        const fixture = readModelForTest();
        const supervisor = {
          ...fixture.threads[1]!,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        };
        const environmentId = EnvironmentId.make("local");
        for (const parentRole of ["supervisor", "specialist"] as const) {
          const parent =
            parentRole === "supervisor"
              ? supervisor
              : {
                  ...supervisor,
                  id: ThreadId.make("persistent-worker"),
                  workjetConfig: {
                    ...DEFAULT_WORKJET_THREAD_CONFIG,
                    team: {
                      role: "specialist" as const,
                      threadId: ThreadId.make("persistent-worker"),
                      projectId: supervisor.projectId,
                      parentThreadId: supervisor.id,
                      domain: "implementation",
                      goal: "Own implementation",
                      createdAt: fixture.updatedAt,
                    },
                  },
                };
          const threads = parentRole === "supervisor" ? [parent] : [supervisor, parent];
          for (const agentCreated of [true, false]) {
            const id = ThreadId.make(`new-${parentRole}-${agentCreated}`);
            const planned = yield* decideOrchestrationCommand({
              environmentId,
              readModel: { ...fixture, threads },
              command: {
                type: "thread.create",
                commandId: CommandId.make(`create-${id}`),
                threadId: id,
                projectId: supervisor.projectId,
                title: "Implement a task",
                ...(agentCreated ? { createdByThreadId: parent.id } : {}),
                modelSelection: supervisor.modelSelection,
                runtimeMode: supervisor.runtimeMode,
                interactionMode: "default",
                workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
                branch: null,
                worktreePath: null,
                createdAt: fixture.updatedAt,
              },
            });
            const event = Array.isArray(planned) ? planned[0]! : planned;
            if (event.type !== "thread.created") throw new Error("creation event");
            const child = {
              ...fixture.threads[0]!,
              latestUserMessageAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
              id,
              branch: null,
              worktreePath: null,
              workjetConfig: event.payload.workjetConfig,
            };
            const model = { ...fixture, threads: [...threads, child] };
            if (!agentCreated) {
              expect(child.workjetConfig).toEqual(DEFAULT_WORKJET_THREAD_CONFIG);
              expect(manualProjectWorkerParent(child, threads)).toBeUndefined();
              yield* requireOneShotIsolation(child, model);
              continue;
            }
            expect(child.workjetConfig).toMatchObject({
              role: "worker",
              parent: { environmentId, threadId: parent.id },
              team: { role: "worker" },
            });
            expect(manualProjectWorkerParent(child, threads)).toBe(parent);
            expect((yield* requireOneShotIsolation(child, model).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            const prepared = {
              ...child,
              branch: `workjet/worker/${id}`,
              worktreePath: "/new/isolated",
              workjetConfig: manualProjectWorkerConfig(child, parent, environmentId, "One PR"),
            };
            yield* requireOneShotIsolation(prepared, { ...model, threads: [...threads, prepared] });
            expect(manualProjectWorkerParent(prepared, threads)).toBeUndefined();
          }
        }
      }),
  );

  it.effect("honors explicit creation provenance in a history bootstrap", () =>
    Effect.gen(function* () {
      const fixture = readModelForTest();
      const supervisor = fixture.threads[1]!;
      for (const agentCreated of [true, false]) {
        const planned = yield* decideOrchestrationCommand({
          environmentId: EnvironmentId.make("local"),
          readModel: fixture,
          command: {
            type: "thread.history.import",
            commandId: CommandId.make(`history-${agentCreated}`),
            threadId: ThreadId.make(`history-${agentCreated}`),
            messages: [],
            createdAt: fixture.updatedAt,
            bootstrap: {
              createThread: {
                projectId: supervisor.projectId,
                title: "Imported task history",
                ...(agentCreated ? { createdByThreadId: supervisor.id } : {}),
                modelSelection: supervisor.modelSelection,
                runtimeMode: supervisor.runtimeMode,
                interactionMode: "default",
                workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
                branch: null,
                worktreePath: null,
                createdAt: fixture.updatedAt,
              },
            },
          },
        });
        const event = Array.isArray(planned) ? planned[0]! : planned;
        if (event.type !== "thread.created") throw new Error("creation event");
        expect(event.payload.workjetConfig.role).toBe(agentCreated ? "worker" : "standard");
      }
    }),
  );

  it.effect("rejects agent provenance from an ordinary, foreign or unavailable parent", () =>
    Effect.gen(function* () {
      const fixture = readModelForTest();
      const parent = fixture.threads[1]!;
      for (const patch of [
        { workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG },
        { archivedAt: fixture.updatedAt },
        { deletedAt: fixture.updatedAt },
        { projectId: ProjectId.make("foreign-project") },
      ]) {
        const result = yield* decideOrchestrationCommand({
          environmentId: EnvironmentId.make("local"),
          readModel: { ...fixture, threads: [{ ...parent, ...patch }] },
          command: {
            type: "thread.create",
            commandId: CommandId.make("agent-create"),
            threadId: ThreadId.make("new-thread"),
            projectId: parent.projectId,
            createdByThreadId: parent.id,
            title: "One task",
            modelSelection: parent.modelSelection,
            runtimeMode: parent.runtimeMode,
            interactionMode: "default",
            workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
            branch: null,
            worktreePath: null,
            createdAt: fixture.updatedAt,
          },
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }),
  );

  it.effect("rejects shared roots, shared worker paths and inconsistent worker roles", () =>
    Effect.gen(function* () {
      const valid = readModelForTest();
      const worker = valid.threads[0]!;
      if (worker.workjetConfig.schemaVersion !== 2) throw new Error("fixture");
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
            ...worker.workjetConfig,
            schemaVersion: 2 as const,
            role: "standard" as const,
            parent: null,
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
  it.effect(
    "allows ordinary Manual and Luma chats regardless of project registration or checkout",
    () =>
      Effect.gen(function* () {
        const model = readModelForTest();
        const original = model.threads[0]!;
        for (const registered of [false, true]) {
          for (const withSupervisor of [false, true]) {
            for (const worktreePath of [null, model.projects[0]!.workspaceRoot, "/user/checkout"]) {
              for (const managedInstructions of ["", "The existing Luma task"]) {
                const thread = {
                  ...original,
                  branch: "user/branch",
                  worktreePath,
                  workjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, managedInstructions },
                };
                yield* requireOneShotIsolation(thread, {
                  ...model,
                  projects: registered
                    ? model.projects.map((project) => ({
                        ...project,
                        ctoxRegistration: {
                          instanceId: "isolated-project",
                          commandId: CommandId.make("registration"),
                          status: "confirmed" as const,
                        },
                      }))
                    : model.projects,
                  threads: withSupervisor ? [thread, model.threads[1]!] : [thread],
                });
              }
            }
          }
        }
      }),
  );
  it.effect("rejects explicitly commissioned workers without isolation metadata", () =>
    Effect.gen(function* () {
      const model = readModelForTest();
      const worker = model.threads[0]!;
      if (worker.workjetConfig.schemaVersion !== 2) throw new Error("fixture");
      const { team: _team, ...workjetConfig } = worker.workjetConfig;
      const thread = { ...worker, workjetConfig };
      for (const withSupervisor of [false, true]) {
        const result = yield* requireOneShotIsolation(thread, {
          ...model,
          threads: withSupervisor ? [thread, model.threads[1]!] : [thread],
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
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
