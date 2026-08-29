import type {
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  PullRequestDiffInput,
  PullRequestDiffResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";

export interface ThreadSnapshotWindow {
  readonly turnLimit: number;
  readonly beforeCursor?: string;
}

export class ShellSnapshotLoader extends Context.Service<
  ShellSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<OrchestrationShellSnapshot>>;
  }
>()("@t3tools/client-runtime/state/productLoaders/ShellSnapshotLoader") {}

export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      window?: ThreadSnapshotWindow,
    ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
  }
>()("@t3tools/client-runtime/state/productLoaders/ThreadSnapshotLoader") {}

export class PullRequestDiffLoader extends Context.Service<
  PullRequestDiffLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      input: PullRequestDiffInput,
    ) => Effect.Effect<PullRequestDiffResult, PullRequestDiffLoadError>;
  }
>()("@t3tools/client-runtime/state/productLoaders/PullRequestDiffLoader") {}

export class PullRequestDiffLoadError extends Data.TaggedError("PullRequestDiffLoadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
