import {
  WORKJET_PRESENTATION_RANGE_BYTES,
  isWorkjetPresentationReceiptForRequest,
  type CtoxWorkjetProjectControlRequest,
  type ProjectId,
  type WorkjetPresentationManifest,
  type WorkjetPresentationMutation,
} from "@workjet/contracts";
import { validateSlideDocument, type SlideDocument } from "@workjet/slide-engine/schema";
import type { CanvasScene } from "@workjet/slide-engine/excalidraw/canvas-schema";
import { requestWorkjetProjectControl } from "../workjetProjectControl";
import { newCommandId, randomUUID } from "./utils";

type Control = typeof requestWorkjetProjectControl;

export interface JourFixePresentation {
  readonly manifest: WorkjetPresentationManifest;
  readonly document: SlideDocument;
}

export interface JourFixePresentationSave {
  readonly mutation: WorkjetPresentationMutation;
  readonly manifest: WorkjetPresentationManifest;
}

function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function confirmed(
  control: Control,
  instanceId: string,
  request: CtoxWorkjetProjectControlRequest,
) {
  const result = await control(instanceId, request);
  if (result._tag !== "completed") throw new Error(`Presentation unavailable: ${result.code}`);
  if (
    result.response.action !== request.action ||
    !isWorkjetPresentationReceiptForRequest(request, result.response)
  )
    throw new Error("The presentation answer does not match the request.");
  return result.response;
}

/**
 * Reads the meeting's presentation: the manifest, then the stored revision in
 * bounded ranges. The assembled bytes must match the manifest hash and the
 * document must pass the slide engine's own validation.
 */
export async function readJourFixePresentation(
  instanceId: string,
  projectId: ProjectId,
  meetingId: string,
  control: Control = requestWorkjetProjectControl,
): Promise<JourFixePresentation | null> {
  const read = await confirmed(control, instanceId, {
    action: "project.presentation.read",
    commandId: newCommandId(),
    projectId,
    meetingId,
  });
  if (read.action !== "project.presentation.read") throw new Error("Unexpected answer.");
  const manifest = read.presentation;
  if (manifest === null) return null;
  const bytes = new Uint8Array(manifest.document_bytes);
  let offset = 0;
  while (offset < manifest.document_bytes) {
    const length = Math.min(WORKJET_PRESENTATION_RANGE_BYTES, manifest.document_bytes - offset);
    const part = await confirmed(control, instanceId, {
      action: "project.presentation.content.read",
      commandId: newCommandId(),
      projectId,
      meetingId,
      presentationId: manifest.presentation_id,
      revision: manifest.revision,
      offset,
      length,
    });
    if (part.action !== "project.presentation.content.read") throw new Error("Unexpected answer.");
    const chunk = base64Bytes(part.range.data_base64);
    if (
      chunk.length !== part.range.length ||
      part.range.total_bytes !== manifest.document_bytes ||
      part.range.document_sha256 !== manifest.document_sha256 ||
      (await sha256Hex(chunk)) !== part.rangeSha256
    )
      throw new Error("A presentation range failed its integrity check.");
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if ((await sha256Hex(bytes)) !== manifest.document_sha256)
    throw new Error("The presentation does not match its stored hash.");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const validation = validateSlideDocument(parsed);
  if (!validation.ok)
    throw new Error(
      `The stored presentation is not a valid slide document: ${validation.issues
        .slice(0, 3)
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  return { manifest, document: validation.document };
}

/**
 * Saves one slide's canvas as the next revision. CTOX validates the complete
 * document again; a newer revision (`expectedRevision` mismatch) is rejected,
 * so the caller should reload and reapply the edit.
 */
export async function saveJourFixePresentationCanvas(
  instanceId: string,
  projectId: ProjectId,
  manifest: WorkjetPresentationManifest,
  slideId: string,
  scene: CanvasScene,
  control: Control = requestWorkjetProjectControl,
  operationId: string = randomUUID(),
): Promise<JourFixePresentationSave> {
  const answer = await confirmed(control, instanceId, {
    action: "project.presentation.canvas.save",
    commandId: newCommandId(),
    projectId,
    meetingId: manifest.meeting_id,
    operationId,
    presentationId: manifest.presentation_id,
    expectedRevision: manifest.revision,
    slideId,
    sceneJson: JSON.stringify(scene),
  });
  if (answer.action !== "project.presentation.canvas.save") throw new Error("Unexpected answer.");
  return { mutation: answer.mutation, manifest: answer.presentation };
}
