import { describe, expect, it, vi } from "vite-plus/test";

import { encodeWorkjetBusinessOsPairLink } from "./invite";
import { importBusinessOsPairingFromClipboard } from "./import-flow";

const NOW = Date.parse("2026-08-25T12:00:00Z");
const INVITE = {
  type: "ctox-business-os-invite",
  version: 1,
  display_name: "Operations",
  instance_id: "instance-a",
  sync_room: "ctox-business-os:instance-a",
  native_peer_id: "native-a",
  signaling_urls: ["wss://signal.example.test/socket"],
  signaling_auth_version: "ctox-role-bound-v1",
  signaling_browser_token: "synthetic-browser-token",
  signaling_browser_token_hash: "1ef21ba2169d3a33ac0af0ff96d6698758b46ed2cb13409b9d50a5eafdd427fa",
  signaling_native_token_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  transport: "webrtc",
  expires_at: "2026-08-25T13:00:00Z",
  data_plane: "rxdb-webrtc",
  http_bridge_available: false,
  session: {
    authenticated: true,
    source: "mobile_invite",
    capability_token: "synthetic-capability-token",
    capability_expires_at_ms: Date.parse("2026-08-25T12:30:00Z"),
    user: { id: "user-a", display_name: "Operator", role: "admin" },
  },
};

function dependencies(save: () => Promise<void> = async () => undefined) {
  let sequence = 0;
  const values = new Map<string, string>();
  return {
    registry: { list: async () => [], save, remove: async () => undefined },
    secrets: {
      write: async (value: string) => {
        const reference = `ref-${++sequence}`;
        values.set(reference, value);
        return reference;
      },
      read: async (reference: string) => values.get(reference) ?? null,
      remove: async (reference: string) => {
        values.delete(reference);
      },
    },
    createOpaqueId: () => `id-${++sequence}`,
    now: () => NOW,
  };
}

describe("Business OS clipboard import", () => {
  it("reads only on request and clears after a successful confirmed import", async () => {
    const clear = vi.fn(async () => undefined);
    const clipboard = {
      readText: vi.fn(async () => encodeWorkjetBusinessOsPairLink(INVITE, { now: NOW })),
      clear,
    };
    const result = await importBusinessOsPairingFromClipboard(
      clipboard,
      async (prepared) => prepared.confirmation.displayName === "Operations",
      dependencies(),
      { now: NOW },
    );

    expect(result?.instanceId).toBe("instance-a");
    expect(clipboard.readText).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("does not clear a cancelled or failed import", async () => {
    const link = encodeWorkjetBusinessOsPairLink(INVITE, { now: NOW });
    const cancelledClear = vi.fn(async () => undefined);
    expect(
      await importBusinessOsPairingFromClipboard(
        { readText: async () => link, clear: cancelledClear },
        async () => false,
        dependencies(),
        { now: NOW },
      ),
    ).toBeNull();
    expect(cancelledClear).not.toHaveBeenCalled();

    const failedClear = vi.fn(async () => undefined);
    await expect(
      importBusinessOsPairingFromClipboard(
        { readText: async () => link, clear: failedClear },
        async () => true,
        dependencies(async () => {
          throw new Error("database unavailable");
        }),
        { now: NOW },
      ),
    ).rejects.toBeDefined();
    expect(failedClear).not.toHaveBeenCalled();
  });
});
