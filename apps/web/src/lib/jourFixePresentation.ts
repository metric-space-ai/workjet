import {
  WORKJET_PRESENTATION_RANGE_BYTES,
  isWorkjetPresentationReceiptForRequest,
  type CommandId,
  type CtoxWorkjetProjectControlRequest,
  type ProjectId,
  type WorkjetPresentationManifest,
  type WorkjetPresentationMutation,
} from "@workjet/contracts";
import { validateSlideDocument, type SlideDocument } from "@workjet/slide-engine/schema";
import type { CanvasScene } from "@workjet/slide-engine/excalidraw/canvas-schema";
import { requestWorkjetProjectControl } from "../workjetProjectControl";
import { newCommandId } from "./utils";
import { jourFixeCacheKey, readJourFixeCache, writeJourFixeCache } from "./jourFixeCache";

import {
  retryJourFixeRead,
  jourFixeReadDeadline,
  jourFixeTransportError,
} from "./jourFixeReadRetry";

type Control = typeof requestWorkjetProjectControl;

export interface JourFixePresentation {
  readonly manifest: WorkjetPresentationManifest;
  readonly document: SlideDocument;
}

/** The slide was changed elsewhere since editing started; the edit was not stored. */
export class PresentationSlideChangedError extends Error {
  constructor() {
    super("This slide was changed elsewhere in the meantime, so your change was not saved.");
    this.name = "PresentationSlideChangedError";
  }
}

/**
 * Same revision, slide and scene give the same operation id, so a retried save
 * (for example after a timed-out desktop call) replays instead of writing twice.
 */
export async function presentationSaveOperationId(
  manifest: WorkjetPresentationManifest,
  slideId: string,
  sceneJson: string,
): Promise<string> {
  const text = `${manifest.presentation_id}\n${manifest.revision}\n${slideId}\n${sceneJson}`;
  return `canvas-${(await sha256Hex(new TextEncoder().encode(text))).slice(0, 48)}`;
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

/**
 * One request per attempt: `build` receives a fresh command id each time, so a
 * retried read is answered anew instead of with an earlier attempt's result.
 */
async function confirmed(
  control: Control,
  instanceId: string,
  build: (commandId: CommandId) => CtoxWorkjetProjectControlRequest,
  options?: { readonly signal?: AbortSignal | undefined; readonly deadline?: number },
) {
  const invoke = async () => {
    const request = build(newCommandId());
    const result = await control(instanceId, request);
    if (result._tag !== "completed") throw jourFixeTransportError(result);
    return { request, result };
  };
  const { request, result } = options ? await retryJourFixeRead(invoke, options) : await invoke();
  if (
    result.response.action !== request.action ||
    !isWorkjetPresentationReceiptForRequest(request, result.response)
  )
    throw new Error("The presentation answer does not match the request.");
  return result.response;
}

interface CachedPresentation {
  readonly manifest: WorkjetPresentationManifest;
  readonly document: unknown;
}

/**
 * The last presentation CTOX confirmed for this meeting, validated again by
 * the slide engine, for an immediate first render. Null when none is stored.
 */
export async function readCachedJourFixePresentation(
  instanceId: string,
  projectId: ProjectId,
  meetingId: string,
): Promise<JourFixePresentation | null> {
  const cached = await readJourFixeCache<CachedPresentation>(
    jourFixeCacheKey.presentation(instanceId, projectId, meetingId),
  );
  if (!cached || cached.manifest?.meeting_id !== meetingId) return null;
  if (cached.manifest.project_id !== projectId) return null;
  const validation = validateSlideDocument(cached.document);
  return validation.ok ? { manifest: cached.manifest, document: validation.document } : null;
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
  signal?: AbortSignal,
): Promise<JourFixePresentation | null> {
  const options = { signal, deadline: jourFixeReadDeadline() };
  const read = await confirmed(
    control,
    instanceId,
    (commandId) => ({ action: "project.presentation.read", commandId, projectId, meetingId }),
    options,
  );
  if (read.action !== "project.presentation.read") throw new Error("Unexpected answer.");
  const manifest = read.presentation;
  if (manifest === null) return null;
  // The stored copy is only reused for byte-identical content of the same revision.
  const cached = await readCachedJourFixePresentation(instanceId, projectId, meetingId);
  if (
    cached &&
    cached.manifest.presentation_id === manifest.presentation_id &&
    cached.manifest.revision === manifest.revision &&
    cached.manifest.document_sha256 === manifest.document_sha256
  )
    return { manifest, document: cached.document };
  const bytes = new Uint8Array(manifest.document_bytes);
  let offset = 0;
  while (offset < manifest.document_bytes) {
    const length = Math.min(WORKJET_PRESENTATION_RANGE_BYTES, manifest.document_bytes - offset);
    const part = await confirmed(
      control,
      instanceId,
      (commandId) => ({
        action: "project.presentation.content.read",
        commandId,
        projectId,
        meetingId,
        presentationId: manifest.presentation_id,
        revision: manifest.revision,
        offset,
        length,
      }),
      options,
    );
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
  void writeJourFixeCache(jourFixeCacheKey.presentation(instanceId, projectId, meetingId), {
    manifest,
    document: parsed,
  } satisfies CachedPresentation);
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
  operationId?: string,
): Promise<JourFixePresentationSave> {
  const sceneJson = JSON.stringify(scene);
  const saveOperationId =
    operationId ?? (await presentationSaveOperationId(manifest, slideId, sceneJson));
  // A single attempt; the content-derived operationId identifies the edit.
  const answer = await confirmed(control, instanceId, (commandId) => ({
    action: "project.presentation.canvas.save",
    commandId,
    projectId,
    meetingId: manifest.meeting_id,
    operationId: saveOperationId,
    presentationId: manifest.presentation_id,
    expectedRevision: manifest.revision,
    slideId,
    sceneJson,
  }));
  if (answer.action !== "project.presentation.canvas.save") throw new Error("Unexpected answer.");
  return { mutation: answer.mutation, manifest: answer.presentation };
}

/**
 * The room's save workflow. An uncertain or rejected write is never rebased into
 * another mutation: retry the edit's original manifest/operation. Only a confirmed
 * write permits a read refresh, and a failed refresh cannot revoke that receipt.
 */
export async function saveJourFixePresentationSlide(
  instanceId: string,
  projectId: ProjectId,
  manifest: WorkjetPresentationManifest,
  slideId: string,
  scene: CanvasScene,
  control: Control = requestWorkjetProjectControl,
): Promise<{
  readonly presentation: JourFixePresentation | null;
  readonly reloadError: string | null;
}> {
  const saved = await saveJourFixePresentationCanvas(
    instanceId,
    projectId,
    manifest,
    slideId,
    scene,
    control,
  );
  try {
    const presentation = await readJourFixePresentation(
      instanceId,
      projectId,
      manifest.meeting_id,
      control,
    );
    if (!presentation || presentation.manifest.revision < saved.manifest.revision)
      throw new Error("The confirmed presentation revision is not available yet.");
    return { presentation, reloadError: null };
  } catch (reason) {
    return {
      presentation: null,
      reloadError:
        reason instanceof Error
          ? `The slide is saved, but the presentation could not be reloaded: ${reason.message}`
          : "The slide is saved, but the presentation could not be reloaded.",
    };
  }
}
