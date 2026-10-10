// @effect-diagnostics nodeBuiltinImport:off -- The validator is a Node CLI; the test bundles it and runs it in child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { beforeAll, describe, expect, it } from "vite-plus/test";

const packageRoot = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const bundle = NodeURL.fileURLToPath(
  new URL("../../dist/slide-engine-validator.mjs", import.meta.url),
);
const deckJson = NodeFS.readFileSync(
  new URL("../../fixtures/jour-fixe-deck.json", import.meta.url),
  "utf8",
);
const deck = JSON.parse(deckJson) as { slides: Array<{ id: string; canvas?: unknown }> };

function build(): string {
  return NodeChildProcess.execFileSync(process.execPath, ["scripts/build-validator.mjs"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}

function run(input: string) {
  const result = NodeChildProcess.spawnSync(process.execPath, [bundle], {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function request(body: Record<string, unknown>) {
  const result = run(JSON.stringify(body));
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout) as Record<string, any>;
}

describe("slide-engine-validator bundle", () => {
  let firstBuild = "";

  beforeAll(() => {
    firstBuild = build();
  });

  it("builds deterministically without react or three", () => {
    expect(firstBuild).toMatch(/sha256=[0-9a-f]{64} {2}bytes=\d+ {2}esbuild=0\.28\.1/);
    const first = NodeFS.readFileSync(bundle);
    build();
    expect(NodeFS.readFileSync(bundle).equals(first)).toBe(true);
    const source = first.toString("utf8");
    expect(source).not.toMatch(/node_modules\/(?:\.pnpm\/)?(?:react|three)[@/]/);
    expect(source).not.toMatch(/from ["'](?:react|three)["']/);
  });

  it("validates the Jour fixe deck", () => {
    // The acceptance check pipes the fixture through zsh `echo`, which expands backslash escapes.
    expect(deckJson).not.toContain("\\");
    expect(request({ op: "validate", document: deck })).toEqual({
      ok: true,
      issues: [],
      warnings: [],
    });
    const broken = structuredClone(deck) as any;
    delete broken.slides[1].blocks[1].data;
    const result = request({ op: "validate", document: broken });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "scene3d.missing_data",
        path: "$.slides[1].blocks[1].data",
        slideId: "kennzahlen",
        blockId: "kennzahlen-szene",
      }),
    ]);
  });

  it("applies edit batches exactly like applySlideDocumentEdits", () => {
    const accepted = request({
      op: "applyEdits",
      document: deck,
      operations: [
        {
          operationId: "kpi",
          kind: "patchBlock",
          slideId: "kennzahlen",
          blockId: "kennzahlen-szene",
          patch: {
            data: { items: [{ label: "Umsatz MRR", value: 19000, previous: 18400, unit: "€" }] },
          },
        },
        {
          kind: "upsertSpeakerNote",
          slideId: "exitwert",
          note: { id: "exitwert-note", kind: "talkingPoint", text: "Ziel fast erreicht." },
        },
      ],
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.appliedOperations).toEqual(["kpi", "upsertSpeakerNote"]);
    expect(accepted.document.slides[1].blocks[1].data.items[0].value).toBe(19000);

    const rejected = request({
      op: "applyEdits",
      document: deck,
      operations: [
        {
          operationId: "bad",
          kind: "patchBlock",
          slideId: "kennzahlen",
          blockId: "kennzahlen-szene",
          patch: { data: { items: [] } },
        },
      ],
    });
    expect(rejected).toMatchObject({
      ok: false,
      appliedOperations: ["bad"],
      issues: [expect.objectContaining({ code: "scene3d.invalid_data" })],
    });
    expect(rejected.document).toBeDefined();

    const canvasAuthority = request({
      op: "applyEdits",
      document: deck,
      operations: [
        {
          operationId: "stale",
          kind: "patchBlock",
          slideId: "entscheidung",
          blockId: "entscheidung-text",
          patch: { text: "Neu" },
        },
      ],
    });
    expect(canvasAuthority).toMatchObject({
      ok: false,
      appliedOperations: [],
      rejectedOperation: "stale",
      issues: [expect.objectContaining({ code: "edit.canvas_authoritative" })],
    });

    const unknownKind = request({
      op: "applyEdits",
      document: deck,
      operations: [{ kind: "rewriteEverything" }],
    });
    expect(unknownKind).toMatchObject({
      ok: false,
      appliedOperations: [],
      rejectedOperation: "operations[0]",
      issues: [expect.objectContaining({ code: "edit.unknown_operation" })],
    });
  });

  it("updates a canvas and converts failures to issues", () => {
    const { scene } = request({ op: "canvasForSlide", document: deck, slideId: "kennzahlen" });
    const accepted = request({ op: "updateCanvas", document: deck, slideId: "kennzahlen", scene });
    expect(accepted.ok).toBe(true);
    expect(accepted.document.slides[1].canvas).toEqual(scene);

    const embed = scene.elements.find((element: any) => element.type === "embeddable");
    embed.customData.learnordie.data = { items: [] };
    const invalidData = request({
      op: "updateCanvas",
      document: deck,
      slideId: "kennzahlen",
      scene,
    });
    expect(invalidData).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: "scene3d.invalid_data", slideId: "kennzahlen" })],
    });

    const invalidScene = request({
      op: "updateCanvas",
      document: deck,
      slideId: "kennzahlen",
      scene: { ...scene, width: 0 },
    });
    expect(invalidScene.ok).toBe(false);
    expect(invalidScene.issues[0]).toMatchObject({
      code: "canvas.invalid",
      slideId: "kennzahlen",
      path: "$.slides[1].canvas.width",
    });

    const missing = request({ op: "updateCanvas", document: deck, slideId: "nope", scene });
    expect(missing).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: "edit.slide_missing", slideId: "nope" })],
    });
  });

  it("returns the stored canvas or a migration", () => {
    const stored = request({ op: "canvasForSlide", document: deck, slideId: "entscheidung" });
    expect(stored).toEqual({ ok: true, scene: deck.slides[4]!.canvas });
    const migrated = request({ op: "canvasForSlide", document: deck, slideId: "titel" });
    expect(migrated.ok).toBe(true);
    expect(migrated.scene).toMatchObject({
      version: "learnordie.excalidraw.v1",
      width: 1600,
      height: 900,
    });
  });

  it("answers outline and meetingSlides", () => {
    const outline = request({ op: "outline", document: deck });
    expect(outline).toMatchObject({
      ok: true,
      id: "jour-fixe-2026-kw41",
      title: "Jour fixe Workjet · KW 41",
      language: "de",
      theme: "learnordie-north",
    });
    expect(outline.slides.map((slide: any) => slide.id)).toEqual([
      "titel",
      "kennzahlen",
      "exitwert",
      "offene-punkte",
      "entscheidung",
    ]);
    expect(outline.slides[2].scenes).toEqual([{ sceneId: "business.trend", hasData: true }]);

    const meeting = request({ op: "meetingSlides", document: deck });
    expect(meeting.ok).toBe(true);
    expect(meeting.slides).toHaveLength(5);
    expect(Object.keys(meeting.slides[0])).toEqual([
      "id",
      "position",
      "title",
      "body_markdown",
      "narration",
    ]);
    expect(meeting.slides[1].body_markdown).toContain("KPI: Umsatz MRR 18.400 € (Δ +8,9 %)");
  });

  it("answers invalid documents with ok:false and exit 0", () => {
    for (const op of ["outline", "meetingSlides", "canvasForSlide"]) {
      const result = request({ op, document: { schemaVersion: "nope" }, slideId: "x" });
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("exits 2 with a stderr message for malformed requests", () => {
    for (const input of [
      "",
      "{",
      "[]",
      '"validate"',
      '{"op":"nope"}',
      '{"op":"validate"}',
      '{"document":{}}',
      '{"op":"applyEdits","document":{},"operations":{}}',
      '{"op":"updateCanvas","document":{},"slideId":"x"}',
    ]) {
      const result = run(input);
      expect(result.status, input).toBe(2);
      expect(result.stdout, input).toBe("");
      expect(result.stderr, input).toMatch(/^slide-engine-validator: /);
    }
  });

  it("rejects input over 24 MiB", () => {
    const result = run(`{"op":"validate","document":"${"x".repeat(24 * 1024 * 1024)}"}`);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/exceeds 25165824 bytes/);
  });
});
