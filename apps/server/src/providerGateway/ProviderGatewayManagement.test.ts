import { describe, expect, it } from "vite-plus/test";

import {
  GATEWAY_MODEL_CHANNELS,
  decodeModelDefinitions,
  decodeRuntimeConfigSummary,
  decodeRuntimeStatus,
  runtimePhase,
} from "./ProviderGatewayManagement.ts";

/**
 * Every payload below is the host's own serialization: snake_case struct
 * fields, a snake_case phase enum, and the `{channel, models}` envelope the
 * model-definitions route wraps around `RegistryModelInfo`.
 */
describe("provider gateway management payloads", () => {
  it("reads the provider phase and active provider from a runtime status", () => {
    expect(
      decodeRuntimeStatus({
        schema: "workjet.provider-gateway.runtime-status.v1",
        main_responses_gateway: { phase: "ready", listen_addr: "127.0.0.1:41000" },
        codex_subscription_gateway: { phase: "ready", listen_addr: "127.0.0.1:41000" },
        management_gateway: { phase: "ready", listen_addr: "127.0.0.1:41001" },
        active_provider: "codex",
      }),
    ).toEqual({ providerPhase: "ready", activeProvider: "codex" });
  });

  it("reports a bootstrap host as waiting rather than ready", () => {
    // A host with no account omits `active_provider` entirely and reports the
    // provider endpoint as waiting for a subscription.
    expect(
      decodeRuntimeStatus({
        schema: "workjet.provider-gateway.runtime-status.v1",
        main_responses_gateway: {
          phase: "waiting_for_subscription",
          listen_addr: "127.0.0.1:41000",
        },
      }),
    ).toEqual({ providerPhase: "waiting-for-subscription", activeProvider: undefined });
  });

  it("calls an unrecognised phase unknown instead of guessing a neighbour", () => {
    expect(runtimePhase("waiting_for_secret")).toBe("unknown");
    expect(runtimePhase("faulted")).toBe("unknown");
    expect(runtimePhase(undefined)).toBe("unknown");
  });

  it("refuses a status whose schema or endpoint is not the host's", () => {
    expect(decodeRuntimeStatus({ schema: "something.else", main_responses_gateway: {} })).toBe(
      undefined,
    );
    expect(
      decodeRuntimeStatus({ schema: "workjet.provider-gateway.runtime-status.v1" }),
    ).toBeUndefined();
  });

  it("reads the per-provider account counts and models from a runtime summary", () => {
    expect(
      decodeRuntimeConfigSummary({
        schema: "workjet.provider-gateway.runtime-summary.v1",
        revision: 1,
        default_provider: "claude",
        providers: [
          {
            provider: "claude",
            account_count: 2,
            enabled_account_count: 1,
            models: ["claude-opus-4", "claude-opus-4"],
          },
        ],
      }),
    ).toEqual({
      defaultProvider: "claude",
      providers: [
        {
          provider: "claude",
          accountCount: 2,
          enabledAccountCount: 1,
          modelIds: ["claude-opus-4"],
        },
      ],
    });
  });

  it("refuses a summary entry with a missing or negative count", () => {
    for (const entry of [
      { provider: "claude", enabled_account_count: 1, models: [] },
      { provider: "claude", account_count: -1, enabled_account_count: 0, models: [] },
      { provider: "", account_count: 1, enabled_account_count: 1, models: [] },
    ]) {
      expect(
        decodeRuntimeConfigSummary({
          schema: "workjet.provider-gateway.runtime-summary.v1",
          revision: 1,
          providers: [entry],
        }),
        JSON.stringify(entry),
      ).toBeUndefined();
    }
  });

  it("falls back to the model id when the host omits both name fields", () => {
    expect(
      decodeModelDefinitions(
        {
          channel: "claude",
          models: [
            { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
            // `display_name` and `name` are both skipped when empty upstream.
            { id: "claude-3-5-haiku-20241022" },
            { id: "claude-3-5-haiku-20241022" },
            { id: "  " },
            "not-an-object",
          ],
        },
        "claude",
      ),
    ).toEqual([
      { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5" },
      { id: "claude-3-5-haiku-20241022", displayName: "claude-3-5-haiku-20241022" },
    ]);
  });

  it("refuses a model payload answering a different channel", () => {
    expect(decodeModelDefinitions({ channel: "codex", models: [] }, "claude")).toBeUndefined();
  });

  it("names a channel only where the host has one", () => {
    // The host's `models_for_channel` has no zai or minimax section, so those
    // two must carry no channel rather than a plausible-looking guess.
    expect(GATEWAY_MODEL_CHANNELS.zai).toBeNull();
    expect(GATEWAY_MODEL_CHANNELS.minimax).toBeNull();
    expect(GATEWAY_MODEL_CHANNELS.claude).toBe("claude");
    expect(GATEWAY_MODEL_CHANNELS.xai).toBe("xai");
    expect(GATEWAY_MODEL_CHANNELS.kimi).toBe("kimi");
  });
});
