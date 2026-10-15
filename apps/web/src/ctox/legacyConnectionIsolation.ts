import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  ConnectionTargetStore,
  ConnectionRegistrationStore,
  ConnectionPersistenceError,
  EnvironmentCacheStore,
} from "@workjet/client-runtime/platform";
import {
  CredentialStore,
  ProfileStore,
  ConnectionTransientError,
} from "@workjet/client-runtime/connection";
import { TokenStore } from "@workjet/client-runtime/authorization";

/** V4 never loads, deletes or rewrites the legacy server catalog/credentials/cache. */
export function createV4ConnectionStorageContext() {
  const unavailable = () =>
    Effect.fail(
      new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "v4_legacy_backend_disabled",
      }),
    );
  const disabled = (operation: ConnectionPersistenceError["operation"]) =>
    Effect.fail(
      new ConnectionPersistenceError({ operation, message: "v4_legacy_backend_disabled" }),
    );
  const cache = EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => disabled("save-shell"),
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => disabled("save-thread"),
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => disabled("save-server-config"),
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => disabled("save-vcs-refs"),
    removeThread: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  return Context.make(ConnectionTargetStore, { list: Effect.succeed([]) }).pipe(
    Context.add(ConnectionRegistrationStore, {
      register: () => disabled("register-connection"),
      remove: () => disabled("remove-connection"),
    }),
    Context.add(
      ProfileStore.ConnectionProfileStore,
      ProfileStore.make({
        get: () => Effect.succeed(Option.none()),
        put: unavailable,
        remove: unavailable,
      }),
    ),
    Context.add(
      CredentialStore.ConnectionCredentialStore,
      CredentialStore.make({
        get: () => Effect.succeed(Option.none()),
        put: unavailable,
        remove: unavailable,
      }),
    ),
    Context.add(
      TokenStore.RemoteDpopAccessTokenStore,
      TokenStore.make({
        get: () => Effect.succeed(Option.none()),
        put: unavailable,
        remove: unavailable,
      }),
    ),
    Context.add(EnvironmentCacheStore, cache),
  );
}
