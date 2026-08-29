import { productLayer } from "@t3tools/client-runtime/connection/product";
import {
  PullRequestDiffLoadError,
  PullRequestDiffLoader,
  ShellSnapshotLoader,
  ThreadSnapshotLoader,
} from "@t3tools/client-runtime/state/product-loaders";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { runtimeContextLayer } from "../lib/runtime";
import {
  backgroundActivityObserverLayer,
  backgroundActivityReporterLayer,
} from "../lib/backgroundActivityReporter";
import { connectionPlatformLayer } from "./platform";

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

const snapshotLoaderLayer = Layer.mergeAll(
  Layer.succeed(
    ThreadSnapshotLoader,
    ThreadSnapshotLoader.of({ load: () => Effect.succeed(Option.none()) }),
  ),
  Layer.succeed(
    ShellSnapshotLoader,
    ShellSnapshotLoader.of({ load: () => Effect.succeed(Option.none()) }),
  ),
  Layer.succeed(
    PullRequestDiffLoader,
    PullRequestDiffLoader.of({
      load: () =>
        Effect.fail(
          new PullRequestDiffLoadError({
            message:
              "Pull-request diff loading is unavailable until the Workjet WebSocket RPC is implemented.",
          }),
        ),
    }),
  ),
);

type ConnectionLayerSource =
  | typeof productLayer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof backgroundActivityObserverLayer
  | typeof backgroundActivityReporterLayer;

const providedClientConnectionLayer = Layer.merge(productLayer, snapshotLoaderLayer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      runtimeContextLayer,
      providedConnectionPlatformLayer,
      backgroundActivityObserverLayer,
    ),
  ),
);

const connectionLayer = backgroundActivityReporterLayer.pipe(
  Layer.provideMerge(providedClientConnectionLayer),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(connectionLayer);
