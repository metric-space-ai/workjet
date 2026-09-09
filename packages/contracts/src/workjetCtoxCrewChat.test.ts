import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  WorkjetThreadConfig,
  WorkjetThreadCtoxCrewChat,
  normalizeWorkjetThreadConfig,
} from "./workjet.ts";
const binding = {
  instanceId: "instance",
  connectionId: "connection",
  chatId: "workjet_private_chat",
};
const decode = Schema.decodeUnknownSync(WorkjetThreadConfig, { onExcessProperty: "error" });
describe("native Crew chat reference", () => {
  it("survives persisted configuration without replacing transfer identity or app links", () => {
    const config = decode({
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      ctoxCrewChat: binding,
      ctoxSession: { instanceId: "instance", sessionId: "transfer-session", fenceEpoch: 3 },
    });
    const restored = decode(JSON.parse(JSON.stringify(normalizeWorkjetThreadConfig(config))));
    expect(restored).toMatchObject({
      ctoxCrewChat: binding,
      ctoxSession: { sessionId: "transfer-session", fenceEpoch: 3 },
    });
  });
  it("does not opt ordinary or legacy threads into Crew execution", () => {
    expect(decode(DEFAULT_WORKJET_THREAD_CONFIG)).not.toHaveProperty("ctoxCrewChat");
    const legacy = decode({
      schemaVersion: 1,
      role: "standard",
      parent: null,
      managedInstructions: "User instructions",
      enabledCapabilityIds: [],
    });
    expect(normalizeWorkjetThreadConfig(legacy)).not.toHaveProperty("ctoxCrewChat");
  });
  it("rejects incomplete, non-private and credential-bearing references", () => {
    const decodeBinding = Schema.decodeUnknownSync(WorkjetThreadCtoxCrewChat, {
      onExcessProperty: "error",
    });
    for (const value of [
      { ...binding, chatId: "code-thread" },
      { ...binding, chatId: "workjet_group_chat" },
      { ...binding, chatId: "workjet_private_" },
      { ...binding, instanceId: "" },
      { ...binding, connectionId: "" },
      { ...binding, commandSession: "secret" },
      { ...binding, chatId: "workjet_private_chat\nother" },
    ])
      expect(() => decodeBinding(value)).toThrow();
  });
});
