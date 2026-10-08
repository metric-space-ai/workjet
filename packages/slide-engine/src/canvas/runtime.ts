// Workjet port of learnordie `src/lib/excalidraw-runtime.ts` (d94f8a59).
// Loads the vendored Excalidraw 0.18 browser closure that the host app serves as static files
// (Workjet: `apps/web/public/vendor/excalidraw/`). Structural types keep the vendored React and
// Excalidraw closure outside the app bundle: the app never imports `@excalidraw/excalidraw`.
import { z } from "zod";

// The Workjet renderer CSP has no 'unsafe-eval'. Zod probes `new Function` for its JIT parser when
// the first object schema is constructed; under the CSP that only reports a violation and falls
// back. This module is the first import of the canvas entry (`./index.ts`), so the engine schemas
// it pulls in are constructed afterwards. A top-level call in a used module survives the package's
// `sideEffects` tree shaking; a side-effect-only import would not.
z.config({ jitless: true });

export type CanvasRuntimeElement = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  customData?: Record<string, unknown> | null;
  [key: string]: unknown;
};
export type CanvasAppState = Record<string, unknown>;
export type CanvasFiles = Record<string, unknown>;
export type CanvasImperativeAPI = {
  getSceneElements(): readonly CanvasRuntimeElement[];
  getAppState(): CanvasAppState;
  getFiles(): CanvasFiles;
  updateScene(scene: {
    elements?: readonly object[];
    appState?: object;
    captureUpdate?: string;
  }): void;
  scrollToContent(elements?: readonly object[], options?: object): void;
  setActiveTool(tool: { type: string }): void;
  addFiles(files: readonly object[]): void;
  refresh(): void;
};
export type CanvasRuntimeProps = {
  initialData?: object;
  excalidrawAPI?: (api: CanvasImperativeAPI) => void;
  onChange?: (
    elements: readonly CanvasRuntimeElement[],
    appState: CanvasAppState,
    files: CanvasFiles,
  ) => void;
  renderEmbeddable?: (element: CanvasRuntimeElement, appState: CanvasAppState) => unknown;
  validateEmbeddable?: (link: string) => boolean;
  onError?: (error: Error) => void;
  [key: string]: unknown;
};
export type CanvasMount = { update(props: object): void; unmount(): void };

/** User-visible texts of the canvas layer. English defaults; pass translations to the loader. */
export type CanvasRuntimeMessages = {
  browserRequired: string;
  runtimeUnavailable: string;
  stylesMissing: string;
  fontsUnsupported: string;
  fontTimeout: string;
  fontMissing: string;
  fontLoadFailed: string;
  retryFonts: string;
  retryFontsFailed: string;
  embedUnsupported: string;
  embedFailed: string;
  embedRetry: string;
  htmlTitle: string;
  htmlTooLarge: string;
  sceneAlt: string;
  slideLabel: string;
  editorLabel: string;
  transcriptLabel: string;
};

export const defaultCanvasRuntimeMessages: CanvasRuntimeMessages = {
  browserRequired: "The drawing canvas needs a browser.",
  runtimeUnavailable: "The local drawing canvas could not be loaded. Try again or reload the page.",
  stylesMissing: "The drawing canvas styles are missing. Try again.",
  fontsUnsupported: "This browser cannot load the drawing fonts.",
  fontTimeout: "The local drawing font could not be loaded. Try again.",
  fontMissing: "The local Assistant font is missing. Try again.",
  fontLoadFailed: "A local drawing font could not be loaded.",
  retryFonts: "Load fonts again",
  retryFontsFailed: "Try again or reload the page",
  embedUnsupported: "This embed is not supported.",
  embedFailed: "The embed could not be loaded.",
  embedRetry: "Try again",
  htmlTitle: "HTML/CSS content",
  htmlTooLarge: "HTML content is too large (at most 65,536 characters).",
  sceneAlt: "Interactive 3D scene",
  slideLabel: "Slide",
  editorLabel: "Slide editor",
  transcriptLabel: "Slide text",
};

export type CanvasRuntime = {
  /** Texts used by the canvas layer, resolved once per runtime. */
  messages: CanvasRuntimeMessages;
  mountExcalidraw(host: HTMLElement, props: object): CanvasMount;
  convertToExcalidrawElements<T extends object = CanvasRuntimeElement>(
    elements: readonly object[],
    options?: { regenerateIds?: boolean },
  ): T[];
  restoreElements<T extends object = CanvasRuntimeElement>(
    elements: readonly object[],
    localElements: readonly object[] | null,
  ): T[];
  exportToSvg(options: {
    elements: readonly object[];
    appState?: object;
    files?: object;
    [key: string]: unknown;
  }): Promise<SVGSVGElement>;
  /** Creates VENDORED React nodes. Never call main-React hooks in these nodes. */
  createElement(type: unknown, props: object | null, ...children: unknown[]): unknown;
};

type NativeRuntime = Omit<CanvasRuntime, "messages">;

export type LoadCanvasRuntimeOptions = {
  /** URL of the vendored runtime directory, e.g. `/vendor/excalidraw/`; must be same-origin. */
  assetBaseUrl: string;
  /** Overrides for the English defaults. The first successful load for a directory wins. */
  messages?: Partial<CanvasRuntimeMessages>;
};

type RuntimeWindow = Window & { EXCALIDRAW_ASSET_PATH?: string };

/** Inert validation marker for engine-owned embeds. It is never requested. */
export const CANVAS_EMBED_LINK_PREFIX = "https://learnordie.invalid/embed/";
const STYLESHEET_ID = "workjet-excalidraw-css";
const LOAD_TIMEOUT_MS = 20_000;
const runtimeLoads = new Map<string, Promise<CanvasRuntime>>();
const moduleLoads = new Map<string, Promise<NativeRuntime>>();
let styleLoad: { href: string; promise: Promise<void> } | undefined;
let attempt = 0;

export function isCanvasEmbedLink(link: unknown): link is string {
  return (
    typeof link === "string" &&
    /^https:\/\/learnordie\.invalid\/embed\/[A-Za-z0-9_.%~-]{1,512}$/.test(link)
  );
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), LOAD_TIMEOUT_MS);
    }),
  ]).finally(() => window.clearTimeout(timer));
}

function loadStyles(baseUrl: string, messages: CanvasRuntimeMessages): Promise<void> {
  const href = new URL("excalidraw.css", baseUrl).href;
  if (styleLoad?.href === href) return styleLoad.promise;
  const existing = document.getElementById(STYLESHEET_ID);
  if (
    existing instanceof HTMLLinkElement &&
    existing.href === href &&
    existing.dataset.loaded === "true"
  ) {
    return Promise.resolve();
  }
  existing?.remove();
  const promise = new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.id = STYLESHEET_ID;
    link.rel = "stylesheet";
    link.href = href;
    const timer = window.setTimeout(() => fail(), LOAD_TIMEOUT_MS);
    const clean = () => {
      window.clearTimeout(timer);
      link.removeEventListener("load", loaded);
      link.removeEventListener("error", fail);
    };
    const fail = () => {
      clean();
      link.remove();
      reject(new Error(messages.stylesMissing));
    };
    const loaded = () => {
      clean();
      link.dataset.loaded = "true";
      resolve();
    };
    link.addEventListener("load", loaded);
    link.addEventListener("error", fail);
    document.head.append(link);
  }).catch((error: unknown) => {
    styleLoad = undefined;
    throw error;
  });
  styleLoad = { href, promise };
  return promise;
}

async function requireFonts(messages: CanvasRuntimeMessages): Promise<void> {
  if (!document.fonts) throw new Error(messages.fontsUnsupported);
  const faces = await withTimeout(document.fonts.load('16px "Assistant"'), messages.fontTimeout);
  if (!faces.length) throw new Error(messages.fontMissing);
}

function loadModule(baseUrl: string, messages: CanvasRuntimeMessages): Promise<NativeRuntime> {
  const cached = moduleLoads.get(baseUrl);
  if (cached) return cached;
  const url = new URL("runtime.mjs", baseUrl);
  // A failed module fetch stays in the browser's module map; a retry needs a new URL.
  if (++attempt > 1) url.searchParams.set("attempt", String(attempt));
  const promise = withTimeout(
    import(/* @vite-ignore */ url.href) as Promise<Partial<NativeRuntime>>,
    messages.runtimeUnavailable,
  )
    .then((loaded) => {
      const required = [
        loaded.mountExcalidraw,
        loaded.createElement,
        loaded.convertToExcalidrawElements,
        loaded.restoreElements,
        loaded.exportToSvg,
      ];
      if (required.some((fn) => typeof fn !== "function")) throw new Error("incomplete runtime");
      return loaded as NativeRuntime;
    })
    .catch(() => {
      moduleLoads.delete(baseUrl);
      throw new Error(messages.runtimeUnavailable);
    });
  moduleLoads.set(baseUrl, promise);
  return promise;
}

function withLocalEmbeds<T extends object>(element: T): T {
  const candidate = element as Record<string, unknown>;
  if (candidate.type !== "embeddable") return element;
  const customData = candidate.customData as Record<string, unknown> | undefined;
  return customData?.learnordie && typeof candidate.id === "string"
    ? { ...element, link: `${CANVAS_EMBED_LINK_PREFIX}${encodeURIComponent(candidate.id)}` }
    : element;
}

function wrapRuntime(native: NativeRuntime, messages: CanvasRuntimeMessages): CanvasRuntime {
  return {
    messages,
    createElement: native.createElement,
    // The skeleton converter passes embeddables through without native defaults.
    // Restore before updateScene, otherwise missing opacity/version makes a new
    // embed invisible until the editor remounts and restores the saved scene.
    convertToExcalidrawElements: <T extends object = CanvasRuntimeElement>(
      elements: readonly object[],
      options?: { regenerateIds?: boolean },
    ) =>
      native
        .restoreElements<T>(native.convertToExcalidrawElements(elements, options), null)
        .map(withLocalEmbeds),
    restoreElements: <T extends object = CanvasRuntimeElement>(
      elements: readonly object[],
      localElements: readonly object[] | null,
    ) => native.restoreElements<T>(elements, localElements).map(withLocalEmbeds),
    // SVG remains static: never use the vendor's foreignObject/iframe export.
    exportToSvg: (options) => native.exportToSvg({ ...options, renderEmbeddables: false }),
    mountExcalidraw(host, initialProps) {
      let disposed = false;
      let props = initialProps as CanvasRuntimeProps;
      let alert: HTMLElement | undefined;
      const normalized = () => ({
        ...props,
        aiEnabled: false,
        isCollaborating: false,
        validateEmbeddable: isCanvasEmbedLink,
        // Internal embed IDs identify our renderers, not navigable web pages.
        onLinkOpen: (element: CanvasRuntimeElement, event: Event) => {
          if (isCanvasEmbedLink(element.link)) event.preventDefault();
        },
        renderEmbeddable: (element: CanvasRuntimeElement, state: CanvasAppState) =>
          props.renderEmbeddable?.(element, state) ??
          native.createElement("div", { role: "note" }, messages.embedUnsupported),
      });
      const mounted = native.mountExcalidraw(host, normalized());
      const failedFonts = new Set<string>();
      const showError = (event: Event) => {
        const faces = (event as Event & { fontfaces?: readonly FontFace[] }).fontfaces ?? [];
        for (const face of faces) {
          if (
            /Assistant|Virgil|Excalifont|Cascadia|Comic Shanns|Liberation|Lilita|Nunito/i.test(
              face.family,
            )
          ) {
            failedFonts.add(face.family);
          }
        }
        if (!failedFonts.size || disposed || alert) return;
        const error = new Error(messages.fontLoadFailed);
        props.onError?.(error);
        alert = document.createElement("aside");
        alert.setAttribute("role", "alert");
        alert.style.cssText =
          "position:absolute;inset:8px 8px auto;z-index:1000;background:#fff4d6;color:#302819;padding:12px;border:1px solid currentColor;border-radius:8px";
        alert.append(document.createTextNode(`${error.message} `));
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = messages.retryFonts;
        retry.addEventListener("click", async () => {
          retry.disabled = true;
          try {
            await requireFonts(messages);
            for (const family of failedFonts) {
              await document.fonts.load(`16px ${JSON.stringify(family)}`);
            }
            failedFonts.clear();
            if (!disposed) {
              alert?.remove();
              alert = undefined;
              mounted.update(normalized());
            }
          } catch {
            retry.textContent = messages.retryFontsFailed;
          } finally {
            retry.disabled = false;
          }
        });
        alert.append(retry);
        host.append(alert);
      };
      document.fonts.addEventListener("loadingerror", showError);
      return {
        update(nextProps) {
          if (disposed) return;
          props = nextProps as CanvasRuntimeProps;
          mounted.update(normalized());
        },
        unmount() {
          if (disposed) return;
          disposed = true;
          document.fonts.removeEventListener("loadingerror", showError);
          alert?.remove();
          mounted.unmount();
        },
      };
    },
  };
}

/**
 * Loads the vendored runtime once per directory: `runtime.mjs` through a same-origin dynamic
 * `import()`, `excalidraw.css` as a stylesheet, then waits for the editor font. Concurrent calls
 * share one load; a failed load is forgotten so the next call retries.
 */
export function loadCanvasRuntime(options: LoadCanvasRuntimeOptions): Promise<CanvasRuntime> {
  const messages = { ...defaultCanvasRuntimeMessages, ...options.messages };
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error(messages.browserRequired));
  }
  const base = new URL(options.assetBaseUrl, document.baseURI);
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  // Never load the editor from a CDN or another origin.
  if (base.origin !== window.location.origin) {
    return Promise.reject(new Error(messages.runtimeUnavailable));
  }
  const baseUrl = base.href;
  const cached = runtimeLoads.get(baseUrl);
  if (cached) return cached;
  (window as RuntimeWindow).EXCALIDRAW_ASSET_PATH = baseUrl;
  const load = Promise.all([
    loadModule(baseUrl, messages),
    loadStyles(baseUrl, messages).then(() => requireFonts(messages)),
  ])
    .then(([native]) => wrapRuntime(native, messages))
    .catch((error: unknown) => {
      runtimeLoads.delete(baseUrl);
      throw error;
    });
  runtimeLoads.set(baseUrl, load);
  return load;
}
