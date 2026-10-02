/**
 * Deterministic `ProviderGatewayService` stand-ins for provider tests.
 *
 * Provider drivers consult the gateway lazily at session start, so any test
 * that builds a driver needs the service in context. These layers supply a
 * fixed status and fail loudly on every management operation — a provider
 * test that reaches for OAuth or process control has escaped its subject.
 *
 * @module provider/testUtils/providerGatewayTestLayer
 */
import {
  WorkjetGatewayOperationError,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderGatewayService } from "../../providerGateway/ProviderGatewayService.ts";

const unsupported = () =>
  Effect.fail(new WorkjetGatewayOperationError({ reason: "host-unavailable" }));

export const stoppedGatewayStatus: WorkjetGatewayStatus = {
  schemaVersion: 1,
  phase: "stopped",
  pid: null,
  providerEndpoint: null,
  managementEndpoint: null,
  failureReason: null,
  configuredAccountCount: 0,
  configuredModelCount: 0,
};

export const readyGatewayStatus = (providerEndpoint: string): WorkjetGatewayStatus => ({
  schemaVersion: 1,
  phase: "ready",
  pid: 4242,
  providerEndpoint,
  managementEndpoint: "http://127.0.0.1:59998",
  failureReason: null,
  configuredAccountCount: 1,
  configuredModelCount: 1,
});

/**
 * Layer serving one fixed status snapshot, and optionally one fixed catalog.
 *
 * `catalog` stays unsupported by default so a test that reaches for it
 * unintentionally still fails loudly: model→provider resolution must only
 * happen for a session that actually pinned a model on a header-carrying
 * driver, and a silently-succeeding catalog would hide a regression there.
 */
export const providerGatewayTestLayer = (
  status: WorkjetGatewayStatus,
  catalog?: WorkjetGatewayCatalog,
) =>
  Layer.succeed(ProviderGatewayService)(
    ProviderGatewayService.of({
      status: () => Effect.succeed(status),
      catalog: () => (catalog === undefined ? unsupported() : Effect.succeed(catalog)),
      start: () => unsupported(),
      stop: () => unsupported(),
      oauthStart: () => unsupported(),
      oauthPoll: () => unsupported(),
      oauthCancel: () => unsupported(),
      addApiKeyAccount: () => unsupported(),
      health: () => unsupported(),
      discoverModels: () => unsupported(),
      updateRouting: () => unsupported(),
    }),
  );

/** The common case: no gateway running, so nothing is routable. */
export const stoppedProviderGatewayTestLayer = providerGatewayTestLayer(stoppedGatewayStatus);
