import { fetchRemoteEnvironmentDescriptor } from "@workjet/client-runtime/environment";
import { ConnectionCatalogDocument } from "@workjet/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import { resolveProvisioningBackendBearerToken } from "./CtoxProvisioningEnvironment.ts";

const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(ConnectionCatalogDocument));
let catalogWarningReported = false;

/** A saved-catalog error cannot prevent discovery of the exact local environment. */
export const makeDecisionHubEnvironmentResolver = Effect.fn("makeDecisionHubEnvironmentResolver")(
  function <E>(input: {
    readonly readCatalog: Effect.Effect<Option.Option<string>, E>;
    readonly localConfigurations: Effect.Effect<readonly DesktopBackendStartConfig[]>;
    readonly notifyCatalogError: Effect.Effect<void>;
  }) {
    return Effect.sync(() =>
      Effect.fn("resolveDecisionHubEnvironment")(function* (environmentId: string) {
        const catalog = yield* input.readCatalog.pipe(
          Effect.flatMap((stored) =>
            Option.isSome(stored)
              ? decodeCatalog(stored.value).pipe(Effect.map(Option.some))
              : Effect.succeed(Option.none<ConnectionCatalogDocument>()),
          ),
          Effect.catch(() =>
            Effect.gen(function* () {
              const shouldReport = yield* Effect.sync(() => {
                if (catalogWarningReported) return false;
                catalogWarningReported = true;
                return true;
              });
              if (shouldReport)
                yield* input.notifyCatalogError.pipe(Effect.catchCause(() => Effect.void));
              return Option.none<ConnectionCatalogDocument>();
            }),
          ),
        );
        if (Option.isSome(catalog)) {
          const target = catalog.value.targets.find(
            (candidate) => candidate.environmentId === environmentId,
          );
          if (target?._tag === "BearerConnectionTarget") {
            const profile = catalog.value.profiles.find(
              (candidate) =>
                candidate._tag === "BearerConnectionProfile" &&
                candidate.connectionId === target.connectionId,
            );
            const credential = catalog.value.credentials.find(
              (candidate) => candidate.connectionId === target.connectionId,
            )?.credential;
            if (
              profile?._tag === "BearerConnectionProfile" &&
              credential?._tag === "BearerConnectionCredential"
            )
              return {
                httpBaseUrl: profile.httpBaseUrl,
                wsBaseUrl: profile.wsBaseUrl,
                bearerToken: credential.token,
              };
          }
        }
        for (const config of yield* input.localConfigurations) {
          const descriptor = yield* fetchRemoteEnvironmentDescriptor({
            httpBaseUrl: config.httpBaseUrl.href,
          });
          if (descriptor.environmentId !== environmentId) continue;
          const bearerToken = yield* resolveProvisioningBackendBearerToken(config);
          return {
            httpBaseUrl: config.httpBaseUrl.href,
            wsBaseUrl: config.httpBaseUrl.href.replace(/^http/, "ws"),
            bearerToken,
          };
        }
        return yield* Effect.fail("environment_unavailable" as const);
      }),
    );
  },
);
