/** Development-only slide canvas fixture. Never connects to a CTOX instance. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  loadCanvasRuntime,
  SlideCanvas,
  type CanvasRuntime,
  type SlideCanvasMode,
  type SlideCanvasTheme,
} from "@workjet/slide-engine/canvas";
import {
  CANVAS_HEIGHT,
  CANVAS_VERSION,
  CANVAS_WIDTH,
  type CanvasElement,
  type CanvasScene,
} from "@workjet/slide-engine/excalidraw/canvas-schema";
import { canvasSceneForSlide, updateSlideCanvas } from "@workjet/slide-engine/excalidraw/scene";
import type { SlideDocument, SlideNode } from "@workjet/slide-engine/schema";
import "@workjet/slide-engine/styles/core.css";
import { Button } from "../components/ui/button";
import "../index.css";

if (!import.meta.env.DEV || !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  throw new Error("Slide engine fixture is available only on a loopback development server.");
}

const INK = "#243a40";
const PAPER = "#fffef8";
const EMBED_LINK = "https://learnordie.invalid/embed/";

function seedFor(id: string): number {
  let seed = 2166136261;
  for (const char of id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return (seed >>> 0) % 2147483647;
}

function element(
  id: string,
  type: CanvasElement["type"],
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Record<string, unknown> = {},
): CanvasElement {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: INK,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: seedFor(id),
    version: 1,
    versionNonce: seedFor(`${id}:version`),
    isDeleted: false,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
    ...extra,
  } as CanvasElement;
}

/** Handwritten text (Virgil, family 1). */
function handwriting(
  id: string,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  sourceBlockId?: string,
): CanvasElement {
  const lines = text.split("\n");
  return element(
    id,
    "text",
    x,
    y,
    Math.max(...lines.map((line) => line.length)) * fontSize * 0.55,
    lines.length * fontSize * 1.25,
    {
      text,
      originalText: text,
      fontSize,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
      ...(sourceBlockId ? { customData: { sourceBlockId } } : {}),
    },
  );
}

function embed(id: string, x: number, y: number, width: number, height: number, payload: object) {
  return element(id, "embeddable", x, y, width, height, {
    strokeColor: "transparent",
    link: `${EMBED_LINK}${encodeURIComponent(id)}`,
    customData: { learnordie: payload },
  });
}

function canvas(elements: CanvasElement[]): CanvasScene {
  return {
    version: CANVAS_VERSION,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    backgroundColor: PAPER,
    elements,
    files: {},
  };
}

const sourceRefs: SlideNode["sourceRefs"] = [
  { id: "fixture-source", sourceType: "manual", label: "Fixture-Daten" },
];

const initialDeck: SlideDocument = {
  schemaVersion: "learnordie.slide.v1",
  id: "jour-fixe-fixture-deck",
  title: "Jour fixe · Projekt Nordlicht",
  language: "de",
  aspect: "16:9",
  theme: "learnordie-north",
  deckSettings: {
    defaultTransition: "none",
    showSlideNumbers: true,
    allowFragments: false,
    mobileMode: "scaled",
  },
  slides: [
    {
      // No canvas: migrated on the fly by the engine.
      id: "titel",
      title: "Jour fixe · Projekt Nordlicht",
      layout: "title_statement",
      intent: "title",
      blocks: [
        { id: "titel-h", type: "heading", text: "Jour fixe · Projekt Nordlicht" },
        {
          id: "titel-p",
          type: "paragraph",
          text: "Kalenderwoche 41 — Stand, Kennzahlen und nächste Schritte",
        },
      ],
      sourceRefs,
    },
    {
      id: "ideen",
      title: "Was wir aus dem Modell lernen",
      layout: "technical_figure_right",
      intent: "concept",
      blocks: [
        { id: "ideen-h", type: "heading", text: "Was wir aus dem Modell lernen" },
        {
          id: "ideen-p",
          type: "paragraph",
          text: "Steifer heißt schneller, aber nicht ruhiger.",
        },
      ],
      canvas: canvas([
        handwriting("ideen:title", "Was wir aus dem Modell lernen", 88, 70, 56, "ideen-h"),
        handwriting("ideen:label", "Federkonstante k", 110, 186, 34),
        element("ideen:box", "rectangle", 100, 240, 480, 220, {
          backgroundColor: "#fff3bf",
          roundness: { type: 3 },
        }),
        element("ideen:arrow", "arrow", 600, 350, 180, 0, {
          points: [
            [0, 0],
            [180, 0],
          ],
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: null,
          endArrowhead: "arrow",
          elbowed: false,
        }),
        handwriting(
          "ideen:note",
          "Steifer heißt schneller —\naber nicht ruhiger.",
          100,
          500,
          30,
          "ideen-p",
        ),
        embed("ideen:law", 800, 180, 700, 600, {
          type: "scene3d",
          sceneId: "modell.law",
          caption: "Hängende Feder: Steifigkeit verändern",
        }),
      ]),
      sourceRefs,
    },
    {
      id: "kennzahlen",
      title: "Kennzahlen seit dem letzten Termin",
      layout: "technical_figure_right",
      intent: "summary",
      blocks: [{ id: "kennzahlen-h", type: "heading", text: "Kennzahlen seit dem letzten Termin" }],
      canvas: canvas([
        handwriting(
          "kennzahlen:title",
          "Kennzahlen seit dem letzten Termin",
          88,
          70,
          56,
          "kennzahlen-h",
        ),
        embed("kennzahlen:kpi", 88, 190, 1424, 640, {
          type: "scene3d",
          sceneId: "business.kpi-bars",
          caption: "Vier Kennzahlen gegenüber dem letzten Jour fixe",
          data: {
            items: [
              { label: "Umsatz", value: 1.24, previous: 1.1, unit: "Mio €" },
              { label: "Marge", value: 18, previous: 16.5, unit: "%" },
              { label: "Offene Tickets", value: 42, previous: 57, better: "lower" },
              { label: "Kundenzufriedenheit", value: 4.4, previous: 4.2, unit: "/ 5" },
            ],
          },
        }),
      ]),
      sourceRefs,
    },
  ],
  assets: [],
  createdBy: { mode: "agent" },
};

type Draft = { slideId: string; scene: CanvasScene };
type Status = { kind: "idle" | "dirty" | "saved" | "error"; text: string };

function describe(error: unknown): string {
  const issues = (error as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .slice(0, 2)
      .map((issue: { path?: unknown; message?: unknown }) =>
        [
          typeof issue.path === "string"
            ? issue.path
            : Array.isArray(issue.path)
              ? issue.path.join(".")
              : "",
          String(issue.message),
        ]
          .filter(Boolean)
          .join(": "),
      )
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function Fixture() {
  const [runtime, setRuntime] = useState<CanvasRuntime | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [deck, setDeck] = useState(initialDeck);
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<SlideCanvasMode>("present");
  const [theme, setTheme] = useState<SlideCanvasTheme>("light");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "" });
  const slide = deck.slides[index] ?? deck.slides[0]!;

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    loadCanvasRuntime({ assetBaseUrl: "/vendor/excalidraw/" }).then(
      (loaded) => {
        if (!cancelled) setRuntime(loaded);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(describe(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.dataset.theme = theme;
  }, [theme]);

  // Unsaved edits belong to the slide they were made on; leaving the slide discards them.
  useEffect(() => {
    setDraft(null);
    setStatus({ kind: "idle", text: "" });
  }, [slide.id]);

  useEffect(() => {
    const fixtureWindow = window as unknown as { slideEngineFixture?: object };
    fixtureWindow.slideEngineFixture = {
      savedSlide: (slideId: string) => deck.slides.find((candidate) => candidate.id === slideId),
      exportCurrentSlideSvg: async () => {
        if (!runtime) throw new Error("Runtime not loaded");
        const scene = slide.canvas ?? canvasSceneForSlide(slide, deck.assets);
        const svg = await runtime.exportToSvg({
          elements: scene.elements,
          appState: { viewBackgroundColor: scene.backgroundColor, exportBackground: true },
          files: scene.files,
        });
        return svg.outerHTML.length;
      },
    };
  }, [deck, runtime, slide]);

  function save() {
    const scene =
      draft?.slideId === slide.id
        ? draft.scene
        : (slide.canvas ?? canvasSceneForSlide(slide, deck.assets));
    try {
      // Validate the slide on its own, so a slide that waits for newer schema support (business
      // scenes) does not block saving the others. The engine checks the full slide and scene.
      const updated = updateSlideCanvas({ ...deck, slides: [slide] }, slide.id, scene).slides[0]!;
      setDeck({
        ...deck,
        slides: deck.slides.map((candidate) => (candidate.id === slide.id ? updated : candidate)),
      });
      setDraft(null);
      setStatus({ kind: "saved", text: "Saved" });
    } catch (error) {
      setStatus({ kind: "error", text: `Not saved: ${describe(error)}` });
    }
  }

  return (
    <main
      className="flex h-dvh flex-col bg-background text-foreground"
      data-workjet-fixture="slide-engine"
    >
      <nav
        className="flex flex-wrap items-center gap-2 border-b border-border p-3"
        aria-label="Fixture controls"
      >
        <span className="mr-auto text-xs text-muted-foreground">
          Isolated fixture · slide {index + 1} of {deck.slides.length} · {slide.title}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={index === 0}
          onClick={() => setIndex(index - 1)}
        >
          Previous slide
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={index === deck.slides.length - 1}
          onClick={() => setIndex(index + 1)}
        >
          Next slide
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={mode === "edit"}
          onClick={() => setMode(mode === "present" ? "edit" : "present")}
        >
          {mode === "present" ? "Edit" : "Present"}
        </Button>
        <Button size="sm" disabled={!runtime} onClick={save}>
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-pressed={theme === "dark"}
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
        >
          {theme === "light" ? "Dark" : "Light"}
        </Button>
        <output
          role="status"
          className="min-w-24 text-xs text-muted-foreground"
          data-save-status={status.kind}
        >
          {status.text}
        </output>
      </nav>
      <div className="relative min-h-0 flex-1" lang={deck.language}>
        {runtime ? (
          <SlideCanvas
            runtime={runtime}
            slide={slide}
            assets={deck.assets}
            mode={mode}
            theme={theme}
            langCode="de-DE"
            onSceneChange={(scene) => {
              setDraft({ slideId: slide.id, scene });
              setStatus({ kind: "dirty", text: "Unsaved changes" });
            }}
          />
        ) : loadError ? (
          <div role="alert" className="p-5 text-sm">
            {loadError}{" "}
            <Button size="sm" variant="outline" onClick={() => setAttempt(attempt + 1)}>
              Load again
            </Button>
          </div>
        ) : (
          <p role="status" className="p-5 text-sm text-muted-foreground">
            Loading the drawing canvas…
          </p>
        )}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
