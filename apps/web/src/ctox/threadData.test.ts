import { expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@workjet/contracts";
import { createKernel } from "./kernel/kernel.mjs";
import { KernelTransport } from "./kernel/transport.mjs";
import { readWorkjetThreadDetail } from "./workjetThreadData";

it("joins only the selected computer-originated thread and never guesses missing model facts", async () => {
  const kernel = createKernel({
    instanceId: "thread-proof",
    userId: "owner",
    storage: "memory",
    dbName: "p11b-thread-scope",
    multiTab: false,
    transport: new KernelTransport(),
  });
  await kernel.ready;
  const api = kernel.appApi("workjet", "p11-b");
  const ref = {
    environmentId: EnvironmentId.make("fixture-computer"),
    threadId: ThreadId.make("t"),
  };
  const timestamp = "2026-10-15T00:00:00.000Z";
  const shell = {
    id: "t",
    environmentId: "fixture-computer",
    projectId: "p",
    title: "Fixture thread",
    modelSelection: { instanceId: "fixture-provider", model: "fixture-model" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const page = (collection: string, docs: { id: string; [key: string]: unknown }[], seq = "1") =>
    kernel.receivePage({
      epoch: "1",
      collection,
      scope_hash: "local",
      gen: 1,
      cursor_to: seq,
      complete: true,
      docs: docs.map((data) => ({ id: data.id, data, rev: seq, seq })),
    });
  try {
    await page("workjet_threads", [shell]);
    await page("workjet_thread_messages", [
      {
        id: "m",
        thread_id: "t",
        role: "assistant",
        text: "Retained answer",
        turnId: null,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "other",
        thread_id: "other-thread",
        role: "assistant",
        text: "Must not join",
        turnId: null,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    expect(readWorkjetThreadDetail(api, ref)?.messages.map((message) => message.text)).toEqual([
      "Retained answer",
    ]);
    expect(
      readWorkjetThreadDetail(api, { ...ref, environmentId: EnvironmentId.make("other-computer") }),
    ).toBeNull();
    await page("workjet_threads", [{ ...shell, modelSelection: undefined }], "2");
    expect(() => readWorkjetThreadDetail(api, ref)).toThrow();
  } finally {
    await kernel.close();
  }
});
