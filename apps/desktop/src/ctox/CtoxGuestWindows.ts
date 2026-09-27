import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { BrowserWindow, type WebContents } from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DesktopIpcInvocation, type DesktopIpcInvokeEvent } from "../ipc/DesktopIpc.ts";
import { CtoxGuestBudget } from "./CtoxGuestBudget.ts";
import * as Guests from "./CtoxGuestManager.ts";

type GuestService = Guests.CtoxGuestManager["Service"];
type GuestDependencies = Effect.Services<ReturnType<typeof Guests.make>>;

interface WindowGuests {
  readonly window: BrowserWindow;
  readonly scope: Scope.Closeable;
  readonly guests: GuestService;
  closed: boolean;
}

export interface CtoxGuestWindowsOptions extends Guests.CtoxGuestManagerOptions {
  readonly windowForSender?: (sender: WebContents) => BrowserWindow | null;
}

/** Only a host window's current main frame may control its guest views. */
export function resolveGuestWindow(
  event: DesktopIpcInvokeEvent | undefined,
  windowForSender: (sender: WebContents) => BrowserWindow | null,
): BrowserWindow | undefined {
  try {
    const sender = event?.sender;
    if (sender === undefined || sender.isDestroyed() || event?.senderFrame !== sender.mainFrame) {
      return undefined;
    }
    if (event.senderFrame === undefined || event.senderFrame === null) return undefined;
    const window = windowForSender(sender);
    return window !== null && !window.isDestroyed() && window.webContents === sender
      ? window
      : undefined;
  } catch {
    return undefined;
  }
}

export const make = (options: CtoxGuestWindowsOptions = {}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<GuestDependencies>();
    const parentScope = yield* Effect.scope;
    const windows = yield* ElectronWindow.ElectronWindow;
    const lock = yield* Semaphore.make(1);
    const entries = new Map<BrowserWindow, WindowGuests>();
    const budget = options.budget ?? new CtoxGuestBudget(Guests.CTOX_GUEST_POOL_LIMIT);
    const runPromise = Effect.runPromiseWith(context);
    const windowForSender =
      options.windowForSender ?? ((sender) => BrowserWindow.fromWebContents(sender));
    let stopped = false;
    let accountGeneration = 0;

    const retire = (entry: WindowGuests) => {
      entry.closed = true;
      if (entries.get(entry.window) === entry) entries.delete(entry.window);
    };
    const close = (entry: WindowGuests) =>
      Scope.close(entry.scope, Exit.void).pipe(Effect.uninterruptible);

    const getOrCreate = (window: BrowserWindow, isCurrent: () => boolean) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            if (stopped || !isCurrent() || window.isDestroyed() || window.webContents.isDestroyed())
              return undefined;
            const previous = entries.get(window);
            if (previous !== undefined) return previous;
            const scope = yield* Scope.fork(parentScope, "sequential");
            let entry: WindowGuests | undefined;
            const guests = yield* Guests.make({ ...options, budget }).pipe(
              Effect.provideService(ElectronWindow.ElectronWindow, {
                ...windows,
                main: Effect.sync(() =>
                  entry?.closed === false && !window.isDestroyed()
                    ? Option.some(window)
                    : Option.none(),
                ),
                sendAll: (channel, ...args) =>
                  Effect.sync(() => {
                    if (
                      entry?.closed !== false ||
                      window.isDestroyed() ||
                      window.webContents.isDestroyed()
                    )
                      return;
                    window.webContents.send(channel, ...args);
                  }),
              }),
              Scope.provide(scope),
              Effect.provide(context),
            );
            entry = { window, scope, guests, closed: false };
            const owned = entry;
            if (!isCurrent()) {
              retire(owned);
              yield* close(owned);
              return undefined;
            }
            entries.set(window, owned);
            const onClose = () => {
              if (owned.closed) return;
              retire(owned);
              removeListeners();
              // The parent scope owns cleanup even though a native event triggered it.
              void runPromise(close(owned).pipe(Effect.forkIn(parentScope))).catch(() => undefined);
            };
            const onNavigation = (
              _event: unknown,
              _url: string,
              inPlace: boolean,
              mainFrame: boolean,
            ) => {
              if (mainFrame && !inPlace) onClose();
            };
            const removeListeners = () => {
              window.off("closed", onClose);
              window.webContents.off("destroyed", onClose);
              window.webContents.off("render-process-gone", onClose);
              window.webContents.off("did-start-navigation", onNavigation);
            };
            window.on("closed", onClose);
            window.webContents.on("destroyed", onClose);
            window.webContents.on("render-process-gone", onClose);
            window.webContents.on("did-start-navigation", onNavigation);
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                retire(owned);
                removeListeners();
              }),
            );
            return owned;
          }),
        )
        .pipe(Effect.uninterruptible);

    const unavailable = { _tag: "failed", code: "not_active" } as const;
    const inWindow = <A>(
      operation: (guests: GuestService) => Effect.Effect<A>,
    ): Effect.Effect<A | typeof unavailable> =>
      Effect.gen(function* () {
        const invocation = yield* DesktopIpcInvocation;
        const window = resolveGuestWindow(invocation, windowForSender);
        if (window === undefined) return unavailable;
        const generation = accountGeneration;
        let invalidated = false;
        const invalidate = () => {
          invalidated = true;
        };
        const onNavigation = (
          _event: unknown,
          _url: string,
          inPlace: boolean,
          mainFrame: boolean,
        ) => {
          if (mainFrame && !inPlace) invalidate();
        };
        const isCurrent = () =>
          !invalidated &&
          generation === accountGeneration &&
          resolveGuestWindow(invocation, windowForSender) === window;
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            // Watch before waiting for admission, including when no guest scope exists yet.
            window.on("closed", invalidate);
            window.webContents.on("destroyed", invalidate);
            window.webContents.on("render-process-gone", invalidate);
            window.webContents.on("did-start-navigation", onNavigation);
          }),
          () =>
            Effect.gen(function* () {
              const entry = yield* getOrCreate(window, isCurrent);
              if (entry === undefined || entry.closed || !isCurrent()) return unavailable;
              const fiber = yield* Effect.forkIn(
                Effect.suspend(() =>
                  entry.closed || !isCurrent()
                    ? Effect.succeed(unavailable)
                    : operation(entry.guests),
                ),
                entry.scope,
              );
              const result = yield* Fiber.await(fiber);
              return Exit.isSuccess(result) && !entry.closed && isCurrent()
                ? result.value
                : unavailable;
            }),
          () =>
            Effect.sync(() => {
              window.off("closed", invalidate);
              window.webContents.off("destroyed", invalidate);
              window.webContents.off("render-process-gone", invalidate);
              window.webContents.off("did-start-navigation", onNavigation);
            }),
        );
      });

    const deactivateAll = lock
      .withPermit(
        Effect.gen(function* () {
          accountGeneration += 1;
          const snapshot = [...entries.values()];
          for (const entry of snapshot) retire(entry);
          for (const entry of snapshot) yield* close(entry);
          return { _tag: "completed" } as const;
        }),
      )
      .pipe(Effect.uninterruptible);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        stopped = true;
        yield* deactivateAll;
      }),
    );

    return Guests.CtoxGuestManager.of({
      enterBusinessOsMode: inWindow((guests) => guests.enterBusinessOsMode),
      exitBusinessOsMode: inWindow((guests) => guests.exitBusinessOsMode),
      activate: (id, bounds) => inWindow((guests) => guests.activate(id, bounds)),
      ensurePooled: (id) => inWindow((guests) => guests.ensurePooled(id)),
      suspend: inWindow((guests) => guests.suspend),
      deactivate: inWindow((guests) => guests.deactivate),
      deactivateAll,
      // Registry removal invalidates this instance in every owning window.
      deactivateInstance: (id) =>
        lock.withPermit(
          Effect.gen(function* () {
            for (const entry of entries.values()) yield* entry.guests.deactivateInstance(id);
            return { _tag: "completed" } as const;
          }),
        ),
      setBounds: (bounds) => inWindow((guests) => guests.setBounds(bounds)),
      readGuestApps: (id) => inWindow((guests) => guests.readGuestApps(id)),
      openGuestApp: (id, module, bounds) =>
        inWindow((guests) => guests.openGuestApp(id, module, bounds)),
      openGuestSettings: (id) => inWindow((guests) => guests.openGuestSettings(id)),
      setHostTheme: (theme) => inWindow((guests) => guests.setHostTheme(theme)),
      requestDeviceControl: (id, request) =>
        inWindow((guests) => guests.requestDeviceControl(id, request)),
      requestComputerControl: (id, request) =>
        inWindow((guests) => guests.requestComputerControl(id, request)),
      requestProjectControl: (id, request) =>
        inWindow((guests) => guests.requestProjectControl(id, request)),
      requestSessionControl: (id, request) =>
        inWindow((guests) => guests.requestSessionControl(id, request)),
      registerSessionTransferEvents: (ids) =>
        inWindow((guests) => guests.registerSessionTransferEvents(ids)),
    });
  });

export const layer = (options: CtoxGuestWindowsOptions = {}) =>
  Layer.effect(Guests.CtoxGuestManager, make(options));
