import {
  SLIDE_DOCUMENT_SCHEMA_VERSION,
  validateSlideDocument,
  type QuestionLevel,
  type SlideAssetRef,
  type SlideBlock,
  type SlideDocument,
  type SlideDocumentValidationIssue,
  type SlideNode,
  type SpeakerNote
} from "./schema";

export type SlideDocumentEditActor = "agent" | "manual" | "import" | "system";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type DistributivePartial<T> = T extends unknown ? Partial<T> : never;

export type SlideBlockPatch = DistributivePartial<DistributiveOmit<SlideBlock, "id" | "type">> & Record<string, unknown>;

export type SlideDocumentEditContext = {
  actor?: SlideDocumentEditActor;
  reason?: string;
  source?: string;
};

export type SlideDocumentEditOperationBase = {
  operationId?: string;
  context?: SlideDocumentEditContext;
};

export type SlideDocumentEditOperation =
  | (SlideDocumentEditOperationBase & {
      kind: "updateDocument";
      patch: Partial<Pick<SlideDocument, "title" | "language" | "aspect" | "theme" | "deckSettings" | "createdBy">>;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "insertSlide";
      slide: SlideNode;
      index?: number;
      beforeSlideId?: string;
      afterSlideId?: string;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "updateSlide";
      slideId: string;
      patch: Partial<Pick<SlideNode, "title" | "layout" | "intent" | "sourceRefs" | "speakerNotes" | "quizAnchors">>;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "deleteSlide";
      slideId: string;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "moveSlide";
      slideId: string;
      index?: number;
      beforeSlideId?: string;
      afterSlideId?: string;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "insertBlock";
      slideId: string;
      block: SlideBlock;
      index?: number;
      beforeBlockId?: string;
      afterBlockId?: string;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "patchBlock";
      slideId: string;
      blockId: string;
      patch: SlideBlockPatch;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "replaceBlock";
      slideId: string;
      blockId: string;
      block: SlideBlock;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "deleteBlock";
      slideId: string;
      blockId: string;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "moveBlock";
      slideId: string;
      blockId: string;
      index?: number;
      beforeBlockId?: string;
      afterBlockId?: string;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "upsertAsset";
      asset: SlideAssetRef;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "deleteAsset";
      assetId: string;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "upsertSpeakerNote";
      slideId: string;
      note: SpeakerNote;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "deleteSpeakerNote";
      slideId: string;
      noteId: string;
    })
  | (SlideDocumentEditOperationBase & {
      kind: "upsertQuizAnchor";
      slideId: string;
      anchor: {
        id: string;
        level: QuestionLevel;
        blockId: string;
        label?: string;
      };
    })
  | (SlideDocumentEditOperationBase & {
      kind: "deleteQuizAnchor";
      slideId: string;
      anchorId: string;
    });

export type SlideDocumentEditResult =
  | {
      ok: true;
      document: SlideDocument;
      appliedOperations: string[];
      issues: SlideDocumentValidationIssue[];
    }
  | {
      ok: false;
      document?: SlideDocument;
      appliedOperations: string[];
      rejectedOperation?: string;
      issues: SlideDocumentValidationIssue[];
    };

export type SlideDocumentEditSummary = {
  slideCount: number;
  assetCount: number;
  blockCount: number;
  quizAnchorCount: number;
  speakerNoteCount: number;
};

export function applySlideDocumentEdits(
  document: SlideDocument,
  operations: SlideDocumentEditOperation[]
): SlideDocumentEditResult {
  const inputValidation = validateSlideDocument(document);
  if (!inputValidation.ok) {
    return {
      ok: false,
      appliedOperations: [],
      issues: inputValidation.issues
    };
  }

  const draft = cloneSlideDocument(inputValidation.document);
  const appliedOperations: string[] = [];

  for (const operation of operations) {
    const operationId = operation.operationId ?? operation.kind;
    const preconditionIssue = applyEditOperation(draft, operation);
    if (preconditionIssue) {
      return {
        ok: false,
        appliedOperations,
        rejectedOperation: operationId,
        issues: [preconditionIssue]
      };
    }
    appliedOperations.push(operationId);
  }

  const validation = validateSlideDocument(draft);
  if (!validation.ok) {
    return {
      ok: false,
      document: validation.document ?? draft,
      appliedOperations,
      issues: validation.issues
    };
  }

  return {
    ok: true,
    document: validation.document,
    appliedOperations,
    issues: validation.issues
  };
}

export function summarizeSlideDocumentForEditing(document: SlideDocument): SlideDocumentEditSummary {
  return {
    slideCount: document.slides.length,
    assetCount: document.assets.length,
    blockCount: document.slides.reduce((sum, slide) => sum + slide.blocks.length, 0),
    quizAnchorCount: document.slides.reduce((sum, slide) => sum + (slide.quizAnchors?.length ?? 0), 0),
    speakerNoteCount: document.slides.reduce((sum, slide) => sum + (slide.speakerNotes?.length ?? 0), 0)
  };
}

function applyEditOperation(
  document: SlideDocument,
  operation: SlideDocumentEditOperation
): SlideDocumentValidationIssue | null {
  const target = "slideId" in operation ? document.slides.find((slide) => slide.id === operation.slideId) : undefined;
  const changesCanvasSource = ["insertBlock", "patchBlock", "replaceBlock", "deleteBlock", "moveBlock"].includes(operation.kind)
    || (operation.kind === "updateSlide" && ["title", "layout"].some((key) => key in operation.patch));
  const changesCanvasAsset = (operation.kind === "upsertAsset" || operation.kind === "deleteAsset") && document.slides.some((slide) => slide.canvas && slide.blocks.some((block) => "assetId" in block && block.assetId === (operation.kind === "upsertAsset" ? operation.asset.id : operation.assetId)));
  if ((target?.canvas && changesCanvasSource) || changesCanvasAsset) {
    return editIssue(operation, "edit.canvas_authoritative", "This slide has a native Excalidraw scene. Block/asset edits cannot replace its visible content.", ["slides"], "Edit the native scene and save it with updateSlideCanvas; metadata, notes and quiz anchors remain editable.");
  }
  switch (operation.kind) {
    case "updateDocument":
      Object.assign(document, operation.patch);
      return null;
    case "insertSlide":
      return insertSlide(document, operation);
    case "updateSlide":
      return updateSlide(document, operation.slideId, operation.patch, operation);
    case "deleteSlide":
      return deleteSlide(document, operation.slideId, operation);
    case "moveSlide":
      return moveSlide(document, operation);
    case "insertBlock":
      return insertBlock(document, operation);
    case "patchBlock":
      return patchBlock(document, operation);
    case "replaceBlock":
      return replaceBlock(document, operation);
    case "deleteBlock":
      return deleteBlock(document, operation);
    case "moveBlock":
      return moveBlock(document, operation);
    case "upsertAsset":
      document.assets = upsertById(document.assets, operation.asset);
      return null;
    case "deleteAsset":
      document.assets = document.assets.filter((asset) => asset.id !== operation.assetId);
      return null;
    case "upsertSpeakerNote":
      return upsertSpeakerNote(document, operation);
    case "deleteSpeakerNote":
      return deleteSpeakerNote(document, operation);
    case "upsertQuizAnchor":
      return upsertQuizAnchor(document, operation);
    case "deleteQuizAnchor":
      return deleteQuizAnchor(document, operation);
  }
}

function insertSlide(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "insertSlide" }>
) {
  const index = insertionIndex(document.slides, operation, "slideId");
  if (index instanceof Error) {
    return editIssue(operation, "edit.slide_anchor_missing", index.message, ["slides"], "Use an existing slide id as beforeSlideId/afterSlideId or provide a numeric index.");
  }
  document.slides.splice(index, 0, operation.slide);
  return null;
}

function updateSlide(
  document: SlideDocument,
  slideId: string,
  patch: Partial<Pick<SlideNode, "title" | "layout" | "intent" | "sourceRefs" | "speakerNotes" | "quizAnchors">>,
  operation: SlideDocumentEditOperation
) {
  const slide = findSlide(document, slideId);
  if (!slide) return missingSlideIssue(operation, slideId);
  Object.assign(slide, patch);
  return null;
}

function deleteSlide(document: SlideDocument, slideId: string, operation: SlideDocumentEditOperation) {
  const index = document.slides.findIndex((slide) => slide.id === slideId);
  if (index < 0) return missingSlideIssue(operation, slideId);
  document.slides.splice(index, 1);
  return null;
}

function moveSlide(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "moveSlide" }>
) {
  const currentIndex = document.slides.findIndex((slide) => slide.id === operation.slideId);
  if (currentIndex < 0) return missingSlideIssue(operation, operation.slideId);
  const [slide] = document.slides.splice(currentIndex, 1);
  const targetIndex = insertionIndex(document.slides, operation, "slideId");
  if (targetIndex instanceof Error) {
    document.slides.splice(currentIndex, 0, slide);
    return editIssue(operation, "edit.slide_anchor_missing", targetIndex.message, ["slides"], "Use an existing slide id as beforeSlideId/afterSlideId or provide a numeric index.");
  }
  document.slides.splice(targetIndex, 0, slide);
  return null;
}

function insertBlock(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "insertBlock" }>
) {
  const slide = findSlide(document, operation.slideId);
  if (!slide) return missingSlideIssue(operation, operation.slideId);
  const index = insertionIndex(slide.blocks, operation, "blockId");
  if (index instanceof Error) {
    return editIssue(operation, "edit.block_anchor_missing", index.message, ["slides", operation.slideId, "blocks"], "Use an existing block id as beforeBlockId/afterBlockId or provide a numeric index.");
  }
  slide.blocks.splice(index, 0, operation.block);
  return null;
}

function patchBlock(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "patchBlock" }>
) {
  const slide = findSlide(document, operation.slideId);
  if (!slide) return missingSlideIssue(operation, operation.slideId);
  const block = slide.blocks.find((candidate) => candidate.id === operation.blockId);
  if (!block) return missingBlockIssue(operation, operation.slideId, operation.blockId);
  Object.assign(block, operation.patch);
  return null;
}

function replaceBlock(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "replaceBlock" }>
) {
  if (operation.block.id !== operation.blockId) {
    return editIssue(operation, "edit.block_id_mismatch", `Replacement block id "${operation.block.id}" does not match target block "${operation.blockId}".`, ["slides", operation.slideId, "blocks"], "Keep block.id equal to blockId so notes, anchors and repair patches remain stable.");
  }
  const slide = findSlide(document, operation.slideId);
  if (!slide) return missingSlideIssue(operation, operation.slideId);
  const index = slide.blocks.findIndex((block) => block.id === operation.blockId);
  if (index < 0) return missingBlockIssue(operation, operation.slideId, operation.blockId);
  slide.blocks[index] = operation.block;
  return null;
}

function deleteBlock(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "deleteBlock" }>
) {
  const slide = findSlide(document, operation.slideId);
  if (!slide) return missingSlideIssue(operation, operation.slideId);
  const index = slide.blocks.findIndex((block) => block.id === operation.blockId);
  if (index < 0) return missingBlockIssue(operation, operation.slideId, operation.blockId);
  slide.blocks.splice(index, 1);
  return null;
}

function moveBlock(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "moveBlock" }>
) {
  const slide = findSlide(document, operation.slideId);
  if (!slide) return missingSlideIssue(operation, operation.slideId);
  const currentIndex = slide.blocks.findIndex((block) => block.id === operation.blockId);
  if (currentIndex < 0) return missingBlockIssue(operation, operation.slideId, operation.blockId);
  const [block] = slide.blocks.splice(currentIndex, 1);
  const targetIndex = insertionIndex(slide.blocks, operation, "blockId");
  if (targetIndex instanceof Error) {
    slide.blocks.splice(currentIndex, 0, block);
    return editIssue(operation, "edit.block_anchor_missing", targetIndex.message, ["slides", operation.slideId, "blocks"], "Use an existing block id as beforeBlockId/afterBlockId or provide a numeric index.");
  }
  slide.blocks.splice(targetIndex, 0, block);
  return null;
}

function upsertSpeakerNote(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "upsertSpeakerNote" }>
) {
  const slide = findSlide(document, operation.slideId);
  if (!slide) return missingSlideIssue(operation, operation.slideId);
  slide.speakerNotes = upsertById(slide.speakerNotes ?? [], operation.note);
  return null;
}

function deleteSpeakerNote(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "deleteSpeakerNote" }>
) {
  const slide = findSlide(document, operation.slideId);
  if (!slide) return missingSlideIssue(operation, operation.slideId);
  slide.speakerNotes = (slide.speakerNotes ?? []).filter((note) => note.id !== operation.noteId);
  return null;
}

function upsertQuizAnchor(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "upsertQuizAnchor" }>
) {
  const slide = findSlide(document, operation.slideId);
  if (!slide) return missingSlideIssue(operation, operation.slideId);
  slide.quizAnchors = upsertById(slide.quizAnchors ?? [], operation.anchor);
  return null;
}

function deleteQuizAnchor(
  document: SlideDocument,
  operation: Extract<SlideDocumentEditOperation, { kind: "deleteQuizAnchor" }>
) {
  const slide = findSlide(document, operation.slideId);
  if (!slide) return missingSlideIssue(operation, operation.slideId);
  slide.quizAnchors = (slide.quizAnchors ?? []).filter((anchor) => anchor.id !== operation.anchorId);
  return null;
}

function findSlide(document: SlideDocument, slideId: string) {
  return document.slides.find((slide) => slide.id === slideId);
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function insertionIndex<T extends { id: string }>(
  items: T[],
  operation: { index?: number; beforeSlideId?: string; afterSlideId?: string; beforeBlockId?: string; afterBlockId?: string },
  idKind: "slideId" | "blockId"
) {
  if (typeof operation.index === "number") {
    return clampIndex(operation.index, items.length);
  }

  const beforeId = idKind === "slideId" ? operation.beforeSlideId : operation.beforeBlockId;
  if (beforeId) {
    const index = items.findIndex((item) => item.id === beforeId);
    return index < 0 ? new Error(`Anchor id "${beforeId}" was not found.`) : index;
  }

  const afterId = idKind === "slideId" ? operation.afterSlideId : operation.afterBlockId;
  if (afterId) {
    const index = items.findIndex((item) => item.id === afterId);
    return index < 0 ? new Error(`Anchor id "${afterId}" was not found.`) : index + 1;
  }

  return items.length;
}

function clampIndex(index: number, length: number) {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(Math.trunc(index), length));
}

function missingSlideIssue(operation: SlideDocumentEditOperation, slideId: string) {
  return editIssue(operation, "edit.slide_missing", `Slide "${slideId}" was not found.`, ["slides"], "Use a slideId that exists in the current SlideDocument.");
}

function missingBlockIssue(operation: SlideDocumentEditOperation, slideId: string, blockId: string) {
  return editIssue(operation, "edit.block_missing", `Block "${blockId}" was not found on slide "${slideId}".`, ["slides", slideId, "blocks"], "Use a blockId that exists on the target slide.");
}

function editIssue(
  operation: SlideDocumentEditOperation,
  code: string,
  message: string,
  pathSegments: Array<string | number>,
  repairHint: string
): SlideDocumentValidationIssue {
  return {
    severity: "error",
    code,
    message,
    path: pathSegments.map(String).join("."),
    pathSegments,
    repairHint,
    slideId: "slideId" in operation ? operation.slideId : undefined,
    blockId: "blockId" in operation ? operation.blockId : undefined,
    assetId: "assetId" in operation ? operation.assetId : undefined,
    expected: operation.operationId,
    received: operation.kind
  };
}

function cloneSlideDocument(document: SlideDocument): SlideDocument {
  return JSON.parse(JSON.stringify(document)) as SlideDocument;
}

export type AgenticSlideEditContract = {
  schemaVersion: typeof SLIDE_DOCUMENT_SCHEMA_VERSION;
  operationKinds: SlideDocumentEditOperation["kind"][];
  stableTargets: Array<"document" | "slideId" | "blockId" | "assetId" | "noteId" | "anchorId">;
  guarantee: "Every edit batch is schema-validated before it can be accepted.";
};

export const AGENTIC_SLIDE_EDIT_CONTRACT: AgenticSlideEditContract = {
  schemaVersion: SLIDE_DOCUMENT_SCHEMA_VERSION,
  operationKinds: [
    "updateDocument",
    "insertSlide",
    "updateSlide",
    "deleteSlide",
    "moveSlide",
    "insertBlock",
    "patchBlock",
    "replaceBlock",
    "deleteBlock",
    "moveBlock",
    "upsertAsset",
    "deleteAsset",
    "upsertSpeakerNote",
    "deleteSpeakerNote",
    "upsertQuizAnchor",
    "deleteQuizAnchor"
  ],
  stableTargets: ["document", "slideId", "blockId", "assetId", "noteId", "anchorId"],
  guarantee: "Every edit batch is schema-validated before it can be accepted."
};
