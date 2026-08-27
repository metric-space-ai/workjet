import type { BusinessOsInstanceId } from "@t3tools/contracts";
import type { WorkjetManagedDeviceSessionAuthorization } from "@t3tools/client-runtime/state/business-os-managed-backend-control";
import { describe, expect, it } from "vite-plus/test";

import {
  loadWorkjetDeviceSession,
  removeWorkjetDeviceSession,
  saveWorkjetDeviceSession,
  type WorkjetDeviceSessionStoreDependencies,
} from "./workjet-device-session-store";

const INSTANCE = "instance-a" as BusinessOsInstanceId;

function authorization(accessToken: string): WorkjetManagedDeviceSessionAuthorization {
  return {
    sessionIssuer: "https://relay.example.test" as never,
    relayIssuer: "https://relay.example.test" as never,
    relayScopes: ["environment:connect", "environment:status"],
    tokenType: "DPoP",
    accessToken: accessToken as never,
    expiresAt: "2026-08-27T06:00:00Z",
    refreshGrant: `${accessToken.padEnd(43, "r")}` as never,
    refreshExpiresAt: "2026-09-27T06:00:00Z",
    businessOsInstanceId: INSTANCE,
    deviceId: "device-a" as never,
  };
}

function makeStore() {
  const references = new Map<string, string>();
  const secrets = new Map<string, string>();
  let nextSecret = 0;
  let failReplace = false;
  const dependencies: WorkjetDeviceSessionStoreDependencies = {
    references: {
      async read(instanceId) {
        return references.get(instanceId) ?? null;
      },
      async replace(instanceId, reference) {
        if (failReplace) throw new Error("sqlite unavailable");
        const previous = references.get(instanceId) ?? null;
        references.set(instanceId, reference);
        return previous;
      },
      async remove(instanceId) {
        const previous = references.get(instanceId) ?? null;
        references.delete(instanceId);
        return previous;
      },
    },
    secrets: {
      async write(value) {
        const reference = `secret-${++nextSecret}`;
        secrets.set(reference, value);
        return reference;
      },
      async read(reference) {
        return secrets.get(reference) ?? null;
      },
      async remove(reference) {
        secrets.delete(reference);
      },
    },
  };
  return {
    dependencies,
    references,
    secrets,
    failNextReplace() {
      failReplace = true;
    },
  };
}

describe("Workjet device session store", () => {
  it("atomically replaces the per-instance secret and removes the old generation", async () => {
    const store = makeStore();
    await saveWorkjetDeviceSession(authorization("access-a"), store.dependencies);
    const firstReference = store.references.get(INSTANCE);
    await saveWorkjetDeviceSession(authorization("access-b"), store.dependencies);

    expect(store.references.get(INSTANCE)).not.toBe(firstReference);
    expect(store.secrets.has(firstReference!)).toBe(false);
    expect((await loadWorkjetDeviceSession(INSTANCE, store.dependencies))?.accessToken).toBe(
      "access-b",
    );
  });

  it("keeps the previous session when the reference swap fails", async () => {
    const store = makeStore();
    await saveWorkjetDeviceSession(authorization("access-a"), store.dependencies);
    const firstReference = store.references.get(INSTANCE);
    store.failNextReplace();

    await expect(
      saveWorkjetDeviceSession(authorization("access-b"), store.dependencies),
    ).rejects.toMatchObject({ code: "write" });
    expect(store.references.get(INSTANCE)).toBe(firstReference);
    expect(store.secrets.size).toBe(1);
  });

  it("removes the reference before deleting the secure value", async () => {
    const store = makeStore();
    await saveWorkjetDeviceSession(authorization("access-a"), store.dependencies);
    await removeWorkjetDeviceSession(INSTANCE, store.dependencies);
    expect(store.references.has(INSTANCE)).toBe(false);
    expect(store.secrets.size).toBe(0);
  });
});
