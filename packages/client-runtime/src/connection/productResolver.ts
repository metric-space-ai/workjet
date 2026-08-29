import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import { ConnectionBlockedError, type PreparedConnection } from "./model.ts";
import { ConnectionResolver } from "./resolverService.ts";

function primarySocketUrl(wsBaseUrl: string): string {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  return url.toString();
}

const prepare = Effect.fn("clientRuntime.connection.product.prepare")(function* (
  entry: ConnectionCatalogEntry,
) {
  if (entry.target._tag !== "PrimaryConnectionTarget") {
    return yield* new ConnectionBlockedError({
      reason: "unsupported",
      detail: "Legacy Code environment connections are unavailable in this product runtime.",
    });
  }
  const target = entry.target;
  return {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: target.httpBaseUrl,
    socketUrl: primarySocketUrl(target.wsBaseUrl),
    httpAuthorization: null,
    target,
  } satisfies PreparedConnection;
});

export const layer = Layer.succeed(ConnectionResolver, ConnectionResolver.of({ prepare }));
