import fixture from "../../../packages/contracts/src/fixtures/workjet-supervisor-route-computation-v2.json" with { type: "json" };
import {
  ProjectId,
  SupervisorRouteDisplayV2,
  type CtoxWorkjetProjectControlResult,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { readSupervisorRoute, supervisorActualComputation } from "./workjetSupervisorRoute";
import type { WorkjetProjectControlPort } from "./workjetProjectControl";

const route = Schema.decodeUnknownSync(SupervisorRouteDisplayV2)(
  fixture.valid_cases.find((item) => item.type === "SupervisorRouteDisplay")?.value,
);
const scope = {
  instanceId: "paired:acceptance",
  projectId: ProjectId.make(route.project_id),
  threadId: route.supervisor_thread_id,
};
function portWith(
  mutate: (reply: Record<string, unknown>) => unknown = (reply) => reply,
  calls: string[] = [],
): WorkjetProjectControlPort {
  return async (instanceId, request) => {
    expect(instanceId).toBe(scope.instanceId);
    calls.push(request.action);
    if (
      request.action !== "project.supervisor.route.capabilities.v2" &&
      request.action !== "project.supervisor.route.read.v2"
    )
      throw Error("Unexpected action");
    const reply =
      request.action === "project.supervisor.route.capabilities.v2"
        ? {
            ...request,
            contract: "ctox.workjet.supervisor.route-capabilities.v2",
            capabilities: {
              schema: "ctox.workjet.supervisor.route-capabilities.v2",
              project_id: scope.projectId,
              supervisor_thread_id: scope.threadId,
              read_schema: "ctox.workjet.supervisor.route-display.v2",
              read_command: "ctox.workjet.project.supervisor.route.read.v2",
            },
          }
        : { ...request, contract: "ctox.workjet.supervisor.route-display.v2", route };
    return { _tag: "completed", response: mutate(reply) } as CtoxWorkjetProjectControlResult;
  };
}
describe("verified native computation reader", () => {
  it("negotiates v2 and exposes only the joined native/SDK computation", async () => {
    const calls: string[] = [];
    const state = await readSupervisorRoute(
      scope,
      new AbortController().signal,
      portWith(undefined, calls),
    );
    expect(calls).toEqual([
      "project.supervisor.route.capabilities.v2",
      "project.supervisor.route.read.v2",
    ]);
    const actual = supervisorActualComputation(state);
    expect(actual).toEqual(route.actual);
    expect(actual).toHaveProperty("sdk_turn_id");
    expect(actual).toHaveProperty("upstream_request_id");
    expect(actual).not.toHaveProperty("turn_id");
    expect(actual).not.toHaveProperty("run_id");
  });
  it("does not downgrade a denied read to a different contract", async () => {
    let count = 0;
    const port: WorkjetProjectControlPort = async () => {
      count++;
      return { _tag: "failed", code: "authentication_required" };
    };
    expect(await readSupervisorRoute(scope, new AbortController().signal, port)).toEqual({
      phase: "unavailable",
      code: "authentication_required",
    });
    expect(count).toBe(1);
  });
  it("does not downgrade a supported v2 capability when its read fails", async () => {
    const calls: string[] = [];
    const ordinary = portWith(undefined, calls);
    const state = await readSupervisorRoute(
      scope,
      new AbortController().signal,
      async (instance, request) => {
        if (request.action === "project.supervisor.route.read.v2") {
          calls.push(request.action);
          return { _tag: "failed", code: "unsupported" };
        }
        return ordinary(instance, request);
      },
    );
    expect(state).toEqual({ phase: "unavailable", code: "unsupported" });
    expect(calls).toEqual([
      "project.supervisor.route.capabilities.v2",
      "project.supervisor.route.read.v2",
    ]);
  });
  it.each(["commandId", "projectId", "threadId"])("rejects a foreign %s", async (field) => {
    const state = await readSupervisorRoute(
      scope,
      new AbortController().signal,
      portWith((reply) => ({ ...reply, [field]: "foreign" })),
    );
    expect(state).toEqual({ phase: "unavailable", code: "guest_failed" });
    expect(supervisorActualComputation(state)).toBeNull();
  });
  it("drops a late v2 read after a scope abort", async () => {
    const controller = new AbortController();
    const ordinary = portWith();
    const state = await readSupervisorRoute(scope, controller.signal, async (instance, request) => {
      const result = await ordinary(instance, request);
      if (request.action === "project.supervisor.route.read.v2") controller.abort();
      return result;
    });
    expect(state).toEqual({ phase: "unavailable", code: "canceled" });
  });
  it("does not infer actual execution from a configured route", () => {
    expect(
      supervisorActualComputation({ phase: "ready", route: { ...route, actual: null } }),
    ).toBeNull();
  });
});
