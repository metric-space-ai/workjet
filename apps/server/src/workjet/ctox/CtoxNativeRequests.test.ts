import { describe, expect, it } from "@effect/vitest";
import { ThreadId, WorkjetConnectionId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import migration60 from "../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import { CtoxNativeRequests, type NativeAppRequest } from "./CtoxNativeRequests.ts";

const identity = {
  threadId: ThreadId.make("thread-a"),
  connectionId: WorkjetConnectionId.make("connection-a"),
  instanceId: "instance-a",
  requestKey: "request-a",
};
const request: NativeAppRequest = {
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
