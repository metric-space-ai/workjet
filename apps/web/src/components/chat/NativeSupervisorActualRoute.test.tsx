import fixture from "../../../../../packages/contracts/src/fixtures/workjet-supervisor-route-computation-v2.json" with { type: "json" };
import { SupervisorRouteDisplayV2 } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { NativeSupervisorActualRoute } from "./NativeSupervisorActualRoute";

const route = Schema.decodeUnknownSync(SupervisorRouteDisplayV2)(
  fixture.valid_cases.find((item) => item.type === "SupervisorRouteDisplay")?.value,
);
describe("observed Supervisor model", () => {
  it("shows the native observed harness/model without displaying private selectors or raw IDs", () => {
    if (!route.actual) throw Error("Pinned fixture must contain an observed computation");
    const html = renderToStaticMarkup(
      <NativeSupervisorActualRoute state={{ phase: "ready", route }} />,
    );
    expect(html).toContain("Last execution · Claude Code · claude-opus-5-5");
    expect(html).not.toContain(route.actual.account_id);
    expect(html).not.toContain(route.actual.sdk_session_id);
    expect(html).not.toContain("Configured ·");
  });
  it("does not render a status from configuration, missing proof or an unavailable scope", () => {
    expect(
      renderToStaticMarkup(
        <NativeSupervisorActualRoute
          state={{ phase: "ready", route: { ...route, actual: null } }}
        />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <NativeSupervisorActualRoute state={{ phase: "unavailable", code: "unsupported" }} />,
      ),
    ).toBe("");
  });
});
