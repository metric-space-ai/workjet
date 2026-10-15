import {
  EnvironmentId,
  ThreadId,
  type ChangeRequest,
  type OrchestrationCommand,
  type RemoteWorkerRequest,
} from "@workjet/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { readModelForTest } from "../orchestration/oneShotTestFixture.ts";
import { reportRemoteWorkerSubmission } from "./WorkerSubmission.ts";
const model = readModelForTest();
const worker = model.threads[0]!;
const parent = model.threads[1]!;
const request = {
  requestId: worker.id,
  parent: { environmentId: EnvironmentId.make("local"), threadId: parent.id },
  project: { id: worker.projectId },
  modelSelection: worker.modelSelection,
  createdAt: worker.createdAt,
} as RemoteWorkerRequest;
const notice = {
  pullRequest: {
    provider: "github" as const,
    number: 305,
    url: "https://github.com/metric-space-ai/workjet/pull/305",
    branch: worker.branch!,
  },
  headOid: "a".repeat(40),
};
const pr: ChangeRequest = {
  provider: "github",
  number: 305,
  title: "Worker result",
  url: notice.pullRequest.url,
  baseRefName: "main",
  headRefName: worker.branch!,
  headCommitOid: notice.headOid,
  state: "open",
  updatedAt: Option.none(),
  isCrossRepository: false,
};
function run(payload: unknown, results: readonly ChangeRequest[] = [pr], input = request) {
  const commands: OrchestrationCommand[] = [];
  return reportRemoteWorkerSubmission(input, payload).pipe(
    Effect.provideService(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
    } as ServerEnvironment["Service"]),
    Effect.provideService(ProjectionSnapshotQuery, {
      getCommandReadModel: () => Effect.succeed(model),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Effect.provideService(SourceControlProviderRegistry, {
      resolve: () =>
        Effect.succeed({
          kind: "github",
          listChangeRequests: () => Effect.succeed(results),
        }),
    } as unknown as SourceControlProviderRegistry["Service"]),
    Effect.provideService(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineService["Service"]),
    Effect.as(commands),
  );
}
describe("remote PR result on the authoritative parent", () => {
  it.effect(
    "writes a clickable PR to the source parent using retained ids and retry-stable commands",
    () =>
      Effect.gen(function* () {
        const commands = yield* run(notice);
        const retry = yield* run(notice);
        assert.deepEqual(commands, retry);
        assert.equal(commands.length, 2);
        if (commands[0]!.type === "thread.message.assistant.delta") {
          assert.equal(commands[0]!.threadId, parent.id);
          assert.include(commands[0]!.delta, "[PR #305](");
          assert.include(commands[0]!.delta, worker.modelSelection.model);
          assert.equal(
            commands[0]!.messageId,
            commands[1]!.type === "thread.message.assistant.complete" ? commands[1]!.messageId : "",
          );
        }
      }),
  );
  it.effect("rejects unverified, ambiguous, forked and foreign-parent notices", () =>
    Effect.gen(function* () {
      for (const results of [
        [],
        [pr, pr],
        [{ ...pr, headCommitOid: "b".repeat(40) }],
        [{ ...pr, isCrossRepository: true }],
        [{ ...pr, headRefName: "main" }],
      ]) {
        const result = yield* run(notice, results).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }
      const wrongBranch = yield* run({
        ...notice,
        pullRequest: { ...notice.pullRequest, branch: "main" },
      }).pipe(Effect.result);
      assert.equal(wrongBranch._tag, "Failure");
      const foreign = yield* run(notice, [pr], {
        ...request,
        parent: { ...request.parent, threadId: ThreadId.make("foreign") },
      }).pipe(Effect.result);
      assert.equal(foreign._tag, "Failure");
    }),
  );
});
