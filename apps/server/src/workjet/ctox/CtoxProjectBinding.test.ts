import { describe, expect, it } from "@effect/vitest";
import {
  BusinessOsInstanceId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  ProjectId,
  ThreadId,
  WorkjetConnectionId,
  type OrchestrationThreadShell,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { bindCtoxConnectionInstance } from "./CtoxConnectionBinding.ts";
import { resolveCtoxProjectBinding } from "./CtoxProjectBinding.ts";

const threadId = ThreadId.make("code-thread");
const projectId = ProjectId.make("physical-code-project");
const nativeProjectId = "native-logical-project";
const instanceId = BusinessOsInstanceId.make("native-welsch");
const connectionId = WorkjetConnectionId.make("welsch-ctox");
const config = {
  ...DEFAULT_WORKJET_THREAD_CONFIG,
  ctoxSession: { instanceId: "managed:welsch", sessionId: "native-session", fenceEpoch: 1 },
  ctoxProject: {
    codeProjectId: projectId,
    codeThreadId: threadId,
    presentationInstanceId: "managed:welsch",
    businessOsInstanceId: instanceId,
    nativeProjectId,
    workingCopyId: "native-copy",
    nativeSessionId: "native-session",
  },
};
const input = {
  threadId,
  binding: { connectionId, instanceId },
};
const thread = {
  id: threadId,
  projectId,
  workjetConfig: config,
} as unknown as OrchestrationThreadShell;
const projectedThread = (value: OrchestrationThreadShell | null) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getThreadShellById: () => Effect.succeed(value === null ? Option.none() : Option.some(value)),
  } as unknown as ProjectionSnapshotQueryShape);

describe("resolveCtoxProjectBinding", () => {
  it.effect("returns the confirmed native ID only through the pinned connection", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* bindCtoxConnectionInstance(connectionId, instanceId);
      expect(yield* resolveCtoxProjectBinding(input)).toEqual({
        connectionId,
        instanceId,
        nativeProjectId,
        workingCopyId: "native-copy",
        nativeSessionId: "native-session",
      });
      expect(
        yield* Effect.flip(
          resolveCtoxProjectBinding(input).pipe(
            Effect.provide(
              projectedThread({ ...thread, projectId: ProjectId.make("another-physical") }),
            ),
          ),
        ),
      ).toMatchObject({ reason: "thread-project-mismatch" });
      expect(
        yield* Effect.flip(
          resolveCtoxProjectBinding(input).pipe(
            Effect.provide(
              projectedThread({
                ...thread,
                workjetConfig: {
                  ...config,
                  ctoxSession: { ...config.ctoxSession, sessionId: "foreign-session" },
                },
              }),
            ),
          ),
        ),
      ).toMatchObject({ reason: "session-mismatch" });
      expect(
        yield* Effect.flip(
          resolveCtoxProjectBinding(input).pipe(Effect.provide(projectedThread(null))),
        ),
      ).toMatchObject({ reason: "thread-unavailable" });
      expect(
        yield* Effect.flip(
          resolveCtoxProjectBinding({
            ...input,
            binding: { connectionId, instanceId: "another-instance" },
          }),
        ),
      ).toMatchObject({ reason: "instance-mismatch" });
      expect(
        yield* Effect.flip(
          resolveCtoxProjectBinding({
            ...input,
            binding: { connectionId: WorkjetConnectionId.make("unpinned"), instanceId },
          }),
        ),
      ).toMatchObject({ reason: "connection-unverified" });
    }).pipe(
      Effect.provide(projectedThread(thread)),
      Effect.provide(NodeSqliteClient.layerMemory()),
    ),
  );
});
