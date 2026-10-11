import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  EventId,
  MessageId,
  type OrchestrationReadModel,
  type OrchestrationCommand,
  OrchestrationEvent,
  supervisorTickDueAt,
} from "@workjet/contracts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const start = "2026-10-11T09:00:00.000Z";
const due = "2026-10-11T09:30:00.000Z";
const afterDowntime = "2026-10-11T12:00:00.000Z";
const projectId = ProjectId.make("tick-project");
const apply = Effect.fn("test.apply")(function* (
  model: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const result = yield* decideOrchestrationCommand({ readModel: model, command });
  const events = Array.isArray(result) ? result : [result];
  let next = model;
  for (const event of events)
    next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
  return { model: next, events: events as readonly Omit<OrchestrationEvent, "sequence">[] };
});
const initial = () =>
  apply(createEmptyReadModel(start), {
    type: "project.create",
    commandId: CommandId.make("tick-create"),
    projectId,
    title: "Control rounds",
    workspaceRoot: null,
    createdAt: start,
  });
const tick = (
  model: OrchestrationReadModel,
  scheduledAt = due,
  createdAt = due,
): OrchestrationCommand => ({
  type: "thread.supervisor.tick",
  threadId: model.threads[0]!.id,
  commandId: CommandId.make(
    "server:supervisor-tick:" + model.threads[0]!.id + ":" + Date.parse(scheduledAt),
  ),
  scheduledAt,
  createdAt,
  text: "Kontrollrunde\nMeasured situation",
});

it.layer(NodeServices.layer)("supervisor control round admission", (it) => {
  it.effect(
    "defaults to 30 minutes, starts a system turn, records its watermark and rejects duplicates",
    () =>
      Effect.gen(function* () {
        const { model } = yield* initial();
        expect(supervisorTickDueAt(start, undefined, undefined)).toBe(Date.parse(due));
        expect((yield* apply(model, tick(model, due, start))).events).toEqual([]);
        const first = yield* apply(model, tick(model));
        expect(first.events.filter((e) => e.type === "thread.turn-start-requested")).toHaveLength(
          1,
        );
        expect(first.model.threads[0]?.messages[0]?.role).toBe("system");
        expect(first.model.threads[0]?.activities[0]?.kind).toBe("supervisor.control-round");
        expect((yield* apply(first.model, tick(first.model))).events).toEqual([]);
      }),
  );
  it.effect("persists disabled and configurable cadence through event projection", () =>
    Effect.gen(function* () {
      let { model } = yield* initial();
      model = (yield* apply(model, {
        type: "project.meta.update",
        commandId: CommandId.make("off"),
        projectId,
        overview: {
          websiteUrl: null,
          slots: [null, null, null],
          supervisorTick: { enabled: false, intervalMinutes: 15 },
        },
      })).model;
      expect((yield* apply(model, tick(model))).events).toEqual([]);
      model = (yield* apply(model, {
        type: "project.meta.update",
        commandId: CommandId.make("on"),
        projectId,
        overview: {
          ...model.projects[0]!.overview!,
          supervisorTick: { enabled: true, intervalMinutes: 15 },
        },
      })).model;
      expect(
        (yield* apply(model, tick(model, "2026-10-11T09:15:00.000Z"))).events.some(
          (e) => e.type === "thread.turn-start-requested",
        ),
      ).toBe(true);
    }),
  );
  it.effect(
    "coalesces missed ticks into one and retains its next due time after restart/replay",
    () =>
      Effect.gen(function* () {
        const { model } = yield* initial();
        const first = yield* apply(model, tick(model, due, afterDowntime));
        expect(first.events.filter((e) => e.type === "thread.turn-start-requested")).toHaveLength(
          1,
        );
        let replayed = model;
        for (const event of first.events)
          replayed = yield* projectEvent(
            replayed,
            yield* decodeEvent({
              ...event,
              sequence: replayed.snapshotSequence + 1,
            }),
          );
        const c = replayed.threads[0]!.workjetConfig;
        expect(
          supervisorTickDueAt(
            start,
            undefined,
            c.schemaVersion === 2 ? c.supervisorTick : undefined,
          ),
        ).toBe(Date.parse(afterDowntime) + 30 * 60000);
        expect((yield* apply(replayed, tick(replayed, due, afterDowntime))).events).toEqual([]);
      }),
  );
  it.effect(
    "consumes busy ticks without queueing, preserving the last completed control watermark",
    () =>
      Effect.gen(function* () {
        const { model } = yield* initial();
        const thread = model.threads[0]!;
        const busy = {
          ...model,
          threads: [
            {
              ...thread,
              messages: [
                {
                  id: MessageId.make("ordinary"),
                  role: "user" as const,
                  text: "Running work",
                  turnId: null,
                  streaming: false,
                  createdAt: "2026-10-11T09:29:00.000Z",
                  updatedAt: "2026-10-11T09:29:00.000Z",
                },
              ],
            },
          ],
        };
        const skipped = yield* apply(busy, tick(busy));
        expect(skipped.events.some((e) => e.type === "thread.turn-start-requested")).toBe(false);
        const config = skipped.model.threads[0]!.workjetConfig;
        expect(config.schemaVersion === 2 && config.supervisorTick?.outcome).toBe("skipped-busy");
        expect(config.schemaVersion === 2 && config.supervisorTick?.lastControlAt).toBeNull();
        expect((yield* apply(skipped.model, tick(skipped.model))).events).toEqual([]);
      }),
  );
  it.effect(
    "skips starting, running and pending-approval supervisors, and rechecks configuration after collection",
    () =>
      Effect.gen(function* () {
        const { model } = yield* initial();
        for (const state of ["starting", "running", "approval"] as const) {
          const thread = model.threads[0]!;
          const busy = {
            ...model,
            threads: [
              {
                ...thread,
                ...(state === "approval"
                  ? {
                      activities: [
                        {
                          id: EventId.make("approval"),
                          tone: "approval" as const,
                          kind: "approval.requested",
                          summary: "Permission",
                          payload: { requestId: "permission" },
                          turnId: null,
                          createdAt: start,
                        },
                      ],
                    }
                  : {
                      session: {
                        threadId: thread.id,
                        status: state,
                        providerName: "codex" as const,
                        providerInstanceId: thread.modelSelection.instanceId,
                        runtimeMode: thread.runtimeMode,
                        activeTurnId: null,
                        lastError: null,
                        updatedAt: start,
                      },
                    }),
              },
            ],
          };
          expect(
            (yield* apply(busy, tick(busy))).events.some(
              (e) => e.type === "thread.turn-start-requested",
            ),
          ).toBe(false);
        }
        const changed = {
          ...model,
          projects: [
            {
              ...model.projects[0]!,
              overview: {
                websiteUrl: null,
                slots: [null, null, null] as const,
                supervisorTick: { enabled: true, intervalMinutes: 60 },
              },
            },
          ],
        };
        expect((yield* apply(changed, tick(changed))).events).toEqual([]);
      }),
  );
});
