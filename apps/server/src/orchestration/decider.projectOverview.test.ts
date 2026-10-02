import {
  CommandId,
  EventId,
  ProjectId,
  type OrchestrationReadModel,
  type ProjectOverview,
} from "@workjet/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
const now = "2026-10-02T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("overview-project");
const overview: ProjectOverview = {
  websiteUrl: "https://example.org",
  slots: [
    { kind: "text", label: "Phase", value: "Review" },
    null,
    { kind: "updated", label: "Changed" },
  ],
};
it.layer(NodeServices.layer)("project overview events", (it) => {
  it.effect("retains metadata over event projection, unrelated edits and explicit clearing", () =>
    Effect.gen(function* () {
      let model = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: EventId.makeUnsafe("create-overview"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.makeUnsafe("create-overview"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("create-overview"),
        metadata: {},
        payload: {
          projectId,
          title: "Overview",
          workspaceRoot: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const update = (
        readModel: OrchestrationReadModel,
        change: { title?: string; overview?: ProjectOverview | null },
        sequence: number,
      ) =>
        Effect.gen(function* () {
          const result = yield* decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.meta.update",
              commandId: CommandId.makeUnsafe(`update-${sequence}`),
              projectId,
              ...change,
            },
          });
          const event = Array.isArray(result) ? result[0]! : result;
          return yield* projectEvent(readModel, { ...event, sequence });
        });
      model = yield* update(model, { overview }, 2);
      expect(model.projects[0]?.overview).toEqual(overview);
      model = yield* update(model, { title: "Renamed" }, 3);
      expect(model.projects[0]?.overview).toEqual(overview);
      expect(model.projects[0]?.title).toBe("Renamed");
      model = yield* update(model, { overview: null }, 4);
      expect(model.projects[0]?.overview).toBeNull();
      expect(model.projects[0]?.workspaceRoot).toBeNull();
    }),
  );
});
