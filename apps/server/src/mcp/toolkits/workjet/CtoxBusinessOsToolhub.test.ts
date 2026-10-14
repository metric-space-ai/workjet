import { ThreadId, WorkjetCtoxBusinessOsInput } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { toolhubIdentity } from "./CtoxBusinessOsTool.ts";

const decode = Schema.decodeUnknownSync(WorkjetCtoxBusinessOsInput, { onExcessProperty: "error" });

describe("ctox_business_os Toolhub operations", () => {
  it("accepts list, catalog, exec and needs_user", () => {
    expect(decode({ request: { operation: "toolhub_list" } }).request.operation).toBe(
      "toolhub_list",
    );
    expect(decode({ request: { operation: "toolhub_catalog", toolkit: "jira" } })).toBeTruthy();
    expect(
      decode({
        request: {
          operation: "toolhub_exec",
          tool: "github.LIST_ISSUES",
          arguments: { owner: "metric-space-ai", repo: "ctox" },
        },
      }),
    ).toBeTruthy();
    expect(
      decode({ request: { operation: "toolhub_needs_user", toolkit: "jira", reason: "x" } }),
    ).toBeTruthy();
  });

  it("never lets the model choose thread or role", () => {
    expect(() =>
      decode({ request: { operation: "toolhub_list", team_role: "supervisor" } }),
    ).toThrow();
    expect(() =>
      decode({
        request: { operation: "toolhub_needs_user", toolkit: "jira", thread_id: "other" },
      }),
    ).toThrow();
    expect(() =>
      decode({ request: { operation: "toolhub_exec", tool: "../etc", arguments: {} } }),
    ).toThrow();
  });

  it.each([
    [{ projectTeamRole: "supervisor" as const }, "supervisor"],
    [{ projectTeamRole: "specialist" as const }, "persistent_worker"],
    [{ projectTeamRole: "worker" as const }, "one_shot_worker"],
    [{ workjetRole: "worker" as const }, "one_shot_worker"],
    [{ workjetRole: "orchestrator" as const }, "operator"],
    [{ workjetRole: "standard" as const }, "operator"],
  ])("maps %o to team_role %s from the trusted scope", (role, expected) => {
    expect(toolhubIdentity({ threadId: ThreadId.make("thread-1"), ...role })).toEqual({
      thread_id: "thread-1",
      team_role: expected,
    });
  });
});
