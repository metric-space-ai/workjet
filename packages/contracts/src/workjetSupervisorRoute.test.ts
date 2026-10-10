import fixture from "./fixtures/workjet-supervisor-route-display-v1.json" with { type: "json" };
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { CtoxWorkjetProjectControlRequest, CtoxWorkjetProjectControlResponse, isWorkjetSupervisorReceiptForRequest } from "./ctox.ts";
import * as routes from "./workjetSupervisorRoute.generated.ts";

const decodeReply = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, { onExcessProperty: "error" });
const request = { action: "project.supervisor.route.read.v1" as const, commandId: CommandId.make("read-route"), projectId: ProjectId.make("project"), threadId: "cc6cfe73-2824-4360-9daf-3b3efb079931" };
const route = Schema.decodeUnknownSync(routes.SupervisorRouteDisplay)(fixture.valid_cases.find((item) => item.type === "SupervisorRouteDisplay")?.value);
const reply = { ...request, contract: "ctox.workjet.supervisor.route-display.v1", route };
describe("native Supervisor route display", () => {
  it("matches the pinned native valid and private-field rejection corpus", () => {
    for (const item of fixture.valid_cases) {
      const decoder = routes[item.type as keyof typeof routes];
      expect(Schema.decodeUnknownSync(decoder)(item.value)).toEqual(item.value);
    }
    for (const item of fixture.invalid_cases) {
      const decoder = routes[item.type as keyof typeof routes];
      expect(() => Schema.decodeUnknownSync(decoder, { onExcessProperty: "error" })(item.value)).toThrow();
    }
  });
  it("negotiates a separate versioned read without expanding turn capabilities", () => {
    expect(Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest)(request)).toEqual(request);
    expect(decodeReply(reply).action).toBe(request.action);
  });
  it("fences operation, project and thread including the inner DTO", () => {
    const matched = decodeReply(reply);
    expect(isWorkjetSupervisorReceiptForRequest(request, matched)).toBe(true);
    for (const mutation of [{ commandId: CommandId.make("different-operation") }, { projectId: ProjectId.make("foreign") }, { threadId: "e28290b0-7b0a-4d19-a242-f27041fadb84" }, { route: { ...route, project_id: "foreign" } }, { route: { ...route, supervisor_thread_id: "foreign" } }]) {
      expect(isWorkjetSupervisorReceiptForRequest(request, decodeReply({ ...reply, ...mutation }))).toBe(false);
    }
  });
  it("rejects a claimed actual producer on the current read contract", () => {
    const configured = route.configured;
    expect(() => decodeReply({ ...reply, route: { ...route, actual: { ...configured, run_id: "unverified-run", turn_id: "unverified-turn", receipt_id: "unverified-receipt" } } })).toThrow();
  });
});
