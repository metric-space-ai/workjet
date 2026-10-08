import { z } from "zod";

export const CANVAS_VERSION = "learnordie.excalidraw.v1" as const;
export const CANVAS_WIDTH = 1600;
export const CANVAS_HEIGHT = 900;
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_:.~-]+$/);
const coordinate = z.number().finite().min(-100000).max(100000);
const color = z.string().max(40).regex(/^(?:#[\da-fA-F]{3,8}|transparent|[a-zA-Z]{1,24})$/);

// HTML is data, never executable application code. The renderer MUST isolate it
// in an iframe sandbox without allow-scripts or allow-same-origin. Runtime must
// sanitize HTML/CSS and deny network/navigation; schema validation is NOT an HTML sanitizer.
export const canvasEmbedSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("scene3d"), sceneId: z.enum([
    "modell.morph", "modell.miniature", "modell.law", "modell.limits",
    "modell.runtime", "modell.learning", "modell.language", "modell.transfer"
  ]), caption: z.string().max(1000).optional(), accent: z.string().regex(/^#[\da-fA-F]{6}$/).optional() }).strict(),
  z.object({ type: z.literal("html"), html: z.string().max(65536), title: z.string().min(1).max(240) }).strict()
]);
export type CanvasEmbed = z.infer<typeof canvasEmbedSchema>;

// Preserve native Excalidraw fields (bindings, arrows, typography, frames, etc.)
// without accepting non-JSON values, unbounded nesting or prototype keys.
function boundedJson(value: unknown, budget = { nodes: 0 }, depth = 0): boolean {
  if (++budget.nodes > 100000 || depth > 16) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 65536;
  if (Array.isArray(value)) return value.length <= 20000 && value.every((v) => boundedJson(v, budget, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(([key, v]) => !["__proto__", "constructor", "prototype"].includes(key) && boundedJson(v, budget, depth + 1));
}

export const canvasElementSchema = z.object({
  id,
  type: z.enum(["rectangle", "diamond", "ellipse", "line", "arrow", "freedraw", "text", "image", "frame", "magicframe", "embeddable"]),
  x: coordinate, y: coordinate,
  width: z.number().finite().min(0).max(100000), height: z.number().finite().min(0).max(100000),
  angle: z.number().finite().optional(), isDeleted: z.boolean().optional(),
  fontSize: z.number().finite().positive().max(10000).optional(),
  fontFamily: z.number().int().min(1).max(100).optional(),
  lineHeight: z.number().finite().positive().max(100).optional(),
  strokeWidth: z.number().finite().min(0).max(1000).optional(),
  roughness: z.number().finite().min(0).max(10).optional(), opacity: z.number().finite().min(0).max(100).optional(),
  points: z.array(z.tuple([coordinate, coordinate])).max(20000).optional(),
  pressures: z.array(z.number().finite().min(0).max(1)).max(20000).optional(),
  groupIds: z.array(id).max(100).optional(), frameId: id.nullable().optional(),
  boundElements: z.array(z.object({ id, type: z.enum(["text", "arrow"]) }).strict()).max(2000).nullable().optional(),
  text: z.string().max(65536).optional(), originalText: z.string().max(65536).optional(),
  fileId: id.nullable().optional(),
  link: z.string().max(2048).nullable().optional(),
  customData: z.object({ sourceBlockId: id.optional(), sourceAssetId: id.optional(), assetPlaceholder: z.boolean().optional(), learnordie: canvasEmbedSchema.optional() }).catchall(z.unknown()).optional()
}).catchall(z.unknown()).superRefine((element, ctx) => {
  if (!boundedJson(element) || JSON.stringify(element).length > 262144) ctx.addIssue({ code: "custom", message: "Element exceeds bounded native JSON limits." });
  if (element.type === "text" && typeof element.text !== "string") ctx.addIssue({ code: "custom", message: "Native text requires text." });
  if (["line", "arrow", "freedraw"].includes(element.type) && !element.points) ctx.addIssue({ code: "custom", message: "Native linear elements require coordinate points." });
  if (element.type === "embeddable" && !element.customData?.learnordie) ctx.addIssue({ code: "custom", message: "Embeddable requires a Learnordie HTML or 3D payload." });
  if (element.type !== "embeddable" && element.customData?.learnordie) ctx.addIssue({ code: "custom", message: "Embed payload must belong to an embeddable element." });
  if (element.link && !/^https:\/\//i.test(element.link)) ctx.addIssue({ code: "custom", message: "Only HTTPS element links are allowed." });
  if (element.type === "image" && !element.isDeleted && !element.fileId) ctx.addIssue({ code: "custom", message: "Image requires a local file id." });
});
export type CanvasElement = z.infer<typeof canvasElementSchema>;

export function isSafeCanvasImage(dataURL: string, mimeType?: string): boolean {
  if (dataURL.length > 4 * 1024 * 1024) return false;
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataURL);
  if (!match || (mimeType && match[1] !== mimeType) || match[2].length % 4 !== 0) return false;
  try {
    const bytes = atob(match[2].slice(0, 32));
    if (match[1] === "image/png") return bytes.startsWith("\x89PNG\r\n\x1a\n");
    if (match[1] === "image/jpeg") return bytes.startsWith("\xff\xd8\xff");
    if (match[1] === "image/gif") return bytes.startsWith("GIF87a") || bytes.startsWith("GIF89a");
    return bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
  } catch { return false; }
}

const fileSchema = z.object({
  id, dataURL: z.string().max(4 * 1024 * 1024), mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  created: z.number().finite().min(0), lastRetrieved: z.number().finite().min(0).optional(), version: z.number().int().min(0).optional()
}).strict().refine((file) => isSafeCanvasImage(file.dataURL, file.mimeType), "Only matching embedded raster image signatures are accepted.");

export const canvasSceneSchema = z.object({
  version: z.literal(CANVAS_VERSION),
  width: z.number().finite().positive().max(10000), height: z.number().finite().positive().max(10000),
  backgroundColor: color,
  elements: z.array(canvasElementSchema).max(2000),
  files: z.record(id, fileSchema)
}).strict().superRefine((scene, ctx) => {
  const ids = new Set<string>();
  for (const element of scene.elements) {
    if (ids.has(element.id)) ctx.addIssue({ code: "custom", message: `Duplicate element id: ${element.id}` });
    ids.add(element.id);
    if (element.type === "image" && !element.isDeleted && element.fileId && !scene.files[element.fileId]) ctx.addIssue({ code: "custom", message: `Missing image file: ${element.fileId}` });
  }
  for (const [key, file] of Object.entries(scene.files)) {
    if (["__proto__", "constructor", "prototype"].includes(key) || key !== file.id) ctx.addIssue({ code: "custom", message: "File key must match its safe id." });
  }
  if (Object.keys(scene.files).length > 100 || JSON.stringify(scene.files).length > 8 * 1024 * 1024 || JSON.stringify(scene.elements).length > 2 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "Scene exceeds file or element budget." });
});
export type CanvasScene = z.infer<typeof canvasSceneSchema>;
