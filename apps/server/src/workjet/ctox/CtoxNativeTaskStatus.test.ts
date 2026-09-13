import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeCtoxNativeTaskStatus } from "./CtoxNativeTaskStatus.ts";
import type { NativeTaskReference } from "./CtoxNativeRequests.ts";

const reference: NativeTaskReference = {
  request: {
    operation: "delegate_task",
    module_id: "inventory",
    title: "Review",
    objective: "Review inventory",
    idempotency_key: "request-1",
  },
  instanceId: "instance-a",
  commandId: "cmd-1",
  taskId: "task-1",
  preparedAt: 1,
  receivedAt: 2,
};
const response = (status: string, data: Record<string, unknown> = {}) => ({
  ok: true,
  record: {
    id: "cmd-1",
    collection: "business_commands",
    status,
    data: { command_id: "cmd-1", task_id: "task-1", module: "inventory", status, ...data },
  },
});

it.effect(
  "uses native queue status and never treats transport acceptance or unknown states as completion",
  () =>
    Effect.gen(function* () {
      for (const [raw, expected] of [
        ["accepted", "queued"],
        ["queued", "queued"],
        ["running", "running"],
        ["waiting_dependencies", "waiting"],
        ["blocked", "waiting"],
        ["retry_wait", "waiting"],
        ["completed", "completed"],
        ["failed", "failed"],
        ["cancelled", "cancelled"],
        ["future-state", "unknown"],
      ] as const) {
        expect((yield* decodeCtoxNativeTaskStatus(reference, response(raw))).state).toBe(expected);
      }
      const observed = yield* decodeCtoxNativeTaskStatus(
        reference,
        response("completed", { task_status: "running", result: "old result" }),
      );
      expect(observed.state).toBe("running");
      expect(observed.reference).toEqual(reference);
      expect(
        (yield* decodeCtoxNativeTaskStatus(
          reference,
          response("failed", { status_note: "Validation failed" }),
        )).note,
      ).toBe("Validation failed");
    }),
);

it.effect("reads Creator-owned app commands using the app record identity", () =>
  Effect.gen(function* () {
    for (const operation of ["create_app", "modify_app"] as const) {
      const appReference: NativeTaskReference = {
        ...reference,
        request: {
          operation,
          module_id: "inventory",
          instruction: "Update inventory",
          idempotency_key: "request-app",
        },
      };
      const data = {
        module: "creator",
        record_id: "inventory",
        command_type:
          operation === "create_app"
            ? "ctox.business_os.app.create"
            : "ctox.business_os.app.modify",
      };
      expect(
        (yield* decodeCtoxNativeTaskStatus(appReference, response("completed", data))).state,
      ).toBe("completed");
      expect(
        yield* Effect.flip(
          decodeCtoxNativeTaskStatus(
            appReference,
            response("completed", { ...data, record_id: "another-app" }),
          ),
        ),
      ).toMatchObject({ reason: "native-response-invalid" });
      expect(
        yield* Effect.flip(
          decodeCtoxNativeTaskStatus(
            appReference,
            response("completed", { ...data, command_type: "ctox.delegate_task" }),
          ),
        ),
      ).toMatchObject({ reason: "native-response-invalid" });
    }
  }),
);

it.effect("refuses status from another command, task, module or collection", () =>
  Effect.gen(function* () {
    const good = response("completed");
    const invalid = [
      { ...good, ok: false },
      { ...good, record: { ...good.record, id: "cmd-other" } },
      { ...good, record: { ...good.record, collection: "ctox_queue_tasks" } },
      { ...good, record: { ...good.record, status: "failed" } },
      response("completed", { command_id: "cmd-other" }),
      response("completed", { command_id: undefined }),
      response("completed", { task_id: "task-other" }),
      response("completed", { task_id: undefined }),
      response("completed", { module: "other-module" }),
      { ok: true, status: "completed" },
    ];
    for (const value of invalid) {
      expect(yield* Effect.flip(decodeCtoxNativeTaskStatus(reference, value))).toMatchObject({
        reason: "native-response-invalid",
      });
    }
    expect(
      yield* Effect.flip(decodeCtoxNativeTaskStatus({ ...reference, commandId: null }, good)),
    ).toMatchObject({ reason: "native-response-invalid" });
  }),
);
