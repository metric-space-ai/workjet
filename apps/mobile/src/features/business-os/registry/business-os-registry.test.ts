import { describe, expect, it, vi } from "vite-plus/test";

import { validateBusinessOsInviteV1 } from "../pairing/invite";
import {
  assertBusinessOsMetadataSafe,
  forgetBusinessOsInstance,
  loadBusinessOsLaunchSecrets,
  pairBusinessOsInstance,
  type BusinessOsInstance,
  type BusinessOsRegistryPort,
  type BusinessOsSecretStorePort,
} from "./business-os-registry";

const NOW = Date.parse("2026-08-25T12:00:00Z");

function validatedInvite(instanceId = "instance-a", secretSuffix = "a") {
  return validateBusinessOsInviteV1(
    {
      type: "ctox-business-os-invite",
      version: 1,
      display_name: `Operations ${instanceId}`,
      instance_id: instanceId,
      sync_room: `ctox-business-os:${instanceId}`,
      native_peer_id: `native-${instanceId}`,
      signaling_urls: ["wss://signal.example.test/socket"],
      signaling_room_password: `room-secret-${secretSuffix}`,
      transport: "webrtc",
      expires_at: "2026-08-25T13:00:00Z",
      data_plane: "rxdb-webrtc",
      http_bridge_available: false,
      session: {
        authenticated: true,
        source: "mobile_invite",
        capability_token: `capability-secret-${secretSuffix}`,
        capability_expires_at_ms: Date.parse("2026-08-25T12:30:00Z"),
        user: { id: "user-a", display_name: "Operator", role: "admin" },
      },
    },
    { now: NOW },
  );
}

function harness() {
  let instances: BusinessOsInstance[] = [];
  const values = new Map<string, string>();
  let sequence = 0;
  const registry: BusinessOsRegistryPort = {
    list: async () => instances,
    save: async (instance) => {
      instances = [...instances.filter((entry) => entry.id !== instance.id), instance];
    },
    remove: async (id) => {
      instances = instances.filter((entry) => entry.id !== id);
    },
  };
  const secrets: BusinessOsSecretStorePort = {
    write: async (value) => {
      const reference = `opaque-ref-${++sequence}`;
      values.set(reference, value);
      return reference;
    },
    read: async (reference) => values.get(reference) ?? null,
    remove: async (reference) => {
      values.delete(reference);
    },
  };
  return {
    dependencies: {
      registry,
      secrets,
      createOpaqueId: () => `opaque-id-${++sequence}`,
      now: () => NOW,
    },
    registry,
    secrets,
    values,
    instances: () => instances,
  };
}

describe("Business OS registry", () => {
  it("keeps credentials out of SQLite-safe metadata", async () => {
    const state = harness();
    const instance = await pairBusinessOsInstance(validatedInvite(), state.dependencies);

    const serialized = JSON.stringify(instance);
    expect(serialized).not.toContain("room-secret-a");
    expect(serialized).not.toContain("capability-secret-a");
    expect(serialized).not.toContain("signaling_room_password");
    expect(await loadBusinessOsLaunchSecrets(instance, state.secrets)).toEqual({
      roomPassword: "room-secret-a",
      capabilityToken: "capability-secret-a",
    });
  });

  it("stores multiple backends with independent storage identities", async () => {
    const state = harness();
    const first = await pairBusinessOsInstance(validatedInvite("instance-a"), state.dependencies);
    const second = await pairBusinessOsInstance(validatedInvite("instance-b"), state.dependencies);

    expect(state.instances()).toHaveLength(2);
    expect(first.storageIdentity).not.toBe(second.storageIdentity);
    expect(first.id).not.toBe(second.id);
  });

  it("re-pairs atomically and preserves the instance web profile", async () => {
    const state = harness();
    const first = await pairBusinessOsInstance(validatedInvite("instance-a", "old"), {
      ...state.dependencies,
      now: () => NOW,
    });
    const oldReferences = [first.roomSecretRef, first.capabilitySecretRef];
    const replacement = await pairBusinessOsInstance(validatedInvite("instance-a", "new"), {
      ...state.dependencies,
      now: () => NOW + 1_000,
    });

    expect(replacement.id).toBe(first.id);
    expect(replacement.storageIdentity).toBe(first.storageIdentity);
    expect(replacement.updatedAtMs).toBe(NOW + 1_000);
    expect(oldReferences.every((reference) => !state.values.has(reference))).toBe(true);
    expect(await loadBusinessOsLaunchSecrets(replacement, state.secrets)).toEqual({
      roomPassword: "room-secret-new",
      capabilityToken: "capability-secret-new",
    });
  });

  it("rolls back new credentials when the metadata write fails", async () => {
    const state = harness();
    const failingRegistry: BusinessOsRegistryPort = {
      ...state.registry,
      save: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    };

    await expect(
      pairBusinessOsInstance(validatedInvite(), {
        ...state.dependencies,
        registry: failingRegistry,
      }),
    ).rejects.toMatchObject({ code: "registry-write" });
    expect(state.values.size).toBe(0);
  });

  it("forgets only the selected profile and its credentials", async () => {
    const state = harness();
    const first = await pairBusinessOsInstance(validatedInvite("instance-a"), state.dependencies);
    const second = await pairBusinessOsInstance(validatedInvite("instance-b"), state.dependencies);
    const removeProfile = vi.fn(async () => undefined);

    await forgetBusinessOsInstance(first, {
      ...state.dependencies,
      profiles: { remove: removeProfile },
    });

    expect(state.instances()).toEqual([second]);
    expect(removeProfile).toHaveBeenCalledWith(first.storageIdentity);
    expect(await loadBusinessOsLaunchSecrets(second, state.secrets)).toBeDefined();
  });

  it("keeps the registry and secrets recoverable when profile deletion fails", async () => {
    const state = harness();
    const instance = await pairBusinessOsInstance(validatedInvite(), state.dependencies);

    await expect(
      forgetBusinessOsInstance(instance, {
        ...state.dependencies,
        profiles: {
          remove: async () => {
            throw new Error("profile busy");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "profile-delete" });

    expect(state.instances()).toEqual([instance]);
    expect(await loadBusinessOsLaunchSecrets(instance, state.secrets)).toBeDefined();
  });

  it("rejects accidental credential-shaped metadata", () => {
    expect(() => assertBusinessOsMetadataSafe({ capability_token: "secret" })).toThrowError(
      expect.objectContaining({ code: "unsafe-metadata" }),
    );
  });
});
