// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Suggested default answers for the one-shot legacy import.
 *
 * The import runs exactly once, so the DECISION stays with the operator: these
 * are PRE-SELECTIONS on the controls, never an auto-accept. What they remove
 * is fourteen dropdown lookups whose right answers are mechanical — and were
 * mechanical enough that a hand-written click list existed. A wrong pre-fill
 * would be reviewed on the same screen that shows it, above an Accept button
 * the operator still has to press.
 *
 * The rules are deliberately conservative — suggest only what is UNAMBIGUOUS,
 * leave everything else unanswered:
 *
 *  - A LOCAL legacy computer maps to the environment this server itself is
 *    (`isSelf`), when exactly one exists.
 *  - A REMOTE legacy computer (ssh/tailscale/…) suggests SKIP: the only
 *    bindable environments here are this server's own, and binding a remote
 *    machine to localhost would silently point its workers at the wrong host —
 *    irreversibly, since the import never runs again.
 *  - A legacy provider suggests the gateway account of the SAME provider kind,
 *    when exactly one such account exists. Two accounts of one kind is a real
 *    choice; no account of the kind suggests SKIP, because binding to a
 *    different provider's account would sign requests with the wrong key.
 */
import type {
  WorkjetLegacyImportBindableTargets,
  WorkjetLegacyImportPending,
} from "@t3tools/contracts";

export type WorkjetLegacyImportSuggestion =
  | { readonly _tag: "bind"; readonly targetId: string }
  | { readonly _tag: "skip" };

/**
 * The legacy Swift provider names carry the kind in free text ("Kimi 1",
 * "OpenAI 2", "Z.ai 1", "xAI"). `modelProvider` is the structured kind where
 * the legacy document recorded one; the name prefix is the fallback. Matching
 * maps onto the gateway's provider keys.
 */
const LEGACY_KIND_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^kimi/i, "kimi"],
  [/^minimax/i, "minimax"],
  [/^openai|^codex/i, "codex"],
  [/^anthropic|^claude/i, "claude"],
  [/^z\.?ai|^glm/i, "zai"],
  [/^xai|^x\.ai|^grok/i, "xai"],
  [/^antigravity/i, "antigravity"],
];

export function legacyProviderKind(input: {
  readonly providerName: string;
  readonly modelProvider: string | null;
}): string | null {
  for (const source of [input.modelProvider ?? "", input.providerName]) {
    const trimmed = source.trim();
    if (trimmed.length === 0) continue;
    for (const [pattern, kind] of LEGACY_KIND_PATTERNS) {
      if (pattern.test(trimmed)) return kind;
    }
  }
  return null;
}

export function suggestLegacyImportAnswer(
  record: WorkjetLegacyImportPending,
  bindable: WorkjetLegacyImportBindableTargets,
): WorkjetLegacyImportSuggestion | null {
  if (record.kind === "computer-environment") {
    if (record.transport === "Lokal") {
      const self = bindable.environments.filter((environment) => environment.isSelf);
      return self.length === 1 ? { _tag: "bind", targetId: self[0]!.environmentId } : null;
    }
    // Remote machine, local-only targets: skip is the only non-destructive
    // answer. Binding it here would re-point its workers at this machine.
    return { _tag: "skip" };
  }
  if (record.kind === "provider-account") {
    // Without a readable gateway catalog "no account of this kind" is
    // indistinguishable from "catalog unreadable" — suggest nothing.
    if (!bindable.gatewayCatalogAvailable) return null;
    const kind = legacyProviderKind(record);
    if (kind === null) return null;
    const matches = bindable.gatewayAccounts.filter(
      (account) => account.provider.trim().toLowerCase() === kind,
    );
    if (matches.length === 1) return { _tag: "bind", targetId: matches[0]!.accountId };
    if (matches.length === 0) return { _tag: "skip" };
    return null;
  }
  if (record.kind === "provider-pool-account") {
    // A pool binds to ONE account and the contract marks the failover loss on
    // the record itself (`failoverLoss: true`), rendered at the control — a
    // pre-selection keeps that visible before Accept. The mechanics are the
    // same as for a single account: one account of the kind, or none.
    if (!bindable.gatewayCatalogAvailable) return null;
    const kind = legacyProviderKind({ providerName: record.pool, modelProvider: null });
    if (kind === null) return null;
    const matches = bindable.gatewayAccounts.filter(
      (account) => account.provider.trim().toLowerCase() === kind,
    );
    if (matches.length === 1) return { _tag: "bind", targetId: matches[0]!.accountId };
    if (matches.length === 0) return { _tag: "skip" };
    return null;
  }
  return null;
}
