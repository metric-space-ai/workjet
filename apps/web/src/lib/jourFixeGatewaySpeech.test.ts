import { describe, expect, it } from "vite-plus/test";
import { openJourFixeGatewaySpeech, isJourFixePrivateFinalReceipt } from "./jourFixeGatewaySpeech";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";
import type { WorkjetJourFixeSpeechRequest } from "@workjet/contracts";
const id = "11111111-1111-4111-8111-111111111111";
const handle = "22222222-2222-4222-8222-222222222222";
const scope = {
  instanceId: "managed:instance",
  projectId: "project",
  meetingId: "meeting",
  deckRevision: 3,
};
const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture() {
  const calls: WorkjetJourFixeSpeechRequest[] = [];
  let finished = false;
  let cursor = 0;
  const port: WorkjetProjectControlPort = async (instance, raw) => {
    expect(instance).toBe(scope.instanceId);
    if (raw.action !== "project.jour_fixe.speech")
      throw new Error("Owner text append is forbidden");
    calls.push(raw);
    const receipt = finished && raw.op === "read" ? { handle, meetingRevision: 8 } : null;
    const events =
      raw.op === "read" && !cursor++ ? [{ sequence: 1, producerSequence: 1, text: "Hallo " }] : [];
    if (raw.op === "finish") finished = true;
    return {
      _tag: "completed",
      response: {
        action: raw.action,
        op: raw.op,
        projectId: raw.projectId,
        meetingId: raw.meetingId,
        deckRevision: raw.deckRevision,
        streamId: id,
        events,
        receipt,
        error: null,
        state:
          raw.op === "cancel"
            ? "canceled"
            : receipt
              ? "committed"
              : raw.op === "finish"
                ? "finishing"
                : "open",
        ...(raw.op === "open" ? { requestId: raw.requestId } : {}),
      },
    };
  };
  return { calls, port };
}
describe("Jour fixe gateway consumer", () => {
  it("writes PCM, emits deltas, and finishes only with a native committed private handle", async () => {
    const f = fixture();
    const deltas: string[] = [];
    const stream = await openJourFixeGatewaySpeech({
      scope,
      signal: new AbortController().signal,
      port: f.port,
      onPartial: (e) => deltas.push(e.text),
    });
    await stream.write(new Uint8Array(3200));
    const first = stream.finish();
    expect(stream.finish()).toBe(first);
    const receipt = await first;
    expect(deltas).toEqual(["Hallo "]);
    expect(isJourFixePrivateFinalReceipt(receipt)).toBe(true);
    expect(isJourFixePrivateFinalReceipt({ ...receipt })).toBe(false);
    expect(() => JSON.stringify(receipt)).toThrow("private");
    expect(receipt.meetingRevision).toBe(8);
    expect(f.calls.filter((c) => c.op === "finish")).toHaveLength(1);
    expect(f.calls.some((c) => "text" in c)).toBe(false);
  });
  it("cancels the exact stream on scope abort and drops late partials", async () => {
    const f = fixture();
    const controller = new AbortController();
    const deltas: string[] = [];
    let deliver: ((value: Awaited<ReturnType<WorkjetProjectControlPort>>) => void) | undefined;
    const port: WorkjetProjectControlPort = (instance, raw) => {
      if (raw.action === "project.jour_fixe.speech" && raw.op === "read")
        return new Promise((resolve) => {
          deliver = resolve;
        });
      return f.port(instance, raw);
    };
    const stream = await openJourFixeGatewaySpeech({
      scope,
      signal: controller.signal,
      port,
      onPartial: (e) => deltas.push(e.text),
    });
    controller.abort();
    await wait(0);
    const read = f.calls.find((c) => c.op === "open")!;
    if (read.op !== "open") throw new Error("fixture");
    deliver?.({
      _tag: "completed",
      response: {
        action: read.action,
        op: "read",
        projectId: read.projectId,
        meetingId: read.meetingId,
        deckRevision: read.deckRevision,
        streamId: id,
        state: "open",
        receipt: null,
        error: null,
        events: [{ sequence: 1, producerSequence: 1, text: "late" }],
      },
    });
    await wait(0);
    expect(deltas).toEqual([]);
    expect(
      f.calls.filter((c) => c.op === "cancel").map((c) => ("streamId" in c ? c.streamId : null)),
    ).toEqual([id]);
    await expect(stream.write(new Uint8Array(3200))).rejects.toThrow();
    await stream.cancel();
  });
  it("rejects wrong-scope or fabricated finals before exposing a private receipt", async () => {
    const f = fixture();
    const port: WorkjetProjectControlPort = async (instance, raw) => {
      const value = await f.port(instance, raw);
      if (
        value._tag === "completed" &&
        value.response.action === "project.jour_fixe.speech" &&
        raw.action === "project.jour_fixe.speech" &&
        raw.op === "open"
      )
        return { ...value, response: { ...value.response, meetingId: "foreign" } };
      return value;
    };
    await expect(
      openJourFixeGatewaySpeech({
        scope,
        signal: new AbortController().signal,
        port,
        onPartial: () => {},
      }),
    ).rejects.toThrow("another scope");
  });
  it("cancels capture even when the UI error notification throws", async () => {
    const f = fixture();
    const stream = await openJourFixeGatewaySpeech({
      scope,
      signal: new AbortController().signal,
      port: f.port,
      onPartial: () => {},
      onError: () => {
        throw new Error("UI notification failed");
      },
    });
    await expect(stream.write(new Uint8Array(3202))).rejects.toThrow("100 ms");
    expect(f.calls.filter((c) => c.op === "cancel")).toHaveLength(1);
    await expect(stream.finish()).rejects.toThrow();
  });
  it("rejects oversized or queued capture instead of dropping PCM", async () => {
    const f = fixture();
    const stream = await openJourFixeGatewaySpeech({
      scope,
      signal: new AbortController().signal,
      port: f.port,
      onPartial: () => {},
    });
    await expect(stream.write(new Uint8Array(3202))).rejects.toThrow("100 ms");
    expect(f.calls.some((c) => c.op === "write")).toBe(false);
    await stream.cancel();
  });
});
