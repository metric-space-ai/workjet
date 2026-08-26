// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  WorkjetBusinessOsComputerAssignInput,
  WorkjetBusinessOsComputerAssignment,
  WorkjetBusinessOsComputerAssignmentAuthority,
} from "./workjetBusinessOsComputers.ts";

const decodeInput = Schema.decodeUnknownSync(WorkjetBusinessOsComputerAssignInput);
const decodeAuthority = Schema.decodeUnknownSync(WorkjetBusinessOsComputerAssignmentAuthority);
const decodeAssignment = Schema.decodeUnknownSync(WorkjetBusinessOsComputerAssignment);

describe("Business OS computer ownership contracts", () => {
  it("keeps client assignment intent free of authority flags", () => {
    const decoded = decodeInput({
      businessOsInstanceId: "business-os-welsch",
      environmentId: "gpu-1",
      hostingMode: "self-hosted",
      backendEnvironmentId: "gpu-1",
      backendHostIdentityId: "host-1",
      serverAttested: true,
    });

    expect(decoded).toEqual({
      businessOsInstanceId: "business-os-welsch",
      environmentId: "gpu-1",
    });
  });

  it("accepts only the explicit version-one co-location confirmation", () => {
    expect(
      decodeInput({
        businessOsInstanceId: "business-os-welsch",
        environmentId: "mac",
        coLocationRiskConfirmation: { policyVersion: 1, confirmed: true },
      }).coLocationRiskConfirmation,
    ).toEqual({ policyVersion: 1, confirmed: true });

    expect(() =>
      decodeInput({
        businessOsInstanceId: "business-os-welsch",
        environmentId: "mac",
        coLocationRiskConfirmation: { policyVersion: 2, confirmed: true },
      }),
    ).toThrow();
    expect(() =>
      decodeInput({
        businessOsInstanceId: "business-os-welsch",
        environmentId: "mac",
        coLocationRiskConfirmation: { policyVersion: 1, confirmed: false },
      }),
    ).toThrow();
  });

  it("models server-attested environment and optional physical-host identities separately", () => {
    expect(
      decodeAuthority({
        businessOsInstanceId: "business-os-welsch",
        hostingMode: "self-hosted",
        backendEnvironmentId: "mac-server",
        backendHostIdentityId: "physical-mac",
        computerEnvironmentId: "mac-code",
        computerHostIdentityId: "physical-mac",
      }),
    ).toEqual({
      businessOsInstanceId: "business-os-welsch",
      hostingMode: "self-hosted",
      backendEnvironmentId: "mac-server",
      backendHostIdentityId: "physical-mac",
      computerEnvironmentId: "mac-code",
      computerHostIdentityId: "physical-mac",
    });
  });

  it("requires persisted risk evidence to carry a server timestamp", () => {
    expect(() =>
      decodeAssignment({
        businessOsInstanceId: "business-os-welsch",
        environmentId: "mac",
        assignedAtMillis: 100,
        coLocationRiskAcceptance: { policyVersion: 1 },
      }),
    ).toThrow();
  });
});
