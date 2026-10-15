import fixture from "../../../packages/contracts/src/fixtures/workjet-supervisor-route-display-v1.json" with { type: "json" };
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  ProjectId,
  SupervisorRouteDisplay,
  type CtoxWorkjetProjectControlResult,
} from "@workjet/contracts";
import { readSupervisorRoute, supervisorRouteLabel } from "./workjetSupervisorRoute";
import type { WorkjetProjectControlPort } from "./workjetProjectControl";
const route = Schema.decodeUnknownSync(SupervisorRouteDisplay)(
  fixture.valid_cases.find((item) => item.type === "SupervisorRouteDisplay")?.value,
);
const scope = {
  instanceId: "paired:acceptance",
  projectId: ProjectId.make(route.project_id),
  threadId: route.supervisor_thread_id,
};
function portWith(
  mutate: (reply: Record<string, unknown>) => unknown = (value) => value,
  calls: string[] = [],
): WorkjetProjectControlPort {
  return async (instance, request) => {
    expect(instance).toBe(scope.instanceId);
    calls.push(request.action);
    if (request.action === "project.supervisor.route.capabilities.v2")
      return { _tag: "failed", code: "unsupported" };
    if (
      request.action !== "project.supervisor.route.capabilities.v1" &&
      request.action !== "project.supervisor.route.read.v1"
    )
      throw Error("Unexpected action");
    const reply =
      request.action === "project.supervisor.route.capabilities.v1"
        ? {
            ...request,
            contract: "ctox.workjet.supervisor.route-capabilities.v1",
            capabilities: {
              schema: "ctox.workjet.supervisor.route-capabilities.v1",
              project_id: scope.projectId,
              supervisor_thread_id: scope.threadId,
              read_schema: "ctox.workjet.supervisor.route-display.v1",
              read_command: "ctox.workjet.project.supervisor.route.read.v1",
            },
          }
        : { ...request, contract: "ctox.workjet.supervisor.route-display.v1", route };
    return { _tag: "completed", response: mutate(reply) } as CtoxWorkjetProjectControlResult;
  };
}
describe("Supervisor route reader", () => {
  it("negotiates before the scoped native read and labels only configured facts", async () => {
    const calls: string[] = [];
    const state = await readSupervisorRoute(
      scope,
      new AbortController().signal,
      portWith(undefined, calls),
    );
    expect(calls).toEqual([
      "project.supervisor.route.capabilities.v2",
      "project.supervisor.route.capabilities.v1",
      "project.supervisor.route.read.v1",
    ]);
    expect(state.phase).toBe("ready");
    if (route.configured === null)
      throw new Error("Pinned route fixture must include a configured Luma");
    expect(supervisorRouteLabel(state).model).toContain(
      `Configured · ${route.configured.harness} · ${route.configured.model}`,
    );
    expect(supervisorRouteLabel(state).title).toContain("No verified execution receipt");
  });
  it("never reads on a legacy connection or changes its send capability", async () => {
    let calls = 0;
    const port: WorkjetProjectControlPort = async () => {
      calls++;
      return { _tag: "failed", code: "unsupported" };
    };
    expect(await readSupervisorRoute(scope, new AbortController().signal, port)).toEqual({
      phase: "unavailable",
      code: "unsupported",
    });
    expect(calls).toBe(2);
  });
  it("rejects another thread or operation even if the schema is valid", async () => {
    for (const mutation of [
      { commandId: "different" },
      { threadId: "e28290b0-7b0a-4d19-a242-f27041fadb84" },
    ]) {
      const state = await readSupervisorRoute(
        scope,
        new AbortController().signal,
        portWith((reply) => ({ ...reply, ...mutation })),
      );
      expect(state).toEqual({ phase: "unavailable", code: "guest_failed" });
    }
  });
  it("drops late capabilities after a scope transition without fetching the route", async () => {
    const controller = new AbortController(),
      calls: string[] = [];
    const ordinary = portWith(undefined, calls);
    const state = await readSupervisorRoute(scope, controller.signal, async (instance, request) => {
      const result = await ordinary(instance, request);
      controller.abort();
      return result;
    });
    expect(state).toEqual({ phase: "unavailable", code: "canceled" });
    expect(calls).toHaveLength(1);
  });
  it("keeps missing details visible without inventing a model", () => {
    expect(supervisorRouteLabel({ phase: "unavailable", code: "unsupported" })).toEqual({
      model: "Instance model",
      computer: "Project instance",
      title:
        "Route details unavailable (unsupported). Execution remains managed by the project instance.",
    });
  });
});
