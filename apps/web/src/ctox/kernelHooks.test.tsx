import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";
import { createKernel } from "./kernel/kernel.mjs";
import { KernelTransport } from "./kernel/transport.mjs";
import { bindCtoxClient, type CtoxAppApi, type LiveQuery, type Query } from "./ctoxClient";
import { useCtoxDoc } from "./hooks";
import { installDom } from "../test/localReactDom";
import { useCtoxProjectChats } from "./workjetLiveData";

it("does not subscribe a nullable document, and drops foreign chats at an instance switch", async () => {
  installDom();
  const kernel = createKernel({
    instanceId: "kernel-hook",
    userId: "owner",
    dbName: "p11b-hook-contract",
    storage: "memory",
    multiTab: false,
    transport: new KernelTransport(),
  });
  await kernel.ready;
  const api = kernel.appApi("workjet", "p11-b");
  let documentReads = 0;
  let subscriptions = 0;
  const counted: CtoxAppApi = {
    ...api,
    get: <T,>(collection: string, id: string) => {
      documentReads++;
      return api.get<T>(collection, id);
    },
    query: <T,>(collection: string, query: Query): LiveQuery<T> => {
      const live = api.query<T>(collection, query);
      return {
        get: () => live.get(),
        subscribe: (receive: (rows: T[]) => void) => {
          subscriptions++;
          const off = live.subscribe(receive);
          return () => {
            subscriptions--;
            off();
          };
        },
      };
    },
  };
  const unbind = bindCtoxClient("kernel-hook", counted);
  const root = createRoot(document.createElement("div"));
  let chats: readonly { id: string }[] = [];
  function Probe({ instanceId }: { instanceId: string }) {
    useCtoxDoc(instanceId, "workjet_supervisor_bindings", null);
    chats = useCtoxProjectChats(instanceId, "p");
    return createElement("output", null, JSON.stringify(chats));
  }
  try {
    await kernel.receivePage({
      epoch: "1",
      collection: "workjet_project_chats",
      scope_hash: "local",
      gen: 1,
      cursor_to: "1",
      complete: true,
      docs: [
        {
          id: "chat",
          seq: "1",
          rev: "1",
          data: {
            id: "chat",
            project_id: "p",
            thread_id: "thread",
            owner_user_id: "owner",
            kind: "private",
            initial: true,
          },
        },
      ],
    });
    await act(async () => root.render(createElement(Probe, { instanceId: "kernel-hook" })));
    expect(documentReads).toBe(0);
    expect(chats.map((chat) => chat.id)).toEqual(["chat"]);
    expect(subscriptions).toBe(1);
    await act(async () => root.render(createElement(Probe, { instanceId: "unbound-instance" })));
    expect(chats).toEqual([]);
    expect(subscriptions).toBe(0);
  } finally {
    await act(async () => root.unmount());
    unbind();
    await kernel.close();
  }
});
