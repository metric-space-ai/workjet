// Workjet fork delta: the request/response protocol of the bundled slide-engine validator.
// CTOX runs it as `node slide-engine-validator.mjs` (one JSON request on stdin, one JSON
// response on stdout); Workjet can call `handleValidatorRequest` in process.
import {
  AGENTIC_SLIDE_EDIT_CONTRACT,
  applySlideDocumentEdits,
  type SlideDocumentEditOperation,
} from "../editing";
import { canvasSceneForSlide, updateSlideCanvas } from "../excalidraw/scene";
import { meetingSlides, slideDocumentOutline } from "../meeting";
import {
  repairIssuesFromZodIssues,
  SlideDocumentValidationError,
  validateSlideDocument,
  type SlideDocument,
  type SlideDocumentValidationIssue,
} from "../schema";
import type { CanvasScene } from "../excalidraw/canvas-schema";

/** Requests larger than this many bytes are rejected before parsing. */
export const VALIDATOR_MAX_INPUT_BYTES = 24 * 1024 * 1024;

export const validatorOps = [
  "validate",
  "applyEdits",
  "updateCanvas",
  "canvasForSlide",
  "outline",
  "meetingSlides",
] as const;
export type ValidatorOp = (typeof validatorOps)[number];

export type ValidatorOutcome =
  | { exitCode: 0; response: Record<string, unknown> }
  | { exitCode: 2; error: string };

type Fields = Record<string, unknown>;

/**
 * Exit code 0 for every well-formed request, including `ok: false` answers. Exit code 2 for a
 * request that is not an object, names an unknown op or lacks a required field.
 */
export function handleValidatorRequest(request: unknown): ValidatorOutcome {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return malformed("request must be a JSON object");
  }
  const fields = request as Fields;
  const op = fields.op;
  if (typeof op !== "string") return malformed('request needs a string "op"');
  if (!(validatorOps as readonly string[]).includes(op)) {
    return malformed(`unknown op "${op}"; expected one of ${validatorOps.join(", ")}`);
  }
  if (!("document" in fields)) return malformed(`op "${op}" needs "document"`);
  const missing = requiredFields[op as ValidatorOp].find(([name, check]) => !check(fields[name]));
  if (missing) return malformed(`op "${op}" needs "${missing[0]}" (${missing[2]})`);
  try {
    return { exitCode: 0, response: runOp(op as ValidatorOp, fields) };
  } catch (error) {
    return {
      exitCode: 0,
      response: {
        ok: false,
        issues: [
          plainIssue(
            "validator.internal_error",
            errorMessage(error),
            "Report this request; the validator failed unexpectedly.",
          ),
        ],
      },
    };
  }
}

const isString = (value: unknown) => typeof value === "string";
const isPresent = (value: unknown) => value !== undefined;

const requiredFields: Record<
  ValidatorOp,
  Array<[name: string, check: (value: unknown) => boolean, expected: string]>
> = {
  validate: [],
  applyEdits: [["operations", Array.isArray, "an array of edit operations"]],
  updateCanvas: [
    ["slideId", isString, "a string"],
    ["scene", isPresent, "a canvas scene"],
  ],
  canvasForSlide: [["slideId", isString, "a string"]],
  outline: [],
  meetingSlides: [],
};

function runOp(op: ValidatorOp, fields: Fields): Record<string, unknown> {
  if (op === "validate") {
    const result = validateSlideDocument(fields.document);
    return {
      ok: result.ok,
      issues: result.issues.filter((issue) => issue.severity === "error"),
      warnings: result.issues.filter((issue) => issue.severity === "warning"),
    };
  }
  if (op === "applyEdits") return applyEdits(fields.document, fields.operations as unknown[]);

  const validation = validateSlideDocument(fields.document);
  if (!validation.ok) return { ok: false, issues: validation.issues };
  const document = validation.document;

  switch (op) {
    case "updateCanvas":
      return updateCanvas(document, fields.slideId as string, fields.scene);
    case "canvasForSlide": {
      const slide = document.slides.find((candidate) => candidate.id === fields.slideId);
      if (!slide) return { ok: false, issues: [missingSlideIssue(fields.slideId as string)] };
      return { ok: true, scene: canvasSceneForSlide(slide, document.assets) };
    }
    case "outline":
      return { ok: true, ...slideDocumentOutline(document) };
    case "meetingSlides":
      return { ok: true, slides: meetingSlides(document) };
  }
}

const knownOperationKinds = new Set<string>(AGENTIC_SLIDE_EDIT_CONTRACT.operationKinds);

function applyEdits(document: unknown, operations: unknown[]): Record<string, unknown> {
  // applySlideDocumentEdits trusts its operation types; reject what JSON can smuggle past them.
  for (const [index, operation] of operations.entries()) {
    const kind =
      typeof operation === "object" && operation !== null && !Array.isArray(operation)
        ? (operation as Fields).kind
        : undefined;
    if (typeof kind === "string" && knownOperationKinds.has(kind)) continue;
    const operationId =
      typeof (operation as Fields | null)?.operationId === "string"
        ? ((operation as Fields).operationId as string)
        : `operations[${index}]`;
    return {
      ok: false,
      appliedOperations: [],
      rejectedOperation: operationId,
      issues: [
        plainIssue(
          "edit.unknown_operation",
          `Operation ${index} has no known kind (received ${JSON.stringify(kind ?? null)}).`,
          `Use one of: ${AGENTIC_SLIDE_EDIT_CONTRACT.operationKinds.join(", ")}.`,
          ["operations", index, "kind"],
        ),
      ],
    };
  }
  try {
    return applySlideDocumentEdits(
      document as SlideDocument,
      operations as SlideDocumentEditOperation[],
    );
  } catch (error) {
    return {
      ok: false,
      appliedOperations: [],
      issues: [
        plainIssue(
          "edit.invalid_operation",
          errorMessage(error),
          "Check the fields of each operation against the edit contract.",
          ["operations"],
        ),
      ],
    };
  }
}

function updateCanvas(
  document: SlideDocument,
  slideId: string,
  scene: unknown,
): Record<string, unknown> {
  const slideIndex = document.slides.findIndex((slide) => slide.id === slideId);
  if (slideIndex < 0) return { ok: false, issues: [missingSlideIssue(slideId)] };
  try {
    const updated = updateSlideCanvas(document, slideId, scene as CanvasScene);
    return { ok: true, document: updated, issues: validateSlideDocument(updated).issues };
  } catch (error) {
    if (error instanceof SlideDocumentValidationError) return { ok: false, issues: error.issues };
    if (isZodError(error)) {
      return {
        ok: false,
        issues: repairIssuesFromZodIssues(error.issues, {
          code: "canvas.invalid",
          pathPrefix: ["slides", slideIndex, "canvas"],
          slideId,
        }),
      };
    }
    return {
      ok: false,
      issues: [
        {
          ...plainIssue(
            "canvas.invalid",
            errorMessage(error),
            "Send a complete learnordie.excalidraw.v1 scene.",
            ["slides", slideIndex, "canvas"],
          ),
          slideId,
        },
      ],
    };
  }
}

function isZodError(
  error: unknown,
): error is { issues: Parameters<typeof repairIssuesFromZodIssues>[0] } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

function missingSlideIssue(slideId: string): SlideDocumentValidationIssue {
  return {
    ...plainIssue(
      "edit.slide_missing",
      `Slide "${slideId}" was not found.`,
      "Use a slideId that exists in the current SlideDocument.",
      ["slides"],
    ),
    slideId,
  };
}

function plainIssue(
  code: string,
  message: string,
  repairHint: string,
  pathSegments: Array<string | number> = [],
): SlideDocumentValidationIssue {
  return {
    severity: "error",
    code,
    message,
    path: pathString(pathSegments),
    pathSegments,
    repairHint,
  };
}

function pathString(pathSegments: Array<string | number>): string {
  return pathSegments.reduce<string>(
    (path, segment) => (typeof segment === "number" ? `${path}[${segment}]` : `${path}.${segment}`),
    "$",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function malformed(error: string): ValidatorOutcome {
  return { exitCode: 2, error };
}
