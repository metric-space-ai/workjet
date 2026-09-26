import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  LocalServiceCredential,
  LocalServiceCredentialError,
} from "./DesktopLocalServiceCredential.ts";
import {
  LocalServiceSessionError,
  makeSessionAccess,
  type LocalSessionDependencies,
} from "./DesktopLocalServiceSession.ts";
import type { DesktopBackendStartConfig } from "./DesktopBackendManager.ts";
vi.mock("electron", () => ({ safeStorage: {} }));

const config: DesktopBackendStartConfig = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  args: [],
  env: {},
  extendEnv: true,
  localSession: { baseDir: "/profile", serverVersion: "1.2.3" },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  bootstrap: {
    mode: "desktop",
    port: 3773,
    noBrowser: true,
    workjetHome: "/profile",
    host: "127.0.0.1",
    desktopBootstrapToken: "unused",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  bootstrapDelivery: "fd3",
  captureOutput: true,
  preflightFailure: Option.none(),
};
const target = {
  version: 1 as const,
  baseDir: "/profile",
  environmentId: "environment-a",
  runtimeInstanceId: "runtime-a",
  serverVersion: "1.2.3",
  origin: "http://127.0.0.1:3773",
};
const credential = Schema.decodeUnknownSync(LocalServiceCredential)({
  version: 1,
  baseDir: target.baseDir,
  environmentId: target.environmentId,
  sessionId: "11111111-1111-4111-8111-111111111111",
  token: "test-secret",
  expiresAt: "2099-01-01T00:00:00Z",
});
const fixture = () => {
  const events: string[] = [];
  const state = {
    saved: Option.none<LocalServiceCredential>(),
    generation: "runtime-a",
    denyRead: false,
    denyProtection: false,
    denySave: false,
    denyValidation: false,
    stores: 0,
  };
  const denied = () => new LocalServiceCredentialError({ operation: "fixture-denied" });
  const dependencies: LocalSessionDependencies = {
    discover: () => Effect.sync(() => ({ ...target, runtimeInstanceId: state.generation })),
    openStore: () =>
      Effect.sync(() => {
        state.stores++;
        return {
          filePath: "/profile/runtime/desktop-auth/session.enc",
          get: Effect.suspend(() =>
            state.denyRead ? Effect.fail(denied()) : Effect.succeed(state.saved),
          ),
          requireProtection: Effect.suspend(() => {
            events.push("protect");
            return state.denyProtection ? Effect.fail(denied()) : Effect.void;
          }),
          save: (value) =>
            Effect.suspend(() => {
              events.push("save");
              if (state.denySave) return Effect.fail(denied());
              state.saved = Option.some(value);
              return Effect.void;
            }),
          remove: () => Effect.die("Enrollment must not remove credentials."),
        };
      }),
    issue: () =>
      Effect.sync(() => {
        events.push("issue");
        return credential;
      }),
    revoke: () =>
      Effect.sync(() => {
        events.push("revoke");
      }),
    validate: (current) =>
      Effect.suspend(() => {
        events.push(`validate:${current.runtimeInstanceId}`);
        return state.denyValidation
          ? Effect.fail(new LocalServiceSessionError({ operation: "authenticate" }))
          : Effect.void;
      }),
  };
  return { dependencies, events, state };
};

it.effect(
  "serializes concurrent first enrollment and reuses the protected session after reopening",
  () =>
    Effect.gen(function* () {
      const { dependencies, events, state } = fixture();
      const first = yield* makeSessionAccess(dependencies);
      assert.deepEqual(
        yield* Effect.all([first.get(config), first.get(config)], { concurrency: 2 }),
        ["test-secret", "test-secret"],
      );
      assert.deepEqual(events, [
        "protect",
        "issue",
        "validate:runtime-a",
        "save",
        "validate:runtime-a",
      ]);
      assert.equal(state.stores, 1);
      const reopened = yield* makeSessionAccess(dependencies);
      state.generation = "runtime-b";
      assert.equal(yield* reopened.get(config), "test-secret");
      assert.equal(events.filter((event) => event === "issue").length, 1);
      assert.equal(events.at(-1), "validate:runtime-b");
    }),
);

it.effect("revokes a new session when its waiting caller is interrupted", () =>
  Effect.gen(function* () {
    const { dependencies, events, state } = fixture();
    const validating = yield* Deferred.make<void>();
    const access = yield* makeSessionAccess({
      ...dependencies,
      validate: () => Deferred.succeed(validating, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const caller = yield* Effect.forkChild(access.get(config));
    yield* Deferred.await(validating);
    yield* Fiber.interrupt(caller);
    assert.equal(events.at(-1), "revoke");
    assert.isTrue(Option.isNone(state.saved));
  }),
);

it.effect("does not repeatedly mint after an uncertain revocation", () =>
  Effect.gen(function* () {
    const { dependencies, events, state } = fixture();
    state.denySave = true;
    const access = yield* makeSessionAccess({
      ...dependencies,
      revoke: () => Effect.fail(new LocalServiceSessionError({ operation: "revoke" })),
    });
    yield* access.get(config).pipe(Effect.flip);
    yield* access.get(config).pipe(Effect.flip);
    assert.equal(events.filter((event) => event === "issue").length, 1);
  }),
);

for (const failure of ["denyRead", "denyProtection"] as const) {
  it.effect(`does not mint after ${failure}`, () =>
    Effect.gen(function* () {
      const { dependencies, events, state } = fixture();
      state[failure] = true;
      const access = yield* makeSessionAccess(dependencies);
      yield* access.get(config).pipe(Effect.flip);
      assert.notInclude(events, "issue");
      assert.isTrue(Option.isNone(state.saved));
    }),
  );
}
for (const failure of ["denySave", "denyValidation"] as const) {
  it.effect(`revokes an issued token after ${failure} without publishing it`, () =>
    Effect.gen(function* () {
      const { dependencies, events, state } = fixture();
      state[failure] = true;
      const access = yield* makeSessionAccess(dependencies);
      yield* access.get(config).pipe(Effect.flip);
      assert.equal(events.at(-1), "revoke");
      assert.isTrue(Option.isNone(state.saved));
    }),
  );
}
for (const failure of ["expired", "revoked", "wrong-profile"] as const) {
  it.effect(`preserves ${failure} credentials without implicit re-enrollment`, () =>
    Effect.gen(function* () {
      const { dependencies, events, state } = fixture();
      state.saved = Option.some({
        ...credential,
        ...(failure === "expired" ? { expiresAt: "1970-01-01T00:00:00Z" } : {}),
        ...(failure === "wrong-profile" ? { environmentId: "another-environment" } : {}),
      });
      state.denyValidation = failure === "revoked";
      const before = state.saved;
      const access = yield* makeSessionAccess(dependencies);
      yield* access.get(config).pipe(Effect.flip);
      assert.strictEqual(state.saved, before);
      assert.notInclude(events, "issue");
      assert.notInclude(events, "revoke");
      assert.notInclude(events, "save");
    }),
  );
}
