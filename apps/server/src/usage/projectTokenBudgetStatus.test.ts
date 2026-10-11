import { expect, it } from "@effect/vitest";
import {
  DEFAULT_MODEL,
  ProjectId,
  UsageDay,
  UsageReadError,
  type OrchestrationProject,
  type UsageSummary,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { UsageService } from "./UsageService.ts";
import { readProjectTokenBudgetStatus } from "./projectTokenBudgetStatus.ts";

const now = Date.parse("2026-10-14T10:00:00Z");
const project: OrchestrationProject = {
  id: ProjectId.make("budget"),
  title: "Budget",
  workspaceRoot: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  deletedAt: null,
  overview: {
    websiteUrl: null,
    slots: [null, null, null],
    regularMeeting: { weekday: 3, time: "13:00", timezone: "Europe/Berlin" },
    tokenBudget: {
      limitBillions: 2.3,
      revision: 1,
      jourFixe: { weekday: 3, time: "13:00", timezone: "Europe/Berlin" },
    },
  },
};
const summary: UsageSummary = {
  contractVersion: 4,
  readAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  timeZone: "Europe/Berlin",
  sinceDay: UsageDay.make("2026-10-07"),
  untilDay: UsageDay.make("2026-10-14"),
  buckets: [
    {
      day: UsageDay.make("2026-10-14"),
      provider: "codex",
      model: DEFAULT_MODEL,
      totals: {
        uncachedInputTokens: 1e9,
        cachedInputTokens: 0.3e9,
        outputTokens: 0.54e9,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: 1,
      unpricedRecords: 1,
      sessions: 1,
    },
  ],
  projectThreads: [],
  sources: [],
  pricing: { status: "unavailable", source: "fixture", fetchedAt: null, knownModels: 0 },
  scanDurationMs: 0,
};
it.effect(
  "uses canonical project input, cached input and output in the current source meeting cycle",
  () =>
    Effect.gen(function* () {
      const result = yield* readProjectTokenBudgetStatus(project, now).pipe(
        Effect.provideService(UsageService, {
          readSummary: (input) => {
            expect(input).toMatchObject({
              projectId: project.id,
              sinceTime: "2026-10-07T11:00:00.000Z",
              untilTime: "2026-10-14T11:00:00.000Z",
            });
            return Effect.succeed(summary);
          },
        }),
      );
      expect(result).toMatchObject({
        consumedTokens: 1.84e9,
        limitBillions: 2.3,
        usageStatus: "measured",
        unknownThreads: 0,
      });
      expect(result.usedPercent).toBeCloseTo(80);
    }),
);
it.effect("reports consumption without a limit and shows unknown thread usage", () =>
  Effect.gen(function* () {
    const result = yield* readProjectTokenBudgetStatus(
      {
        ...project,
        overview: {
          ...project.overview!,
          tokenBudget: { limitBillions: null, revision: 2, jourFixe: null },
        },
      },
      now,
    ).pipe(
      Effect.provideService(UsageService, {
        readSummary: () =>
          Effect.succeed({
            ...summary,
            projectThreads: [
              {
                projectId: project.id,
                threadId: "missing",
                title: "Missing",
                role: "worker",
                status: "unknown",
              },
            ],
          }),
      }),
    );
    expect(result).toMatchObject({
      consumedTokens: 1.84e9,
      limitBillions: null,
      usedPercent: null,
      usageStatus: "incomplete",
      unknownThreads: 1,
    });
  }),
);
it.effect("falls back to unknown on failed usage instead of failing a control round", () =>
  Effect.gen(function* () {
    const result = yield* readProjectTokenBudgetStatus(project, now).pipe(
      Effect.provideService(UsageService, {
        readSummary: () =>
          Effect.fail(new UsageReadError({ reason: "scanFailed", detail: "Fixture unavailable" })),
      }),
    );
    expect(result).toMatchObject({
      consumedTokens: null,
      usedPercent: null,
      usageStatus: "unavailable",
      unknownThreads: null,
    });
  }),
);
it.effect("uses the calendar week after a source meeting is removed", () =>
  Effect.gen(function* () {
    const result = yield* readProjectTokenBudgetStatus(
      {
        ...project,
        overview: {
          ...project.overview!,
          regularMeeting: null,
          tokenBudget: { ...project.overview!.tokenBudget!, jourFixe: null },
        },
      },
      now,
    );
    expect(result.cycle).toMatchObject({
      start: "2026-10-11T22:00:00.000Z",
      end: "2026-10-18T22:00:00.000Z",
    });
    expect(result.usageStatus).toBe("unavailable");
  }),
);
