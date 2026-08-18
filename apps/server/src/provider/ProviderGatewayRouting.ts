/**
 * ProviderGatewayRouting — route an opted-in provider instance's harness
 * sessions through the Workjet provider gateway.
 *
 * Design (docs/workjet-plan.md, Wave 3 routing note): routing is expressed
 * purely as environment variables layered onto the EXISTING per-instance
 * `mergeProviderInstanceEnvironment` merge point. Driver internals are not
 * forked — every driver already feeds that merged env into its child
 * process, so a routed session is just a session whose env carries the
 * gateway's loopback base URL.
 *
 * Precedence (lowest to highest):
 *   1. `process.env` of the server
 *   2. gateway routing variables injected here
 *   3. variables the operator declared on the provider instance
 *
 * An explicitly declared instance variable therefore always wins: an
 * operator who pins `ANTHROPIC_BASE_URL` by hand keeps that value even with
 * `routeViaGateway` on. That ordering is deliberate — the per-instance
 * environment list is the most specific, operator-authored statement of
 * intent, and silently overriding it would make a declared variable a lie.
 *
 * Resolution is LAZY: it runs per session start, not at driver construction.
 * The gateway is a long-lived process that starts, stops, and faults
 * independently of the provider registry, so a value captured when the
 * instance was built would go stale. Failure to resolve is a typed
 * `ProviderGatewayRoutingError`, never a silent fall back to the harness
 * CLI's own credentials.
 *
 * @module provider/ProviderGatewayRouting
 */
import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProviderGatewayService } from "../providerGateway/ProviderGatewayService.ts";
import { ProviderGatewayRoutingError } from "./Errors.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

/**
 * Placeholder credential handed to the harness CLI.
 *
 * The gateway's provider endpoint is loopback-only and performs no API-key
 * authentication, but the harness CLIs refuse to start when their key
 * variable is empty. This value is therefore a non-empty stand-in, never a
 * secret, and must never be treated as one.
 */
export const GATEWAY_PLACEHOLDER_API_KEY = "workjet-gateway";

/** Codex `model_providers.<id>` key used for the gateway route. */
export const GATEWAY_CODEX_PROVIDER_ID = "workjet_gateway";

/**
 * Env var Codex reads the gateway key from. Codex resolves a provider's
 * credential indirectly through `model_providers.<id>.env_key`, so the
 * variable name is ours to choose and is deliberately Workjet-scoped rather
 * than reusing `OPENAI_API_KEY` (which would also affect unrouted tools).
 */
export const GATEWAY_CODEX_API_KEY_ENV = "WORKJET_GATEWAY_API_KEY";

/**
 * Env var the Codex driver already consults for extra CLI launch arguments
 * (`resolveCodexLaunchArgs`). This is the seam that makes Codex routable
 * without forking the driver: Codex has no base-URL environment variable,
 * but it does accept `-c key=value` config overrides, and those overrides
 * reach the CLI through this variable.
 */
export const GATEWAY_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

/**
 * Harness drivers with a base-URL mechanism verified against the installed
 * CLI. Anything absent here is intentionally left unrouted rather than
 * routed with guessed variables.
 */
export const GATEWAY_ROUTABLE_DRIVERS = ["claudeAgent", "codex"] as const;
export type GatewayRoutableDriver = (typeof GATEWAY_ROUTABLE_DRIVERS)[number];

export function isGatewayRoutableDriver(driver: string): driver is GatewayRoutableDriver {
  return (GATEWAY_ROUTABLE_DRIVERS as ReadonlyArray<string>).includes(driver);
}

/**
 * Normalize the gateway's advertised endpoint for use as a base URL.
 *
 * A trailing slash is stripped because the harness CLIs join paths onto the
 * base URL directly and a doubled separator is not universally tolerated.
 */
export function normalizeGatewayBaseUrl(providerEndpoint: string): string {
  return providerEndpoint.trim().replace(/\/+$/, "");
}

/**
 * Build the Codex `-c` config overrides that point Codex at the gateway.
 *
 * Verified against codex-cli 0.144.1 (see module tests): Codex ignores
 * `OPENAI_BASE_URL` entirely, and honors a custom base URL only through a
 * `model_providers.<id>` entry. Dotted `-c` overrides build that entry
 * without touching the user's `config.toml`, which matters because the
 * shadow-home layout symlinks the real `config.toml` into place.
 *
 * Each value is passed unquoted: Codex parses an override value as TOML and
 * falls back to the raw string when that fails, so a URL (invalid TOML)
 * arrives as a literal string. Avoiding quotes also keeps the arguments
 * safe for the driver's plain whitespace tokenizer.
 */
export function codexGatewayLaunchArgs(baseUrl: string): string {
  const providerKey = `model_providers.${GATEWAY_CODEX_PROVIDER_ID}`;
  return [
    `-c model_provider=${GATEWAY_CODEX_PROVIDER_ID}`,
    `-c ${providerKey}.name=Workjet`,
    `-c ${providerKey}.base_url=${baseUrl}/v1`,
    `-c ${providerKey}.wire_api=responses`,
    `-c ${providerKey}.env_key=${GATEWAY_CODEX_API_KEY_ENV}`,
  ].join(" ");
}

/**
 * The env overlay a routed session needs, per driver.
 *
 * `existingLaunchArgs` is the instance's configured Codex launch arguments;
 * the gateway overrides are appended to them rather than replacing them,
 * because `T3CODE_CODEX_LAUNCH_ARGS` shadows the configured value entirely
 * and dropping the operator's arguments would be a silent regression.
 */
export function gatewayRoutingEnvironmentOverlay(input: {
  readonly driver: GatewayRoutableDriver;
  readonly providerEndpoint: string;
  readonly existingLaunchArgs?: string | undefined;
}): Record<string, string> {
  const baseUrl = normalizeGatewayBaseUrl(input.providerEndpoint);
  if (input.driver === "claudeAgent") {
    // ANTHROPIC_AUTH_TOKEN is deliberately NOT set. Claude Code treats it as
    // an OAuth-style bearer and prefers it over ANTHROPIC_API_KEY; setting
    // both makes which credential is sent depend on CLI version.
    return {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_API_KEY: GATEWAY_PLACEHOLDER_API_KEY,
    };
  }

  const configured = input.existingLaunchArgs?.trim() ?? "";
  const gatewayArgs = codexGatewayLaunchArgs(baseUrl);
  return {
    [GATEWAY_CODEX_API_KEY_ENV]: GATEWAY_PLACEHOLDER_API_KEY,
    [GATEWAY_CODEX_LAUNCH_ARGS_ENV]:
      configured.length > 0 ? `${configured} ${gatewayArgs}` : gatewayArgs,
  };
}

/**
 * Apply a routing overlay to an already-merged environment, honoring the
 * precedence rule: a variable the operator declared on the instance is left
 * exactly as declared.
 */
export function applyGatewayRoutingOverlay(input: {
  readonly merged: NodeJS.ProcessEnv;
  readonly declared: ProviderInstanceEnvironment | undefined;
  readonly overlay: Record<string, string>;
}): NodeJS.ProcessEnv {
  const declaredNames = new Set((input.declared ?? []).map((variable) => variable.name));
  const next: NodeJS.ProcessEnv = { ...input.merged };
  for (const [name, value] of Object.entries(input.overlay)) {
    if (declaredNames.has(name)) continue;
    next[name] = value;
  }
  return next;
}

export interface ResolveGatewayRoutedEnvironmentInput {
  readonly driver: string;
  readonly instanceId: string;
  readonly routeViaGateway: boolean;
  readonly environment: ProviderInstanceEnvironment | undefined;
  /** Codex only — the instance's configured launch arguments, preserved. */
  readonly launchArgs?: string | undefined;
  /** Overridable for tests; defaults to the server process environment. */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Resolve the environment a session should start with.
 *
 * For an instance that did not opt in this is exactly today's behavior —
 * the plain per-instance merge, with no gateway lookup performed at all.
 */
export const resolveGatewayRoutedEnvironment = Effect.fn("resolveGatewayRoutedEnvironment")(
  function* (
    input: ResolveGatewayRoutedEnvironmentInput,
  ): Effect.fn.Return<NodeJS.ProcessEnv, ProviderGatewayRoutingError, ProviderGatewayService> {
    const merged = mergeProviderInstanceEnvironment(
      input.environment,
      input.baseEnv ?? process.env,
    );
    if (!input.routeViaGateway) {
      return merged;
    }

    if (!isGatewayRoutableDriver(input.driver)) {
      return yield* new ProviderGatewayRoutingError({
        provider: input.driver,
        instanceId: input.instanceId,
        reason: "driver-unsupported",
        detail: `No verified Workjet gateway base-URL mechanism exists for the '${input.driver}' driver. Disable "Route via Workjet gateway" for this instance.`,
      });
    }

    const gateway = yield* ProviderGatewayService;
    const status = yield* gateway.status();
    if (status.phase !== "ready") {
      return yield* new ProviderGatewayRoutingError({
        provider: input.driver,
        instanceId: input.instanceId,
        reason: "gateway-not-ready",
        detail: `The Workjet provider gateway is '${status.phase}'. Start the gateway, or disable "Route via Workjet gateway" for this instance.`,
      });
    }

    const providerEndpoint = status.providerEndpoint;
    if (providerEndpoint === null || providerEndpoint.trim().length === 0) {
      return yield* new ProviderGatewayRoutingError({
        provider: input.driver,
        instanceId: input.instanceId,
        reason: "endpoint-unavailable",
        detail:
          "The Workjet provider gateway reported ready without a provider endpoint. Restart the gateway.",
      });
    }

    return applyGatewayRoutingOverlay({
      merged,
      declared: input.environment,
      overlay: gatewayRoutingEnvironmentOverlay({
        driver: input.driver,
        providerEndpoint,
        ...(input.launchArgs === undefined ? {} : { existingLaunchArgs: input.launchArgs }),
      }),
    });
  },
);
