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
  decodeEnrollmentSessions,
  requestLocalSessionRecoveryConsent,
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
it.effect("selects only the exact enrollment subject, never a label or a matching prefix", () =>
  Effect.gen(function* () {
    const selected = yield* decodeEnrollmentSessions(
      `[
      {"sessionId":"11111111-1111-4111-8111-111111111111","subject":"workjet-desktop-enrollment:attempt-a"},
      {"sessionId":"22222222-2222-4222-8222-222222222222","subject":"workjet-desktop-enrollment:attempt-ab","client":{"label":"Workjet Desktop"}},
      {"sessionId":"33333333-3333-4333-8333-333333333333","subject":"cli-issued-session","client":{"label":"workjet-desktop-enrollment:attempt-a"}}
    ]`,
      "attempt-a",
    );
    assert.deepEqual(selected, [credential.sessionId]);
    yield* decodeEnrollmentSessions("{", "attempt-a").pipe(Effect.flip);
  }),
);

it.effect(
  "recovery consent defaults to Cancel and requires the stopped-installations checkbox",
  () =>
    Effect.gen(function* () {
      for (const response of [0, 1]) {
        for (const checkboxChecked of [false, true]) {
          const consent = yield* requestLocalSessionRecoveryConsent(
            {
              showMessageBox: (options) => {
                assert.equal(options.defaultId, 0);
                assert.equal(options.cancelId, 0);
                assert.equal(options.checkboxChecked, false);
                return Effect.succeed({ response, checkboxChecked });
              },
            },
            target,
          );
          assert.equal(consent, response === 1 && checkboxChecked);
        }
      }
    }),
);

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
    pending: false,
    approveRecovery: true,
  };
  const denied = () => new LocalServiceCredentialError({ operation: "fixture-denied" });
  const dependencies: LocalSessionDependencies = {
    confirmRecovery: () =>
      Effect.sync(() => {
        events.push("confirm");
        return state.approveRecovery;
      }),
    listEnrollmentSessions: (_config, _target, attemptId) =>
      Effect.sync(() => {
        assert.equal(attemptId, "attempt-a");
        events.push("list-exact-enrollment");
        return [credential.sessionId];
      }),
    discover: () => Effect.sync(() => ({ ...target, runtimeInstanceId: state.generation })),
    openStore: () =>
      Effect.sync(() => {
        state.stores++;
        return {
          filePath: "/profile/runtime/desktop-auth/session.enc",
          withAccess: <A, E, R>(operation: Effect.Effect<A, E, R>) => operation,
          inspectRecovery: Effect.sync(() => ({
            baseDir: target.baseDir,
            environmentId: target.environmentId,
            sessionId: Option.isSome(state.saved) ? state.saved.value.sessionId : undefined,
            attemptId: state.pending ? "attempt-a" : undefined,
            fingerprints: [],
          })),
          retireRecovered: () =>
            Effect.sync(() => {
              events.push("retire");
              state.pending = false;
              state.saved = Option.none();
              state.denyRead = false;
            }),
          assertEnrollmentSettled: Effect.suspend(() =>
            state.pending ? Effect.fail(denied()) : Effect.void,
          ),
          beginEnrollment: Effect.suspend(() => {
            if (state.pending) return Effect.fail(denied());
            state.pending = true;
            return Effect.succeed("attempt-a");
          }),
          finishEnrollment: () =>
            Effect.sync(() => {
              state.pending = false;
            }),
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
  "explicit recovery reconciles unknown enrollment before retiring files or re-enrolling",
  () =>
    Effect.gen(function* () {
      const { dependencies, state, events } = fixture();
      state.pending = true;
      const access = yield* makeSessionAccess(dependencies);
      const prepared = yield* access.prepareWithRecovery(config);
      assert.equal(prepared.credential.sessionId, credential.sessionId);
      assert.deepEqual(events, [
        "protect",
        "confirm",
        "list-exact-enrollment",
        "revoke",
        "retire",
        "protect",
        "issue",
        "validate:runtime-a",
        "save",
      ]);
    }),
);

it.effect("refuses a recovery identity from another environment before consent or revocation", () =>
  Effect.gen(function* () {
    const { dependencies, state, events } = fixture();
    state.saved = Option.some(credential);
    const access = yield* makeSessionAccess({
      ...dependencies,
      discover: () => Effect.succeed({ ...target, environmentId: "environment-b" }),
    });
    const error = yield* access.recover(config).pipe(Effect.flip);
    assert.include(error.operation, "recovery target");
    assert.deepEqual(events, []);
    assert.isTrue(Option.isSome(state.saved));
  }),
);

it.effect(
  "cancel preserves the old session without revocation, retirement or automatic re-enrollment",
  () =>
    Effect.gen(function* () {
      const { dependencies, state, events } = fixture();
      state.pending = true;
      state.approveRecovery = false;
      const access = yield* makeSessionAccess(dependencies);
      const error = yield* access.prepareWithRecovery(config).pipe(Effect.flip);
      assert.include(error.operation, "cancelling");
      yield* access.prepareWithRecovery(config).pipe(Effect.flip);
      assert.deepEqual(events, ["protect", "confirm"]);
      assert.isTrue(state.pending);
    }),
);

it.effect(
  "a lost revoke reply retains recovery across reopening and never retries within the same UI",
  () =>
    Effect.gen(function* () {
      const { dependencies, state, events } = fixture();
      state.pending = true;
      const first = yield* makeSessionAccess({
        ...dependencies,
        revoke: () =>
          Effect.sync(() => events.push("revoke-unknown")).pipe(
            Effect.andThen(
              Effect.fail(new LocalServiceSessionError({ operation: "confirm revocation of" })),
            ),
          ),
      });
      yield* first.prepareWithRecovery(config).pipe(Effect.flip);
      yield* first.prepareWithRecovery(config).pipe(Effect.flip);
      assert.isTrue(state.pending);
      assert.deepEqual(events, ["protect", "confirm", "list-exact-enrollment", "revoke-unknown"]);
      const reopened = yield* makeSessionAccess(dependencies);
      yield* reopened.prepareWithRecovery(config);
      assert.equal(events.filter((event) => event === "issue").length, 1);
      assert.isBelow(events.indexOf("revoke"), events.indexOf("retire"));
    }),
);

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

it.effect(
  "retains unknown issuance before reply failure across caller and service recreation",
  () =>
    Effect.gen(function* () {
      const { dependencies, events, state } = fixture();
      const unknown = {
        ...dependencies,
        issue: (_config: DesktopBackendStartConfig, _target: typeof target, enrollmentId: string) =>
          Effect.suspend(() => {
            assert.isTrue(state.pending);
            assert.equal(enrollmentId, "attempt-a");
            events.push("server-session-committed");
            return Effect.fail(
              new LocalServiceSessionError({ operation: "receive a truncated issuance reply for" }),
            );
          }),
      };
      const first = yield* makeSessionAccess(unknown);
      yield* first.get(config).pipe(Effect.flip);
      yield* first.get(config).pipe(Effect.flip);
      const reopened = yield* makeSessionAccess(unknown);
      yield* reopened.get(config).pipe(Effect.flip);
      assert.equal(events.filter((event) => event === "server-session-committed").length, 1);
      assert.isTrue(state.pending);
      assert.isTrue(Option.isNone(state.saved));
      assert.notInclude(events, "revoke");
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
      const error = yield* access.get(config).pipe(Effect.flip);
      assert.equal(
        error.operation,
        failure === "denySave" ? "fixture-denied credential for" : "authenticate",
      );
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
