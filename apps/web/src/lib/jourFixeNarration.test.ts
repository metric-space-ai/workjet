import { describe, expect, it } from "vite-plus/test";
import { prepareJourFixeNarration } from "./jourFixeNarration";
import type { WorkjetProjectControlPort } from "../workjetProjectControl";
import {
  JOUR_FIXE_NARRATION_RANGE_BYTES,
  type WorkjetJourFixeNarrationReadResponse,
} from "@workjet/contracts";
const scope = {
  instanceId: "managed:instance",
  projectId: "project",
  meetingId: "meeting",
  deckRevision: 3,
};
async function hash(bytes: Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function fixture(size = 50) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
  const audio = {
    file_id: "retained",
    generation_id: "generation",
    sha256: await hash(bytes),
    narration_text_sha256: "a".repeat(64),
    mime_type: "audio/wav" as const,
    format: "wav" as const,
    duration_ms: 1000,
    source_run_id: "run",
    model: "grok-4.7",
    synthesis_duration_ms: 123,
    provenance: "native_gateway" as const,
  };
  const requests: { offset: number; length: number }[] = [];
  let change = (response: WorkjetJourFixeNarrationReadResponse) => response;
  const port: WorkjetProjectControlPort = async (instance, request) => {
    expect(instance).toBe(scope.instanceId);
    if (request.action !== "project.jour_fixe.narration.read")
      throw new Error("Synthesis or text mutation is forbidden");
    requests.push({ offset: request.offset, length: request.length });
    const part = bytes.slice(request.offset, request.offset + request.length);
    let binary = "";
    for (const byte of part) binary += String.fromCharCode(byte);
    const response: WorkjetJourFixeNarrationReadResponse = {
      ...request,
      meetingRevision: 9,
      audio: { ...audio },
      totalBytes: bytes.length,
      length: part.length,
      bytesBase64: btoa(binary),
      rangeSha256: await hash(part),
    };
    return { _tag: "completed", response: change(response) };
  };
  return {
    bytes,
    requests,
    port,
    mutate: (fn: typeof change) => {
      change = fn;
    },
  };
}
describe("retained Jour fixe narration", () => {
  it("returns verified audio, without a URL, provider request or caller-selected file", async () => {
    const f = await fixture();
    const blob = await prepareJourFixeNarration({
      scope,
      slideId: "slide",
      signal: new AbortController().signal,
      port: f.port,
    });
    expect(blob.type).toBe("audio/wav");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(f.bytes);
    expect(f.requests).toEqual([{ offset: 0, length: JOUR_FIXE_NARRATION_RANGE_BYTES }]);
  });
  it("assembles ordered bounded ranges and verifies the full audio digest", async () => {
    const f = await fixture(JOUR_FIXE_NARRATION_RANGE_BYTES + 20);
    const blob = await prepareJourFixeNarration({
      scope,
      slideId: "slide",
      signal: new AbortController().signal,
      port: f.port,
    });
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(f.bytes);
    expect(f.requests.map((request) => request.offset)).toEqual([
      0,
      JOUR_FIXE_NARRATION_RANGE_BYTES,
    ]);
  });
  it("rejects wrong command, scope, range, generation and malformed Base64", async () => {
    for (const mutation of [
      (r: WorkjetJourFixeNarrationReadResponse) => ({
        ...r,
        commandId: "other" as typeof r.commandId,
      }),
      (r: WorkjetJourFixeNarrationReadResponse) => ({ ...r, meetingId: "other" }),
      (r: WorkjetJourFixeNarrationReadResponse) => ({ ...r, deckRevision: r.deckRevision + 1 }),
      (r: WorkjetJourFixeNarrationReadResponse) => ({ ...r, offset: r.offset + 1 }),
      (r: WorkjetJourFixeNarrationReadResponse) => ({ ...r, bytesBase64: "invalid_" }),
      (r: WorkjetJourFixeNarrationReadResponse) => ({
        ...r,
        audio: { ...r.audio, generation_id: "" },
      }),
    ]) {
      const f = await fixture();
      f.mutate(mutation);
      await expect(
        prepareJourFixeNarration({
          scope,
          slideId: "slide",
          signal: new AbortController().signal,
          port: f.port,
        }),
      ).rejects.toThrow();
    }
  });
  it("rejects a correct range digest with a wrong complete-file digest", async () => {
    const f = await fixture();
    f.mutate((r) => ({ ...r, audio: { ...r.audio, sha256: "b".repeat(64) } }));
    await expect(
      prepareJourFixeNarration({
        scope,
        slideId: "slide",
        signal: new AbortController().signal,
        port: f.port,
      }),
    ).rejects.toThrow("complete-file");
  });
  it("rejects tampered byte range and changing audio between ranges", async () => {
    const damaged = await fixture();
    damaged.mutate((r) => ({ ...r, rangeSha256: "b".repeat(64) }));
    await expect(
      prepareJourFixeNarration({
        scope,
        slideId: "slide",
        signal: new AbortController().signal,
        port: damaged.port,
      }),
    ).rejects.toThrow("range");
    const changed = await fixture(JOUR_FIXE_NARRATION_RANGE_BYTES + 1);
    changed.mutate((r) =>
      r.offset ? { ...r, audio: { ...r.audio, generation_id: "replacement" } } : r,
    );
    await expect(
      prepareJourFixeNarration({
        scope,
        slideId: "slide",
        signal: new AbortController().signal,
        port: changed.port,
      }),
    ).rejects.toThrow("changed");
  });
  it("aborts before starting and cancels a pending result without another range", async () => {
    const f = await fixture();
    const before = new AbortController();
    before.abort();
    await expect(
      prepareJourFixeNarration({ scope, slideId: "slide", signal: before.signal, port: f.port }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.requests).toHaveLength(0);
    const controller = new AbortController();
    let release: ((value: Awaited<ReturnType<WorkjetProjectControlPort>>) => void) | undefined;
    let entered: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const port: WorkjetProjectControlPort = () =>
      new Promise((resolve) => {
        release = resolve;
        entered?.();
      });
    const read = prepareJourFixeNarration({
      scope,
      slideId: "slide",
      signal: controller.signal,
      port,
    });
    await ready;
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    release?.({ _tag: "failed", code: "not_active" });
  });
});
