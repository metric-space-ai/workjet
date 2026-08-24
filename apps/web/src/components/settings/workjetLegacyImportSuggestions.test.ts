// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type {
  WorkjetLegacyImportBindableTargets,
  WorkjetLegacyImportPending,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { legacyProviderKind, suggestLegacyImportAnswer } from "./workjetLegacyImportSuggestions";

// The operator's actual records, from config.v1.json.
const computer = (name: string, transport: "Lokal" | "Tailscale"): WorkjetLegacyImportPending =>
  ({
    kind: "computer-environment",
    computerId: "id-" + name,
    computerName: name,
    transport,
    host: transport === "Lokal" ? null : "100.71.114.101",
  }) as unknown as WorkjetLegacyImportPending;

const provider = (name: string, modelProvider: string | null = null): WorkjetLegacyImportPending =>
  ({
    kind: "provider-account",
    providerId: "id-" + name,
    providerName: name,
    modelProvider,
    accountLabel: null,
    externalCredentialId: null,
    modelIds: [],
  }) as unknown as WorkjetLegacyImportPending;

const targets = (
  overrides: Partial<WorkjetLegacyImportBindableTargets> = {},
): WorkjetLegacyImportBindableTargets =>
  ({
    environments: [{ environmentId: "env-self", isSelf: true, referencedByConfiguration: true }],
    gatewayAccounts: [
      {
        accountId: "acc-kimi",
        label: "Kimi (Moonshot)",
        provider: "kimi",
        credentialSuffix: "xoYy",
      },
      {
        accountId: "acc-codex",
        label: "michael@googlemail.com",
        provider: "codex",
        credentialSuffix: null,
      },
      { accountId: "acc-zai", label: "Z.ai (GLM)", provider: "zai", credentialSuffix: "mAzP" },
    ],
    gatewayCatalogAvailable: true,
    ...overrides,
  }) as unknown as WorkjetLegacyImportBindableTargets;

describe("suggesting the mechanical answers of the one-shot import", () => {
  it("binds the local computer to the environment this server is", () => {
    expect(suggestLegacyImportAnswer(computer("Local", "Lokal"), targets())).toEqual({
      _tag: "bind",
      targetId: "env-self",
    });
  });

  it("suggests SKIP for a remote machine, never localhost", () => {
    // The only bindable environments are this server's own. Binding
    // gpu3-a4500 here would silently re-point its workers at this machine —
    // irreversibly, since the import never runs again.
    expect(suggestLegacyImportAnswer(computer("gpu3-a4500", "Tailscale"), targets())).toEqual({
      _tag: "skip",
    });
  });

  it("maps a legacy provider to the single gateway account of its kind", () => {
    expect(suggestLegacyImportAnswer(provider("Kimi 1"), targets())).toEqual({
      _tag: "bind",
      targetId: "acc-kimi",
    });
    // OpenAI accounts route through the Codex gateway account.
    expect(suggestLegacyImportAnswer(provider("OpenAI 2"), targets())).toEqual({
      _tag: "bind",
      targetId: "acc-codex",
    });
    expect(suggestLegacyImportAnswer(provider("Z.ai 1"), targets())).toEqual({
      _tag: "bind",
      targetId: "acc-zai",
    });
  });

  it("suggests SKIP when no account of the kind exists", () => {
    // Binding xAI to some other provider's account would sign requests with
    // the wrong key.
    expect(suggestLegacyImportAnswer(provider("xAI"), targets())).toEqual({ _tag: "skip" });
  });

  it("suggests NOTHING when the choice is genuinely ambiguous", () => {
    const two = targets({
      gatewayAccounts: [
        { accountId: "a", label: "K1", provider: "kimi", credentialSuffix: null },
        { accountId: "b", label: "K2", provider: "kimi", credentialSuffix: null },
      ],
    } as never);

    expect(suggestLegacyImportAnswer(provider("Kimi 1"), two)).toBeNull();
  });

  it("suggests NOTHING when the catalog could not be read", () => {
    // "No account of this kind" and "catalog unreadable" must not collapse
    // into the same SKIP.
    expect(
      suggestLegacyImportAnswer(provider("Kimi 1"), targets({ gatewayCatalogAvailable: false })),
    ).toBeNull();
  });

  it("answers pools by the same one-account-of-the-kind rule", () => {
    const pool = (name: string): WorkjetLegacyImportPending =>
      ({
        kind: "provider-pool-account",
        pool: name,
        workerIds: [],
        failoverLoss: true,
      }) as unknown as WorkjetLegacyImportPending;

    // One kimi account: bind. The failover-loss note stays on the control.
    expect(suggestLegacyImportAnswer(pool("Kimi"), targets())).toEqual({
      _tag: "bind",
      targetId: "acc-kimi",
    });
    // No xai account: skip, never another provider's key.
    expect(suggestLegacyImportAnswer(pool("xAI"), targets())).toEqual({ _tag: "skip" });
  });

  it("reads the kind from the structured field before the free-text name", () => {
    expect(legacyProviderKind({ providerName: "Zugang 3", modelProvider: "Kimi" })).toBe("kimi");
    expect(legacyProviderKind({ providerName: "OpenAI 1", modelProvider: null })).toBe("codex");
    expect(legacyProviderKind({ providerName: "unbekannt", modelProvider: null })).toBeNull();
  });
});
