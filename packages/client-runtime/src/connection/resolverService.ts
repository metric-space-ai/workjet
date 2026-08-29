import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { ConnectionAttemptError, PreparedConnection } from "./model.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  }
>()("@t3tools/client-runtime/connection/resolverService/ConnectionResolver") {}
