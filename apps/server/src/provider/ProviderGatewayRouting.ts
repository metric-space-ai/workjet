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
 * Four harnesses are routable, each through a mechanism verified against the
 * installed CLI rather than assumed from its documentation:
 *   - claudeAgent  `ANTHROPIC_BASE_URL` (bare root; the CLI appends `/v1/...`)
 *   - codex        dotted `-c model_providers.*` launch args, because
 *                  `OPENAI_BASE_URL` is empirically ignored
 *   - grok         `GROK_MODELS_BASE_URL` (`/v1`-prefixed)
 *   - opencode     `ANTHROPIC_BASE_URL` + `OPENAI_BASE_URL` (`/v1`-prefixed),
 *                  read by the AI-SDK provider packages inside `opencode serve`
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
 * A routed session also has to tell the gateway WHICH upstream to serve. The
 * gateway host's only per-request selector is the `X-CTOX-Provider` header, so
 * the model the composer selected is resolved against the gateway catalog
 * (`resolveWorkjetGatewayModelRoute`) and the answer is written as a request
 * header through the mechanism each CLI actually has — `ANTHROPIC_CUSTOM_HEADERS`
 * for Claude Code, a `http_headers` `-c` override for Codex. Grok and OpenCode
 * have no such env mechanism, so their sessions keep relying on the gateway's
 * configured default provider; see {@link GATEWAY_PROVIDER_HEADER_DRIVERS}.
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
import {
  resolveWorkjetGatewayModelRoute,
  WORKJET_GATEWAY_PROVIDER_HEADER,
  type ProviderInstanceEnvironment,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayProvider,
} from "@t3tools/contracts";
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
 * Env var the Grok CLI reads its OpenAI-compatible inference base URL from.
 *
 * Verified against the installed `grok` binary (see module tests): with
 * `GROK_MODELS_BASE_URL=<base>/v1` the CLI fetched `GET <base>/v1/models` and
 * posted turns to `<base>/v1/responses` and `<base>/v1/chat/completions` — all
 * three are routes the gateway serves. `GROK_MODELS_LIST_URL` is deliberately
 * NOT set: Grok derives the list URL as `{base}/models`, which is correct here.
 */
export const GATEWAY_GROK_BASE_URL_ENV = "GROK_MODELS_BASE_URL";

/**
 * Credential variable Grok pairs with a custom base URL.
 *
 * Caveat observed on the installed binary: when a `grok login` session token
 * exists it outranks `XAI_API_KEY` in Grok's credential order, so inference
 * requests reach the gateway carrying that session bearer instead of the
 * placeholder. Routing itself is unaffected — every request still goes to the
 * loopback gateway rather than to api.x.ai — but the gateway, not the CLI, is
 * what decides which upstream credential is finally used.
 */
export const GATEWAY_GROK_API_KEY_ENV = "XAI_API_KEY";

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
export const GATEWAY_ROUTABLE_DRIVERS = ["claudeAgent", "codex", "grok", "opencode"] as const;
export type GatewayRoutableDriver = (typeof GATEWAY_ROUTABLE_DRIVERS)[number];

export function isGatewayRoutableDriver(driver: string): driver is GatewayRoutableDriver {
  return (GATEWAY_ROUTABLE_DRIVERS as ReadonlyArray<string>).includes(driver);
}

/**
 * Env var Claude Code reads extra request headers from, one `Name: Value` per
 * line. Verified against the installed CLI 2.1.226 (loopback probe): with
 * `ANTHROPIC_CUSTOM_HEADERS="X-CTOX-Provider: claude"` the observed
 * `POST /v1/messages?beta=true` carried `x-ctox-provider: claude`.
 */
export const GATEWAY_CLAUDE_CUSTOM_HEADERS_ENV = "ANTHROPIC_CUSTOM_HEADERS";

/**
 * Drivers that can actually CARRY the resolved provider to the gateway.
 *
 * The gateway host's only per-request selector is the
 * `X-CTOX-Provider` header; with the header absent it serves its configured
 * default provider. So a driver belongs here only when a verified mechanism
 * exists to put that header on its requests:
 *   - claudeAgent  `ANTHROPIC_CUSTOM_HEADERS` (verified, CLI 2.1.226)
 *   - codex        `model_providers.<id>.http_headers.<name>` through the
 *                  existing `-c` launch-argument seam (verified, codex-cli
 *                  0.144.1: the probe saw `x-ctox-provider` on
 *                  `GET /v1/models` and `POST /v1/responses`)
 *
 * Grok and OpenCode are deliberately absent. Grok does support per-header
 * configuration, but only as `extra_headers`/`env_http_headers` inside
 * `config.toml`, which Workjet does not author; OpenCode's AI-SDK providers
 * expose no header environment variable at all. For those two the model is
 * still resolved for reporting, but the session is NOT failed on a resolution
 * error and no header is written — inventing one the request never carries
 * would be a lie in the environment, and failing would regress routing that
 * works today via the gateway's default provider.
 */
export const GATEWAY_PROVIDER_HEADER_DRIVERS = ["claudeAgent", "codex"] as const;
export type GatewayProviderHeaderDriver = (typeof GATEWAY_PROVIDER_HEADER_DRIVERS)[number];

export function driverCarriesGatewayProvider(
  driver: string,
): driver is GatewayProviderHeaderDriver {
  return (GATEWAY_PROVIDER_HEADER_DRIVERS as ReadonlyArray<string>).includes(driver);
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
 * The gateway's `/v1` prefix, as every client that joins bare route names
 * onto a base URL needs it.
 *
 * Claude Code is the exception: it appends `/v1/messages` itself, so it gets
 * {@link normalizeGatewayBaseUrl} instead. Codex, Grok, and OpenCode all join
 * `/responses`, `/models`, or `/messages` directly and therefore need the
 * prefix baked into the base URL. Kept as one function so the gateway's route
 * layout is stated in a single place rather than re-spelled per driver.
 */
export function gatewayVersionedBaseUrl(providerEndpoint: string): string {
  return `${normalizeGatewayBaseUrl(providerEndpoint)}/v1`;
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
export function codexGatewayLaunchArgs(
  providerEndpoint: string,
  gatewayProvider?: WorkjetGatewayProvider | undefined,
): string {
  const providerKey = `model_providers.${GATEWAY_CODEX_PROVIDER_ID}`;
  return [
    `-c model_provider=${GATEWAY_CODEX_PROVIDER_ID}`,
    `-c ${providerKey}.name=Workjet`,
    `-c ${providerKey}.base_url=${gatewayVersionedBaseUrl(providerEndpoint)}`,
    `-c ${providerKey}.wire_api=responses`,
    `-c ${providerKey}.env_key=${GATEWAY_CODEX_API_KEY_ENV}`,
    // Static request header naming the upstream the gateway must serve.
    // Verified against codex-cli 0.144.1: a dotted `-c` override under
    // `http_headers` accepts a hyphenated header name and the probe saw the
    // header on both `GET /v1/models` and `POST /v1/responses`.
    ...(gatewayProvider === undefined
      ? []
      : [`-c ${providerKey}.http_headers.${WORKJET_GATEWAY_PROVIDER_HEADER}=${gatewayProvider}`]),
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
  /**
   * The gateway provider the selected model resolved to. Omitted when the
   * session pinned no model, when the catalog declares none, or when the
   * driver has no verified header mechanism — in each case the gateway falls
   * back to its own configured default provider.
   */
  readonly gatewayProvider?: WorkjetGatewayProvider | undefined;
}): Record<string, string> {
  const baseUrl = normalizeGatewayBaseUrl(input.providerEndpoint);
  const versionedBaseUrl = gatewayVersionedBaseUrl(input.providerEndpoint);

  switch (input.driver) {
    case "claudeAgent":
      // ANTHROPIC_AUTH_TOKEN is deliberately NOT set. Claude Code treats it as
      // an OAuth-style bearer and prefers it over ANTHROPIC_API_KEY; setting
      // both makes which credential is sent depend on CLI version.
      return {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_API_KEY: GATEWAY_PLACEHOLDER_API_KEY,
        ...(input.gatewayProvider === undefined
          ? {}
          : {
              [GATEWAY_CLAUDE_CUSTOM_HEADERS_ENV]: `${WORKJET_GATEWAY_PROVIDER_HEADER}: ${input.gatewayProvider}`,
            }),
      };

    case "grok":
      return {
        [GATEWAY_GROK_BASE_URL_ENV]: versionedBaseUrl,
        [GATEWAY_GROK_API_KEY_ENV]: GATEWAY_PLACEHOLDER_API_KEY,
      };

    case "opencode":
      // OpenCode drives models through the Vercel AI SDK provider packages,
      // which read the standard per-vendor base-URL variables and join bare
      // route names (`/messages`, `/responses`) onto them — hence the `/v1`
      // form here, unlike Claude Code's bare root. Verified against the
      // installed CLI (see module tests): the spawned `opencode serve`
      // inherits these and reached the local probe at `/v1/messages` and
      // `/v1/responses`.
      //
      // This covers the Anthropic- and OpenAI-shaped providers, which are the
      // wire formats the gateway serves. A session pinned to some other
      // OpenCode provider (Google, MiniMax, …) has no gateway route and keeps
      // using its own credentials.
      return {
        ANTHROPIC_BASE_URL: versionedBaseUrl,
        ANTHROPIC_API_KEY: GATEWAY_PLACEHOLDER_API_KEY,
        OPENAI_BASE_URL: versionedBaseUrl,
        OPENAI_API_KEY: GATEWAY_PLACEHOLDER_API_KEY,
      };

    case "codex": {
      const configured = input.existingLaunchArgs?.trim() ?? "";
      const gatewayArgs = codexGatewayLaunchArgs(input.providerEndpoint, input.gatewayProvider);
      return {
        [GATEWAY_CODEX_API_KEY_ENV]: GATEWAY_PLACEHOLDER_API_KEY,
        [GATEWAY_CODEX_LAUNCH_ARGS_ENV]:
          configured.length > 0 ? `${configured} ${gatewayArgs}` : gatewayArgs,
      };
    }
  }
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

/**
 * OpenCode-specific pre-check: is this instance routable at all?
 *
 * Routing reaches OpenCode through the environment of the `opencode serve`
 * child Workjet spawns. An instance configured with an external `serverUrl`
 * has no such child, so the overlay would be written and then ignored — the
 * operator would believe they were on the gateway pool while the external
 * server kept billing its own credentials. Returns the error to raise, or
 * `null` when the instance is routable.
 */
export function openCodeGatewayRoutingBlock(input: {
  readonly instanceId: string;
  readonly routeViaGateway: boolean;
  readonly serverUrl: string | null | undefined;
}): ProviderGatewayRoutingError | null {
  const externalServerUrl = input.serverUrl?.trim() ?? "";
  if (!input.routeViaGateway || externalServerUrl.length === 0) return null;
  return new ProviderGatewayRoutingError({
    provider: "opencode",
    instanceId: input.instanceId,
    reason: "instance-unroutable",
    detail: `This OpenCode instance targets an external server (${externalServerUrl}); Workjet does not control that process's environment and cannot route it through the gateway. Clear the server URL so Workjet starts OpenCode itself, or disable "Route via Workjet gateway" for this instance.`,
  });
}

export interface ResolveGatewayRoutedEnvironmentInput {
  readonly driver: string;
  readonly instanceId: string;
  readonly routeViaGateway: boolean;
  readonly environment: ProviderInstanceEnvironment | undefined;
  /** Codex only — the instance's configured launch arguments, preserved. */
  readonly launchArgs?: string | undefined;
  /**
   * The model the composer selected for this session, as the harness sees it.
   * Absent when the thread pinned no model; the gateway then serves its own
   * default provider, exactly as before this resolution existed.
   */
  readonly model?: string | null | undefined;
  /** Overridable for tests; defaults to the server process environment. */
  readonly baseEnv?: NodeJS.ProcessEnv;
}

/**
 * Resolve the selected model to a gateway provider, or fail typed.
 *
 * Only called for a driver that can carry the answer, and only when a model
 * was actually selected: reading the catalog for a session that could not use
 * the result would be a pointless management round trip on every session
 * start, and — worse — would turn a catalog outage into a routing failure for
 * sessions that never needed the catalog.
 */
const resolveGatewayProviderForModel = Effect.fn("resolveGatewayProviderForModel")(
  function* (input: {
    readonly driver: string;
    readonly instanceId: string;
    readonly model: string;
  }): Effect.fn.Return<
    WorkjetGatewayProvider | undefined,
    ProviderGatewayRoutingError,
    ProviderGatewayService
  > {
    const gateway = yield* ProviderGatewayService;
    const catalog: WorkjetGatewayCatalog = yield* gateway.catalog().pipe(
      Effect.mapError(
        (cause) =>
          new ProviderGatewayRoutingError({
            provider: input.driver,
            instanceId: input.instanceId,
            reason: "catalog-unavailable",
            detail: `The Workjet gateway is ready but its account catalog could not be read (${cause.reason}), so model '${input.model}' cannot be resolved to a provider.`,
            cause,
          }),
      ),
    );

    const resolution = resolveWorkjetGatewayModelRoute({ catalog, model: input.model });
    if (resolution.outcome === "failed") {
      return yield* new ProviderGatewayRoutingError({
        provider: input.driver,
        instanceId: input.instanceId,
        reason: resolution.reason,
        detail: resolution.detail,
      });
    }
    // A skipped resolution leaves the header off on purpose; the gateway then
    // applies its configured default provider.
    return resolution.outcome === "resolved" ? resolution.provider : undefined;
  },
);

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

    const selectedModel = input.model?.trim() ?? "";
    const gatewayProvider =
      selectedModel.length > 0 && driverCarriesGatewayProvider(input.driver)
        ? yield* resolveGatewayProviderForModel({
            driver: input.driver,
            instanceId: input.instanceId,
            model: selectedModel,
          })
        : undefined;

    return applyGatewayRoutingOverlay({
      merged,
      declared: input.environment,
      overlay: gatewayRoutingEnvironmentOverlay({
        driver: input.driver,
        providerEndpoint,
        ...(input.launchArgs === undefined ? {} : { existingLaunchArgs: input.launchArgs }),
        ...(gatewayProvider === undefined ? {} : { gatewayProvider }),
      }),
    });
  },
);
