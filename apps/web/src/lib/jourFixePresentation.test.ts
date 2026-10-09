import { describe, expect, it } from "vite-plus/test";
import type {
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResult,
  ProjectId,
  WorkjetPresentationManifest,
} from "@workjet/contracts";
import { jourFixeDeck } from "@workjet/slide-engine/fixtures/jour-fixe-deck";
import {
  presentationSaveOperationId,
  readJourFixePresentation,
  saveJourFixePresentationCanvas,
  saveJourFixePresentationSlide,
} from "./jourFixePresentation";

const projectId = "project" as ProjectId;
const bytes = new TextEncoder().encode(JSON.stringify(jourFixeDeck));

async function sha256Hex(value: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function base64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function manifest(): Promise<WorkjetPresentationManifest> {
  return {
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
}

function control(stored: WorkjetPresentationManifest, served: Uint8Array<ArrayBuffer> = bytes) {
  const calls: CtoxWorkjetProjectControlRequest[] = [];
  const port = async (
    _instance: string,
    request: CtoxWorkjetProjectControlRequest,
  ): Promise<CtoxWorkjetProjectControlResult> => {
    calls.push(request);
    if (request.action === "project.presentation.read") {
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
    }
    if (request.action === "project.presentation.content.read") {
      const part = served.subarray(request.offset, request.offset + request.length);
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
    }
    if (request.action === "project.presentation.canvas.save") {
      const next = { ...stored, revision: stored.revision + 1, source: "owner" as const };
      return {
        _tag: "completed",
        response: {
          action: request.action,
          commandId: request.commandId,
          projectId: request.projectId,
          meetingId: request.meetingId,
          contract: "ctox.workjet.presentation.v1",
          mutation: {
            operation_id: request.operationId,
            presentation_id: request.presentationId,
            project_id: request.projectId,
            meeting_id: request.meetingId,
            revision: request.expectedRevision + 1,
            document_sha256: next.document_sha256,
            document_bytes: next.document_bytes,
            slide_ids: next.slide_ids,
          },
          presentation: next,
        },
      };
    }
    return { _tag: "failed", code: "unsupported" };
  };
  return {
    port: port as typeof import("../workjetProjectControl").requestWorkjetProjectControl,
    calls,
  };
}

describe("Jour fixe presentation transport", () => {
  it("assembles the stored revision from bounded ranges and validates it", async () => {
    const stored = await manifest();
    const { port, calls } = control(stored);
    const result = await readJourFixePresentation("instance", projectId, "meeting-1", port);
    expect(result?.manifest.revision).toBe(2);
    expect(result?.document.slides.map((slide) => slide.id)).toEqual(stored.slide_ids);
    expect(calls[0]?.action).toBe("project.presentation.read");
    expect(
      calls.slice(1).every((call) => call.action === "project.presentation.content.read"),
    ).toBe(true);
  });

  it("rejects bytes that do not match the manifest hash", async () => {
    const stored = await manifest();
    const tampered = new Uint8Array(bytes);
    tampered[10] = tampered[10] === 32 ? 33 : 32;
    const { port } = control(stored, tampered);
    await expect(
      readJourFixePresentation("instance", projectId, "meeting-1", port),
    ).rejects.toThrow(/hash/);
  });

  it("returns null when the meeting has no presentation", async () => {
    const stored = await manifest();
    const { port } = control(stored);
    const empty = (async (instance: string, request: CtoxWorkjetProjectControlRequest) => {
      const answer = await port(instance, request);
      if (answer._tag === "completed" && answer.response.action === "project.presentation.read")
        return { ...answer, response: { ...answer.response, presentation: null } };
      return answer;
    }) as typeof port;
    await expect(readJourFixePresentation("instance", projectId, "meeting-1", empty)).resolves.toBe(
      null,
    );
  });

  it("saves one slide canvas against the revision it was edited from", async () => {
    const stored = await manifest();
    const { port, calls } = control(stored);
    const scene = {
      version: "learnordie.excalidraw.v1" as const,
      width: 1600,
      height: 900,
      backgroundColor: "#fffef8",
      elements: [],
      files: {},
    };
    const saved = await saveJourFixePresentationCanvas(
      "instance",
      projectId,
      stored,
      stored.slide_ids[0] ?? "titel",
      scene,
      port,
      "operation-1",
    );
    expect(saved.mutation.revision).toBe(3);
    expect(saved.manifest.revision).toBe(3);
    const request = calls.at(-1);
    expect(request?.action === "project.presentation.canvas.save" && request.expectedRevision).toBe(
      2,
    );
  });
  it("gives a retried save of the same scene the same operation id", async () => {
    const stored = await manifest();
    const first = await presentationSaveOperationId(stored, "titel", '{"elements":[]}');
    const again = await presentationSaveOperationId(stored, "titel", '{"elements":[]}');
    const other = await presentationSaveOperationId(stored, "titel", '{"elements":[1]}');
    const newer = await presentationSaveOperationId(
      { ...stored, revision: stored.revision + 1 },
      "titel",
      '{"elements":[]}',
    );
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(newer).not.toBe(first);
  });
});

describe("the room's confirmed presentation-save workflow", () => {
  const scene = {
    version: "learnordie.excalidraw.v1" as const,
    width: 1600,
    height: 900,
    backgroundColor: "#fffef8",
    elements: [],
    files: {},
  };

  it("replays a committed save with a lost reply without rebasing or writing twice", async () => {
    const base = await manifest();
    const next = { ...base, revision: base.revision + 1, source: "owner" as const };
    const server = control(base);
    const reads = control(next);
    let writes = 0;
    let retained: Extract<CtoxWorkjetProjectControlRequest, { action: "project.presentation.canvas.save" }> | undefined;
    const requests: CtoxWorkjetProjectControlRequest[] = [];
    const port: typeof server.port = async (instance, request) => {
      requests.push(request);
      if (request.action !== "project.presentation.canvas.save") return reads.port(instance, request);
      if (!retained) {
        retained = request;
        writes += 1;
        // The server committed the operation, but the reply was lost.
        return { _tag: "failed", code: "timeout" };
      }
      expect(request.operationId).toBe(retained.operationId);
      expect(request.expectedRevision).toBe(retained.expectedRevision);
      expect(request.sceneJson).toBe(retained.sceneJson);
      return server.port(instance, request);
    };
    await expect(saveJourFixePresentationSlide("instance", projectId, base, "titel", scene, port))
      .rejects.toThrow("timeout");
    expect(requests.map((request) => request.action)).toEqual(["project.presentation.canvas.save"]);
    const retried = await saveJourFixePresentationSlide("instance", projectId, base, "titel", scene, port);
    expect(retried.presentation?.manifest.revision).toBe(3);
    expect(retried.reloadError).toBeNull();
    expect(writes).toBe(1);
    expect(requests.filter((request) => request.action === "project.presentation.canvas.save")).toHaveLength(2);
  });

  it("never turns a concurrent-revision rejection into a mutation on the refreshed slide", async () => {
    const base = await manifest();
    const requests: CtoxWorkjetProjectControlRequest[] = [];
    const port: ReturnType<typeof control>["port"] = async (_instance, request) => {
      requests.push(request);
      return { _tag: "failed", code: "guest_failed" };
    };
    await expect(saveJourFixePresentationSlide("instance", projectId, base, "titel", scene, port))
      .rejects.toThrow("guest_failed");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.action === "project.presentation.canvas.save" && requests[0].expectedRevision).toBe(base.revision);
  });

  it("keeps a confirmed receipt when the subsequent read is unavailable", async () => {
    const base = await manifest();
    const server = control(base);
    const port: typeof server.port = async (instance, request) =>
      request.action === "project.presentation.canvas.save"
        ? server.port(instance, request)
        : { _tag: "failed", code: "not_active" };
    const saved = await saveJourFixePresentationSlide("instance", projectId, base, "titel", scene, port);
    expect(saved.presentation).toBeNull();
    expect(saved.reloadError).toContain("The slide is saved");
    expect(saved.reloadError).toContain("not_active");
    expect(server.calls).toHaveLength(1);
  });
});
