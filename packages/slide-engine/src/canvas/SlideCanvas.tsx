// Workjet port of learnordie `src/components/excalidraw/ExcalidrawCanvas.tsx` (d94f8a59):
// one Excalidraw editor per slide, presented as a fitted 16:9 frame or edited with the full
// drawing tools. The host app owns persistence: edits arrive through `onSceneChange`.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CanvasScene } from "../excalidraw/canvas-schema";
import { canvasSceneForSlide } from "../excalidraw/scene";
import type { SlideAssetRef, SlideNode } from "../schema";
import { renderCanvasEmbeddable } from "./CanvasEmbed";
import type {
  CanvasAppState,
  CanvasFiles,
  CanvasImperativeAPI,
  CanvasMount,
  CanvasRuntime,
  CanvasRuntimeElement,
} from "./runtime";
import { ensureCanvasStyles } from "./styles";
import {
  canvasChangeKey,
  canvasFingerprint,
  frameViewport,
  isCanvasGestureActive,
  toCanvasScene,
  viewportMatches,
  type CanvasViewport,
} from "./sync";

export type SlideAsset = SlideAssetRef;
export type SlideCanvasMode = "present" | "edit";
export type SlideCanvasTheme = "light" | "dark";
export type SlideCanvasProps = {
  /** From `loadCanvasRuntime`; one runtime serves every canvas on the page. */
  runtime: CanvasRuntime;
  slide: SlideNode;
  assets: SlideAsset[];
  mode: SlideCanvasMode;
  theme: SlideCanvasTheme;
  /** Excalidraw UI language, e.g. `en` or `de-DE`. */
  langCode?: string;
  /** Edit mode only: a valid `learnordie.excalidraw.v1` scene after each user edit (debounced). */
  onSceneChange?: (scene: CanvasScene) => void;
  /**
   * Edit mode only: receives a function that reads the editor's scene right now, including the
   * last stroke and open text that the debounced `onSceneChange` has not reported yet. It returns
   * `null` when the scene equals the slide's stored scene. Call it when the user saves.
   */
  captureRef?: { current: (() => CanvasScene | null) | null };
  className?: string;
};

const CHANGE_DEBOUNCE_MS = 250;
const EDIT_FIT_MARGIN = 0.92;
const EMBED_HOST = ".learnordie-canvas-embed-host";
// Excalidraw viewport shortcuts: Ctrl/Cmd +/-/0 zoom, Shift+1/2/3 fit.
const ZOOM_CODES = new Set(["Equal", "Minus", "Digit0", "NumpadAdd", "NumpadSubtract", "Numpad0"]);
const FIT_CODES = new Set(["Digit1", "Digit2", "Digit3"]);

type EditorState = { slideId: string; scene: CanvasScene; fingerprint: string };

function insideEmbed(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EMBED_HOST) !== null;
}

type TranscriptLine = { id: string; text: string };

function transcriptOf(scene: CanvasScene): TranscriptLine[] {
  return scene.elements
    .filter((element) => element.type === "text" && !element.isDeleted && element.opacity !== 0)
    .map((element) => ({ id: element.id, text: element.originalText ?? element.text ?? "" }))
    .filter((line) => line.text.trim().length > 0);
}

export function SlideCanvas({
  runtime,
  slide,
  assets,
  mode,
  theme,
  langCode = "en",
  onSceneChange,
  captureRef,
  className,
}: SlideCanvasProps) {
  // Stored native scenes are authoritative; older slides are migrated on the fly.
  const scene = useMemo(() => slide.canvas ?? canvasSceneForSlide(slide, assets), [slide, assets]);
  const outerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorState | null>(null);
  const propFingerprintRef = useRef("");
  // Recently emitted scenes: a host that saves one of them echoes it back; that is not an edit.
  const emittedRef = useRef<string[]>([]);
  const apiRef = useRef<CanvasImperativeAPI | null>(null);
  const mountRef = useRef<{ mount: CanvasMount; props: Record<string, unknown> } | null>(null);
  const latestRef = useRef({ slide, theme, langCode, onSceneChange, captureRef });
  const [ready, setReady] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const messages = runtime.messages;

  useEffect(() => {
    latestRef.current = { slide, theme, langCode, onSceneChange, captureRef };
  });

  // Track the scene the editor shows. A new slide replaces it; a changed scene for the same
  // slide is an external edit unless it only echoes what this editor emitted.
  useEffect(() => {
    const fingerprint = canvasFingerprint(scene);
    const editor = editorRef.current;
    if (!editor || editor.slideId !== slide.id) {
      editorRef.current = { slideId: slide.id, scene, fingerprint };
      propFingerprintRef.current = fingerprint;
      emittedRef.current = [];
      return;
    }
    if (fingerprint === propFingerprintRef.current) return;
    propFingerprintRef.current = fingerprint;
    if (fingerprint === editor.fingerprint || emittedRef.current.includes(fingerprint)) return;
    editorRef.current = { slideId: slide.id, scene, fingerprint };
    const api = apiRef.current;
    if (!api) return;
    api.addFiles(Object.values(scene.files));
    api.updateScene({
      elements: runtime.restoreElements(scene.elements, null),
      appState: { viewBackgroundColor: scene.backgroundColor },
    });
  }, [runtime, scene, slide.id]);

  useEffect(() => {
    const outer = outerRef.current;
    const stage = stageRef.current;
    const host = hostRef.current;
    const editor = editorRef.current;
    if (!outer || !stage || !host || !editor) return;
    ensureCanvasStyles();
    const present = mode === "present";
    const source = editor.scene;
    const frame = { width: source.width, height: source.height };
    let disposed = false;
    let api: CanvasImperativeAPI | null = null;
    let fitted: CanvasViewport | null = null;
    let fitFrame = 0;
    let changeTimer = 0;
    let initialized = false;
    let userEdited = false;
    let lastKey = "";
    let latest: {
      elements: readonly CanvasRuntimeElement[];
      state: CanvasAppState;
      files: CanvasFiles;
    } | null = null;

    // Present: size the stage to the frame's aspect ratio (letterbox) and show exactly the
    // frame. Edit: the editor fills the host and starts with the whole frame in view.
    const layout = (): CanvasViewport => {
      if (present) {
        const scale = Math.max(
          0,
          Math.min(outer.clientWidth / frame.width, outer.clientHeight / frame.height),
        );
        stage.style.width = `${frame.width * scale}px`;
        stage.style.height = `${frame.height * scale}px`;
        return frameViewport(frame.width * scale, frame.height * scale, frame);
      }
      stage.style.removeProperty("width");
      stage.style.removeProperty("height");
      return frameViewport(stage.clientWidth, stage.clientHeight, frame, EDIT_FIT_MARGIN);
    };
    const applyFit = (viewport: CanvasViewport) => {
      fitted = viewport;
      // The stage may move without resizing (letterbox recentring); refresh the editor offsets.
      api?.refresh();
      api?.updateScene({
        appState: {
          zoom: { value: viewport.zoom },
          scrollX: viewport.scrollX,
          scrollY: viewport.scrollY,
        },
        captureUpdate: "NEVER",
      });
    };
    const scheduleFit = () => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        if (!disposed) applyFit(layout());
      });
    };

    const emit = (flush: boolean) => {
      window.clearTimeout(changeTimer);
      changeTimer = 0;
      if (!latest) return;
      if (!flush && isCanvasGestureActive(latest.state)) {
        changeTimer = window.setTimeout(() => emit(false), CHANGE_DEBOUNCE_MS);
        return;
      }
      const next = toCanvasScene(source, latest.elements, latest.state, latest.files);
      const fingerprint = canvasFingerprint(next);
      const current = editorRef.current;
      if (!current || current.slideId !== editor.slideId || fingerprint === current.fingerprint) {
        return;
      }
      editorRef.current = { slideId: editor.slideId, scene: next, fingerprint };
      // Font metrics and other native normalization are not edits; only user input counts.
      if (!userEdited) return;
      emittedRef.current = [...emittedRef.current.slice(-7), fingerprint];
      latestRef.current.onSceneChange?.(next);
    };
    const onChange = (
      elements: readonly CanvasRuntimeElement[],
      state: CanvasAppState,
      files: CanvasFiles,
    ) => {
      if (disposed) return;
      if (present) {
        if (fitted && !viewportMatches(state, fitted)) scheduleFit();
        return;
      }
      latest = { elements, state, files };
      const key = canvasChangeKey(elements, state);
      if (!initialized) {
        // The first native callback normalizes imported geometry and font metrics.
        initialized = true;
        lastKey = key;
        emit(true);
        return;
      }
      if (key === lastKey && !changeTimer) return;
      lastKey = key;
      window.clearTimeout(changeTimer);
      changeTimer = window.setTimeout(() => emit(false), CHANGE_DEBOUNCE_MS);
    };

    const viewport = layout();
    fitted = viewport;
    const props: Record<string, unknown> = {
      initialData: {
        elements: runtime.restoreElements(source.elements, null),
        files: source.files,
        appState: {
          viewBackgroundColor: source.backgroundColor,
          // New text uses the handwriting font family 1 (Virgil), like migrated slides.
          currentItemFontFamily: 1,
          // Readable on a 1600 × 900 slide; Excalidraw's default (20) is a footnote there.
          currentItemFontSize: 36,
          currentItemStrokeColor: "#243f43",
          currentItemRoughness: 1,
          gridSize: null,
          zoom: { value: viewport.zoom },
          scrollX: viewport.scrollX,
          scrollY: viewport.scrollY,
        },
      },
      name: latestRef.current.slide.title,
      theme: latestRef.current.theme,
      langCode: latestRef.current.langCode,
      viewModeEnabled: present,
      zenModeEnabled: present,
      handleKeyboardGlobally: false,
      autoFocus: false,
      UIOptions: {
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          export: false,
          saveAsImage: false,
          toggleTheme: false,
          clearCanvas: !present,
        },
        tools: { image: !present },
      },
      renderEmbeddable: (element: CanvasRuntimeElement) => renderCanvasEmbeddable(runtime, element),
      excalidrawAPI: (value: CanvasImperativeAPI) => {
        if (disposed) return;
        api = value;
        apiRef.current = value;
        setReady(true);
        scheduleFit();
      },
      onChange,
    };
    const mount = runtime.mountExcalidraw(host, props);
    mountRef.current = { mount, props };
    setTranscript(present ? transcriptOf(source) : []);

    const resize = new ResizeObserver(() => {
      if (disposed) return;
      // Keep a viewport the editor user changed; a presented slide always refits.
      if (!present && api && fitted && !viewportMatches(api.getAppState(), fitted)) return;
      applyFit(layout());
    });
    resize.observe(outer);

    // Present: no accidental pan, zoom or selection on the drawing; embeds stay interactive.
    const block = (event: Event) => {
      if (insideEmbed(event.target)) return;
      event.stopPropagation();
      if (event.cancelable) event.preventDefault();
    };
    const wheel = (event: WheelEvent) => {
      event.stopPropagation();
      if (event.ctrlKey || !insideEmbed(event.target)) event.preventDefault();
    };
    const zoomKeys = (event: KeyboardEvent) => {
      if (insideEmbed(event.target) || !host.contains(event.target as Node | null)) return;
      const zoomShortcut =
        ((event.ctrlKey || event.metaKey) && ZOOM_CODES.has(event.code)) ||
        (event.shiftKey && FIT_CODES.has(event.code));
      if (zoomShortcut) event.stopPropagation();
    };
    const markEdited = () => {
      userEdited = true;
    };
    const blocked = ["pointerdown", "dblclick", "contextmenu", "touchstart", "touchmove"] as const;
    const edits = ["pointerdown", "keydown", "drop", "paste"] as const;
    if (present) {
      for (const type of blocked)
        outer.addEventListener(type, block, { capture: true, passive: false });
      outer.addEventListener("wheel", wheel, { capture: true, passive: false });
      outer.addEventListener("keydown", zoomKeys, { capture: true });
    } else {
      for (const type of edits) outer.addEventListener(type, markEdited, { capture: true });
    }
    const capture = latestRef.current.captureRef;
    if (capture && !present) {
      capture.current = () => {
        if (disposed || !api || !userEdited) return null;
        const next = toCanvasScene(
          source,
          api.getSceneElements(),
          api.getAppState(),
          api.getFiles(),
        );
        return canvasFingerprint(next) === propFingerprintRef.current ? null : next;
      };
    }

    return () => {
      if (capture && !present) capture.current = null;
      // Deliver a pending edit before the editor goes away (mode or slide switch, unmount).
      if (changeTimer) emit(true);
      disposed = true;
      cancelAnimationFrame(fitFrame);
      window.clearTimeout(changeTimer);
      resize.disconnect();
      for (const type of blocked) outer.removeEventListener(type, block, { capture: true });
      outer.removeEventListener("wheel", wheel, { capture: true });
      outer.removeEventListener("keydown", zoomKeys, { capture: true });
      for (const type of edits) outer.removeEventListener(type, markEdited, { capture: true });
      apiRef.current = null;
      mountRef.current = null;
      setReady(false);
      mount.unmount();
    };
  }, [runtime, slide.id, mode]);

  useEffect(() => {
    const mounted = mountRef.current;
    if (!mounted || (mounted.props.theme === theme && mounted.props.langCode === langCode)) return;
    mounted.props = { ...mounted.props, theme, langCode };
    mounted.mount.update(mounted.props);
  }, [theme, langCode]);

  const present = mode === "present";
  return (
    <div
      ref={outerRef}
      className={className ? `workjet-slide-canvas ${className}` : "workjet-slide-canvas"}
      data-mode={mode}
      data-theme={theme}
      data-canvas-engine="excalidraw"
      data-canvas-ready={ready}
      data-slide-id={slide.id}
      role="group"
      aria-label={present ? `${messages.slideLabel}: ${slide.title}` : messages.editorLabel}
    >
      <div ref={stageRef} className="workjet-slide-canvas__stage">
        <div ref={hostRef} className="workjet-slide-canvas__host" />
      </div>
      {present && transcript.length > 0 ? (
        <section className="workjet-slide-canvas__transcript" aria-label={messages.transcriptLabel}>
          {transcript.map((line) => (
            <p key={line.id}>{line.text}</p>
          ))}
        </section>
      ) : null}
    </div>
  );
}
