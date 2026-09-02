import { BusinessOsInstanceId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  businessOsCodeScopeContainsEnvironment,
  projectBusinessOsEnvironmentIds,
  resolveBusinessOsCodeScopeEnvironmentIds,
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

  it("includes the Primary environment when the registered local computer identifies it", () => {
    const entries = new Map([
      [WELSCH_ENV, { target: { _tag: "RelayConnectionTarget", businessOsInstanceId: WELSCH } }],
      [OTHER_ENV, { target: { _tag: "RelayConnectionTarget", businessOsInstanceId: OTHER } }],
      [PRIMARY_ENV, { target: { _tag: "PrimaryConnectionTarget" } }],
    ]);

    expect([
      ...resolveBusinessOsCodeScopeEnvironmentIds({
        businessOsInstanceId: WELSCH,
        entries,
        primaryEnvironmentId: PRIMARY_ENV,
        computers: [{ presentationKind: "local", environmentId: PRIMARY_ENV }],
      }),
    ]).toEqual([WELSCH_ENV, PRIMARY_ENV]);
  });

  it("keeps the Primary environment out without a registered local computer", () => {
    expect([
      ...resolveBusinessOsCodeScopeEnvironmentIds({
        businessOsInstanceId: WELSCH,
        entries: new Map(),
        primaryEnvironmentId: PRIMARY_ENV,
        computers: [],
      }),
    ]).toEqual([]);
  });

  it("keeps the Primary environment out when the local computer identifies another environment", () => {
    expect([
      ...resolveBusinessOsCodeScopeEnvironmentIds({
        businessOsInstanceId: WELSCH,
        entries: new Map(),
        primaryEnvironmentId: PRIMARY_ENV,
        computers: [{ presentationKind: "local", environmentId: OTHER_ENV }],
      }),
    ]).toEqual([]);
  });

  it("keeps the Primary environment out for non-local computer presentations", () => {
    expect([
      ...resolveBusinessOsCodeScopeEnvironmentIds({
        businessOsInstanceId: WELSCH,
        entries: new Map(),
        primaryEnvironmentId: PRIMARY_ENV,
        computers: [
          { presentationKind: "ssh", environmentId: PRIMARY_ENV },
          { presentationKind: "tailscale", environmentId: PRIMARY_ENV },
          { presentationKind: "t3-connect", environmentId: PRIMARY_ENV },
        ],
      }),
    ]).toEqual([]);
  });

  it("fails closed with an empty scope while authority or membership is unresolved", () => {
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
      environmentIds: new Set(),
      blocker: "authority-rejected",
    };

    expect([...resolving.environmentIds]).toEqual([]);
    expect([...blocked.environmentIds]).toEqual([]);
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
