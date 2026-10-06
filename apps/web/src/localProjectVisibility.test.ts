import { EnvironmentId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { localProjectIsVisible } from "./localProjectVisibility";
import type { BusinessOsCodeScopeSnapshot } from "./businessOsCodeScope";
const primary = EnvironmentId.make("local-primary");
const remote = EnvironmentId.make("remote-computer");
const scope: BusinessOsCodeScopeSnapshot = {
  phase: "blocked",
  presentationInstanceId: "welsch",
  businessOsInstanceId: null,
  environmentIds: new Set(),
  blocker: "authority-unavailable",
};
const context = { scope, selectedInstanceId: "welsch", primaryEnvironmentId: primary };
describe("local logical project visibility before computer assignment", () => {
  it("keeps the saved current-tenant project and retained supervisor reachable", () => {
    expect(
      localProjectIsVisible(
        { environmentId: primary, ctoxRegistration: { instanceId: "welsch" } },
        context,
      ),
    ).toBe(true);
  });
  it("does not expose another tenant, a legacy local project, or an unassigned remote computer", () => {
    expect(
      localProjectIsVisible(
        { environmentId: primary, ctoxRegistration: { instanceId: "other" } },
        context,
      ),
    ).toBe(false);
    expect(localProjectIsVisible({ environmentId: primary }, context)).toBe(false);
    expect(
      localProjectIsVisible(
        { environmentId: remote, ctoxRegistration: { instanceId: "welsch" } },
        context,
      ),
    ).toBe(false);
  });
  it("hides the project after switching tenant or clearing the selection", () => {
    const project = { environmentId: primary, ctoxRegistration: { instanceId: "welsch" } };
    expect(localProjectIsVisible(project, { ...context, selectedInstanceId: "other" })).toBe(false);
    expect(localProjectIsVisible(project, { ...context, selectedInstanceId: null })).toBe(false);
    expect(localProjectIsVisible(project, { ...context, primaryEnvironmentId: null })).toBe(false);
  });
});
