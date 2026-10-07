# Source gateway inference for remote workers

The source Workjet server exposes three authenticated environment WebSocket RPCs.
They live in the managed server, independently of the renderer or Electron UI.
Provider API keys, OAuth material, the source CTOX Owner bearer and the source
Workjet session credential remain in the source managed process. The target
worker receives only logical references and the claimed native permit locator.

## Resolve the model binding

`workjet.providerGateway.bindModel` accepts:

```ts
{
  target: { connectionId, instanceId, computerId },
  modelSelection: { instanceId: sourceHarnessInstanceId, model: exactModelId },
  routeId?: configuredLlmRouteId,
}
```

The source harness instance must be enabled and opted into gateway routing.
The resolver intersects configured `llmRoutes[].gatewayAccountId` with the
fresh scoped catalog for the exact target and exact model ID. One enabled,
granted account must match. Multiple accounts fail closed unless an explicit
route narrows the selection. Automatic source stack account selection is not
implemented by this binding resolver; native references alone cannot establish it. Provider names come from the selected account;
labels and model aliases never establish a provider or account identity.
The result is `{target, credentialRef, providerRef, modelRef}`. These references
are selected scope, not permission to perform inference. The source broker
uses them in the immutable CTOX remote-worker admission binding.

## Revalidate create and turn admission

`workjet.providerGateway.admit` accepts `{sourceConnectionId, workerRequest,
permit}` and requires orchestration operate scope. It returns `{}` only after
the same current scoped grant and source native execution checks as inference.
The Receiver and serialized Engine `RemoteWorkerAdmission.admit(request)`
adapter can use this source bridge endpoint with the durable claimed receipt.
The claimed receipt includes its exact `renewalSequence`; a stale renewal,
owner epoch, execution binding or expiry fails closed. Native renewal remains
owned by the shared admission client; the model consumer never extends a lease.

## Execute through the source bridge

`workjet.providerGateway.infer` requires orchestration operate scope and accepts:

```ts
{
  sourceConnectionId, // server-held source CTOX connection
  workerRequest: immutableRemoteWorkerRequest,
  permit: claimedNativeRemoteWorkerReceipt,
  requestJson: JSON.stringify({ model: exactModelId, input, stream: false }),
}
```

The source consumer checks the actual source environment, exact source account,
provider/model and target tuple against a newly loaded scoped catalog. It then
calls `business_os.remote_worker_admission` with `action:"revalidate"` through
the existing server-held `DecisionHubConnectionRegistry` connection and native
MCP control transport. The complete claimed receipt (owner, authority epoch,
fingerprint, expiry, immutable binding and execution ID) must match.
No Business OS collection is queried or bridged over HTTP/WebSocket.

Only after both checks does the source send a bounded `/v1/responses` request
to its own loopback gateway. `X-CTOX-Account` and `X-CTOX-Provider` force the
bound account/provider. The gateway must acknowledge the same account in
`X-CTOX-Account-Selected`; missing or different acknowledgement rejects the
response, including any retry fallback. Request size is 256 KiB, response size
1 MiB and request duration at most 120 seconds or the permit's remaining life.
Streaming/background requests and cross-request conversation IDs are refused.
The source repeats grant and native revalidation before publishing the response.
Failures expose safe error classes, never credential material or raw headers.

## Remaining receiver integration

`makeManagedSourceGatewayInference` from
`apps/server/src/providerGateway/ManagedSourceGatewayInference.ts` is the shared
production constructor. It accepts `{environmentId: Effect<EnvironmentId>,
settings: Pick<ServerSettingsService["Service"], "getSettings">,
gateway: Pick<ProviderGatewayServiceShape, "scopedCatalog" | "status">,
connections: Pick<DecisionHubConnectionRegistryShape, "resolveReadyTarget"> | undefined}`
and returns `{bindModel, admit, infer}`. Both authenticated `ws.ts` RPC and the
source Node worker listener can call this constructor with source-held services;
an absent registry fails closed. Its revalidation port calls
`makeCtoxRemoteWorkerAdmissionClient.execute` with the immutable
worker request, source native scope, binding, `"revalidate"`, permit ID and
execution ID. This shares the Instances admission owner's actual typed client,
including canonical request digest verification and current source connection
resolution. It creates no separate native credential store or owner authorizer.

The target Receiver/CLI still needs an owned managed bridge that carries each
inference request back to these source RPCs, using its bound execution and
native receipt. The source side of that bridge owns the authenticated Workjet
connection; neither the worker nor its target host may receive its bearer.
The CLI's loopback adapter must support this non-streaming Responses contract
and return `requestJson` from the inference result as the response body.
The source must remain running as a managed service after UI Quit. This PR
does not claim that target CLI integration, remote execution or installed
acceptance has occurred. A receiver without that bridge must fail closed.
