import type { CanvasRuntimeMessages } from "@workjet/slide-engine/canvas";

/** Sprache der Excalidraw-Bühne im Regeltermin (UI-Vertrag §4). */
export const JOUR_FIXE_CANVAS_LANG_CODE = "de-DE";

/** Deutsche Texte der Zeichenbühne; an jeden `loadCanvasRuntime`-Aufruf. */
export const JOUR_FIXE_CANVAS_MESSAGES: CanvasRuntimeMessages = {
  browserRequired: "Zeichenbühne braucht einen Browser",
  runtimeUnavailable: "Zeichenbühne nicht geladen",
  stylesMissing: "Stile der Zeichenbühne fehlen",
  fontsUnsupported: "Schriften nicht ladbar",
  fontTimeout: "Schrift nicht geladen",
  fontMissing: "Schrift fehlt",
  fontLoadFailed: "Schrift nicht geladen",
  retryFonts: "Erneut versuchen",
  retryFontsFailed: "Erneut versuchen",
  embedUnsupported: "Einbettung nicht unterstützt",
  embedFailed: "Einbettung nicht geladen",
  embedRetry: "Erneut versuchen",
  htmlTitle: "HTML-Inhalt",
  htmlTooLarge: "HTML-Inhalt zu groß",
  sceneAlt: "3D-Szene",
  slideLabel: "Folie",
  editorLabel: "Folien-Editor",
  transcriptLabel: "Folientext",
};
