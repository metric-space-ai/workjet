import type {
  CtoxV4ProxyAttachEvent,
  CtoxV4ProxyAttachInput,
  CtoxV4ProxyReplyInput,
} from "@workjet/contracts";
import {
  createCtoxV4ProxyServer,
  type CtoxV4ProxyReply,
  type CtoxV4ProxyServer,
} from "@workjet/shared/ctoxV4AppProxy";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { bindCtoxV4AppPort } from "./CtoxV4AppPorts.ts";

/**
 * Server half of the renderer→server V4 app proxy (C3). One attach stream = one renderer that
 * holds the bound kernel client of one instance for its running session. The instance is
 * registered in `CtoxV4AppPorts` once the renderer delivered the mirrored collections and is
 * removed when the stream ends; without an attached renderer the server path for that instance
 * stays off (no V3 fallback for a V4 instance, no server-side kernel).
 */
export interface CtoxV4AppProxySessions {
  readonly open: (
    input: CtoxV4ProxyAttachInput,
    endpoints: ReadonlyArray<string>,
    emit: (event: CtoxV4ProxyAttachEvent) => void,
  ) => { readonly attachId: string; readonly close: () => void };
  readonly reply: (input: CtoxV4ProxyReplyInput) => boolean;
  readonly size: () => number;
}

export function makeCtoxV4AppProxySessions(
  newId: () => string = () => crypto.randomUUID(),
): CtoxV4AppProxySessions {
  const sessions = new Map<string, CtoxV4ProxyServer>();
  return {
    open: (input, endpoints, emit) => {
      const attachId = newId();
      emit({ type: "attached", attachId });
      const server = createCtoxV4ProxyServer({
        actor: input.actor,
        send: (request) => emit({ type: "request", request: request as Record<string, unknown> }),
      });
      sessions.set(attachId, server);
      let releases: Array<() => void> = [];
      void server.ready.then(() => {
        if (sessions.get(attachId) !== server) return;
        releases =
          endpoints.length === 0
            ? [bindCtoxV4AppPort({ instanceId: input.instanceId }, server.port)]
            : endpoints.map((endpoint) =>
                bindCtoxV4AppPort({ instanceId: input.instanceId, endpoint }, server.port),
              );
      });
      return {
        attachId,
        close: () => {
          if (sessions.get(attachId) !== server) return;
          sessions.delete(attachId);
          for (const release of releases) release();
          releases = [];
          server.close();
        },
      };
    },
    reply: (input) => {
      const server = sessions.get(input.attachId);
      if (server === undefined) return false;
      server.receive(input.reply as unknown as CtoxV4ProxyReply);
      return true;
    },
    size: () => sessions.size,
  };
}

/** Process-wide sessions; the WebSocket handlers are the only callers. */
export const ctoxV4AppProxySessions = makeCtoxV4AppProxySessions();

export function ctoxV4AppProxyAttachStream<E>(
  sessions: CtoxV4AppProxySessions,
  input: CtoxV4ProxyAttachInput,
  endpoints: Effect.Effect<ReadonlyArray<string>, E>,
): Stream.Stream<CtoxV4ProxyAttachEvent> {
  return Stream.callback<CtoxV4ProxyAttachEvent>((queue) =>
    Effect.gen(function* () {
      const resolved = yield* endpoints.pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          sessions.open(input, resolved, (event) => {
            Queue.offerUnsafe(queue, event);
          }),
        ),
        (session) => Effect.sync(session.close),
      );
    }),
  );
}
