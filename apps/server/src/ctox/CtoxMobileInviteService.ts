// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  CtoxMobileInviteCreateResult,
  CtoxMobileInviteRevokeResult,
  type CtoxMobileInviteCreateResult as CtoxMobileInviteCreateResultType,
  type CtoxMobileInviteRevokeResult as CtoxMobileInviteRevokeResultType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DEFAULT_CTOX_COMMAND = "ctox";
const CTOX_BIN_ENV = "CTOX_BIN";
const CLI_TIMEOUT = Duration.seconds(20);
const MAX_OUTPUT_BYTES = 262_144;

export type CtoxMobileInviteFailureReason =
  | "cli_unavailable"
  | "cli_timeout"
  | "cli_failed"
  | "invalid_response";

export class CtoxMobileInviteServiceError extends Schema.TaggedErrorClass<CtoxMobileInviteServiceError>()(
  "CtoxMobileInviteServiceError",
  { reason: Schema.Literals(["cli_unavailable", "cli_timeout", "cli_failed", "invalid_response"]) },
) {
  override get message(): string {
    return "The CTOX mobile invite operation failed.";
  }
}

export class CtoxMobileInviteService extends Context.Service<
  CtoxMobileInviteService,
  {
    readonly create: (
      ttlSeconds: number,
    ) => Effect.Effect<CtoxMobileInviteCreateResultType, CtoxMobileInviteServiceError>;
    readonly revoke: (
      inviteId: string,
    ) => Effect.Effect<CtoxMobileInviteRevokeResultType, CtoxMobileInviteServiceError>;
  }
>()("t3/ctox/CtoxMobileInviteService") {}

function serviceError(reason: CtoxMobileInviteFailureReason) {
  return new CtoxMobileInviteServiceError({ reason });
}

function resolveCtoxBinary(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env[CTOX_BIN_ENV]?.trim();
  return configured ? configured : DEFAULT_CTOX_COMMAND;
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

const runCli = Effect.fn("CtoxMobileInviteService.runCli")(function* (input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}) {
  const result = yield* Effect.gen(function* () {
    const child = yield* input.spawner
      .spawn(ChildProcess.make(input.command, [...input.args]))
      .pipe(Effect.mapError(() => serviceError("cli_unavailable")));
    const [stdout, , exitCode] = yield* Effect.all(
      [collectBounded(child.stdout), collectBounded(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(() => serviceError("cli_failed")));
    return { stdout, exitCode: Number(exitCode) };
  }).pipe(
    Effect.scoped,
    Effect.timeout(CLI_TIMEOUT),
    Effect.catchTag("TimeoutError", () => Effect.fail(serviceError("cli_timeout"))),
  );
  if (result.exitCode !== 0) return yield* serviceError("cli_failed");
  if (new TextEncoder().encode(result.stdout).byteLength > MAX_OUTPUT_BYTES) {
    return yield* serviceError("invalid_response");
  }
  return result.stdout;
});

function parseJson(value: string): Effect.Effect<unknown, CtoxMobileInviteServiceError> {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(
    Effect.mapError(() => serviceError("invalid_response")),
  );
}

export interface CtoxMobileInviteServiceOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nowEpochMs?: () => number;
}

export const make = Effect.fn("CtoxMobileInviteService.make")(function* (
  options: CtoxMobileInviteServiceOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = resolveCtoxBinary(options.env ?? process.env);
  const currentTimeMillis =
    options.nowEpochMs === undefined
      ? DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
      : Effect.sync(options.nowEpochMs);

  const create = Effect.fn("CtoxMobileInviteService.create")(function* (ttlSeconds: number) {
    const stdout = yield* runCli({
      spawner,
      command,
      args: ["business-os", "mobile-invite", "create", "--ttl-seconds", String(ttlSeconds)],
    });
    const result = yield* Schema.decodeUnknownEffect(CtoxMobileInviteCreateResult)(
      yield* parseJson(stdout),
    ).pipe(Effect.mapError(() => serviceError("invalid_response")));
    const expiresAtMs = Date.parse(result.expiresAt);
    const nowEpochMs = yield* currentTimeMillis;
    if (
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= nowEpochMs ||
      result.invite.session.capability_expires_at_ms > expiresAtMs
    ) {
      return yield* serviceError("invalid_response");
    }
    return result;
  });

  const revoke = Effect.fn("CtoxMobileInviteService.revoke")(function* (inviteId: string) {
    const stdout = yield* runCli({
      spawner,
      command,
      args: ["business-os", "mobile-invite", "revoke", "--invite-id", inviteId],
    });
    return yield* Schema.decodeUnknownEffect(CtoxMobileInviteRevokeResult)(
      yield* parseJson(stdout),
    ).pipe(Effect.mapError(() => serviceError("invalid_response")));
  });

  return CtoxMobileInviteService.of({ create, revoke });
});

export const layer = (options: CtoxMobileInviteServiceOptions = {}) =>
  Layer.effect(CtoxMobileInviteService, make(options));
