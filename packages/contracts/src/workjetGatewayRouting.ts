/**
 * workjetGatewayRouting — resolve a SELECTED MODEL to the gateway provider
 * (and pool) that should serve it.
 *
 * The gateway multiplexes several upstreams behind one loopback endpoint. Its
 * only per-request selector is the `X-CTOX-Provider` header (see the Rust
 * host's `serve_provider_connection`); with the header absent the host serves
 * its configured default provider. Deciding WHICH provider a model belongs to
 * is therefore a Workjet-side job, and it has to happen at session start, from
 * the model the user picked in the composer.
 *
 * This module is the single statement of those rules. It lives in `contracts`
 * rather than in the server because both sides need the SAME answer: the
 * server carries it into the harness environment, and the settings UI shows
 * the operator what each known model resolves to. A second implementation in
 * the web app would be a second place for the routing table to be wrong.
 *
 * Resolution order, most specific first:
 *   1. `routes` — an operator-authored mapping of model patterns to a pool.
 *   2. `pools`  — a pool that lists the model, when no route matched.
 *   3. `accounts` — the provider whose catalog lists the model.
 *
 * Every step is fail-loud. An unknown model is `model-unrouted`, not a silent
 * fall-through to the gateway default: the default would quietly bill the
 * wrong subscription, which is exactly the failure the gateway exists to
 * prevent. Two candidates that disagree are `route-ambiguous` /
 * `model-ambiguous` rather than a first-wins guess.
 *
 * Two outcomes are deliberately NOT failures, because in both the catalog has
 * nothing to say and today's default-provider behavior is correct:
 *   - `model-unspecified` — the session pinned no model.
 *   - `catalog-empty`     — no route, pool, or account declares any model.
 *
 * @module workjetGatewayRouting
 */
import type {
  WorkjetGatewayCatalog,
  WorkjetGatewayPoolId,
  WorkjetGatewayProvider,
  WorkjetGatewayRouteId,
} from "./workjet.ts";

/** HTTP header the gateway host reads its provider selection from. */
export const WORKJET_GATEWAY_PROVIDER_HEADER = "X-CTOX-Provider";

/** Which part of the catalog produced a resolution. */
export type WorkjetGatewayModelRouteVia = "route" | "pool" | "account";

/** Why a resolution was skipped without being an error. */
export type WorkjetGatewayModelRouteSkipReason = "model-unspecified" | "catalog-empty";

/** Why a resolution failed. Closed set, so callers branch without parsing prose. */
export type WorkjetGatewayModelRouteFailureReason =
  | "model-unrouted"
  | "route-ambiguous"
  | "model-ambiguous";

export interface WorkjetGatewayModelRouteResolved {
  readonly outcome: "resolved";
  readonly model: string;
  readonly provider: WorkjetGatewayProvider;
  /** The pool that serves the model, when one is named; `null` on the account fallback. */
  readonly poolId: WorkjetGatewayPoolId | null;
  readonly routeId: WorkjetGatewayRouteId | null;
  readonly via: WorkjetGatewayModelRouteVia;
}

export interface WorkjetGatewayModelRouteSkipped {
  readonly outcome: "skipped";
  readonly model: string | null;
  readonly reason: WorkjetGatewayModelRouteSkipReason;
  readonly detail: string;
}

export interface WorkjetGatewayModelRouteFailed {
  readonly outcome: "failed";
  readonly model: string;
  readonly reason: WorkjetGatewayModelRouteFailureReason;
  readonly detail: string;
}

export type WorkjetGatewayModelRoute =
  | WorkjetGatewayModelRouteResolved
  | WorkjetGatewayModelRouteSkipped
  | WorkjetGatewayModelRouteFailed;

/**
 * Does `pattern` describe `model`?
 *
 * A pattern is a plain model id, optionally with `*` standing for any run of
 * characters — the smallest glob that expresses the two things operators
 * actually write (`claude-*`, `*-mini`). Matching is case-insensitive because
 * model ids are quoted inconsistently across harnesses, and a case-only miss
 * would surface as a bogus `model-unrouted`.
 */
export const matchesWorkjetGatewayModelPattern = (pattern: string, model: string): boolean => {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  if (normalizedPattern.length === 0 || normalizedModel.length === 0) return false;
  if (!normalizedPattern.includes("*")) return normalizedPattern === normalizedModel;
  const expression = normalizedPattern
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(normalizedModel);
};

/**
 * How specific a matching pattern is: the number of literal characters it
 * pins. An exact id therefore always outranks a glob, and `claude-opus-*`
 * outranks `claude-*`. Ranking rather than first-wins keeps a broad catch-all
 * route from shadowing the precise route written next to it.
 */
const patternSpecificity = (pattern: string): number =>
  pattern.trim().replace(/\*/g, "").length + (pattern.includes("*") ? 0 : 1_000);

const bestSpecificity = (patterns: ReadonlyArray<string>, model: string): number | undefined => {
  let best: number | undefined;
  for (const pattern of patterns) {
    if (!matchesWorkjetGatewayModelPattern(pattern, model)) continue;
    const specificity = patternSpecificity(pattern);
    if (best === undefined || specificity > best) best = specificity;
  }
  return best;
};

const catalogDeclaresAnyModel = (catalog: WorkjetGatewayCatalog): boolean =>
  catalog.routes.some((route) => route.modelIds.length > 0) ||
  catalog.pools.some((pool) => pool.modelIds.length > 0) ||
  catalog.accounts.some((account) => account.modelIds.length > 0);

export interface ResolveWorkjetGatewayModelRouteInput {
  readonly catalog: WorkjetGatewayCatalog;
  /** The model the composer selected; `null`/`undefined` when none was pinned. */
  readonly model: string | null | undefined;
}

/**
 * Resolve the gateway provider that should serve `model`.
 *
 * Pure and total: every input produces one of the three outcomes, and the
 * caller decides whether a `failed` outcome aborts a session (the server) or
 * is rendered as a warning row (the settings UI).
 */
export const resolveWorkjetGatewayModelRoute = (
  input: ResolveWorkjetGatewayModelRouteInput,
): WorkjetGatewayModelRoute => {
  const model = input.model?.trim() ?? "";
  if (model.length === 0) {
    return {
      outcome: "skipped",
      model: null,
      reason: "model-unspecified",
      detail: "The session pinned no model, so the gateway serves its default provider.",
    };
  }
  const catalog = input.catalog;
  if (!catalogDeclaresAnyModel(catalog)) {
    return {
      outcome: "skipped",
      model,
      reason: "catalog-empty",
      detail:
        "No gateway route, pool, or account declares any model, so there is nothing to route by.",
    };
  }

  // 1. Routes. Only the most specific matches compete; a tie between pools is
  //    an operator mistake we must not resolve by declaration order.
  const routeMatches = catalog.routes
    .map((route) => ({ route, specificity: bestSpecificity(route.modelIds, model) }))
    .filter(
      (candidate): candidate is { route: (typeof catalog.routes)[number]; specificity: number } =>
        candidate.specificity !== undefined,
    );
  if (routeMatches.length > 0) {
    const top = Math.max(...routeMatches.map((candidate) => candidate.specificity));
    const winners = routeMatches.filter((candidate) => candidate.specificity === top);
    const targets = new Set(winners.map((candidate) => `${candidate.route.poolId}`));
    if (targets.size > 1) {
      return {
        outcome: "failed",
        model,
        reason: "route-ambiguous",
        detail: `Model '${model}' matches equally specific gateway routes pointing at different pools (${[...targets].sort().join(", ")}). Narrow one of the route patterns.`,
      };
    }
    const winner = winners[0]!.route;
    return {
      outcome: "resolved",
      model,
      provider: winner.provider,
      poolId: winner.poolId,
      routeId: winner.id,
      via: "route",
    };
  }

  // 2. Pools, when no route claimed the model.
  const poolMatches = catalog.pools.filter(
    (pool) => bestSpecificity(pool.modelIds, model) !== undefined,
  );
  if (poolMatches.length > 0) {
    const providers = new Set(poolMatches.map((pool) => pool.provider));
    if (providers.size > 1) {
      return {
        outcome: "failed",
        model,
        reason: "model-ambiguous",
        detail: `Model '${model}' is listed by gateway pools of different providers (${[...providers].sort().join(", ")}). Add a route that pins the model to one pool.`,
      };
    }
    if (poolMatches.length > 1) {
      return {
        outcome: "failed",
        model,
        reason: "model-ambiguous",
        detail: `Model '${model}' is listed by more than one gateway pool (${poolMatches
          .map((pool) => `${pool.id}`)
          .sort()
          .join(", ")}). Add a route that pins the model to one pool.`,
      };
    }
    const pool = poolMatches[0]!;
    return {
      outcome: "resolved",
      model,
      provider: pool.provider,
      poolId: pool.id,
      routeId: null,
      via: "pool",
    };
  }

  // 3. Accounts. Disabled accounts do not count: routing to a provider whose
  //    only account for the model is switched off would fail upstream, far
  //    from the setting that caused it.
  const accountProviders = new Set(
    catalog.accounts
      .filter(
        (account) => account.enabled && bestSpecificity(account.modelIds, model) !== undefined,
      )
      .map((account) => account.provider),
  );
  if (accountProviders.size === 1) {
    const [provider] = [...accountProviders];
    return {
      outcome: "resolved",
      model,
      provider: provider!,
      poolId: null,
      routeId: null,
      via: "account",
    };
  }
  if (accountProviders.size > 1) {
    return {
      outcome: "failed",
      model,
      reason: "model-ambiguous",
      detail: `Model '${model}' is served by gateway accounts of more than one provider (${[
        ...accountProviders,
      ]
        .sort()
        .join(", ")}). Add a route that pins the model to one pool.`,
    };
  }
  return {
    outcome: "failed",
    model,
    reason: "model-unrouted",
    detail: `No enabled Workjet gateway account, pool, or route serves model '${model}'. Add the model to a gateway account, or pick a model the gateway carries.`,
  };
};

/**
 * The resolution outcome for every model the catalog knows, for the read-only
 * settings view. Sorted by model id so the table is stable across reloads.
 */
export const workjetGatewayModelRouteTable = (
  catalog: WorkjetGatewayCatalog,
): ReadonlyArray<WorkjetGatewayModelRoute> =>
  [...catalog.models]
    .map((summary) => summary.id)
    .sort((left, right) => left.localeCompare(right))
    .map((model) => resolveWorkjetGatewayModelRoute({ catalog, model }));
