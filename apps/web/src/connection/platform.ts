import {
  ClientPresentation,
  CloudSession,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  Connectivity,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcRequestObserver } from "@t3tools/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { isHostedStaticApp } from "../hostedPairing";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import { connectionStorageLayer } from "./storage";

let nextObservedRpcRequestId = 0;

function currentNetworkStatus(): "unknown" | "offline" | "online" {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          if (document.visibilityState === "visible") {
            Queue.offerUnsafe(queue, "application-active");
          }
        };
        document.addEventListener("visibilitychange", listener);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          document.removeEventListener("visibilitychange", listener);
        }),
    ).pipe(Effect.asVoid),
  ),
});

function clientMetadata() {
  const desktop = window.desktopBridge !== undefined;
  const platform = navigator.platform.trim();
  return {
    label: desktop ? "Workjet Desktop" : "Workjet Web",
    deviceType: "desktop" as const,
    ...(platform === "" ? {} : { os: platform }),
  };
}

const capabilitiesLayer = Layer.effectContext(
  Effect.sync(() => {
    const presentation = ClientPresentation.of({
      metadata: clientMetadata(),
      scopes: AuthStandardClientScopes,
    });
    const cloudSession = CloudSession.of({
      clerkToken: Effect.fail(
        new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Managed relay connections are not supported by Workjet Web or Desktop.",
        }),
      ),
    });
    const identity = RelayDeviceIdentity.of({
      deviceId: Effect.succeed(Option.none()),
    });
    const primaryAuth = PrimaryEnvironmentAuth.of({
      bearerToken: Effect.succeed(Option.none()),
    });
    const sshUnavailable = () =>
      Effect.fail(
        new ConnectionBlockedError({
          reason: "unsupported",
          detail: "SSH Code environments are unavailable in the RxDB/WebRTC-only product.",
        }),
      );
    const ssh = SshEnvironmentGateway.of({
      provision: sshUnavailable,
      prepare: sshUnavailable,
      disconnect: () => Effect.void,
    });

    return Context.make(CloudSession, cloudSession).pipe(
      Context.add(PrimaryEnvironmentAuth, primaryAuth),
      Context.add(RelayDeviceIdentity, identity),
      Context.add(ClientPresentation, presentation),
      Context.add(SshEnvironmentGateway, ssh),
    );
  }),
);

const loadPrimaryConnectionRegistration = Effect.fn(
  "web.connectionPlatform.loadPrimaryConnectionRegistration",
)((resolved: PrimaryEnvironmentTarget) =>
  Effect.succeed(
    new PrimaryConnectionRegistration({
      target: new PrimaryConnectionTarget({
        environmentId: PRIMARY_LOCAL_ENVIRONMENT_ID as EnvironmentId,
        label: "Workjet",
        httpBaseUrl: resolved.target.httpBaseUrl,
        wsBaseUrl: resolved.target.wsBaseUrl,
      }),
    }),
  ),
);

// Poll cadence for the primary host topology. There is no change event on the
// bridge, so the renderer re-reads only the non-secret socket target.
const PLATFORM_POLL_INTERVAL = "3 seconds";

export type PrimaryEnvironmentTargetRead =
  | {
      readonly _tag: "Success";
      readonly target: PrimaryEnvironmentTarget | null;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    };

export function readPrimaryEnvironmentTargetResult(
  readTarget: () => PrimaryEnvironmentTarget | null = readPrimaryEnvironmentTarget,
): PrimaryEnvironmentTargetRead {
  try {
    return { _tag: "Success", target: readTarget() };
  } catch (cause) {
    return { _tag: "Failure", cause };
  }
}

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    if (isHostedStaticApp()) {
      return PlatformConnectionSource.of({
        registrations: Stream.empty,
      });
    }
    // Product startup may project only the canonical primary WebSocket target.
    // Descriptor discovery, bearer exchange, SSH and secondary Code backends
    // were EnvironmentHttp authorities and intentionally have no fallback.
    const buildPlatformRegistrations = Effect.gen(function* () {
      const primaryTopologyRead = readPrimaryEnvironmentTargetResult();
      if (primaryTopologyRead._tag === "Failure") {
        yield* Effect.logWarning("Could not read the primary environment topology.", {
          cause: primaryTopologyRead.cause,
        });
        return [] as ReadonlyArray<PlatformConnectionRegistration>;
      }
      if (primaryTopologyRead.target === null) {
        return [] as ReadonlyArray<PlatformConnectionRegistration>;
      }
      return [yield* loadPrimaryConnectionRegistration(primaryTopologyRead.target)];
    });

    return PlatformConnectionSource.of({
      registrations: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(
        Stream.mapEffect(() => buildPlatformRegistrations),
      ),
    });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.sync(() => {
        clearComposerDraftsEnvironment(environmentId);
      }),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        nextObservedRpcRequestId += 1;
        const requestId = `${environmentId}:${nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentId}`);
        return Effect.sync(() => {
          acknowledgeRpcRequest(requestId);
        });
      }),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof connectionStorageLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | typeof capabilitiesLayer
  | typeof platformConnectionSourceLayer
  | typeof environmentOwnedDataCleanupLayer
  | typeof rpcRequestObserverLayer;

export const connectionPlatformLayer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);
