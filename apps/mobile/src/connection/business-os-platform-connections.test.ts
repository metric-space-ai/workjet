import { BusinessOsInstanceId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMobileBusinessOsPlatformRegistrations } from "./business-os-platform-connections";

describe("mobile Business OS platform connections", () => {
  it("projects only device-session-authorized memberships with canonical authority scope", () => {
    const managedEnvironment = EnvironmentId.make("environment-managed");
    const legacyEnvironment = EnvironmentId.make("environment-legacy");
    const registrations = buildMobileBusinessOsPlatformRegistrations({
      instances: [
        { localId: "local-a", authorityId: "authority-a", label: "WELSCH" },
        { localId: "local-b", authorityId: "authority-b", label: "Legacy" },
      ],
      bindings: [
        { businessOsInstanceId: "local-a", environmentId: managedEnvironment },
        { businessOsInstanceId: "local-b", environmentId: legacyEnvironment },
      ],
      deviceSessionAuthorityIds: new Set([BusinessOsInstanceId.make("authority-a")]),
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.target).toMatchObject({
      environmentId: managedEnvironment,
      businessOsInstanceId: BusinessOsInstanceId.make("authority-a"),
    });
  });

  it("deduplicates one computer and fails closed for unknown local instances", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const registrations = buildMobileBusinessOsPlatformRegistrations({
      instances: [{ localId: "local-a", authorityId: "authority-a", label: "WELSCH" }],
      bindings: [
        { businessOsInstanceId: "missing", environmentId },
        { businessOsInstanceId: "local-a", environmentId },
        { businessOsInstanceId: "local-a", environmentId },
      ],
      deviceSessionAuthorityIds: new Set([BusinessOsInstanceId.make("authority-a")]),
    });

    expect(registrations).toHaveLength(1);
  });
});
