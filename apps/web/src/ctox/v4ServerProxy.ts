import { EnvironmentRegistry } from "@workjet/client-runtime/connection";
import { request, subscribe } from "@workjet/client-runtime/rpc";
import {
  WS_METHODS,
  type CtoxV4ProxyAttachEvent,
  type CtoxV4ProxyReplyInput,
  type EnvironmentId,
} from "@workjet/contracts";
import {
  serveCtoxV4Proxy,
  type CtoxV4ProxyClient,
  type CtoxV4ProxyClientApi,
  type CtoxV4ProxyRequest,
} from "@workjet/shared/ctoxV4AppProxy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { listBoundCtoxClients, subscribeCtoxClients, type CtoxAppApi } from "./ctoxClient";

/**
 * Renderer half of the V4 app proxy (C3). For every instance whose kernel client is bound in
 * this renderer it attaches to the local Workjet server and answers the server's `api.query`,
 * `api.get`, `api.patch`/`put`, live subscriptions and commands with the bound client. The
 * attach lives exactly as long as the binding: unbind, logout or a lost socket ends the stream
 * and the server removes the instance from its V4 registry. No other instance, no V3 path.
 */
export interface CtoxV4RendererSession {
  readonly onEvent: (event: CtoxV4ProxyAttachEvent) => void;
  readonly close: () => void;
}

export function createCtoxV4RendererSession(
  api: CtoxV4ProxyClientApi,
  reply: (input: CtoxV4ProxyReplyInput) => void,
): CtoxV4RendererSession {
  let attachId: string | null = null;
  let proxy: CtoxV4ProxyClient | null = null;
  let closed = false;
  return {
    onEvent: (event) => {
      if (closed) return;
      if (event.type === "attached") {
        // A reconnect is a new server session: drop every subscription of the old one.
        proxy?.close();
        const id = event.attachId;
        attachId = id;
        proxy = serveCtoxV4Proxy(api, (message) => {
          if (attachId === id) reply({ attachId: id, reply: message as Record<string, unknown> });
        });
        return;
      }
      proxy?.handle(event.request as unknown as CtoxV4ProxyRequest);
    },
    close: () => {
      closed = true;
      proxy?.close();
      proxy = null;
    },
  };
}

const boundClients = Stream.callback<ReadonlyArray<{ instanceId: string; api: CtoxAppApi }>>(
  (queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        Queue.offerUnsafe(queue, listBoundCtoxClients());
        return subscribeCtoxClients(() => {
          Queue.offerUnsafe(queue, listBoundCtoxClients());
        });
      }),
      (off) => Effect.sync(off),
    ),
);

const sameClients = (
  left: ReadonlyArray<{ instanceId: string; api: CtoxAppApi }>,
  right: ReadonlyArray<{ instanceId: string; api: CtoxAppApi }>,
) =>
  left.length === right.length &&
  left.every(
    (entry, index) =>
      entry.instanceId === right[index]?.instanceId && entry.api === right[index]?.api,
  );

const session = (
  registry: EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
  bound: { instanceId: string; api: CtoxAppApi },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const replies = yield* Queue.unbounded<CtoxV4ProxyReplyInput>();
      const renderer = createCtoxV4RendererSession(
        bound.api as unknown as CtoxV4ProxyClientApi,
        (input) => {
          Queue.offerUnsafe(replies, input);
        },
      );
      const incoming = registry
        .followStream(
          environmentId,
          subscribe(WS_METHODS.workjetCtoxV4Attach, {
            instanceId: bound.instanceId,
            actor: { id: bound.api.actor.id, role: bound.api.actor.role },
          }),
        )
        .pipe(Stream.tap((event) => Effect.sync(() => renderer.onEvent(event))));
      const outgoing = Stream.fromQueue(replies).pipe(
        Stream.mapEffect((input) =>
          registry
            .run(environmentId, request(WS_METHODS.workjetCtoxV4Reply, input))
            .pipe(Effect.ignore),
        ),
      );
      return Stream.merge(incoming, outgoing).pipe(
        Stream.ensuring(Effect.sync(renderer.close)),
        Stream.catch(() => Stream.empty),
      );
    }),
  );

/** Attaches every bound V4 client to the primary (local) Workjet server. */
export const ctoxV4ServerProxyLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map(
        (entries) =>
          [...entries].find(([, entry]) => entry.target._tag === "PrimaryConnectionTarget")?.[0] ??
          null,
      ),
      Stream.changes,
      Stream.switchMap((environmentId) =>
        environmentId === null
          ? Stream.empty
          : boundClients.pipe(
              Stream.changesWith(sameClients),
              Stream.switchMap((clients) =>
                Stream.mergeAll(
                  clients.map((bound) => session(registry, environmentId, bound)),
                  { concurrency: "unbounded" },
                ),
              ),
            ),
      ),
      Stream.runDrain,
      Effect.forkScoped,
    );
  }),
);
