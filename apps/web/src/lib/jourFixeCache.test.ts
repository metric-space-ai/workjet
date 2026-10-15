import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type {
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResult,
  ProjectId,
  WorkjetJourFixeMeeting,
  WorkjetJourFixeNarrationReadResponse,
  WorkjetPresentationManifest,
} from "@workjet/contracts";
import { jourFixeDeck } from "@workjet/slide-engine/fixtures/jour-fixe-deck";
import { setJourFixeCacheBackend } from "./jourFixeCache";
import { prepareJourFixeNarration } from "./jourFixeNarration";
import { readCachedJourFixePresentation, readJourFixePresentation } from "./jourFixePresentation";
import { JOUR_FIXE_PREFETCH_WINDOW_MS, prefetchJourFixeMeeting } from "./jourFixePrefetch";

const instanceId = "managed:instance";
const projectId = "project" as ProjectId;
const scope = { instanceId, projectId: "project", meetingId: "meeting-1", deckRevision: 3 };

async function sha256Hex(value: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function base64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

let store: Map<string, unknown>;
beforeEach(() => {
  store = new Map();
  setJourFixeCacheBackend({
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
  });
});
afterEach(() => setJourFixeCacheBackend(null));

async function narrationPort(bytes: Uint8Array<ArrayBuffer>) {
  const requests: CtoxWorkjetProjectControlRequest[] = [];
  const port = async (
    _instance: string,
    request: CtoxWorkjetProjectControlRequest,
  ): Promise<CtoxWorkjetProjectControlResult> => {
    requests.push(request);
    if (request.action !== "project.jour_fixe.narration.read") throw new Error("unexpected");
    const part = bytes.slice(request.offset, request.offset + request.length);
    const response: WorkjetJourFixeNarrationReadResponse = {
      ...request,
      meetingRevision: 9,
      audio: {
        file_id: "retained",
        generation_id: "generation",
        sha256: await sha256Hex(bytes),
        narration_text_sha256: "a".repeat(64),
        mime_type: "audio/wav",
        format: "wav",
        duration_ms: 1000,
        source_run_id: "run",
        model: "grok-4.7",
        synthesis_duration_ms: 1,
        provenance: "native_gateway",
      },
      totalBytes: bytes.length,
      length: part.length,
      bytesBase64: base64(part),
      rangeSha256: await sha256Hex(part),
    };
    return { _tag: "completed", response };
  };
  return { port, requests };
}

describe("Jour fixe durable cache", () => {
  it("serves a slide's narration a second time without any CTOX round trip", async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index);
    const f = await narrationPort(bytes);
    const signal = new AbortController().signal;
    const first = await prepareJourFixeNarration({ scope, slideId: "s1", signal, port: f.port });
    expect(f.requests).toHaveLength(1);
    const second = await prepareJourFixeNarration({ scope, slideId: "s1", signal, port: f.port });
    expect(f.requests).toHaveLength(1);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(
      new Uint8Array(await first.arrayBuffer()),
    );
    // Another deck revision is another narration.
    await prepareJourFixeNarration({
      scope: { ...scope, deckRevision: 4 },
      slideId: "s1",
      signal,
      port: f.port,
    });
    expect(f.requests).toHaveLength(2);
  });

  it("reuses a stored deck only for the same revision and content hash", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(jourFixeDeck));
    const manifest: WorkjetPresentationManifest = {
      presentation_id: "workjet_presentation_1",
      project_id: "project",
      meeting_id: "meeting-1",
      owner_user_id: "owner",
      title: jourFixeDeck.title,
      revision: 2,
      document_schema: "learnordie.slide.v1",
      document_file_id: "workjet_presentation_file",
      document_generation_id: "presentation_generation",
      document_sha256: await sha256Hex(bytes),
      document_bytes: bytes.length,
      slide_ids: jourFixeDeck.slides.map((slide) => slide.id),
      source: "agent",
      updated_by: "supervisor:test",
      updated_at_ms: 1,
    };
    let stored = manifest;
    const calls: string[] = [];
    const port = async (
      _instance: string,
      request: CtoxWorkjetProjectControlRequest,
    ): Promise<CtoxWorkjetProjectControlResult> => {
      calls.push(request.action);
      if (request.action === "project.presentation.read")
        return {
          _tag: "completed",
          response: {
            action: request.action,
            commandId: request.commandId,
            projectId: request.projectId,
            meetingId: request.meetingId,
            contract: "ctox.workjet.presentation.v1",
            presentation: stored,
          },
        };
      if (request.action !== "project.presentation.content.read") throw new Error("unexpected");
      const part = bytes.subarray(request.offset, request.offset + request.length);
      return {
        _tag: "completed",
        response: {
          action: request.action,
          commandId: request.commandId,
          projectId: request.projectId,
          meetingId: request.meetingId,
          range: {
            presentation_id: stored.presentation_id,
            revision: stored.revision,
            offset: request.offset,
            length: part.length,
            total_bytes: stored.document_bytes,
            document_sha256: stored.document_sha256,
            data_base64: base64(part),
          },
          rangeSha256: await sha256Hex(part),
        },
      };
    };
    expect(await readCachedJourFixePresentation(instanceId, projectId, "meeting-1")).toBeNull();
    await readJourFixePresentation(instanceId, projectId, "meeting-1", port);
    const firstReads = calls.filter((a) => a === "project.presentation.content.read").length;
    expect(firstReads).toBeGreaterThan(0);
    const cached = await readCachedJourFixePresentation(instanceId, projectId, "meeting-1");
    expect(cached?.manifest.revision).toBe(2);
    calls.length = 0;
    await readJourFixePresentation(instanceId, projectId, "meeting-1", port);
    expect(calls).toEqual(["project.presentation.read"]);
    stored = { ...manifest, revision: 3 };
    calls.length = 0;
    await readJourFixePresentation(instanceId, projectId, "meeting-1", port);
    expect(calls.filter((a) => a === "project.presentation.content.read").length).toBe(firstReads);
  });

  it("prefetches only meetings near their start", async () => {
    const meeting = {
      id: "meeting-1",
      project_id: "project",
      state: "ready",
      deck_revision: 3,
      scheduled_at_ms: 10 * JOUR_FIXE_PREFETCH_WINDOW_MS,
      slides: [],
    } as unknown as WorkjetJourFixeMeeting;
    await prefetchJourFixeMeeting(instanceId, meeting, 0);
    expect(store.size).toBe(0);
    await prefetchJourFixeMeeting(
      instanceId,
      { ...meeting, state: "planned" },
      meeting.scheduled_at_ms,
    );
    expect(store.size).toBe(0);
  });

  it("treats an unavailable store as a cache miss", async () => {
    setJourFixeCacheBackend({
      get: async () => {
        throw new Error("blocked");
      },
      set: async () => {
        throw new Error("full");
      },
    });
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const f = await narrationPort(bytes);
    const signal = new AbortController().signal;
    await prepareJourFixeNarration({ scope, slideId: "s1", signal, port: f.port });
    await prepareJourFixeNarration({ scope, slideId: "s1", signal, port: f.port });
    expect(f.requests).toHaveLength(2);
  });
});
