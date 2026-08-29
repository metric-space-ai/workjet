import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopSchemes from "../electron/desktopSchemes.ts";
import { DEEP_LINK_PENDING_CHANNEL } from "../ipc/channels.ts";
import * as DesktopDeepLink from "./DesktopDeepLink.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

/**
 * The OS entry point for `workjet://` deep links — the only place an
 * OS-delivered link enters the app.
 *
 * A link that arrives here is NEVER acted on. It is parsed, queued, and
 * offered to the renderer, which asks the user before navigating. The
 * `will-navigate` consumer in DesktopWindow is a different case and keeps its
 * silent in-app redirect: that navigation was already initiated by the
 * renderer itself (a link the user clicked inside the app), so the user has
 * acted and the redirect only re-expresses their own click on the origin the
 * renderer is served from. An OS link, by contrast, can be triggered by any
 * web page or document on the machine, which is why it needs a confirmation.
 *
 * Ordering — why `register` must run before `app.whenReady()`
 * ----------------------------------------------------------
 * macOS delivers a cold-start deep link as an `open-url` event that can fire
 * *before* `ready`: launching the app by clicking a link is one event-loop
 * turn, and Electron emits `open-url` as soon as the Cocoa app delegate
 * receives it. A handler installed after `await app.whenReady()` therefore
 * misses exactly the case the feature exists for — and only in a packaged
 * build, because a development run always has an app already running, so the
 * link arrives post-ready and the bug stays invisible. `DesktopApp.startup`
 * consequently calls `register` in the same synchronous stretch as the other
 * pre-ready setup, before it yields on `electronApp.whenReady`, and
 * `DesktopDeepLinkRouter.test.ts` asserts that ordering statically against the
 * source so a later refactor cannot move the registration past the first await.
 *
 * Because no window exists at that point, an early link is queued (capped at
 * MAX_PENDING_DEEP_LINKS) instead of pushed, and the renderer drains the queue
 * when it mounts.
 *
 * Coexistence with the Clerk bridge
 * ---------------------------------
 * `@clerk/electron` installs its own `open-url` and `second-instance`
 * listeners for the OAuth callback, whose URL it builds as
 * `${renderer.scheme}://${renderer.host}/` — i.e. `workjet://app/` — and
 * matches on protocol + host + pathname only, with the OAuth parameters in the
 * query string. This parser accepts that URL too, so without a filter every
 * sign-in would raise an "open this link?" dialog. Two rules keep the two
 * consumers disjoint:
 *
 *   1. Only URLs whose scheme is one of DESKTOP_DEEP_LINK_SCHEMES are handled
 *      at all, so any foreign scheme passes straight through to whoever owns
 *      it.
 *   2. A link on the *renderer* scheme whose path is exactly `/` is Clerk's
 *      OAuth callback and is ignored here. Electron invokes every registered
 *      listener, so ignoring is precisely what leaves the event to Clerk. This
 *      router never removes Clerk's listener and never calls
 *      `preventDefault()` on an event it does not own.
 *
 * Product deep links always carry a path (`workjet://app/threads/x`), so
 * rule 2 costs nothing: a bare `://app/` link has no target to navigate to.
 */

/** Beyond this many unconfirmed links, further arrivals are dropped. */
export const MAX_PENDING_DEEP_LINKS = 4;

export interface PendingDesktopDeepLink {
  readonly linkId: string;
  readonly scheme: string;
  readonly canonicalUrl: string;
  readonly path: string;
  readonly search: string;
  readonly hash: string;
}

export type DesktopDeepLinkSource = "open-url" | "argv";

/**
 * A log-safe rendering of a URL: scheme and host only. Deep links can carry
 * invite codes, pairing tokens, and OAuth parameters, so the raw URL never
 * reaches a log file.
 */
export function redactDeepLinkUrl(rawUrl: string): string {
  const separator = rawUrl.indexOf(":");
  if (separator <= 0) return "<unparseable>";
  const scheme = rawUrl.slice(0, separator).toLowerCase();
  if (scheme.length > 32 || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) return "<unparseable>";
  const remainder = rawUrl.slice(separator + 1);
  if (!remainder.startsWith("//")) return `${scheme}:<redacted>`;
  const host = (remainder.slice(2).split(/[/?#]/, 1)[0] ?? "").toLowerCase();
  return host.length === 0 || host.length > 64 ? `${scheme}://<redacted>` : `${scheme}://${host}`;
}

/**
 * True for the `workjet://app/` shape Clerk's OAuth transport owns. See the
 * module doc: the renderer scheme with an empty path is a sign-in callback,
 * never a product deep link.
 */
export function isClerkOAuthCallbackLink(
  link: DesktopDeepLink.DesktopDeepLink,
  rendererScheme: string,
): boolean {
  return link.scheme === rendererScheme && link.path === "/";
}

/**
 * The raw arguments of a process argv that are deep links this app owns.
 * Windows and Linux hand the URL to the app as a command-line argument, both
 * on cold start and through `second-instance`; everything else in argv (the
 * executable path, Chromium switches, file arguments) is skipped.
 */
export function extractDeepLinksFromArgv(argv: readonly string[]): readonly string[] {
  return argv.filter((argument) => Option.isSome(DesktopDeepLink.parseDesktopDeepLink(argument)));
}

export class DesktopDeepLinkRouter extends Context.Service<
  DesktopDeepLinkRouter,
  {
    /**
     * Installs the OS entry points. Must run before the first `await` on
     * `app.whenReady()` — see the module doc.
     */
    readonly register: Effect.Effect<void, never, Scope.Scope>;
    /**
     * Removes and returns every held link. Draining is the only way a link
     * leaves the main process, so each link is delivered exactly once.
     */
    readonly takePending: Effect.Effect<readonly PendingDesktopDeepLink[]>;
    /** Accepts one OS-delivered URL. Exposed so tests can drive the queue. */
    readonly offer: (rawUrl: string, source: DesktopDeepLinkSource) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopDeepLinkRouter") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-deep-link");

interface PreventableEvent {
  readonly preventDefault?: () => void;
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;

  const rendererScheme = DesktopSchemes.getDesktopScheme(environment.isDevelopment);
  const pendingRef = yield* Ref.make<readonly PendingDesktopDeepLink[]>([]);
  const counterRef = yield* Ref.make(0);

  const offer = (rawUrl: string, source: DesktopDeepLinkSource) =>
    Effect.gen(function* () {
      const parsed = DesktopDeepLink.parseDesktopDeepLink(rawUrl);
      if (Option.isNone(parsed)) {
        yield* logWarning("dropped an unparseable deep link", {
          source,
          url: redactDeepLinkUrl(rawUrl),
        });
        return;
      }

      const link = parsed.value;
      if (link.scheme !== rendererScheme) {
        yield* logWarning("dropped a deep link for another Workjet build variant", {
          source,
          scheme: link.scheme,
        });
        return;
      }
      if (isClerkOAuthCallbackLink(link, rendererScheme)) {
        // Left to the Clerk bridge's own listener. Not an error, and not
        // logged per-arrival: every sign-in produces one.
        return;
      }

      const pending = yield* Ref.get(pendingRef);
      if (pending.length >= MAX_PENDING_DEEP_LINKS) {
        yield* logWarning("dropped a deep link because the pending queue is full", {
          source,
          scheme: link.scheme,
          pending: pending.length,
          limit: MAX_PENDING_DEEP_LINKS,
        });
        return;
      }

      const sequence = yield* Ref.updateAndGet(counterRef, (current) => current + 1);
      yield* Ref.set(pendingRef, [
        ...pending,
        {
          linkId: `deep-link-${sequence}`,
          scheme: link.scheme,
          canonicalUrl: link.canonicalUrl,
          path: link.path,
          search: link.search,
          hash: link.hash,
        },
      ]);
      yield* logInfo("queued a deep link for explicit confirmation", {
        source,
        scheme: link.scheme,
        pending: pending.length + 1,
      });
      // A signal only; the renderer drains through takePending. With no window
      // yet this is a no-op and the renderer drains on mount instead — which
      // is also why the push carries no payload: a link can never be delivered
      // twice by racing the push against the drain.
      yield* electronWindow.sendAll(DEEP_LINK_PENDING_CHANNEL);
    });

  const register = Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);

    yield* electronApp.on<[PreventableEvent, string]>("open-url", (event, url) => {
      const parsed = DesktopDeepLink.parseDesktopDeepLink(url);
      // Claim only links this app owns and that are not Clerk's callback, so
      // Clerk still sees its own event untouched.
      if (
        Option.isSome(parsed) &&
        parsed.value.scheme === rendererScheme &&
        !isClerkOAuthCallbackLink(parsed.value, rendererScheme)
      ) {
        event?.preventDefault?.();
        void runPromise(offer(url, "open-url"));
        return;
      }
      if (Option.isNone(parsed) && schemeOf(url) === rendererScheme) {
        // Ours by scheme but malformed: record the drop, still without
        // touching the event.
        void runPromise(offer(url, "open-url"));
      }
    });

    yield* electronApp.on<[PreventableEvent, readonly string[]]>(
      "second-instance",
      (_event, argv) => {
        const urls = extractDeepLinksFromArgv(argv ?? []);
        if (urls.length === 0) return;
        void runPromise(Effect.forEach(urls, (url) => offer(url, "argv")).pipe(Effect.asVoid));
      },
    );

    // Windows and Linux cold starts carry the URL in this process's own argv,
    // where no `second-instance` event will ever repeat it.
    yield* Effect.forEach(extractDeepLinksFromArgv(process.argv.slice(1)), (url) =>
      offer(url, "argv"),
    );
  });

  return DesktopDeepLinkRouter.of({
    register,
    takePending: Ref.getAndSet(pendingRef, []),
    offer,
  });
});

const schemeOf = (rawUrl: string): string => {
  const separator = rawUrl.indexOf(":");
  return separator <= 0 ? "" : rawUrl.slice(0, separator);
};

export const layer = Layer.effect(DesktopDeepLinkRouter, make);
