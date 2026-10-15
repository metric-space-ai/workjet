/**
 * Secret request canary: a value typed into the chat secret card must cross
 * exactly one boundary (the `secret.request.fulfill` project-control request)
 * and must not reach browser storage, logs, the returned outcome, or any other
 * project-control payload.
 */
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CtoxWorkjetProjectControlResponse } from "@workjet/contracts";

const CANARY = "CANARY-secret-7f3a9c1e5b-Ünïcode";
const sent: unknown[] = [];

vi.mock("./workjetProjectControl", () => ({
  requestWorkjetProjectControl: vi.fn(
    async (_instance: string, request: { action: string; requestId?: string }) => {
      sent.push(request);
      if (request.action === "secret.put" || request.action === "secret.delete") {
        return {
          _tag: "completed",
          response: { action: request.action, name: (request as unknown as { name: string }).name },
        };
      }
      if (request.action === "secret.request.list") {
        return { _tag: "completed", response: { action: "secret.request.list", requests: [] } };
      }
      return {
        _tag: "completed",
        response: {
          action: request.action,
          requestId: request.requestId,
          status: request.action === "secret.request.fulfill" ? "stored" : "declined",
          ref: "[secret-ref:mail/cto1_password]",
        },
      };
    },
  ),
}));

function mapStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

describe("secret request canary", () => {
  const logs: string[] = [];
  beforeEach(() => {
    sent.length = 0;
    logs.length = 0;
    vi.stubGlobal("localStorage", mapStorage());
    vi.stubGlobal("sessionStorage", mapStorage());
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the value only in the fulfil request and returns only the reference", async () => {
    const { fulfillSecretRequest, listSecretRequests } = await import("./workjetSecretRequests");
    await listSecretRequests("inst-1", "thread-1");
    const outcome = await fulfillSecretRequest("inst-1", "sreq_abc", CANARY);
    expect(outcome).toEqual({ ok: true, ref: "[secret-ref:mail/cto1_password]" });
    expect(JSON.stringify(outcome)).not.toContain(CANARY);

    const carriers = sent.filter((r) => JSON.stringify(r).includes(CANARY));
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toMatchObject({ action: "secret.request.fulfill", requestId: "sreq_abc" });

    const dump = JSON.stringify({
      local: Object.fromEntries(Object.entries(localStorage)),
      localKeys: Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)),
      session: Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)),
    });
    expect(dump).not.toContain(CANARY);
    expect(logs.join("\n")).not.toContain(CANARY);
  });

  it("settings put sends the value once and keeps it out of storage and logs", async () => {
    const { putCredential } = await import("./workjetSecretRequests");
    expect(await putCredential("inst-1", "CUSTOM_KEY", CANARY)).toBe(true);
    expect(sent.filter((r) => JSON.stringify(r).includes(CANARY))).toHaveLength(1);
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(CANARY);
    expect(logs.join("\n")).not.toContain(CANARY);
  });

  it("rejects responses that try to carry a value back", () => {
    const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse);
    const decoded = decode({
      action: "secret.request.fulfill",
      requestId: "sreq_abc",
      status: "stored",
      ref: "[secret-ref:mail/cto1_password]",
      value: CANARY,
    });
    expect(JSON.stringify(decoded)).not.toContain(CANARY);
  });

  it("keeps the card and helpers free of storage and draft writers", () => {
    for (const rel of [
      "./components/chat/SecretRequestCard.tsx",
      "./workjetSecretRequests.ts",
      "./components/ui/secret-input.tsx",
    ]) {
      const source = NodeFS.readFileSync(
        NodeURL.fileURLToPath(new URL(rel, import.meta.url)),
        "utf8",
      );
      expect(source).not.toMatch(
        /localStorage|sessionStorage|indexedDB|composerDraft|DraftStore|console\./,
      );
    }
  });
});
