// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  CtoxMobileShellPackResolveResult,
  type CtoxMobileShellPackResolveResult as CtoxMobileShellPackResolveResultType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const CLI_TIMEOUT = Duration.seconds(20);

export class CtoxMobileShellPackServiceError extends Schema.TaggedErrorClass<CtoxMobileShellPackServiceError>()(
  "CtoxMobileShellPackServiceError",
  { reason: Schema.Literals(["cli_unavailable", "cli_timeout", "cli_failed", "invalid_response"]) },
) {
  override get message(): string {
    return "The CTOX mobile shell-pack operation failed.";
  }
}

export class CtoxMobileShellPackService extends Context.Service<
  CtoxMobileShellPackService,
  {
    readonly resolve: (
      businessOsRevision: string,
      appVersion: string,
    ) => Effect.Effect<CtoxMobileShellPackResolveResultType, CtoxMobileShellPackServiceError>;
  }
>()("t3/ctox/CtoxMobileShellPackService") {}

function serviceError(
  reason: "cli_unavailable" | "cli_timeout" | "cli_failed" | "invalid_response",
) {
  return new CtoxMobileShellPackServiceError({ reason });
}

function collectBounded<E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulated, chunk) =>
        new TextEncoder().encode(accumulated).byteLength > MAX_OUTPUT_BYTES
          ? accumulated
          : accumulated + chunk,
    ),
  );
}

export interface CtoxMobileShellPackServiceOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nowEpochMs?: () => number;
}

export const make = Effect.fn("CtoxMobileShellPackService.make")(function* (
  options: CtoxMobileShellPackServiceOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = options.env?.CTOX_BIN?.trim() || process.env.CTOX_BIN?.trim() || "ctox";
  const now =
    options.nowEpochMs === undefined
      ? DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
      : Effect.sync(options.nowEpochMs);

  const resolve = Effect.fn("CtoxMobileShellPackService.resolve")(function* (
    businessOsRevision: string,
    appVersion: string,
  ) {
    const output = yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(command, [
            "business-os",
            "mobile-shell",
            "resolve",
            "--business-os-revision",
            businessOsRevision,
            "--app-version",
            appVersion,
          ]),
        )
        .pipe(Effect.mapError(() => serviceError("cli_unavailable")));
      const [stdout, , exitCode] = yield* Effect.all(
        [collectBounded(child.stdout), collectBounded(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      ).pipe(Effect.mapError(() => serviceError("cli_failed")));
      if (Number(exitCode) !== 0) return yield* serviceError("cli_failed");
      return stdout;
    }).pipe(
      Effect.scoped,
      Effect.timeout(CLI_TIMEOUT),
      Effect.catchTag("TimeoutError", () => Effect.fail(serviceError("cli_timeout"))),
    );
    if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) {
      return yield* serviceError("invalid_response");
    }
    const decodedJson = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
      output,
    ).pipe(Effect.mapError(() => serviceError("invalid_response")));
    const result = yield* Schema.decodeUnknownEffect(CtoxMobileShellPackResolveResult)(
      decodedJson,
    ).pipe(Effect.mapError(() => serviceError("invalid_response")));
    const paths = new Set(result.manifest.files.map((file) => file.path));
    const totalSize = result.manifest.files.reduce((sum, file) => sum + file.size, 0);
    const expiresAtMs = Date.parse(result.artifact.expiresAt);
    if (
      paths.size !== result.manifest.files.length ||
      !paths.has("index.html") ||
      totalSize !== result.manifest.totalSize ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= (yield* now)
    )
      return yield* serviceError("invalid_response");
    return result;
  });

  return CtoxMobileShellPackService.of({ resolve });
});

export const layer = (options: CtoxMobileShellPackServiceOptions = {}) =>
  Layer.effect(CtoxMobileShellPackService, make(options));
