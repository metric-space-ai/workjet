import {
  WorkjetHarness,
  type ProviderDriverKind,
  type ProviderSessionStartInput,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProviderAdapterValidationError } from "../provider/Errors.ts";
import { readWorkerSourceHarness } from "./WorkerSourceHarness.ts";
import { workerSourceDriver, workerSourceNativeProfile } from "./WorkerSourceNativeProfile.ts";

/** Foreign native workers must use the admitted source account and their private profile. */
export const admitWorkerSourceNativeProfile = Effect.fn("admitWorkerSourceNativeProfile")(
  function* (input: ProviderSessionStartInput, provider: ProviderDriverKind) {
    const failure = (issue: string) =>
      new ProviderAdapterValidationError({ provider, operation: "startSession", issue });
    const source = readWorkerSourceHarness(input.threadId);
    if (input.workjetConfig?.role === "worker") {
      const environment = yield* Effect.serviceOption(ServerEnvironment);
      const localEnvironmentId = Option.isSome(environment)
        ? yield* environment.value.getEnvironmentId
        : undefined;
      if (
        input.workjetConfig.parent.environmentId !== localEnvironmentId &&
        (!source ||
          source.identity.requestId !== input.threadId ||
          source.identity.sourceEnvironmentId !== input.workjetConfig.parent.environmentId ||
          source.identity.targetEnvironmentId !== localEnvironmentId)
      )
        return yield* failure(
          "Foreign worker source route is unavailable or mismatched; reconnect its source before restart.",
        );
    }
    if (!source) return undefined;
    if (source.isRevoked() || source.model !== input.modelSelection?.model)
      return yield* failure(
        "Foreign worker source model differs from its permit or the route is revoked.",
      );
    const native = "nativeProfile" in source ? source.nativeProfile : undefined;
    if (
      !native ||
      typeof native !== "object" ||
      !("harness" in native) ||
      !("directory" in native) ||
      typeof native.directory !== "string"
    )
      return yield* failure("Foreign worker source harness profile is unavailable or mismatched.");
    const directory = native.directory;
    const harness = yield* Schema.decodeUnknownEffect(WorkjetHarness)(native.harness).pipe(
      Effect.mapError(() =>
        failure("Foreign worker source harness profile is unavailable or mismatched."),
      ),
    );
    if (
      workerSourceDriver(harness) !== provider ||
      ("harness" in source && source.harness !== harness)
    )
      return yield* failure("Foreign worker source harness profile is unavailable or mismatched.");
    const profile = yield* Effect.try({
      try: () =>
        workerSourceNativeProfile({
          harness,
          model: source.model,
          baseUrl: source.baseUrl,
          apiKey: source.apiKey,
          directory,
        }),
      catch: () => failure("Foreign worker source harness profile is unavailable or mismatched."),
    });
    yield* Effect.tryPromise({
      try: () => source.admit(),
      catch: () => failure("Foreign worker source admission failed or expired."),
    });
    const runtime: Record<string, string> = {};
    for (const name of [
      "PATH",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "TERM",
      "SYSTEMROOT",
      "SystemRoot",
      "COMSPEC",
    ]) {
      const value = process.env[name];
      if (value !== undefined) runtime[name] = value;
    }
    const environment: NodeJS.ProcessEnv = {
      ...runtime,
      ...profile.environment,
      WORKJET_WORKER_SOURCE_URL: source.baseUrl,
      WORKJET_WORKER_SOURCE_KEY: source.apiKey,
    };
    return { ...profile, environment };
  },
);
