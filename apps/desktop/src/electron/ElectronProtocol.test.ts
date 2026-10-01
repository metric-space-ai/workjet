import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { beforeEach, vi } from "vite-plus/test";

const { handleMock, netFetchMock, unhandleMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

const bundledRendererFixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-renderer-"));
    const root = NodePath.join(directory, "client");
    await NodeFSP.mkdir(NodePath.join(root, "assets"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, "index.html"), "<main>Local shell</main>");
    await NodeFSP.writeFile(NodePath.join(root, "assets/app.js"), "window.localShell = true;");
    await NodeFSP.writeFile(NodePath.join(directory, "outside.txt"), "private");
    await NodeFSP.symlink(
      NodePath.join(directory, "outside.txt"),
      NodePath.join(root, "escape.txt"),
    );
    return { directory, root };
  }),
  ({ directory }) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    unhandleMock.mockReset();
  });

  it.effect("proxies the stable renderer origin to the current app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "workjet-dev",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3774/"),
            clerkFrontendApiHostname: "clerk.workjet.codes",
          });
          assert.isDefined(handler);

          const response = yield* Effect.promise(() =>
            handler!(
              new Request("workjet-dev://app/api/health?verbose=1", {
                headers: {
                  accept: "application/json",
                  origin: "workjet-dev://app",
                  referer: "workjet-dev://app/",
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.workjet.codes https://challenges.cloudflare.com",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "connect-src 'self' http: https: ws: wss:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "img-src 'self' workjet-dev: blob: data: http: https:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "font-src 'self' workjet-dev: data:",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["workjet-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      const forwardedHeaders = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("accept"), "application/json");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("referer"));
      assert.isNull(forwardedHeaders.get("sec-fetch-site"));
      assert.deepEqual(unhandleMock.mock.calls, [["workjet-dev"]]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("loads shipped UI and assets while the local service is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root } = yield* bundledRendererFixture;
        let handler: ((request: Request) => Promise<Response>) | undefined;
        handleMock.mockImplementation((_scheme, nextHandler) => {
          handler = nextHandler;
        });
        netFetchMock.mockRejectedValue(new Error("local service has not been installed"));
        const protocol = yield* ElectronProtocol.ElectronProtocol;
        yield* protocol.registerDesktopProtocol({
          scheme: "workjet",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          backendOrigin: new URL("http://127.0.0.1:3773/"),
          clerkFrontendApiHostname: undefined,
          bundledRendererRoot: root,
        });
        const page = yield* Effect.promise(() => handler!(new Request("workjet://app/")));
        assert.equal(yield* Effect.promise(() => page.text()), "<main>Local shell</main>");
        assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
        assert.include(page.headers.get("content-security-policy") ?? "", "default-src 'self'");
        const script = yield* Effect.promise(() =>
          handler!(new Request("workjet://app/assets/app.js?v=1")),
        );
        assert.equal(yield* Effect.promise(() => script.text()), "window.localShell = true;");
        assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
        const head = yield* Effect.promise(() =>
          handler!(new Request("workjet://app/assets/app.js", { method: "HEAD" })),
        );
        assert.equal(yield* Effect.promise(() => head.text()), "");
        assert.equal(head.headers.get("content-length"), "25");
        assert.equal(netFetchMock.mock.calls.length, 0);
      }),
    ).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("confines static reads and keeps server APIs out of the UI fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root } = yield* bundledRendererFixture;
        let handler: ((request: Request) => Promise<Response>) | undefined;
        handleMock.mockImplementation((_scheme, nextHandler) => {
          handler = nextHandler;
        });
        const protocol = yield* ElectronProtocol.ElectronProtocol;
        yield* protocol.registerDesktopProtocol({
          scheme: "workjet",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          backendOrigin: new URL("http://127.0.0.1:3773/"),
          clerkFrontendApiHostname: undefined,
          bundledRendererRoot: root,
        });
        for (const [url, status] of [
          ["workjet://other/", 404],
          ["workjet://app/%2e%2e%2foutside.txt", 400],
          ["workjet://app/assets%5c..%5coutside.txt", 400],
          ["workjet://app/%00", 400],
          ["workjet://app/%ZZ", 400],
          ["workjet://app/escape.txt", 403],
          ["workjet://app/assets/missing.js", 404],
          ["workjet://app/unknown-route", 404],
        ] as const) {
          const response = yield* Effect.promise(() => handler!(new Request(url)));
          assert.equal(response.status, status, url);
          assert.equal(yield* Effect.promise(() => response.text()), "");
        }
        const mutation = yield* Effect.promise(() =>
          handler!(new Request("workjet://app/index.html", { method: "POST", body: "change" })),
        );
        assert.equal(mutation.status, 405);
        assert.equal(netFetchMock.mock.calls.length, 0);
        netFetchMock.mockResolvedValue(new Response("authentication required", { status: 401 }));
        const api = yield* Effect.promise(() =>
          handler!(new Request("workjet://app/api/auth/session")),
        );
        assert.equal(api.status, 401);
        assert.equal(yield* Effect.promise(() => api.text()), "authentication required");
        assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/auth/session");
      }),
    ).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("rejects custom protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "workjet",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("workjet://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("retries transient renderer target failures", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733"))
        .mockResolvedValueOnce(new Response("ready"));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "workjet-dev",
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("workjet-dev://app/")));
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol registration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const error = yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "workjet-dev",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          backendOrigin: new URL("http://127.0.0.1:3774/"),
          clerkFrontendApiHostname: undefined,
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "workjet-dev");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to register Electron protocol scheme "workjet-dev".');
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol unregistration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol unregistration failed");
      unhandleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const exit = yield* Effect.exit(
        Effect.scoped(
          protocol.registerDesktopProtocol({
            scheme: "workjet",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          }),
        ),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronProtocol.ElectronProtocolUnregistrationError);
        assert.equal(error.scheme, "workjet");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, 'Failed to unregister Electron protocol scheme "workjet".');
      }
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it("keeps executable sources host-restricted while allowing runtime network resources", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "workjet",
      targetOrigin: new URL("http://127.0.0.1:3773/"),
      backendOrigin: new URL("http://127.0.0.1:3773/"),
      clerkFrontendApiHostname: "clerk.workjet.codes",
    });
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );

    assert.deepEqual(directives["script-src"], [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      "https://clerk.workjet.codes",
      "https://challenges.cloudflare.com",
    ]);
    assert.deepEqual(directives["connect-src"], ["'self'", "http:", "https:", "ws:", "wss:"]);
    assert.deepEqual(directives["img-src"], [
      "'self'",
      "workjet:",
      "blob:",
      "data:",
      "http:",
      "https:",
    ]);
    assert.deepEqual(directives["font-src"], ["'self'", "workjet:", "data:"]);
  });
});
