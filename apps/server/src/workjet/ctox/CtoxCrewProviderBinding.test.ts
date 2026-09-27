import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, WorkjetConnectionId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration60 from "../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration62 from "../../persistence/Migrations/062_WorkjetCtoxCrewStarts.ts";
import migration63 from "../../persistence/Migrations/063_WorkjetCtoxCrewProviderBinding.ts";
import { CtoxNativeRequests, type NativeTaskRequest } from "./CtoxNativeRequests.ts";

const identity = {
  threadId: ThreadId.make("dev"),
  connectionId: WorkjetConnectionId.make("connection"),
  instanceId: "instance",
  requestKey: "request",
};
const native = {
  attemptId: "attempt",
  commandId: "command",
  taskId: "task",
  executorId: "executor",
  memberId: "member",
};
const providerInstanceId = ProviderInstanceId.make("codex_work");
const providerThreadId = "provider-thread";
const open = CtoxNativeRequests.pipe(Effect.provide(CtoxNativeRequests.layer));
const setup = Effect.gen(function* () {
  yield* migration60;
  yield* migration62;
  const requests = yield* open;
  const request: NativeTaskRequest = {
    operation: "start_crew_execution",
    thread_id: "workjet_private_chat",
    title: "Work",
    instruction: "Work",
    harness: "codex",
    timeout_seconds: 60,
    idempotency_key: identity.requestKey,
  };
  yield* requests.prepare(identity, request, {
    endpoint: "https://ctox.example/mcp",
    token: "test-token",
  });
  yield* requests.recordReceipt(identity, {
    schema: "ctox.project_crew_request.v1",
    command_id: native.commandId,
    task_id: native.taskId,
    thread_id: request.thread_id,
    crew_member_id: native.memberId,
    executor_id: native.executorId,
    status: "accepted",
  });
  return requests;
});

describe("durable Crew provider assignment", () => {
  it.effect("migrates a legacy reservation and retains assignment across reconstruction", () =>
    Effect.gen(function* () {
      const requests = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO workjet_ctox_crew_starts
          (thread_id, request_key, attempt_id, command_id, task_id, executor_id, member_id, reserved_at_ms)
        VALUES (${identity.threadId}, ${identity.requestKey}, ${native.attemptId},
          ${native.commandId}, ${native.taskId}, ${native.executorId}, ${native.memberId}, 123)
      `;
      yield* migration63;
      expect(yield* requests.readCrewStart(identity, native.attemptId)).toEqual({
        ...native,
        providerInstanceId: null,
        providerThreadId: null,
      });
      expect((yield* requests.reserveCrewStart(identity, native)).state).toBe("existing");
      const assigned = yield* requests.bindCrewStartProvider(
        identity,
        native,
        providerInstanceId,
        providerThreadId,
      );
      const restarted = yield* open;
      expect(yield* restarted.readCrewStart(identity, native.attemptId)).toEqual(assigned);
      expect(
        yield* restarted.bindCrewStartProvider(
          identity,
          native,
          providerInstanceId,
          providerThreadId,
        ),
      ).toEqual(assigned);
      expect((yield* restarted.reserveCrewStart(identity, native)).binding).toEqual(assigned);
      expect(yield* sql`SELECT reserved_at_ms FROM workjet_ctox_crew_starts`).toEqual([
        { reserved_at_ms: 123 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("rejects every changed native identity before assigning an unassigned row", () =>
    Effect.gen(function* () {
      const requests = yield* setup;
      yield* migration63;
      const original = (yield* requests.reserveCrewStart(identity, native)).binding;
      for (const changed of [
        { ...native, attemptId: "foreign" },
        { ...native, commandId: "foreign" },
        { ...native, taskId: "foreign" },
        { ...native, executorId: "foreign" },
        { ...native, memberId: "foreign" },
      ]) {
        expect(
          yield* Effect.flip(
            requests.bindCrewStartProvider(identity, changed, providerInstanceId, providerThreadId),
          ),
        ).toMatchObject({ reason: "native-task-reference-conflict" });
        expect(yield* requests.readCrewStart(identity, native.attemptId)).toEqual(original);
      }
      for (const changed of [
        { ...identity, connectionId: WorkjetConnectionId.make("foreign") },
        { ...identity, instanceId: "foreign" },
      ]) {
        expect(
          yield* Effect.flip(
            requests.bindCrewStartProvider(changed, native, providerInstanceId, providerThreadId),
          ),
        ).toMatchObject({ reason: "native-request-conflict" });
      }
      for (const changed of [
        { ...identity, threadId: ThreadId.make("missing") },
        { ...identity, requestKey: "missing" },
      ]) {
        expect(
          yield* Effect.flip(
            requests.bindCrewStartProvider(changed, native, providerInstanceId, providerThreadId),
          ),
        ).toMatchObject({ reason: "native-request-not-found" });
      }
      expect(yield* requests.readCrewStart(identity, native.attemptId)).toEqual(original);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT attempt_id FROM workjet_ctox_crew_starts`).toEqual([
        { attempt_id: native.attemptId },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("rejects invalid values and either changed half of an assigned pair", () =>
    Effect.gen(function* () {
      const requests = yield* setup;
      yield* migration63;
      const original = (yield* requests.reserveCrewStart(identity, native)).binding;
      expect(
        yield* Effect.flip(
          requests.bindCrewStartProvider(identity, native, providerInstanceId, ""),
        ),
      ).toMatchObject({ reason: "native-response-invalid" });
      expect(
        yield* Effect.flip(
          requests.bindCrewStartProvider(
            identity,
            { ...native, memberId: "" },
            providerInstanceId,
            providerThreadId,
          ),
        ),
      ).toMatchObject({ reason: "native-response-invalid" });
      expect(yield* requests.readCrewStart(identity, native.attemptId)).toEqual(original);
      const assigned = yield* requests.bindCrewStartProvider(
        identity,
        native,
        providerInstanceId,
        providerThreadId,
      );
      for (const pair of [
        { providerInstanceId: ProviderInstanceId.make("other"), providerThreadId },
        { providerInstanceId, providerThreadId: "other-thread" },
      ]) {
        expect(
          yield* Effect.flip(
            requests.bindCrewStartProvider(
              identity,
              native,
              pair.providerInstanceId,
              pair.providerThreadId,
            ),
          ),
        ).toMatchObject({ reason: "native-task-reference-conflict" });
        expect(yield* requests.readCrewStart(identity, native.attemptId)).toEqual(assigned);
      }
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("rejects partial and corrupt rows while preserving database error classification", () =>
    Effect.gen(function* () {
      const requests = yield* setup;
      yield* migration63;
      yield* requests.reserveCrewStart(identity, native);
      const sql = yield* SqlClient.SqlClient;
      for (const pair of [
        { instance: providerInstanceId, thread: null },
        { instance: null, thread: providerThreadId },
        { instance: providerInstanceId, thread: "" },
      ]) {
        yield* sql`UPDATE workjet_ctox_crew_starts
          SET provider_instance_id = ${pair.instance}, provider_thread_id = ${pair.thread}`;
        expect(
          yield* Effect.flip(requests.readCrewStart(identity, native.attemptId)),
        ).toMatchObject({
          reason: "native-task-reference-conflict",
        });
        expect(
          yield* Effect.flip(
            requests.bindCrewStartProvider(identity, native, providerInstanceId, providerThreadId),
          ),
        ).toMatchObject({ reason: "native-task-reference-conflict" });
        expect(
          yield* sql`SELECT provider_instance_id, provider_thread_id
          FROM workjet_ctox_crew_starts`,
        ).toEqual([{ provider_instance_id: pair.instance, provider_thread_id: pair.thread }]);
      }
      yield* sql`DROP TABLE workjet_ctox_crew_starts`;
      expect(yield* Effect.flip(requests.readCrewStart(identity, native.attemptId))).toMatchObject({
        reason: "native-request-store-unavailable",
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
