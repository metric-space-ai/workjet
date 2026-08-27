import { BusinessOsInstanceId } from "@t3tools/contracts";
import {
  createManagedWorkjetDeviceInvite,
  issueManagedRelayControlIdentityAssertion,
  readManagedWorkjetDeviceSessionAuthorization,
  resolveManagedBusinessOsBackendControl,
  revokeManagedWorkjetDeviceInvite,
} from "@t3tools/client-runtime/state/business-os-managed-backend-control";
import { useEffect, useMemo, useState } from "react";
import * as Schema from "effect/Schema";

import { runtime } from "../../lib/runtime";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { makeManagedWorkjetDeviceInviteControl } from "./workjet-managed-device-invite-control";
import type { WorkjetDeviceInviteControlPort } from "./workjet-device-invite-control";

const decodeBusinessOsInstanceId = Schema.decodeUnknownSync(BusinessOsInstanceId);

const transport = {
  resolve: (input: Parameters<typeof resolveManagedBusinessOsBackendControl>[0]) =>
    runtime.runPromise(resolveManagedBusinessOsBackendControl(input)),
  createDeviceInvite: (input: Parameters<typeof createManagedWorkjetDeviceInvite>[0]) =>
    runtime.runPromise(createManagedWorkjetDeviceInvite(input)),
  revokeDeviceInvite: (input: Parameters<typeof revokeManagedWorkjetDeviceInvite>[0]) =>
    runtime.runPromise(revokeManagedWorkjetDeviceInvite(input)),
};

const productionControl = makeManagedWorkjetDeviceInviteControl(transport, {
  loadInstallationId: loadOrCreateAgentAwarenessDeviceId,
  loadRelayIdentityAssertion: async ({ businessOsInstanceId, workjetInstallationId }) => {
    const authorization = await runtime.runPromise(
      readManagedWorkjetDeviceSessionAuthorization({ businessOsInstanceId }),
    );
    if (
      authorization.businessOsInstanceId !== businessOsInstanceId ||
      authorization.deviceId !== workjetInstallationId
    ) {
      throw new Error("The Workjet device session belongs to another installation.");
    }
    const issued = await runtime.runPromise(
      issueManagedRelayControlIdentityAssertion({
        relayIssuer: authorization.relayIssuer,
        payload: {
          audience: "ctox.dev",
          workjetInstallationId,
          businessOsInstanceId,
        },
      }),
    );
    if (Date.parse(issued.expiresAt) <= Date.now()) {
      throw new Error("The Workjet control identity is expired.");
    }
    return issued.assertion;
  },
});

/** Enables QR creation only for a paired V2 session and configured producer. */
export function useManagedWorkjetDeviceInviteControl(
  rawBusinessOsInstanceId: string | null,
): WorkjetDeviceInviteControlPort | undefined {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAvailable(false);
    if (!rawBusinessOsInstanceId || !resolveCloudPublicConfig().managedControl.url) return;
    let businessOsInstanceId: BusinessOsInstanceId;
    try {
      businessOsInstanceId = decodeBusinessOsInstanceId(rawBusinessOsInstanceId);
    } catch {
      return;
    }
    void runtime
      .runPromise(readManagedWorkjetDeviceSessionAuthorization({ businessOsInstanceId }))
      .then(
        (authorization) => {
          if (!cancelled) {
            setAvailable(authorization.businessOsInstanceId === businessOsInstanceId);
          }
        },
        () => {
          if (!cancelled) setAvailable(false);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [rawBusinessOsInstanceId]);

  return useMemo(() => (available ? productionControl : undefined), [available]);
}
