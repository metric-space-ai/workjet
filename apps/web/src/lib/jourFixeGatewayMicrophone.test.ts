import { describe, expect, it, vi } from "vite-plus/test";
import { createJourFixeGatewayMicrophoneProvider } from "./jourFixeGatewayMicrophone";
import type { JourFixeMicrophoneCaptureFactory } from "./jourFixeBrowserMicrophone";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";
import type { WorkjetJourFixeSpeechRequest } from "@workjet/contracts";

const scope = {
  instanceId: "managed:instance",
  projectId: "project",
  meetingId: "meeting",
  deckRevision: 3,
};
const id = "11111111-1111-4111-8111-111111111111";
const wait = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
  const calls: WorkjetJourFixeSpeechRequest[] = [];
  let finished = false;
  const port: WorkjetProjectControlPort = async (_instance, raw) => {
    if (raw.action !== "project.jour_fixe.speech") throw new Error("Owner text fallback forbidden");
    calls.push(raw);
    if (raw.op === "finish") finished = true;
    const committed = finished && raw.op === "read";
    const n = raw.op === "read" ? raw.afterSequence + 1 : 0;
    return {
      _tag: "completed",
      response: {
        action: raw.action,
        op: raw.op,
        projectId: raw.projectId,
        meetingId: raw.meetingId,
        deckRevision: raw.deckRevision,
        streamId: id,
        state:
          raw.op === "cancel"
            ? "canceled"
            : committed
              ? "committed"
              : raw.op === "finish"
                ? "finishing"
                : "open",
        events:
          !finished && n > 0 && n <= 2
            ? [{ sequence: n, producerSequence: n, text: n === 1 ? "Hallo " : "Welt" }]
            : [],
        receipt: committed
          ? { handle: "22222222-2222-4222-8222-222222222222", meetingRevision: 8 }
          : null,
        error: null,
        ...(raw.op === "open" ? { requestId: raw.requestId } : {}),
      },
    };
  };
  const cancel = vi.fn();
  const flush = vi.fn(async () => {});
  let captureOptions: Parameters<JourFixeMicrophoneCaptureFactory>[0] | undefined;
  const capture: JourFixeMicrophoneCaptureFactory = vi.fn(async (options) => {
    captureOptions = options;
    return { cancel, finish: flush };
  });
  const committed = vi.fn();
  const stopped = vi.fn();
  const errors = vi.fn();
  const partial = vi.fn();
  const controller = new AbortController();
  const provider = createJourFixeGatewayMicrophoneProvider({
    port,
    capture,
    prepareNarration: async () => {
      throw new Error("No authorized narration supplied");
    },
  });
  const start = () =>
    provider.startListening({
      scope,
      signal: controller.signal,
      onCommitted: committed,
      onStopped: stopped,
      onError: errors,
      onPartial: partial,
    });
  return {
    calls,
    port,
    capture,
    cancel,
    flush,
    controller,
    start,
    committed,
    stopped,
    errors,
    partial,
    frame(voiced = true, bytes = 3200) {
      captureOptions!.onFrame({ pcm: new Uint8Array(bytes), voiced });
    },
  };
}
describe("gateway microphone provider", () => {
  it("accumulates delta text and refreshes only after native durable final", async () => {
    const f = fixture();
    const handle = await f.start();
    await wait();
    expect(f.partial.mock.calls.map((c) => c[0].text)).toEqual(["Hallo ", "Hallo Welt"]);
    f.frame();
    expect(f.committed).not.toHaveBeenCalled();
    await handle.stop();
    expect(f.flush).toHaveBeenCalledOnce();
    expect(f.committed).toHaveBeenCalledOnce();
    expect(f.stopped).toHaveBeenCalledOnce();
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.calls.filter((c) => c.op === "finish")).toHaveLength(1);
    expect(f.calls.some((c) => "text" in c)).toBe(false);
    await handle.stop();
    expect(f.committed).toHaveBeenCalledOnce();
  });
  it("auto-finishes after trailing silence and releases capture", async () => {
    const f = fixture();
    await f.start();
    f.frame();
    for (let i = 0; i < 6; i++) f.frame(false);
    await wait();
    expect(f.committed).toHaveBeenCalledOnce();
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it("cancels silence-only input without a native final", async () => {
    const f = fixture();
    const handle = await f.start();
    f.frame(false);
    await handle.stop();
    expect(f.committed).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.op === "finish")).toBe(false);
    expect(f.calls.some((c) => c.op === "cancel")).toBe(true);
  });
  it("scope abort closes capture immediately and ignores late frames", async () => {
    const f = fixture();
    await f.start();
    f.controller.abort();
    f.frame();
    await wait(0);
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.calls.some((c) => c.op === "write")).toBe(false);
    expect(f.committed).not.toHaveBeenCalled();
  });
  it("does not request the microphone when native transport is unavailable", async () => {
    const f = fixture();
    const provider = createJourFixeGatewayMicrophoneProvider({
      capture: f.capture,
      port: async () => {
        throw new Error("missing transport configuration");
      },
      prepareNarration: async () => new Blob(),
    });
    await expect(
      provider.startListening({
        scope,
        signal: f.controller.signal,
        onCommitted: f.committed,
        onPartial: f.partial,
        onError: f.errors,
      }),
    ).rejects.toThrow("missing transport");
    expect(f.capture).not.toHaveBeenCalled();
  });
  it("oversized capture cancels even if UI error notification throws", async () => {
    const f = fixture();
    await f.start();
    f.errors.mockImplementation(() => {
      throw new Error("UI failed");
    });
    f.frame(true, 3202);
    await wait(0);
    expect(f.cancel).toHaveBeenCalledOnce();
    expect(f.committed).not.toHaveBeenCalled();
    expect(f.calls.some((c) => c.op === "cancel")).toBe(true);
  });
});
