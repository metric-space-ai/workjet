import * as Schema from "effect/Schema";
import {
  CtoxWorkjetProjectControlResponse,
  WorkjetJourFixeMeeting,
  WorkjetPresentationManifest,
  type CtoxWorkjetProjectControlRequest,
} from "@workjet/contracts";
import { getBoundCtoxClientInstance, getCtoxClient, type CtoxAppApi } from "./ctoxClient";
import { CtoxLocalReadError, readProjectRows } from "./projectReadData";

const decode = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse);
const decodeMeeting = Schema.decodeUnknownSync(WorkjetJourFixeMeeting);
const decodePresentation = Schema.decodeUnknownSync(WorkjetPresentationManifest);
type FileMetadata = {
  id: string;
  ref: string;
  size: number;
  owner_app: string;
  generation_id: string;
};
async function hash(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function base64(bytes: Uint8Array<ArrayBuffer>) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 4096)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  return btoa(text);
}
/** Files are CAS transfers (§10.2a/16.32), never business read commands or persisted Base64. */
export async function readLocalProjectFile(
  api: CtoxAppApi,
  request: CtoxWorkjetProjectControlRequest,
) {
  if (
    !("offset" in request) ||
    !("length" in request) ||
    !Number.isSafeInteger(request.offset) ||
    request.offset < 0 ||
    !Number.isSafeInteger(request.length) ||
    request.length <= 0 ||
    request.length > 256 * 1024
  )
    throw new CtoxLocalReadError("invalid", "file_range_invalid", "files");
  const instanceId = getBoundCtoxClientInstance(api);
  if (instanceId === null)
    throw new CtoxLocalReadError("unavailable", "ctox_scope_changed", "files");
  const { rows, collection } = readProjectRows(api, request);
  if (rows.length !== 1)
    throw new CtoxLocalReadError("not_found", "projection_missing", collection);
  const source = rows[0]!;
  let fileId: string, generation: string, sha256: string;
  let manifest: ReturnType<typeof decodePresentation> | undefined;
  let meeting: ReturnType<typeof decodeMeeting> | undefined;
  if (request.action === "project.presentation.content.read") {
    manifest = decodePresentation(source);
    if (
      manifest.presentation_id !== request.presentationId ||
      manifest.revision !== request.revision
    )
      throw new CtoxLocalReadError("conflict", "presentation_revision_changed", collection);
    fileId = manifest.document_file_id;
    generation = manifest.document_generation_id;
    sha256 = manifest.document_sha256;
  } else if (request.action === "project.jour_fixe.narration.read") {
    meeting = decodeMeeting(source);
    const audio = meeting.slides.find((slide) => slide.id === request.slideId)?.audio;
    if (!audio || meeting.deck_revision !== request.deckRevision || !audio.generation_id)
      throw new CtoxLocalReadError("conflict", "narration_revision_changed", collection);
    fileId = audio.file_id;
    generation = audio.generation_id;
    sha256 = audio.sha256;
  } else throw new CtoxLocalReadError("invalid", "file_read_action_unknown", "files");
  const metadata = api.get<FileMetadata>("files", fileId).get();
  if (
    !metadata ||
    metadata.owner_app !== "workjet" ||
    metadata.generation_id !== generation ||
    metadata.ref !== sha256 ||
    !/^[a-f0-9]{64}$/.test(metadata.ref) ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size <= 0 ||
    metadata.size > 8 * 1024 * 1024
  )
    throw new CtoxLocalReadError("invalid", "file_linkage_invalid", `files/${fileId}`);
  const blob = await api.files.get(metadata.ref);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (getCtoxClient(instanceId) !== api)
    throw new CtoxLocalReadError("unavailable", "ctox_scope_changed", "files");
  const after = api.get<FileMetadata>("files", fileId).get();
  if (
    !after ||
    after.ref !== metadata.ref ||
    after.generation_id !== generation ||
    after.owner_app !== "workjet" ||
    after.size !== metadata.size ||
    bytes.length !== metadata.size ||
    (await hash(bytes)) !== sha256
  )
    throw new CtoxLocalReadError("invalid", "file_integrity_failed", `files/${fileId}`);
  const current = readProjectRows(api, request).rows[0];
  if (!current) throw new CtoxLocalReadError("not_found", "projection_missing", collection);
  if (request.action === "project.presentation.content.read" && manifest) {
    const next = decodePresentation(current);
    if (
      next.revision !== manifest.revision ||
      next.document_file_id !== fileId ||
      next.document_sha256 !== sha256 ||
      next.document_generation_id !== generation
    )
      throw new CtoxLocalReadError("conflict", "presentation_revision_changed", collection);
    const chunk = bytes.slice(request.offset, request.offset + request.length);
    if (chunk.length === 0 || bytes.length !== manifest.document_bytes)
      throw new CtoxLocalReadError("invalid", "file_range_invalid", "files");
    return decode({
      ...request,
      range: {
        presentation_id: manifest.presentation_id,
        revision: manifest.revision,
        offset: request.offset,
        length: chunk.length,
        total_bytes: bytes.length,
        document_sha256: sha256,
        data_base64: base64(chunk),
      },
      rangeSha256: await hash(chunk),
    });
  }
  if (request.action === "project.jour_fixe.narration.read" && meeting) {
    const next = decodeMeeting(current);
    const audio = next.slides.find((slide) => slide.id === request.slideId)?.audio;
    if (
      !audio ||
      next.deck_revision !== request.deckRevision ||
      audio.sha256 !== sha256 ||
      audio.generation_id !== generation ||
      audio.file_id !== fileId
    )
      throw new CtoxLocalReadError("conflict", "narration_revision_changed", collection);
    const chunk = bytes.slice(request.offset, request.offset + request.length);
    if (chunk.length === 0) throw new CtoxLocalReadError("invalid", "file_range_invalid", "files");
    return decode({
      ...request,
      meetingRevision: next.revision,
      audio,
      totalBytes: bytes.length,
      length: chunk.length,
      bytesBase64: base64(chunk),
      rangeSha256: await hash(chunk),
    });
  }
  throw new CtoxLocalReadError("invalid", "file_read_action_unknown", "files");
}
