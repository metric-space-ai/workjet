// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ProviderDriverKind } from "@workjet/contracts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { PiRpcFramer, type PiRpcMessage } from "./PiRpcProtocol.ts";
import { resolveSpawnCommand } from "@workjet/shared/shell";

const provider = ProviderDriverKind.make("pi");
const error = (method: string, detail: string) => new ProviderAdapterRequestError({ provider, method, detail });

export const makePiRpc = Effect.fn("makePiRpc")(function* (input: {
  readonly binaryPath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const scope = yield* Scope.Scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = yield* resolveSpawnCommand(input.binaryPath, [...input.args], { env: input.environment, extendEnv: true });
  const child = yield* spawner.spawn(ChildProcess.make(command.command, command.args, {
    cwd: input.cwd, env: input.environment, extendEnv: true, shell: command.shell,
  })).pipe(Effect.mapError(cause => error("spawn", cause.message)));
  const outgoing = yield* Queue.unbounded<Uint8Array>();
  const events = yield* Queue.unbounded<PiRpcMessage>();
  const pending = new Map<string, Deferred.Deferred<unknown, ProviderAdapterRequestError>>();
  const failPending = (detail: string) => Effect.forEach(pending.values(), reply => Deferred.fail(reply, error("rpc", detail)), { discard: true });
  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catch(cause => failPending(cause.message)),
    Effect.forkIn(scope),
  );
  const framer = new PiRpcFramer();
  yield* Stream.decodeText(child.stdout).pipe(
    Stream.runForEach(chunk => Effect.gen(function* () {
      const messages = yield* Effect.try({ try: () => framer.push(chunk), catch: cause => error("rpc.decode", String(cause)) });
      yield* Effect.forEach(messages, message => {
        if (message.type !== "response") return Queue.offer(events, message).pipe(Effect.asVoid);
        const reply = message.id ? pending.get(message.id) : undefined;
        if (!reply) return Effect.void;
        return message.success === true
          ? Deferred.succeed(reply, message.data).pipe(Effect.asVoid)
          : Deferred.fail(reply, error("rpc", message.error ?? "Pi rejected the RPC command.")).pipe(Effect.asVoid);
      }, { discard: true });
    })),
    Effect.andThen(Effect.try({ try: () => framer.end(), catch: cause => error("rpc.decode", String(cause)) })),
    Effect.catch(cause => failPending(cause.message)),
    Effect.ensuring(Effect.gen(function* () {
      yield* failPending("The Pi RPC process exited.");
      yield* Queue.offer(events, { type: "workjet_process_exited" });
    })),
    Effect.forkIn(scope),
  );
  yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
  yield* Effect.addFinalizer(() => failPending("The Pi RPC session stopped."));
  const request = Effect.fn("Pi.rpc.request")(function* (type: string, fields: Record<string, unknown> = {}) {
    const id = randomUUID();
    const reply = yield* Deferred.make<unknown, ProviderAdapterRequestError>();
    pending.set(id, reply);
    return yield* Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({ ...fields, id, type }).pipe(Effect.mapError(cause => error(type, cause.message)));
      yield* Queue.offer(outgoing, new TextEncoder().encode(encoded + "\n"));
      return yield* Deferred.await(reply).pipe(Effect.timeout("30 seconds"), Effect.mapError(cause => error(type, cause.message)));
    }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
  });
  return { child, request, events: Stream.fromQueue(events) };
});
export type PiRpc = Effect.Success<ReturnType<typeof makePiRpc>>;
