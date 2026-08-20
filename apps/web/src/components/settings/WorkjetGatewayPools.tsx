import {
  WORKJET_GATEWAY_MAX_ACCOUNT_PRIORITY,
  WORKJET_GATEWAY_MAX_ACCOUNT_WEIGHT,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayHealth,
  type WorkjetGatewayModelDiscovery,
  type WorkjetGatewayPoolMember,
  type WorkjetGatewayProviderPool,
  type WorkjetGatewayRoutingStrategy,
  type WorkjetGatewayUpdateRoutingInput,
} from "@t3tools/contracts";
import { TriangleAlertIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { WORKJET_GATEWAY_PROVIDER_LABELS } from "./WorkjetGatewayAccounts";

export const WORKJET_GATEWAY_ROUTING_STRATEGIES: ReadonlyArray<WorkjetGatewayRoutingStrategy> = [
  "round-robin",
  "fill-first",
  "weighted-round-robin",
];

export const WORKJET_GATEWAY_ROUTING_STRATEGY_LABELS: Readonly<
  Record<WorkjetGatewayRoutingStrategy, string>
> = {
  "round-robin": "Round robin",
  "fill-first": "Fill first",
  "weighted-round-robin": "Weighted round robin",
};

export const WORKJET_GATEWAY_ROUTING_STRATEGY_DESCRIPTIONS: Readonly<
  Record<WorkjetGatewayRoutingStrategy, string>
> = {
  "round-robin": "Rotates evenly over the usable accounts. Weights are ignored.",
  "fill-first": "Always picks the same first account until it stops being usable.",
  "weighted-round-robin": "Rotates in proportion to each account's weight.",
};

/**
 * Age of a health reading, in the same discipline the harness runtime cards
 * use: a phase without its age reads as a live fact, and a cached one outlives
 * whatever it described.
 */
export function gatewayObservedAgeLabel(observedAtMs: number, nowMs: number): string {
  const elapsedMs = nowMs - observedAtMs;
  if (!Number.isFinite(elapsedMs)) return "check time unknown";
  if (elapsedMs < 0) return "checked just now";
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 5) return "checked just now";
  if (seconds < 60) return `checked ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `checked ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `checked ${hours}h ago`;
  return `checked ${Math.floor(hours / 24)}d ago`;
}

/**
 * What the pool's configured strategy actually does to this provider, stated
 * without euphemism. An API-key pool is told plainly that its strategy and
 * weights are not read at all, because showing a weight column that changes
 * nothing is worse than showing none.
 */
export function gatewayPoolBehaviourDescription(pool: WorkjetGatewayProviderPool): string {
  if (!pool.weightHonored && !pool.priorityExclusive) {
    return "The gateway sorts this pool by priority and then rotates over every enabled account. It does not read weights or the selection strategy for this provider.";
  }
  const base = WORKJET_GATEWAY_ROUTING_STRATEGY_DESCRIPTIONS[pool.strategy];
  const priority = pool.priorityExclusive
    ? " Only accounts at the highest priority are eligible; the rest are held back until those stop being usable."
    : "";
  const weight = pool.weightHonored ? "" : " Weights are not used under this strategy.";
  return `${base}${priority}${weight}`;
}

export function gatewayPoolMemberStateLabel(member: WorkjetGatewayPoolMember): string {
  if (!member.enabled) return "Disabled";
  return member.selectable ? "In rotation" : "Held back";
}

export type WorkjetGatewayRoutingState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "completed" };

export interface WorkjetGatewayPoolsSectionState {
  readonly catalog: WorkjetGatewayCatalog | null;
  readonly health: WorkjetGatewayHealth | null;
  readonly models: WorkjetGatewayModelDiscovery | null;
  readonly healthError: string | null;
  readonly modelsError: string | null;
  /** Injected so the rendered age is deterministic in tests. */
  readonly nowMs: number;
  readonly canEdit: boolean;
  readonly routing: WorkjetGatewayRoutingState;
  readonly onSaveRouting: (input: WorkjetGatewayUpdateRoutingInput) => void;
}

interface MemberDraft {
  readonly enabled: boolean;
  readonly priority: number;
  readonly weight: number;
}

const draftKey = (member: WorkjetGatewayPoolMember): string => String(member.accountId);

const boundedInteger = (
  raw: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

function PoolMemberRow({
  member,
  pool,
  draft,
  disabled,
  onChange,
}: {
  readonly member: WorkjetGatewayPoolMember;
  readonly pool: WorkjetGatewayProviderPool;
  readonly draft: MemberDraft;
  readonly disabled: boolean;
  readonly onChange: (next: MemberDraft) => void;
}) {
  const idBase = `workjet-gateway-pool-${String(member.accountId)}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/40 pt-2 first:border-t-0 first:pt-0">
      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled}
          aria-label={`Enable ${member.label}`}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
        />
        <span className="min-w-0 truncate">{member.label}</span>
      </label>
      <label
        htmlFor={`${idBase}-priority`}
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        Priority
        <input
          id={`${idBase}-priority`}
          type="number"
          inputMode="numeric"
          value={draft.priority}
          disabled={disabled}
          min={-WORKJET_GATEWAY_MAX_ACCOUNT_PRIORITY}
          max={WORKJET_GATEWAY_MAX_ACCOUNT_PRIORITY}
          onChange={(event) =>
            onChange({
              ...draft,
              priority: boundedInteger(
                event.target.value,
                -WORKJET_GATEWAY_MAX_ACCOUNT_PRIORITY,
                WORKJET_GATEWAY_MAX_ACCOUNT_PRIORITY,
                draft.priority,
              ),
            })
          }
          className="w-16 rounded-md border border-border bg-background px-1.5 py-0.5 text-right font-mono text-xs text-foreground"
        />
      </label>
      {/*
        A weight field on a pool that never reads weights is a lie in a text
        box, so the column simply is not offered there.
      */}
      {pool.weightHonored ? (
        <label
          htmlFor={`${idBase}-weight`}
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          Weight
          <input
            id={`${idBase}-weight`}
            type="number"
            inputMode="numeric"
            value={draft.weight}
            disabled={disabled}
            min={1}
            max={WORKJET_GATEWAY_MAX_ACCOUNT_WEIGHT}
            onChange={(event) =>
              onChange({
                ...draft,
                weight: boundedInteger(
                  event.target.value,
                  1,
                  WORKJET_GATEWAY_MAX_ACCOUNT_WEIGHT,
                  draft.weight,
                ),
              })
            }
            className="w-16 rounded-md border border-border bg-background px-1.5 py-0.5 text-right font-mono text-xs text-foreground"
          />
        </label>
      ) : null}
      <span className="text-xs text-muted-foreground">{gatewayPoolMemberStateLabel(member)}</span>
    </div>
  );
}

function GatewayHealthRow({
  health,
  healthError,
  nowMs,
}: {
  readonly health: WorkjetGatewayHealth | null;
  readonly healthError: string | null;
  readonly nowMs: number;
}) {
  if (healthError !== null) {
    return (
      <SettingsRow
        title="Health"
        status={
          <span role="alert" className="flex items-start gap-1.5 text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {healthError}
          </span>
        }
      />
    );
  }
  if (health === null) {
    return (
      <SettingsRow
        title="Health"
        status={<span className="text-muted-foreground">No health reading yet.</span>}
      />
    );
  }
  return (
    <SettingsRow
      title="Health"
      description="Read from the running gateway. The gateway reports provider-level state only: it does not publish per-account rate-limit, cooldown, or capacity figures, so none are shown here."
      status={
        <div className="space-y-0.5">
          <p role="status">{gatewayObservedAgeLabel(health.observedAtMs, nowMs)}</p>
          {health.providers.length === 0 ? (
            <p className="text-muted-foreground">No provider is configured.</p>
          ) : (
            health.providers.map((provider) => (
              <p key={provider.provider} className="text-muted-foreground">
                {WORKJET_GATEWAY_PROVIDER_LABELS[provider.provider]} ·{" "}
                {provider.enabledAccountCount} of {provider.accountCount} enabled ·{" "}
                {provider.phase === "ready"
                  ? "serving"
                  : provider.phase === "waiting-for-subscription"
                    ? "waiting for an account"
                    : "state unknown"}
              </p>
            ))
          )}
          <p className="text-muted-foreground">
            Per-account health: not reported by the gateway. Capacity: not reported by the gateway.
          </p>
        </div>
      }
    />
  );
}

function GatewayModelsRow({
  models,
  modelsError,
  nowMs,
}: {
  readonly models: WorkjetGatewayModelDiscovery | null;
  readonly modelsError: string | null;
  readonly nowMs: number;
}) {
  if (modelsError !== null) {
    return (
      <SettingsRow
        title="Models"
        status={
          <span role="alert" className="flex items-start gap-1.5 text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {modelsError}
          </span>
        }
      />
    );
  }
  if (models === null) {
    return (
      <SettingsRow
        title="Models"
        status={<span className="text-muted-foreground">No model reading yet.</span>}
      />
    );
  }
  return (
    <SettingsRow
      title="Models"
      description="What the gateway says each provider serves. This comes from the gateway's own model catalog and from the models recorded on each account — the gateway does not ask the provider, so neither list is a live capability answer."
      status={
        <div className="space-y-0.5">
          <p role="status">{gatewayObservedAgeLabel(models.observedAtMs, nowMs)}</p>
          {models.providers.length === 0 ? (
            <p className="text-muted-foreground">No provider is configured.</p>
          ) : (
            models.providers.map((provider) => {
              const fromCatalog = provider.models.filter(
                (model) => model.source === "gateway-catalog",
              ).length;
              const configured = provider.models.length - fromCatalog;
              return (
                <p key={provider.provider} className="text-muted-foreground">
                  {WORKJET_GATEWAY_PROVIDER_LABELS[provider.provider]} ·{" "}
                  {provider.catalogAvailable
                    ? `${fromCatalog} from the gateway catalog`
                    : "no gateway catalog for this provider"}
                  {configured > 0 ? ` · ${configured} from account configuration` : ""}
                </p>
              );
            })
          )}
        </div>
      }
    />
  );
}

/**
 * Pool membership, health, and model discovery for the environment's gateway.
 *
 * Everything editable here maps one-to-one onto something the gateway host
 * actually reads. There is no named-pool editor because the host has no named
 * pools: it holds one pool per provider and cannot route to a subset of one.
 */
export function WorkjetGatewayPoolsSectionView(state: WorkjetGatewayPoolsSectionState) {
  const pools = state.catalog?.providerPools ?? [];
  const catalogStrategy = state.catalog?.routingStrategy ?? "round-robin";
  // Seeded from the catalog and re-seeded whenever the server's answer changes,
  // so a save elsewhere is never silently overwritten by a stale draft.
  const seed = useMemo(() => {
    const members = new Map<string, MemberDraft>();
    for (const pool of pools) {
      for (const member of pool.members) {
        members.set(draftKey(member), {
          enabled: member.enabled,
          priority: member.priority,
          weight: member.weight,
        });
      }
    }
    return { strategy: catalogStrategy, members };
  }, [catalogStrategy, pools]);
  const [draft, setDraft] = useState(seed);
  const [seenSeed, setSeenSeed] = useState(seed);
  if (seenSeed !== seed) {
    setSeenSeed(seed);
    setDraft(seed);
  }

  const isSaving = state.routing.status === "saving";
  const disabled = !state.canEdit || isSaving;
  const isDirty =
    draft.strategy !== seed.strategy ||
    [...draft.members].some(([accountId, member]) => {
      const original = seed.members.get(accountId);
      return (
        original === undefined ||
        original.enabled !== member.enabled ||
        original.priority !== member.priority ||
        original.weight !== member.weight
      );
    });

  const save = () => {
    if (disabled || !isDirty) return;
    state.onSaveRouting({
      strategy: draft.strategy,
      accounts: [...draft.members].map(([accountId, member]) => ({
        accountId: accountId as WorkjetGatewayUpdateRoutingInput["accounts"][number]["accountId"],
        enabled: member.enabled,
        priority: member.priority,
        weight: member.weight,
      })),
    });
  };

  return (
    <SettingsSection
      id={searchableSetting("workjet-provider-pools").id}
      title="Gateway pools"
      headerAction={
        <Button type="button" size="sm" onClick={save} disabled={disabled || !isDirty}>
          {isSaving ? <Spinner className="size-3.5" /> : null}
          Save pools
        </Button>
      }
    >
      <SettingsRow
        title="Selection strategy"
        description="One strategy for the whole gateway. The gateway holds a single selection strategy for every pool, not one per provider, so this choice applies everywhere."
        control={
          <select
            aria-label="Gateway selection strategy"
            value={draft.strategy}
            disabled={disabled}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                strategy: event.target.value as WorkjetGatewayRoutingStrategy,
              }))
            }
            className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {WORKJET_GATEWAY_ROUTING_STRATEGIES.map((strategy) => (
              <option key={strategy} value={strategy}>
                {WORKJET_GATEWAY_ROUTING_STRATEGY_LABELS[strategy]}
              </option>
            ))}
          </select>
        }
        status={
          <span className="text-muted-foreground">
            {WORKJET_GATEWAY_ROUTING_STRATEGY_DESCRIPTIONS[draft.strategy]}
          </span>
        }
      />

      {state.routing.status === "failed" ? (
        <SettingsRow
          title="Pools not saved"
          status={
            <span role="alert" className="flex items-start gap-1.5 text-destructive">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              {state.routing.message}
            </span>
          }
        />
      ) : null}

      {pools.length === 0 ? (
        <SettingsRow
          title="No pools"
          status={
            <span className="text-muted-foreground">
              A pool appears for each provider once it has an account.
            </span>
          }
        />
      ) : (
        pools.map((pool) => (
          <SettingsRow
            key={pool.provider}
            title={`${WORKJET_GATEWAY_PROVIDER_LABELS[pool.provider]} pool`}
            description={gatewayPoolBehaviourDescription(pool)}
          >
            <div className="mt-1 space-y-2 pb-3.5">
              {pool.members.map((member) => {
                const memberDraft = draft.members.get(draftKey(member)) ?? {
                  enabled: member.enabled,
                  priority: member.priority,
                  weight: member.weight,
                };
                return (
                  <PoolMemberRow
                    key={String(member.accountId)}
                    member={member}
                    pool={pool}
                    draft={memberDraft}
                    disabled={disabled}
                    onChange={(next) =>
                      setDraft((current) => {
                        const members = new Map(current.members);
                        members.set(draftKey(member), next);
                        return { ...current, members };
                      })
                    }
                  />
                );
              })}
            </div>
          </SettingsRow>
        ))
      )}

      <GatewayHealthRow health={state.health} healthError={state.healthError} nowMs={state.nowMs} />
      <GatewayModelsRow models={state.models} modelsError={state.modelsError} nowMs={state.nowMs} />
    </SettingsSection>
  );
}
