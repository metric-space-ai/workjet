import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopDeepLinkRouter from "../../app/DesktopDeepLinkRouter.ts";
import * as IpcChannels from "../channels.ts";
import { DesktopPendingDeepLinksSchema, takePendingDeepLinks } from "./deepLinks.ts";

const decode = Schema.decodeUnknownEffect(DesktopPendingDeepLinksSchema);

const pending: DesktopDeepLinkRouter.PendingDesktopDeepLink = {
  linkId: "deep-link-1",
  scheme: "workjet",
  canonicalUrl: "workjet://app/threads/abc?tab=diff",
  path: "/threads/abc",
  search: "?tab=diff",
  hash: "",
};

const routerLayer = (initial: readonly DesktopDeepLinkRouter.PendingDesktopDeepLink[]) =>
  Layer.effect(
    DesktopDeepLinkRouter.DesktopDeepLinkRouter,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial);
      return DesktopDeepLinkRouter.DesktopDeepLinkRouter.of({
        register: Effect.void,
        takePending: Ref.getAndSet(ref, []),
        offer: () => Effect.void,
      });
    }),
  );

describe("deep-link IPC contract", () => {
  it("uses a stable channel name", () => {
    assert.equal(takePendingDeepLinks.channel, IpcChannels.TAKE_PENDING_DEEP_LINKS_CHANNEL);
  });

  it.effect("returns the held links in a decodable shape and drains them", () =>
    Effect.gen(function* () {
      const first = yield* takePendingDeepLinks.handler(undefined).pipe(Effect.flatMap(decode));
      assert.deepEqual([...first], [pending]);

      // The handler drains, so the renderer receives each link exactly once.
      const second = yield* takePendingDeepLinks.handler(undefined).pipe(Effect.flatMap(decode));
      assert.deepEqual([...second], []);
    }).pipe(Effect.provide(routerLayer([pending]))),
  );
});
