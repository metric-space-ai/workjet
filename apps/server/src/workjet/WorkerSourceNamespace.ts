// @effect-diagnostics nodeBuiltinImport:off -- Project the persisted original allocation, never a new path observation.
import * as NodePath from "node:path";
import type { ProviderDriverKind, ProviderSessionStartInput } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ProviderAdapterValidationError } from "../provider/Errors.ts";
import { ResourceMonitorBinary } from "../resourceTelemetry/ResourceMonitorBinary.ts";
import { IsolatedWorkerWorktreeStore } from "./IsolatedWorkerWorktreeStore.ts";
import { readWorkerSourceHarness } from "./WorkerSourceHarness.ts";
import type { WorkerNamespaceSpawnCapture } from "./WorkerNamespaceSpawn.ts";

export type WorkerNamespaceSessionCapture = Omit<
  WorkerNamespaceSpawnCapture,
  "runtimeFiles" | "runtimeDirectories"
> & {
  readonly revalidate: (signal: AbortSignal) => Promise<void>;
};

/** This is process custody, not an Owner/team grant. The common policy boundary
 * continues to reject autonomous execution until native authority is enforced. */
export const prepareWorkerSourceNamespace = Effect.fn("prepareWorkerSourceNamespace")(function* (
  input: ProviderSessionStartInput,
  provider: ProviderDriverKind,
) {
  const source = readWorkerSourceHarness(input.threadId);
  if (!source?.modelSocket) return undefined;
  const failure = (issue: string) =>
    new ProviderAdapterValidationError({ provider, operation: "startSession", issue });
  const config = input.workjetConfig;
  const policy = config?.schemaVersion === 2 ? config.executionPolicy : undefined;
  const profile = source.nativeProfileCapture;
  if (
    source.isRevoked() ||
    config?.role !== "worker" ||
    policy?.mode !== "autonomous-worktree" ||
    !input.cwd ||
    !profile ||
    source.identity.requestId !== input.threadId ||
    source.identity.sourceEnvironmentId !== config.parent.environmentId
  )
    return yield* failure("Worker namespace source, policy or private profile is unavailable.");
  const store = yield* Effect.serviceOption(IsolatedWorkerWorktreeStore);
  const binary = yield* Effect.serviceOption(ResourceMonitorBinary);
  if (Option.isNone(store) || Option.isNone(binary))
    return yield* failure("Worker namespace allocation journal or native launcher is unavailable.");
  const receipt = yield* store.value
    .get(input.threadId)
    .pipe(Effect.mapError(() => failure("Worker namespace allocation journal could not be read.")));
  if (Option.isNone(receipt))
    return yield* failure("Worker namespace has no original allocation receipt.");
  const { intent, custody } = receipt.value;
  if (
    custody === null ||
    custody.kind !== "isolated" ||
    intent.workerId !== input.threadId ||
    intent.projectId !== policy.projectId ||
    intent.authorityDigest !== source.identity.requestDigest ||
    intent.destination !== input.cwd ||
    intent.branch !== "workjet/worker/" + input.threadId ||
    !NodePath.isAbsolute(intent.destination) ||
    NodePath.resolve(intent.destination) !== intent.destination ||
    NodePath.dirname(custody.worktreePath) !== NodePath.dirname(intent.destination) ||
    !NodePath.basename(custody.worktreePath).startsWith(
      ".workjet-prepared-" + input.threadId + "-",
    ) ||
    custody.adminPath !== NodePath.join(custody.worktreePath, ".git")
  )
    return yield* failure("Worker namespace differs from its original allocation receipt.");
  const helperPath = yield* binary.value.resolve.pipe(
    Effect.mapError(() => failure("Worker namespace native launcher is unavailable.")),
  );
  const revalidate = async (signal?: AbortSignal) => {
    const current = () => readWorkerSourceHarness(input.threadId) === source && !source.isRevoked();
    if (!current()) throw failure("Worker namespace original source route is unavailable.");
    await source.admit(signal);
    if (!current())
      throw failure("Worker namespace original source route changed during admission.");
  };
  yield* Effect.tryPromise({
    try: revalidate,
    catch: () => failure("Worker namespace source admission failed or expired."),
  });
  return {
    helperPath,
    worktree: {
      ...custody,
      worktreePath: intent.destination,
      adminPath: NodePath.join(intent.destination, ".git"),
    },
    profile,
    modelSocket: source.modelSocket,
    revalidate,
  } satisfies WorkerNamespaceSessionCapture;
});
