import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResponse,
} from "./ctox.ts";
import { isWorkjetPresentationReceiptForRequest } from "./workjetPresentation.ts";

const sha = "a".repeat(64);
const manifest = {
  presentation_id: "workjet_presentation_1",
  project_id: "project",
  meeting_id: "meeting-1",
  owner_user_id: "owner",
  title: "Regeltermin",
  revision: 3,
  document_schema: "learnordie.slide.v1",
  document_file_id: "file",
  document_generation_id: "generation",
  document_sha256: sha,
  document_bytes: 1200,
  slide_ids: ["titel", "kennzahlen"],
  source: "owner",
  updated_by: "owner",
  updated_at_ms: 1,
};
const scope = { commandId: "command-1", projectId: "project", meetingId: "meeting-1" };
const save = {
  action: "project.presentation.canvas.save",
  ...scope,
  operationId: "operation-1",
  presentationId: "workjet_presentation_1",
  expectedRevision: 2,
  slideId: "kennzahlen",
  sceneJson: '{"version":"learnordie.excalidraw.v1"}',
};
const saved = {
  action: "project.presentation.canvas.save",
  ...scope,
  contract: "ctox.workjet.presentation.v1",
  mutation: {
    operation_id: "operation-1",
    presentation_id: "workjet_presentation_1",
    project_id: "project",
    meeting_id: "meeting-1",
    revision: 3,
    document_sha256: sha,
    document_bytes: 1200,
    slide_ids: ["titel", "kennzahlen"],
  },
  presentation: manifest,
};
const content = {
  action: "project.presentation.content.read",
  ...scope,
  presentationId: "workjet_presentation_1",
  revision: 3,
  offset: 1024,
  length: 4096,
};
const range = {
  action: "project.presentation.content.read",
  ...scope,
  range: {
    presentation_id: "workjet_presentation_1",
    revision: 3,
    offset: 1024,
    length: 176,
    total_bytes: 1200,
    document_sha256: sha,
    data_base64: "eyJ9",
  },
  rangeSha256: sha,
};

describe("Workjet presentation contract", () => {
  it("is part of the project control unions with strict decoding", () => {
    const decodeRequest = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, {
      onExcessProperty: "error",
    });
    const decodeResponse = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
      onExcessProperty: "error",
    });
    expect(decodeRequest(save).action).toBe("project.presentation.canvas.save");
    expect(decodeResponse(saved).action).toBe("project.presentation.canvas.save");
    expect(() => decodeRequest({ ...save, scene: {} })).toThrow();
    expect(() => decodeRequest({ ...content, length: 128 * 1024 + 1 })).toThrow();
  });

  it("accepts only receipts that answer the exact request", () => {
    expect(isWorkjetPresentationReceiptForRequest(save, saved)).toBe(true);
    expect(
      isWorkjetPresentationReceiptForRequest(save, {
        ...saved,
        mutation: { ...saved.mutation, revision: 4 },
      }),
    ).toBe(false);
    expect(
      isWorkjetPresentationReceiptForRequest(save, {
        ...saved,
        mutation: { ...saved.mutation, operation_id: "other" },
      }),
    ).toBe(false);
    expect(isWorkjetPresentationReceiptForRequest(content, range)).toBe(true);
    expect(
      isWorkjetPresentationReceiptForRequest(content, {
        ...range,
        range: { ...range.range, revision: 4 },
      }),
    ).toBe(false);
    expect(
      isWorkjetPresentationReceiptForRequest(
        { action: "project.presentation.read", ...scope },
        {
          action: "project.presentation.read",
          ...scope,
          contract: "ctox.workjet.presentation.v1",
          presentation: { ...manifest, meeting_id: "other" },
        },
      ),
    ).toBe(false);
  });

  it("leaves every other project action to its own receipt check", () => {
    expect(
      isWorkjetPresentationReceiptForRequest(
        { action: "project.kpis.read", commandId: "c", projectId: "p" },
        {},
      ),
    ).toBe(true);
  });
});
