import { seedKernelTestShell } from "./kernelTestHost";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createKernel } from "./kernel/kernel.mjs";
import { KernelTransport } from "./kernel/transport.mjs";
import type { Kernel, KernelWrite } from "./ctoxClient";
import { bindKernelCtoxClient } from "./kernelClient";
import { getCtoxClient } from "./ctoxClient";
import { observeCtoxCommand, executeCtoxCommand } from "./commands";

let fixtureSequence = 0;
const kernels: Kernel[] = [];
const releases: (() => void)[] = [];
class AckTransport extends KernelTransport {
  override async connect(
    _identity: Parameters<KernelTransport["connect"]>[0],
    events: Parameters<KernelTransport["connect"]>[1],
  ) {
    events.link({ state: "online", rtt_ms: 0, relay: false });
  }
  override async write(entry: KernelWrite) {
    return {
      status: "accepted" as const,
      rev: "1",
      seq: "1",
      doc: { ...(entry.body as Record<string, unknown>), status: "accepted" },
    };
  }
}
afterEach(async () => {
  releases.splice(0).forEach((off) => off());
  await Promise.all(kernels.splice(0).map((kernel) => kernel.close()));
});
async function open(instanceId: string, transport = new KernelTransport()) {
  const kernel = createKernel({
    instanceId,
    userId: "fixture-owner",
    storage: "memory",
    dbName: `p11b-${instanceId}-${++fixtureSequence}`,
    multiTab: false,
    transport,
  });
  kernels.push(kernel);
  await kernel.ready;
  await seedKernelTestShell(kernel);
  releases.push(bindKernelCtoxClient(kernel, "p11-b"));
  return { kernel, api: getCtoxClient(instanceId)! };
}

describe("real kernel command and scope contract", () => {
  it("does not confuse a command write ACK with execution; terminal callback is once", async () => {
    const { kernel, api } = await open("command-owner", new AckTransport());
    const handle = api.command(
      "threads.message.create",
      { body: "real durable command" },
      { record_id: "t" },
    );
    await handle.local;
    const stored = api.get<Record<string, unknown>>("business_commands", handle.id).get();
    expect(stored?.record_id).toBe("t");
    let completions = 0;
    let result: unknown;
    releases.push(
      observeCtoxCommand(handle, {
        onComplete: (value) => {
          completions++;
          result = value;
        },
        onFailed: (code) => {
          throw new Error(code);
        },
      }),
    );
    expect(await handle.result).toMatchObject({ status: "accepted", seq: "1" });
    expect(completions).toBe(0);
    for (const seq of ["2", "3"])
      await kernel.receivePage({
        epoch: "1",
        collection: "business_commands",
        scope_hash: "local",
        gen: 1,
        cursor_to: seq,
        complete: true,
        docs: [
          {
            id: handle.id,
            seq,
            rev: seq,
            data: { ...stored, id: handle.id, status: "done", result: { message_id: "m" } },
          },
        ],
      });
    expect(completions).toBe(1);
    expect(result).toEqual({ message_id: "m" });
  });

  it("detaches an aborted waiter without cancelling the durable command or leaking scope", async () => {
    const a = await open("a");
    const b = await open("b", new AckTransport());
    const abort = new AbortController();
    const waiting = executeCtoxCommand(
      a.api,
      "threads.message.create",
      { body: "keep" },
      { signal: abort.signal },
    );
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    await Promise.resolve();
    expect(a.api.query("business_commands", {}).get()).toHaveLength(1);
    expect(b.api.query("business_commands", {}).get()).toEqual([]);
    const detached = executeCtoxCommand(a.api, "threads.message.create", {
      body: "pending on unmount",
    });
    releases[0]!();
    await expect(detached).rejects.toMatchObject({ code: "ctox_scope_changed" });
    const cancelled = b.api.command("threads.message.create", { body: "cancel via Core" });
    await cancelled.local;
    await cancelled.result;
    const intent = b.api.get<Record<string, unknown>>("business_commands", cancelled.id).get();
    const failures: string[] = [];
    releases.push(
      observeCtoxCommand(cancelled, {
        onComplete: () => {
          throw new Error("cancelled command completed");
        },
        onFailed: (code) => failures.push(code),
      }),
    );
    await b.kernel.receivePage({
      epoch: "1",
      collection: "business_commands",
      scope_hash: "local",
      gen: 1,
      cursor_to: "2",
      complete: true,
      docs: [
        {
          id: cancelled.id,
          seq: "2",
          rev: "2",
          data: { ...intent, id: cancelled.id, status: "cancelled" },
        },
      ],
    });
    expect(failures).toEqual(["cancelled"]);
  });
});
