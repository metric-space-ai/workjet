import { describe, expect, it } from "vite-plus/test";
import type { WorkjetManagedDeviceInviteManualConnectionResult } from "@workjet/contracts";
import {
  decodeBusinessOsManualCredential,
  encodeBusinessOsManualCredential,
} from "./businessOsManualCredential";

const connection: WorkjetManagedDeviceInviteManualConnectionResult = {
  signalingUrls: ["wss://signaling.example.test/v2"],
  room: "ctox-business-os:test-instance",
  authVersion: "ctox-role-bound-v1",
  browserToken: "synthetic-browser-token",
  browserTokenHash: "a".repeat(64),
  nativeTokenHash: "b".repeat(64),
  expiresAt: "2026-09-09T12:00:00Z",
};
const input = () => ({
  signalingUrls: connection.signalingUrls.join("\n"),
  room: connection.room,
  password: encodeBusinessOsManualCredential(connection),
  now: Date.parse("2026-09-09T11:00:00Z"),
});

describe("manual instance connection", () => {
  it("restores the invitation proofs from the three user-facing fields", () => {
    const result = decodeBusinessOsManualCredential(input());
    expect(result.syncRoom).toBe(connection.room);
    expect(result.signalingUrls).toEqual(connection.signalingUrls);
    expect(result.browserToken).toBe(connection.browserToken);
    expect(result.browserTokenHash).toBe(connection.browserTokenHash);
    expect(result.nativeTokenHash).toBe(connection.nativeTokenHash);
    expect(result.capabilityExpiresAtMs).toBe(Date.parse(connection.expiresAt));
    expect(result).not.toHaveProperty("capabilityToken");
    expect(result).not.toHaveProperty("role");
  });
  it("rejects a room from another invitation", () => {
    expect(() => decodeBusinessOsManualCredential({ ...input(), room: "another-room" })).toThrow(
      "derselben Einladung",
    );
  });
  it("rejects another signaling server", () => {
    expect(() =>
      decodeBusinessOsManualCredential({ ...input(), signalingUrls: "wss://other.example.test" }),
    ).toThrow("derselben Einladung");
  });
  it("rejects expiry including the exact expiry instant", () => {
    expect(() =>
      decodeBusinessOsManualCredential({ ...input(), now: Date.parse(connection.expiresAt) }),
    ).toThrow("abgelaufen");
  });
  it("rejects an invalid expiry instead of passing an unbounded lifetime", () => {
    expect(() =>
      decodeBusinessOsManualCredential({
        ...input(),
        password: encodeBusinessOsManualCredential({ ...connection, expiresAt: "2026-99-99T99:00:00Z" }),
      }),
    ).toThrow("abgelaufen");
  });
  it("rejects a bare token without inventing missing native proof", () => {
    expect(() =>
      decodeBusinessOsManualCredential({ ...input(), password: connection.browserToken }),
    ).toThrow("Verbindungspasswort");
  });
  it("reports malformed data without echoing secret input", () => {
    const bad = "workjet-join-v1.not-a-secret";
    expect(() => decodeBusinessOsManualCredential({ ...input(), password: bad })).toThrow(
      "ungültig oder unvollständig",
    );
    try {
      decodeBusinessOsManualCredential({ ...input(), password: bad });
    } catch (error) {
      expect(String(error)).not.toContain(bad);
    }
  });
});
