import {
  BusinessOsInstanceId,
  WorkjetInstallationId,
  type WorkjetDeviceBindingListResult,
  type WorkjetDeviceInviteCreateResult,
  type WorkjetManagedBackendControlResolveResult,
  type WorkjetManagedDeviceInviteManualConnectionResult,
} from "@t3tools/contracts";
import {
  createManagedWorkjetDeviceInvite,
  listManagedWorkjetDeviceBindings,
  readManagedWorkjetDeviceInviteManualConnection,
  resolveManagedBusinessOsBackendControl,
  revokeManagedWorkjetDeviceBinding,
  revokeManagedWorkjetDeviceInvite,
} from "@t3tools/client-runtime/state/business-os-managed-backend-control";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { randomUUID } from "../../lib/utils";
import { runtime } from "../../lib/runtime";

const INSTALLATION_ID_KEY = "workjet.installation-id.v1";
const decodeBusinessOsInstanceId = Schema.decodeUnknownSync(BusinessOsInstanceId);
const decodeWorkjetInstallationId = Schema.decodeUnknownSync(WorkjetInstallationId);

function loadOrCreateInstallationId(): WorkjetInstallationId {
  const stored = globalThis.localStorage?.getItem(INSTALLATION_ID_KEY);
  if (stored) {
    try {
      return decodeWorkjetInstallationId(stored);
    } catch {
      globalThis.localStorage?.removeItem(INSTALLATION_ID_KEY);
    }
  }
  const created = decodeWorkjetInstallationId(`desktop:${randomUUID()}`);
  globalThis.localStorage?.setItem(INSTALLATION_ID_KEY, created);
  return created;
}

export interface BusinessOsDeviceControlScope {
  readonly businessOsInstanceId: BusinessOsInstanceId;
  readonly backendControlConnectionId: WorkjetManagedBackendControlResolveResult["backendControlConnectionId"];
}

async function resolveControl(
  rawBusinessOsInstanceId: string,
): Promise<BusinessOsDeviceControlScope> {
  const businessOsInstanceId = decodeBusinessOsInstanceId(rawBusinessOsInstanceId);
  const workjetInstallationId = loadOrCreateInstallationId();
  const identityPort = window.desktopBridge?.ctox?.issueControlIdentityAssertion;
  if (identityPort === undefined) throw new Error("control_identity_unavailable");
  const controlIdentity = await identityPort({
    audience: "ctox.dev",
    businessOsInstanceId,
    workjetInstallationId,
  });
  if (Date.parse(controlIdentity.expiresAt) <= Date.now()) {
    throw new Error("control_identity_expired");
  }
  const resolved = await runtime.runPromise(
    resolveManagedBusinessOsBackendControl({
      businessOsInstanceId,
      workjetInstallationId,
      relayIdentityAssertion: controlIdentity.assertion,
    }),
  );
  if (resolved.businessOsInstanceId !== businessOsInstanceId) {
    throw new Error("wrong_business_os_instance");
  }
  return {
    businessOsInstanceId,
    backendControlConnectionId: resolved.backendControlConnectionId,
  };
}

export async function listBusinessOsDevices(
  businessOsInstanceId: string,
): Promise<WorkjetDeviceBindingListResult> {
  const scope = await resolveControl(businessOsInstanceId);
  return runtime.runPromise(listManagedWorkjetDeviceBindings(scope));
}

export async function createBusinessOsDeviceInvite(
  businessOsInstanceId: string,
): Promise<WorkjetDeviceInviteCreateResult> {
  const scope = await resolveControl(businessOsInstanceId);
  return runtime.runPromise(createManagedWorkjetDeviceInvite({ ...scope, ttlSeconds: 300 }));
}

export async function revokeBusinessOsDeviceInvite(
  businessOsInstanceId: string,
  inviteId: string,
): Promise<void> {
  const scope = await resolveControl(businessOsInstanceId);
  await runtime.runPromise(revokeManagedWorkjetDeviceInvite({ ...scope, inviteId }));
}

export async function readBusinessOsDeviceInviteManualConnection(
  businessOsInstanceId: string,
  inviteId: string,
): Promise<WorkjetManagedDeviceInviteManualConnectionResult> {
  const scope = await resolveControl(businessOsInstanceId);
  return runtime.runPromise(readManagedWorkjetDeviceInviteManualConnection({ ...scope, inviteId }));
}

export async function revokeBusinessOsDevice(
  businessOsInstanceId: string,
  devicePairingId: string,
): Promise<void> {
  const scope = await resolveControl(businessOsInstanceId);
  await runtime.runPromise(revokeManagedWorkjetDeviceBinding({ ...scope, devicePairingId }));
}
