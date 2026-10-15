import fixture from "./fixtures/workjet-supervisor-route-computation-v2.json" with { type: "json" };
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  SupervisorRouteCapabilitiesV2,
  SupervisorRouteDisplayV2,
} from "./workjetSupervisorRouteV2.ts";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { CtoxWorkjetProjectControlResponse, isWorkjetSupervisorReceiptForRequest } from "./ctox.ts";

const schemas = {
  SupervisorRouteDisplay: SupervisorRouteDisplayV2,
  SupervisorRouteCapabilities: SupervisorRouteCapabilitiesV2,
} as const;

describe("pinned native v2 computation contract", () => {
  it("accepts the native display/capability fixtures with exact public field names", () => {
    for (const item of fixture.valid_cases) {
      if (item.type === "SupervisorRouteDisplay")
        expect(() =>
          Schema.decodeUnknownSync(schemas.SupervisorRouteDisplay, { onExcessProperty: "error" })(
            item.value,
          ),
        ).not.toThrow();
      if (item.type === "SupervisorRouteCapabilities")
        expect(() =>
          Schema.decodeUnknownSync(schemas.SupervisorRouteCapabilities, {
            onExcessProperty: "error",
          })(item.value),
        ).not.toThrow();
    }
  });
  it("rejects native negative display cases without relabelling SDK IDs", () => {
    for (const item of fixture.invalid_cases) {
      if (item.type === "SupervisorRouteDisplay")
        expect(() =>
          Schema.decodeUnknownSync(SupervisorRouteDisplayV2, { onExcessProperty: "error" })(
            item.value,
          ),
        ).toThrow();
    }
  });
  it("correlates both the v2 outer receipt and its inner project/thread", () => {
    const route = Schema.decodeUnknownSync(SupervisorRouteDisplayV2)(
      fixture.valid_cases.find((item) => item.type === "SupervisorRouteDisplay")?.value,
    );
    const request = {
      action: "project.supervisor.route.read.v2" as const,
      commandId: CommandId.make("read-route-v2"),
      projectId: ProjectId.make(route.project_id),
      threadId: route.supervisor_thread_id,
    };
    const reply = { ...request, contract: "ctox.workjet.supervisor.route-display.v2", route };
    const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
      onExcessProperty: "error",
    });
    expect(isWorkjetSupervisorReceiptForRequest(request, decode(reply))).toBe(true);
    for (const mutation of [
      { commandId: "different-operation" },
      { projectId: "foreign" },
      { threadId: "e28290b0-7b0a-4d19-a242-f27041fadb84" },
      { route: { ...route, project_id: "foreign" } },
      { route: { ...route, supervisor_thread_id: "foreign" } },
    ])
      expect(isWorkjetSupervisorReceiptForRequest(request, decode({ ...reply, ...mutation }))).toBe(
        false,
      );
  });
});
