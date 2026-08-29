// @effect-diagnostics nodeBuiltinImport:off - reads DesktopApp.ts as text to assert pre-ready registration ordering statically.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DEEP_LINK_PENDING_CHANNEL } from "../ipc/channels.ts";
import * as DesktopDeepLinkRouter from "./DesktopDeepLinkRouter.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

// it.scoped is deprecated in this vitest integration; scope the body instead.
const itScoped = (name: string, body: () => Effect.Effect<void, never, Scope.Scope>) =>
  it.effect(name, () => Effect.scoped(body()));

type AppListener = (...args: never[]) => void;

interface Harness {
  readonly listeners: Map<string, AppListener[]>;
  readonly sent: string[];
  readonly preventedDefaults: string[];
}

const makeHarness = (): Harness => ({
  listeners: new Map(),
  sent: [],
  preventedDefaults: [],
});

const makeRouter = (harness: Harness, isDevelopment = false) => {
  const electronApp = {
    on: (eventName: string, listener: AppListener) =>
      Effect.sync(() => {
        const existing = harness.listeners.get(eventName) ?? [];
        harness.listeners.set(eventName, [...existing, listener]);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  const electronWindow = {
    sendAll: (channel: string) =>
      Effect.sync(() => {
        harness.sent.push(channel);
      }),
  } as unknown as ElectronWindow.ElectronWindow["Service"];

  const environment = DesktopEnvironment.DesktopEnvironment.of({
    isDevelopment,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  return DesktopDeepLinkRouter.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(ElectronWindow.ElectronWindow, electronWindow),
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
      ),
    ),
  );
};

/** The OS listeners hand their work to a promise; let it settle. */
const flush = Effect.promise(
  () =>
    new Promise<void>((resolve) => {
      setImmediate(() => setImmediate(resolve));
    }),
);

const openUrl = (harness: Harness, url: string) =>
  Effect.gen(function* () {
    const listener = harness.listeners.get("open-url")?.[0];
    assert.isDefined(listener, "open-url listener is registered");
    const event = {
      preventDefault: () => {
        harness.preventedDefaults.push(url);
      },
    };
    (listener as unknown as (event: unknown, url: string) => void)(event, url);
    yield* flush;
  });

const secondInstance = (harness: Harness, argv: readonly string[]) =>
  Effect.gen(function* () {
    const listener = harness.listeners.get("second-instance")?.[0];
    assert.isDefined(listener, "second-instance listener is registered");
    (listener as unknown as (event: unknown, argv: readonly string[]) => void)({}, argv);
    yield* flush;
  });

describe("DesktopDeepLinkRouter", () => {
  itScoped("registers both OS entry points", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const router = yield* makeRouter(harness);
      yield* router.register;

      assert.deepEqual([...harness.listeners.keys()].sort(), ["open-url", "second-instance"]);
    }),
  );

  itScoped("queues an open-url link that arrives before any window exists", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const router = yield* makeRouter(harness);
      yield* router.register;

      yield* openUrl(harness, "workjet://app/threads/abc?tab=diff#top");

      // Pre-ready there is no window, so the signal is a no-op — the link
      // survives in the queue and the renderer picks it up when it mounts.
      const delivered = yield* router.takePending;
      assert.deepEqual(delivered, [
        {
          linkId: "deep-link-1",
          scheme: "workjet",
          canonicalUrl: "workjet://app/threads/abc?tab=diff#top",
          path: "/threads/abc",
          search: "?tab=diff",
          hash: "#top",
        },
      ]);
      // Draining is the only exit: a second take is empty, so a link can
      // never be delivered twice.
      assert.deepEqual(yield* router.takePending, []);
    }),
  );

  itScoped("signals the renderer once a link is queued, and claims the OS event", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const router = yield* makeRouter(harness);
      yield* router.register;

      yield* openUrl(harness, "workjet://app/settings");

      assert.deepEqual(harness.sent, [DEEP_LINK_PENDING_CHANNEL]);
      assert.deepEqual(harness.preventedDefaults, ["workjet://app/settings"]);
      assert.equal((yield* router.takePending).length, 1);
    }),
  );

  itScoped("ignores foreign schemes so other open-url consumers keep their events", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const router = yield* makeRouter(harness);
      yield* router.register;

      yield* openUrl(harness, "clerk://callback?code=secret");
      yield* openUrl(harness, "https://example.test/x");

      assert.deepEqual(yield* router.takePending, []);
      assert.deepEqual(harness.sent, []);
      assert.deepEqual(harness.preventedDefaults, []);
    }),
  );

  itScoped("extracts deep links from a second-instance argv", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const router = yield* makeRouter(harness);
      yield* router.register;

      yield* secondInstance(harness, [
        "C:\\Program Files\\Workjet\\Workjet.exe",
        "--allow-file-access-from-files",
        "workjet://app/threads/from-argv",
        "https://example.test/ignored",
      ]);

      const delivered = yield* router.takePending;
      assert.deepEqual(
        delivered.map((link) => link.canonicalUrl),
        ["workjet://app/threads/from-argv"],
      );
    }),
  );

  itScoped("drops links beyond the pending cap", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const router = yield* makeRouter(harness);

      for (let index = 0; index < DesktopDeepLinkRouter.MAX_PENDING_DEEP_LINKS + 3; index += 1) {
        yield* router.offer(`workjet://app/threads/${index}`, "open-url");
      }

      const delivered = yield* router.takePending;
      assert.equal(delivered.length, DesktopDeepLinkRouter.MAX_PENDING_DEEP_LINKS);
      // FIFO: the oldest links are kept, the overflow is dropped.
      assert.deepEqual(
        delivered.map((link) => link.path),
        ["/threads/0", "/threads/1", "/threads/2", "/threads/3"],
      );
    }),
  );

  itScoped("drops malformed and retired links instead of queueing them", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const router = yield* makeRouter(harness);

      yield* router.offer("workjet://evil.example/steal", "open-url");
      yield* router.offer("workjet:notaurl", "argv");
      yield* router.offer("ctox-desktop://app/threads/retired", "open-url");
      yield* router.offer("t3code://app/threads/retired", "argv");

      assert.deepEqual(yield* router.takePending, []);
    }),
  );

  itScoped("rejects a development link in the production runtime", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const router = yield* makeRouter(harness, false);

      yield* router.offer("workjet-dev://app/threads/wrong-build", "argv");

      assert.deepEqual(yield* router.takePending, []);
    }),
  );

  itScoped("uses the development renderer scheme", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const router = yield* makeRouter(harness, true);

      yield* router.offer("workjet-dev://app/threads/x", "open-url");
      const delivered = yield* router.takePending;
      assert.deepEqual(
        delivered.map((link) => link.canonicalUrl),
        ["workjet-dev://app/threads/x"],
      );

      yield* router.offer("workjet://app/threads/wrong-build", "argv");
      assert.deepEqual(yield* router.takePending, []);
    }),
  );
});

describe("extractDeepLinksFromArgv", () => {
  it("keeps only arguments this app owns", () => {
    assert.deepEqual(
      [
        ...DesktopDeepLinkRouter.extractDeepLinksFromArgv([
          "/usr/bin/workjet",
          "workjet://app/a",
          "ctox://instance/pairing",
          "ctox-desktop://app/b?x=1",
          "--flag",
        ]),
      ],
      ["workjet://app/a"],
    );
  });
});

describe("redactDeepLinkUrl", () => {
  it("keeps scheme and host and nothing else", () => {
    assert.equal(
      DesktopDeepLinkRouter.redactDeepLinkUrl("workjet://app/invite?token=secret#frag"),
      "workjet://app",
    );
    assert.equal(DesktopDeepLinkRouter.redactDeepLinkUrl("workjet:secret"), "workjet:<redacted>");
    assert.equal(DesktopDeepLinkRouter.redactDeepLinkUrl("not a url"), "<unparseable>");
    assert.equal(DesktopDeepLinkRouter.redactDeepLinkUrl("workjet://"), "workjet://<redacted>");
  });
});

describe("pre-ready registration ordering", () => {
  // A packaged macOS cold start can emit `open-url` before `ready`, and a full
  // packaged launch is far too heavy to run here — so the ordering is asserted
  // statically instead: the registration must appear in DesktopApp.startup
  // before the first `whenReady` await. See the DesktopDeepLinkRouter module
  // doc for why this is the bug that only shows up packaged.
  it("registers the OS entry points before startup awaits whenReady", () => {
    const source = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "DesktopApp.ts"), "utf8");
    const registerIndex = source.indexOf("deepLinkRouter.register");
    const whenReadyIndex = source.indexOf("electronApp.whenReady");

    assert.isAbove(registerIndex, 0, "startup registers the deep-link router");
    assert.isAbove(whenReadyIndex, 0, "startup awaits whenReady");
    assert.isBelow(registerIndex, whenReadyIndex);

    const between = source
      .slice(registerIndex + "deepLinkRouter.register".length, whenReadyIndex)
      .replace(/yield\*\s*$/, "");
    assert.notInclude(
      between,
      "yield*",
      "nothing may be awaited between the registration and whenReady",
    );
  });
});
