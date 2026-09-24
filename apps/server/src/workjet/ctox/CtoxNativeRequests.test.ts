import { describe, expect, it } from "@effect/vitest";
import { ThreadId, WorkjetConnectionId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration60 from "../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration61 from "../../persistence/Migrations/061_WorkjetCtoxNativeTurns.ts";
import { CtoxNativeRequests, type NativeTaskRequest } from "./CtoxNativeRequests.ts";

const identity = {
  threadId: ThreadId.make("thread-a"),
  connectionId: WorkjetConnectionId.make("connection-a"),
  instanceId: "instance-a",
  requestKey: "request-a",
};
const request: NativeTaskRequest = {
  operation: "modify_app",
  module_id: "inventory",
  instruction: "Add a review action",
  idempotency_key: identity.requestKey,
};
const target = { endpoint: "https://mcp.ctox.dev/mcp/instance-a", token: "test-only-bearer-token" };
const receipt = {
  module_id: "inventory",
  command_type: "ctox.business_os.app.modify",
  command_id: "cmd-native-a",
  task_id: "task-native-a",
};
const open = CtoxNativeRequests.pipe(Effect.provide(CtoxNativeRequests.layer));

describe("durable native CTOX request identity", () => {
  it.effect(
    "pages persisted Crew turn candidates across restart without treating them as claims",
    () =>
      Effect.gen(function* () {
        yield* migration60;
        yield* migration61;
        const requests = yield* open;
        yield* requests.prepareTurn(identity, request, target, "event-non-crew");
        const crewIdentity = {
          ...identity,
          threadId: ThreadId.make("thread-crew"),
          requestKey: "request-crew",
        };
        const crew: NativeTaskRequest = {
          operation: "start_crew_execution",
          thread_id: "workjet_private_chat",
          title: "Crew work",
          instruction: "Review the project",
          harness: "codex",
          timeout_seconds: 60,
          idempotency_key: crewIdentity.requestKey,
        };
        yield* requests.prepareTurn(crewIdentity, crew, target, "event-crew");
        const restarted = yield* open;
        const first = yield* restarted.listCrewRecoveryCandidates(0, 1);
        expect(first.candidates).toEqual([]);
        expect(first.nextSequence).toBe(1);
        const second = yield* restarted.listCrewRecoveryCandidates(first.nextSequence!, 1);
        expect(second.candidates).toEqual([
          { sequence: 2, requestId: "event-crew", identity: crewIdentity },
        ]);
        expect(second.nextSequence).toBe(2);
        expect(
          (yield* restarted.listCrewRecoveryCandidates(second.nextSequence!, 1)).candidates,
        ).toEqual([]);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("rolls back a newly prepared intent when its turn identity conflicts", () =>
    Effect.gen(function* () {
      yield* migration60;
      yield* migration61;
      const requests = yield* open;
      yield* requests.prepareTurn(identity, request, target, "event-shared");
      const conflictingIdentity = { ...identity, requestKey: "request-b" };
      const conflictingRequest = { ...request, idempotency_key: conflictingIdentity.requestKey };
      expect(
        yield* Effect.flip(
          requests.prepareTurn(conflictingIdentity, conflictingRequest, target, "event-shared"),
        ),
      ).toMatchObject({ reason: "native-request-conflict" });
      expect(yield* Effect.flip(requests.get(conflictingIdentity))).toMatchObject({
        reason: "native-request-not-found",
      });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("pins a native project task and accepts only that project's receipt", () =>
    Effect.gen(function* () {
      yield* migration60;
      const requests = yield* open;
      const project: NativeTaskRequest = {
        operation: "start_project_task",
        project_id: "logical-project-a",
        title: "Native project work",
        instruction: "Review this project",
        idempotency_key: identity.requestKey,
      };
      const nativeKey = yield* requests.prepare(identity, project, target);
      const restarted = yield* open;
      expect((yield* restarted.get(identity)).request).toEqual(project);
      expect(yield* restarted.prepare(identity, project, target)).toBe(nativeKey);
      const projectReceipt = {
        schema: "ctox.native_project_task.v1",
        project_id: project.project_id,
        command_id: "cmd-project-a",
        task_id: "task-project-a",
      };
      expect(yield* Effect.flip(restarted.recordReceipt(identity, receipt))).toMatchObject({
        reason: "native-response-invalid",
      });
      expect(
        yield* Effect.flip(
          restarted.recordReceipt(identity, { ...projectReceipt, project_id: "logical-project-b" }),
        ),
      ).toMatchObject({ reason: "native-response-invalid" });
      yield* restarted.recordReceipt(identity, projectReceipt);
      expect(yield* restarted.get(identity)).toMatchObject({
        request: project,
        commandId: projectReceipt.command_id,
        taskId: projectReceipt.task_id,
      });
      expect(
        yield* Effect.flip(
          restarted.prepare(identity, { ...project, instruction: "Different work" }, target),
        ),
      ).toMatchObject({ reason: "native-request-conflict" });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("recovers general native delegation and rejects an app-command receipt", () =>
    Effect.gen(function* () {
      yield* migration60;
      const requests = yield* open;
      const delegated: NativeTaskRequest = {
        operation: "delegate_task",
        module_id: "inventory",
        title: "Review inventory",
        objective: "Identify records that require replenishment",
        record_id: "inventory-1",
        idempotency_key: identity.requestKey,
      };
      const nativeKey = yield* requests.prepare(identity, delegated, target);
      expect(yield* Effect.flip(requests.recordReceipt(identity, receipt))).toMatchObject({
        reason: "native-response-invalid",
      });
      const restarted = yield* open;
      expect((yield* restarted.get(identity)).request).toEqual(delegated);
      expect(yield* restarted.prepare(identity, delegated, target)).toBe(nativeKey);
      yield* restarted.recordReceipt(identity, { ...receipt, command_type: "ctox.delegate_task" });
      expect(yield* restarted.get(identity)).toMatchObject({
        request: delegated,
        commandId: receipt.command_id,
        taskId: receipt.task_id,
      });
      expect(
        yield* Effect.flip(
          restarted.prepare(identity, { ...delegated, objective: "Different work" }, target),
        ),
      ).toMatchObject({ reason: "native-request-conflict" });
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect("recovers prepared intent and the same native task after service reconstruction", () =>
    Effect.gen(function* () {
      yield* migration60;
      const first = yield* open;
      const nativeKey = yield* first.prepare(identity, request, target);
      const restarted = yield* open;
      expect(yield* restarted.get(identity)).toMatchObject({
        request,
        instanceId: identity.instanceId,
        commandId: null,
        taskId: null,
        receivedAt: null,
      });
      expect(yield* restarted.prepare(identity, request, target)).toBe(nativeKey);
      yield* restarted.recordReceipt(identity, receipt);
      const again = yield* open;
      expect(yield* again.get(identity)).toMatchObject({
        request,
        commandId: receipt.command_id,
        taskId: receipt.task_id,
      });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT intent_json, target_digest FROM workjet_ctox_native_requests`;
      expect(rows).toHaveLength(1);
      expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(rows)).not.toContain(
        target.token,
      );
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          yield* again.get(identity),
        ),
      ).not.toContain("targetDigest");
      expect(
        yield* again.prepare(
          { ...identity, threadId: ThreadId.make("independent-thread") },
          request,
          target,
        ),
      ).not.toBe(nativeKey);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect(
    "rejects changed intent, instance, connection and credentials without replacing the claim",
    () =>
      Effect.gen(function* () {
        yield* migration60;
        const requests = yield* open;
        yield* requests.prepare(identity, request, target);
        for (const changed of [
          { identity, request: { ...request, instruction: "Delete the app" } },
          { identity: { ...identity, instanceId: "instance-b" }, request },
          {
            identity: { ...identity, connectionId: WorkjetConnectionId.make("connection-b") },
            request,
          },
        ]) {
          expect(
            yield* Effect.flip(requests.prepare(changed.identity, changed.request, target)),
          ).toMatchObject({ reason: "native-request-conflict" });
        }
        expect(
          yield* Effect.flip(
            requests.prepare(identity, request, { ...target, token: "another-actor-token" }),
          ),
        ).toMatchObject({ reason: "native-request-credentials-changed" });
        expect((yield* requests.get(identity)).request).toEqual(request);
        expect(
          yield* Effect.flip(requests.get({ ...identity, threadId: ThreadId.make("thread-b") })),
        ).toMatchObject({ reason: "native-request-not-found" });
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );

  it.effect(
    "allows only one concurrent intent and refuses replacement native task references",
    () =>
      Effect.gen(function* () {
        yield* migration60;
        const first = yield* open;
        const second = yield* open;
        const outcomes = yield* Effect.all(
          [
            first.prepare(identity, request, target).pipe(Effect.result),
            second
              .prepare(identity, { ...request, instruction: "Another request" }, target)
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
        yield* first.recordReceipt(identity, receipt);
        expect(
          yield* Effect.flip(second.recordReceipt(identity, { ...receipt, task_id: "task-other" })),
        ).toMatchObject({ reason: "native-task-reference-conflict" });
        expect(
          yield* Effect.flip(
            second.recordReceipt(identity, { ...receipt, module_id: "another-app" }),
          ),
        ).toMatchObject({ reason: "native-response-invalid" });
        expect((yield* first.get(identity)).taskId).toBe(receipt.task_id);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
});
