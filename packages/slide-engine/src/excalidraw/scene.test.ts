import assert from "node:assert/strict";
import test from "node:test";
import { legacySlidesToSlideDocument, slideDocumentToLegacySlides } from "../legacy";
import { applySlideDocumentEdits } from "../editing";
import { parseSlideDocument, type SlideBlock } from "../schema";
import { allBlockTypesSlideDocument } from "../fixtures";
import { canvasSceneSchema, isSafeCanvasImage, type CanvasElement } from "./canvas-schema";
import { canvasSceneForSlide, updateSlideCanvas } from "./scene";
import { hasEngineOnlyBlocks, mergeLegacySlideEditsIntoDocument, normalizeLectureSlideDocument } from "../../../../src/lib/slide-documents";

function fixture() {
  return legacySlidesToSlideDocument([{ id: "slide-one", title: "Die Welle", eyebrow: "Einführung", topic: "Lager", copy: ["Originaltext mit Umlauten äöü"], diagram: "bearing" }]);
}
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test("empty editor draft text does not crash legacy-to-native conversion", () => {
  const source = { id: "empty-draft", title: "", eyebrow: "", topic: " ", copy: ["", " ", "Kept text"], diagram: "bearing" as const };
  const document = legacySlidesToSlideDocument([source], { title: "" });
  assert.equal(document.slides[0].title, "Folie 1");
  assert.deepEqual(document.slides[0].blocks.filter((block) => block.type === "paragraph"), [{ id: "empty-draft-copy-3", type: "paragraph", text: "Kept text" }]);
  assert.equal(document.slides[0].blocks.find((block) => block.type === "figure")?.caption, undefined);
  assert.ok(canvasSceneSchema.safeParse(canvasSceneForSlide(document.slides[0], document.assets)).success);
  assert.equal(source.title, "");
  assert.deepEqual(source.copy, ["", " ", "Kept text"]);
});

test("legacy conversion produces deterministic native editable text and vector diagrams", () => {
  const document = fixture();
  const slide = document.slides[0];
  const scene = canvasSceneForSlide(slide, document.assets);
  assert.deepEqual(scene, canvasSceneForSlide(slide, document.assets));
  assert.deepEqual([scene.width, scene.height], [1600, 900]);
  assert.ok(scene.elements.some((e) => e.type === "text" && e.originalText === slide.title));
  assert.equal(scene.elements.filter((e) => e.type === "ellipse").length, 2);
  assert.ok(scene.elements.every((e) => e.x >= 0 && e.y >= 0 && e.x + e.width <= 1600 && e.y + e.height <= 900));
  assert.ok(!scene.elements.some((e) => e.type === "image"));
});

test("all existing block fixtures convert without changing provenance or source content", () => {
  for (const slide of allBlockTypesSlideDocument.slides) {
    const before = JSON.stringify(slide);
    const scene = canvasSceneForSlide(slide, allBlockTypesSlideDocument.assets);
    assert.ok(canvasSceneSchema.safeParse(scene).success);
    for (const block of slide.blocks.filter((block) => block.type !== "spacer")) {
      assert.ok(scene.elements.some((element) => element.customData?.sourceBlockId === block.id), block.id);
    }
    assert.equal(JSON.stringify(slide), before);
  }
});

test("table cells and mathematical source remain individually editable", () => {
  const slide = fixture().slides[0];
  slide.blocks = [
    { id: "table", type: "table", columns: ["A", "B"], rows: [["eins", "zwei"], ["drei", "vier"]], mobileStrategy: "scroll" },
    { id: "formula", type: "formula", latex: "F = m \\cdot a" }
  ];
  const scene = canvasSceneForSlide(slide);
  for (const text of ["A", "B", "eins", "zwei", "drei", "vier", "F = m \\cdot a"]) assert.ok(scene.elements.some((e) => e.originalText === text));
});

test("3D becomes a native embeddable with inert sentinel and stable block mapping", () => {
  const slide = fixture().slides[0];
  slide.blocks = [{ id: "model", type: "scene3d", sceneId: "modell.morph", altText: "Modell", caption: "Interaktiv", accent: "#123456" }];
  const embed = canvasSceneForSlide(slide).elements.find((e) => e.type === "embeddable")!;
  assert.deepEqual(embed.customData, { sourceBlockId: "model", learnordie: { type: "scene3d", sceneId: "modell.morph", caption: "Interaktiv", accent: "#123456" } });
  assert.equal(embed.link, "https://learnordie.invalid/embed/model%3Ascene");
});

test("native canvas is authoritative and roundtrips mixed HTML, 3D, free drawing and metadata", () => {
  const document = fixture();
  const slide = document.slides[0];
  const scene = canvasSceneForSlide(slide, document.assets);
  const base = scene.elements[0];
  const extras: CanvasElement[] = [
    { ...base, id: "html", type: "embeddable", customData: { learnordie: { type: "html", title: "Widget", html: "<article><b>Eigenes HTML</b></article>" } } },
    { ...base, id: "three", type: "embeddable", customData: { learnordie: { type: "scene3d", sceneId: "modell.runtime" } } },
    { ...base, id: "drawing", type: "freedraw", points: [[0, 0], [12, 30]], pressures: [0.5, 0.8], simulatePressure: false, customData: { note: "kept" } }
  ];
  scene.elements.push(...extras);
  const updated = updateSlideCanvas(document, slide.id, scene);
  const persisted = parseSlideDocument(JSON.parse(JSON.stringify(updated)));
  assert.deepEqual(canvasSceneForSlide(persisted.slides[0]), scene);
  assert.deepEqual(persisted.slides[0].sourceRefs, slide.sourceRefs);
  assert.deepEqual(persisted.slides[0].speakerNotes, slide.speakerNotes);
  assert.deepEqual(persisted.slides[0].blocks, slide.blocks);
  assert.equal(document.slides[0].canvas, undefined);
});

test("canvas text edits refresh bounded title and legacy paragraph projections without losing full text", () => {
  const document = fixture();
  const scene = canvasSceneForSlide(document.slides[0], document.assets);
  for (const e of scene.elements) {
    if (e.id === "slide-one:title") e.text = e.originalText = "Neuer Titel";
    if (e.customData?.sourceBlockId === "slide-one-copy-1") e.text = e.originalText = "Neuer Inhalt";
  }
  const updated = updateSlideCanvas(document, "slide-one", scene);
  const legacy = slideDocumentToLegacySlides(updated)[0];
  assert.equal(updated.slides[0].title, "Neuer Titel");
  assert.equal(legacy.title, "Neuer Titel");
  assert.deepEqual(legacy.copy, ["Neuer Inhalt"]);
  scene.elements.find((e) => e.customData?.sourceBlockId === "slide-one-copy-1")!.isDeleted = true;
  assert.deepEqual(slideDocumentToLegacySlides(updateSlideCanvas(updated, "slide-one", scene))[0].copy, []);
});

test("block AI edits fail explicitly on native slides; notes/anchors still survive", () => {
  const document = fixture();
  const native = updateSlideCanvas(document, "slide-one", canvasSceneForSlide(document.slides[0], document.assets));
  const rejected = applySlideDocumentEdits(native, [{ kind: "patchBlock", slideId: "slide-one", blockId: "slide-one-copy-1", patch: { text: "Stale edit" } }]);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.issues[0].code, "edit.canvas_authoritative");
  const accepted = applySlideDocumentEdits(native, [{ kind: "upsertSpeakerNote", slideId: "slide-one", note: { id: "note-two", text: "More context" } }]);
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.deepEqual(accepted.document.slides[0].canvas, native.slides[0].canvas);
});

test("valid embedded raster image is persisted, external URLs and SVG are never fetched", () => {
  assert.equal(isSafeCanvasImage(png), true);
  for (const unsafe of ["https://example.org/x.png", "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,PHNjcmlwdD4="]) assert.equal(isSafeCanvasImage(unsafe), false);
  const document = fixture();
  document.assets[0].url = png;
  const scene = canvasSceneForSlide(document.slides[0], document.assets);
  assert.equal(Object.values(scene.files)[0].dataURL, png);
  assert.equal(scene.elements.filter((e) => e.type === "image").length, 1);
});

test("invalid dimensions, duplicate IDs, remote/missing images and unbounded native data are rejected", () => {
  const scene = canvasSceneForSlide(fixture().slides[0]);
  const invalid = [
    { ...scene, width: Infinity }, { ...scene, height: 0 }, { ...scene, width: 10001 },
    { ...scene, elements: [scene.elements[0], scene.elements[0]] },
    { ...scene, elements: [{ ...scene.elements[0], x: NaN }] },
    { ...scene, elements: [{ ...scene.elements[0], type: "image", fileId: "missing" }] },
    { ...scene, elements: [{ ...scene.elements[0], link: "javascript:alert(1)" }] },
    { ...scene, elements: [{ ...scene.elements[0], text: "x".repeat(65537) }] },
    { ...scene, elements: [{ ...scene.elements[0], type: "embeddable" }] },
    { ...scene, files: { bad: { id: "bad", dataURL: "https://example.org/p.png", mimeType: "image/png", created: 0 } } }
  ];
  for (const input of invalid) assert.equal(canvasSceneSchema.safeParse(input).success, false);
});

test("unhydrated remote assets reserve image geometry and explicit stable hydration metadata", () => {
  const document = fixture();
  document.assets[0].id = "remote-image";
  document.assets[0].url = "https://example.org/lecture.png";
  const figure = document.slides[0].blocks.find((block) => block.type === "figure")!;
  figure.assetId = "remote-image";
  const scene = canvasSceneForSlide(document.slides[0], document.assets);
  const placeholder = scene.elements.find((e) => e.customData?.sourceAssetId === "remote-image")!;
  assert.equal(placeholder.customData?.sourceBlockId, figure.id);
  assert.equal(placeholder.customData?.assetPlaceholder, true);
  assert.equal(placeholder.type, "rectangle");
  assert.ok(placeholder.height > 100);
  assert.equal(Object.keys(scene.files).length, 0);
  assert.ok(scene.elements.some((e) => e.originalText?.includes("Bildimport ausstehend")));
});

test("HTML bounds are enforced independently from runtime sandbox and sanitization", () => {
  const scene = canvasSceneForSlide(fixture().slides[0]);
  const embed = { ...scene.elements[0], type: "embeddable", customData: { learnordie: { type: "html", title: "HTML", html: "<p>Safe text</p>" } } };
  assert.equal(canvasSceneSchema.safeParse({ ...scene, elements: [embed] }).success, true);
  embed.customData.learnordie.html = "x".repeat(65537);
  assert.equal(canvasSceneSchema.safeParse({ ...scene, elements: [embed] }).success, false);
  assert.throws(() => updateSlideCanvas(fixture(), "missing", scene), /does not exist/);
});

test("dense blocks retain full editable original text rather than truncating migration", () => {
  const slide = fixture().slides[0];
  slide.blocks = Array.from({ length: 24 }, (_, i): SlideBlock => ({ id: `copy-${i}`, type: "paragraph", text: "Long content. ".repeat(80) }));
  const scene = canvasSceneForSlide(slide);
  assert.equal(scene.elements.filter((e) => e.type === "text").length, 25);
  assert.ok(scene.elements.every((e) => e.y + e.height <= 900));
  assert.equal(scene.elements.find((e) => e.customData?.sourceBlockId === "copy-23")?.originalText, "Long content. ".repeat(80));
});

test("legacy no-op saves preserve native scenes; edits and invalid native fallback fail explicitly", () => {
  const document = fixture();
  const native = updateSlideCanvas(document, "slide-one", canvasSceneForSlide(document.slides[0], document.assets));
  const projection = slideDocumentToLegacySlides(native);
  assert.equal(hasEngineOnlyBlocks(native), true);
  assert.deepEqual(mergeLegacySlideEditsIntoDocument(native, projection), native);
  assert.throws(() => mergeLegacySlideEditsIntoDocument(native, [{ ...projection[0], copy: ["Overwrite"] }]), /canvas_authoritative/);
  assert.throws(() => mergeLegacySlideEditsIntoDocument(native, []), /canvas_authoritative/);
  const invalid = structuredClone(native);
  invalid.slides[0].canvas!.width = 0;
  assert.throws(() => normalizeLectureSlideDocument(invalid, { id: "fixture", title: "Fallback", slides: projection }), /refusing destructive legacy fallback/);
});
