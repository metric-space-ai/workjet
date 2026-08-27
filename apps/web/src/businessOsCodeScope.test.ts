import { BusinessOsInstanceId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  businessOsCodeScopeContainsEnvironment,
  projectBusinessOsEnvironmentIds,
  type BusinessOsCodeScopeSnapshot,
} from "./businessOsCodeScope";

const WELSCH = BusinessOsInstanceId.make("business-os-welsch");
const OTHER = BusinessOsInstanceId.make("business-os-other");
const WELSCH_ENV = EnvironmentId.make("environment-welsch");
const OTHER_ENV = EnvironmentId.make("environment-other");
const UNSCOPED_RELAY = EnvironmentId.make("environment-unscoped-relay");
const PRIMARY_ENV = EnvironmentId.make("environment-primary");
const SSH_ENV = EnvironmentId.make("environment-ssh");

describe("Business OS Code scope", () => {
  it("projects only Relay environments attested for the exact active instance", () => {
    const entries = new Map([
      [WELSCH_ENV, { target: { _tag: "RelayConnectionTarget", businessOsInstanceId: WELSCH } }],
      [OTHER_ENV, { target: { _tag: "RelayConnectionTarget", businessOsInstanceId: OTHER } }],
      [UNSCOPED_RELAY, { target: { _tag: "RelayConnectionTarget" } }],
      [PRIMARY_ENV, { target: { _tag: "PrimaryConnectionTarget" } }],
      [SSH_ENV, { target: { _tag: "SshConnectionTarget" } }],
    ]);

    expect([...projectBusinessOsEnvironmentIds(WELSCH, entries)]).toEqual([WELSCH_ENV]);
  });

  it("fails closed while authority or membership is unresolved", () => {
    const resolving: BusinessOsCodeScopeSnapshot = {
      phase: "resolving",
      presentationInstanceId: "managed:welsch",
      businessOsInstanceId: null,
      environmentIds: new Set(),
      blocker: null,
    };
    const blocked: BusinessOsCodeScopeSnapshot = {
      phase: "blocked",
      presentationInstanceId: "managed:welsch",
      businessOsInstanceId: null,
      environmentIds: new Set([WELSCH_ENV]),
      blocker: "authority-rejected",
    };

    expect(businessOsCodeScopeContainsEnvironment(resolving, WELSCH_ENV)).toBe(false);
    expect(businessOsCodeScopeContainsEnvironment(blocked, WELSCH_ENV)).toBe(false);
  });

  it("allows only environments present in a ready instance scope", () => {
    const ready: BusinessOsCodeScopeSnapshot = {
      phase: "ready",
      presentationInstanceId: "managed:welsch",
      businessOsInstanceId: WELSCH,
      environmentIds: new Set([WELSCH_ENV]),
      blocker: null,
    };

    expect(businessOsCodeScopeContainsEnvironment(ready, WELSCH_ENV)).toBe(true);
    expect(businessOsCodeScopeContainsEnvironment(ready, OTHER_ENV)).toBe(false);
  });
});
