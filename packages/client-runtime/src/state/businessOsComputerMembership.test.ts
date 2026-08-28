import { describe, expect, it } from "vite-plus/test";

import {
  WORKJET_BUSINESS_OS_COMPUTERS_ASSIGN_PATH,
  WORKJET_BUSINESS_OS_COMPUTERS_LIST_PATH,
  WORKJET_BUSINESS_OS_COMPUTERS_UNASSIGN_PATH,
  businessOsComputerMembershipScopeKey,
} from "./businessOsComputerMembership.ts";

describe("Business OS computer membership client runtime", () => {
  it("uses dedicated control-plane endpoints", () => {
    expect(WORKJET_BUSINESS_OS_COMPUTERS_LIST_PATH).toBe("/api/workjet/business-os/computers/list");
    expect(WORKJET_BUSINESS_OS_COMPUTERS_ASSIGN_PATH).toBe(
      "/api/workjet/business-os/computers/assign",
    );
    expect(WORKJET_BUSINESS_OS_COMPUTERS_UNASSIGN_PATH).toBe(
      "/api/workjet/business-os/computers/unassign",
    );
  });

  it("keeps command state isolated by Business OS instance and computer", () => {
    expect(
      businessOsComputerMembershipScopeKey({
        businessOsInstanceId: "business-os-a",
        environmentId: "gpu-1",
      }),
    ).not.toBe(
      businessOsComputerMembershipScopeKey({
        businessOsInstanceId: "business-os-b",
        environmentId: "gpu-1",
      }),
    );
    expect(
      businessOsComputerMembershipScopeKey({
        businessOsInstanceId: "business-os-a",
        environmentId: "gpu-1",
      }),
    ).not.toBe(
      businessOsComputerMembershipScopeKey({
        businessOsInstanceId: "business-os-a",
        environmentId: "gpu-2",
      }),
    );
  });
});
