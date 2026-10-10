import { describe, expect, it, vi } from "vite-plus/test";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";
import { ComposerDictationStream } from "./composerDictation";

function fixture(options: { foreign?: boolean; unsupported?: boolean } = {}) {
  const requests: unknown[] = [];
  const port = vi.fn<WorkjetProjectControlPort>(async (_instance, request) => {
    requests.push(request);
    if (options.unsupported) return { _tag: "failed", code: "unsupported" };
    if (request.action !== "speech.dictation")
      throw new Error("Unexpected meeting or settings mutation");
    return {
      _tag: "completed",
      response: {
        action: request.action,
        commandId: request.commandId,
        op: request.op,
        streamId:
          options.foreign && request.op !== "open" ? "another-recording" : "owned-recording",
        state: request.op === "finish" ? "finished" : "open",
        events: [],
        text: request.op === "finish" ? "Spoken draft" : null,
        error: null,
      },
    };
  });
  const controller = new AbortController();
  const stream = new ComposerDictationStream("managed:dictation-fixture", controller.signal, port);
  return { port, requests, controller, stream };
}

describe("composer dictation transport", () => {
  it("closes a native stream whose open receipt arrives after navigation", async () => {
    const controller = new AbortController();
    let resolve!: (value: Awaited<ReturnType<WorkjetProjectControlPort>>) => void;
    const pending = new Promise<Awaited<ReturnType<WorkjetProjectControlPort>>>((accept) => {
      resolve = accept;
    });
    let openRequest: Parameters<WorkjetProjectControlPort>[1] | undefined;
    let canceled!: () => void;
    const cancellation = new Promise<void>((accept) => {
      canceled = accept;
    });
    const port = vi.fn<WorkjetProjectControlPort>(async (_instance, request) => {
      if (request.action !== "speech.dictation") throw new Error("Unexpected action");
      if (request.op === "open") {
        openRequest = request;
        return pending;
      }
      if (request.op === "cancel") canceled();
      return {
        _tag: "completed",
        response: {
          action: request.action,
          commandId: request.commandId,
          op: request.op,
          streamId: request.streamId,
          state: "canceled",
          events: [],
          text: null,
          error: null,
        },
      };
    });
    const stream = new ComposerDictationStream(
      "managed:dictation-fixture",
      controller.signal,
      port,
    );
    const opening = stream.open();
    const rejected = expect(opening).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    stream.cancel();
    await rejected;
    if (!openRequest || openRequest.action !== "speech.dictation")
      throw new Error("Missing open request");
    resolve({
      _tag: "completed",
      response: {
        action: openRequest.action,
        commandId: openRequest.commandId,
        op: "open",
        streamId: "late-recording",
        state: "open",
        events: [],
        text: null,
        error: null,
      },
    });
    await pending;
    await cancellation;
    expect(port).toHaveBeenLastCalledWith(
      "managed:dictation-fixture",
      expect.objectContaining({ op: "cancel", streamId: "late-recording" }),
    );
  });

  it("routes PCM to the configured instance and returns final text without meeting writes", async () => {
    const f = fixture();
    await f.stream.open();
    f.stream.write(new Uint8Array(3200));
    expect(await f.stream.finish()).toBe("Spoken draft");
    expect(f.port).toHaveBeenCalledWith(
      "managed:dictation-fixture",
      expect.objectContaining({ op: "write", sequence: 1, streamId: "owned-recording" }),
    );
    expect(f.requests).toHaveLength(3);
    expect(f.requests.every((r) => (r as { action: string }).action === "speech.dictation")).toBe(
      true,
    );
  });
  it("rejects another recording's final text", async () => {
    const f = fixture({ foreign: true });
    await f.stream.open();
    await expect(f.stream.finish()).rejects.toThrow("another recording");
  });
  it("bounds audio and outstanding frames instead of silently dropping speech", async () => {
    const f = fixture();
    await f.stream.open();
    expect(() => f.stream.write(new Uint8Array(3202))).toThrow("could not keep up");
    for (let i = 0; i < 8; i++) f.stream.write(new Uint8Array(2));
    expect(() => f.stream.write(new Uint8Array(2))).toThrow("could not keep up");
    f.controller.abort();
    f.stream.cancel();
  });
  it("cancels the exact owned recording after scope abort", async () => {
    const f = fixture();
    await f.stream.open();
    f.controller.abort();
    f.stream.cancel();
    expect(f.port).toHaveBeenLastCalledWith(
      "managed:dictation-fixture",
      expect.objectContaining({ op: "cancel", streamId: "owned-recording" }),
    );
    await expect(f.stream.finish()).rejects.toThrow("closed");
  });
  it("explains missing instance support without using a different speech provider", async () => {
    const f = fixture({ unsupported: true });
    await expect(f.stream.open()).rejects.toThrow("Open Speech settings");
    expect(f.requests).toHaveLength(1);
  });
});
