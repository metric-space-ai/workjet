import { type ProjectId, isWorkjetJourFixeNarrationReceiptForRequest,
  JOUR_FIXE_NARRATION_MAX_BYTES, JOUR_FIXE_NARRATION_RANGE_BYTES,
  type WorkjetJourFixeNarrationReadResponse } from "@workjet/contracts";
import { requestWorkjetProjectControl, type WorkjetProjectControlPort } from "../workjetProjectControl";
import type { JourFixeSpeechScope } from "./jourFixeSpeech";
import { newCommandId } from "./utils";

export interface JourFixeNarrationOptions {
  readonly scope: JourFixeSpeechScope;
  readonly slideId: string;
  readonly signal: AbortSignal;
  readonly port?: WorkjetProjectControlPort;
}
const canceled = () => new DOMException("Narration scope canceled.", "AbortError");
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
/** Resolve retained audio only. The room session owns and revokes its Blob URL. */
export async function prepareJourFixeNarration(options: JourFixeNarrationOptions): Promise<Blob> {
  const scope = Object.freeze({ ...options.scope });
  const slideId = options.slideId;
  const signal = options.signal;
  const port = options.port;
  const deadline = Date.now() + 120_000;
  let first: WorkjetJourFixeNarrationReadResponse | undefined;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let offset = 0;
  const current = () => {
    if (signal.aborted) throw canceled();
    if (Date.now() >= deadline) throw new Error("Narration retrieval exceeded its deadline.");
  };
  const invoke = async (request: Parameters<WorkjetProjectControlPort>[1]) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let detach = () => {};
    try {
      return await Promise.race([
        requestWorkjetProjectControl(scope.instanceId, request, port),
        new Promise<never>((_, reject) => {
          const abort = () => reject(canceled());
          signal.addEventListener("abort", abort, { once: true });
          detach = () => signal.removeEventListener("abort", abort);
          timeout = setTimeout(() => reject(new Error("Narration retrieval exceeded its deadline.")),
            Math.min(30_000, Math.max(1, deadline - Date.now())));
          if (signal.aborted) abort();
        }),
      ]);
    } finally { if (timeout !== undefined) clearTimeout(timeout); detach(); }
  };
  try {
    do {
      current();
      const request = {
        action: "project.jour_fixe.narration.read" as const, commandId: newCommandId(),
        projectId: scope.projectId as ProjectId, meetingId: scope.meetingId, deckRevision: scope.deckRevision,
        slideId, offset, length: JOUR_FIXE_NARRATION_RANGE_BYTES,
      };
      const result = await invoke(request);
      current();
      if (result._tag !== "completed") throw new Error(`Narration transport unavailable: ${result.code}`);
      if (!isWorkjetJourFixeNarrationReceiptForRequest(request, result.response))
        throw new Error("Narration response belongs to another slide, scope or byte range.");
      const response = result.response;
      if (!first) {
        first = response;
        bytes = new Uint8Array(response.totalBytes);
      } else if (response.totalBytes !== first.totalBytes || response.audio.file_id !== first.audio.file_id
        || response.audio.generation_id !== first.audio.generation_id || response.audio.sha256 !== first.audio.sha256
        || response.audio.narration_text_sha256 !== first.audio.narration_text_sha256
        || response.audio.provenance !== first.audio.provenance || response.audio.duration_ms !== first.audio.duration_ms) {
        throw new Error("The retained narration changed during retrieval.");
      }
      const part = decode(response.bytesBase64);
      if (!bytes || part.length !== response.length || offset + part.length > JOUR_FIXE_NARRATION_MAX_BYTES
        || await digest(part) !== response.rangeSha256)
        throw new Error("Narration audio range failed its integrity check.");
      current();
      bytes.set(part, offset);
      offset += part.length;
    } while (first && offset < first.totalBytes);
    if (!first || !bytes || offset !== first.totalBytes || await digest(bytes) !== first.audio.sha256)
      throw new Error("Narration audio failed its complete-file integrity check.");
    current();
    return new Blob([bytes], { type: "audio/wav" });
  } catch (error) {
    bytes?.fill(0);
    throw error;
  }
}
