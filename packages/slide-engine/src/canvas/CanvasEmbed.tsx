// Workjet port of learnordie `src/components/excalidraw/CanvasEmbed.tsx` (d94f8a59).
import { Component, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Scene3DBlockRenderer } from "../components/Scene3DBlockRenderer";
import type { Scene3DBlock } from "../components/types";
import { scene3dSceneIdValues } from "../schema";
import { isBusinessSceneId } from "../scenes/business-data";
import type { CanvasRuntime, CanvasRuntimeElement, CanvasRuntimeMessages } from "./runtime";

export const MAX_CANVAS_HTML_LENGTH = 65_536;
export const CANVAS_HTML_SANDBOX = "";
export const CANVAS_HTML_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

type SceneEmbed = {
  type: "scene3d";
  sceneId: string;
  caption?: string;
  accent?: string;
  /** Business scene data; passed through as `block.data`, validated by the scene renderer. */
  data?: unknown;
};
type HtmlEmbed = { type: "html"; html: string; title?: string };
export type CanvasEmbedData = SceneEmbed | HtmlEmbed;

function isKnownSceneId(sceneId: string): boolean {
  return (
    (scene3dSceneIdValues as readonly string[]).includes(sceneId) || isBusinessSceneId(sceneId)
  );
}

/** Revalidate at the rendering boundary; persisted/imported scenes are untrusted. */
export function parseCanvasEmbed(element: CanvasRuntimeElement): CanvasEmbedData | null {
  if (element.type !== "embeddable") return null;
  const data = element.customData?.learnordie;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (
    value.type === "html" &&
    typeof value.html === "string" &&
    value.html.length <= MAX_CANVAS_HTML_LENGTH
  ) {
    return {
      type: "html",
      html: value.html,
      ...(typeof value.title === "string" ? { title: value.title.slice(0, 240) } : {}),
    };
  }
  if (
    value.type === "scene3d" &&
    typeof value.sceneId === "string" &&
    isKnownSceneId(value.sceneId)
  ) {
    return {
      type: "scene3d",
      sceneId: value.sceneId,
      ...(typeof value.caption === "string" ? { caption: value.caption.slice(0, 240) } : {}),
      ...(typeof value.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(value.accent)
        ? { accent: value.accent }
        : {}),
      ...(value.data !== undefined ? { data: value.data } : {}),
    };
  }
  return null;
}

const ALLOWED_HTML_TAGS = new Set(
  "div span section article aside header footer main nav p h1 h2 h3 h4 h5 h6 strong b em i u s del small sub sup mark code pre blockquote q abbr time address br hr ul ol li dl dt dd table caption thead tbody tfoot tr th td colgroup col figure figcaption img details summary progress meter style svg g path circle ellipse rect line polyline polygon text tspan defs lineargradient radialgradient stop clippath title desc".split(
    " ",
  ),
);
const ALLOWED_HTML_ATTRIBUTES = new Set(
  "class id style title lang dir role width height alt colspan rowspan scope start reversed open value min max low high optimum datetime viewbox d x y x1 y1 x2 y2 cx cy r rx ry points fill stroke stroke-width opacity transform offset stop-color stop-opacity preserveaspectratio".split(
    " ",
  ),
);

/**
 * Parse into an INERT, detached template, never into the application's mounted DOM.
 * No script (including event attributes), link, form, refresh, remote URL, nested
 * frame, or active SVG is retained. CSP + opaque sandbox are independent layers.
 */
export function buildCanvasHtmlDocument(html: string, tooLarge: string): string {
  if (html.length > MAX_CANVAS_HTML_LENGTH) throw new Error(tooLarge);
  const template = document.createElement("template");
  template.innerHTML = html;
  const visit = (parent: ParentNode, depth: number) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 8) {
        node.remove();
        continue;
      }
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const tag = element.localName.toLowerCase();
      if (!ALLOWED_HTML_TAGS.has(tag) || depth > 32) {
        element.remove();
        continue;
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const dataImage =
          tag === "img" &&
          name === "src" &&
          /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(attribute.value);
        if (!dataImage && !ALLOWED_HTML_ATTRIBUTES.has(name) && !/^aria-[a-z-]+$/.test(name)) {
          element.removeAttribute(attribute.name);
        }
      }
      visit(element, depth + 1);
    }
  };
  visit(template.content, 0);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CANVAS_HTML_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;box-sizing:border-box}body{padding:16px;font-family:system-ui,sans-serif;color:#20252b;overflow-wrap:anywhere}*,*:before,*:after{box-sizing:inherit}img,svg{max-width:100%}</style></head><body>${template.innerHTML}</body></html>`;
}

class EmbedErrorBoundary extends Component<
  { messages: CanvasRuntimeMessages; children?: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <div role="alert">
        {this.props.messages.embedFailed}{" "}
        <button type="button" onClick={() => this.setState({ failed: false })}>
          {this.props.messages.embedRetry}
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}

export function CanvasEmbedContent({
  element,
  messages,
}: {
  element: CanvasRuntimeElement;
  messages: CanvasRuntimeMessages;
}) {
  const data = parseCanvasEmbed(element);
  if (!data) return <div role="note">{messages.embedUnsupported}</div>;
  if (data.type === "html") {
    return (
      <iframe
        className="learnordie-canvas-html"
        title={data.title || messages.htmlTitle}
        sandbox={CANVAS_HTML_SANDBOX}
        referrerPolicy="no-referrer"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'"
        srcDoc={buildCanvasHtmlDocument(data.html, messages.htmlTooLarge)}
        style={{ width: "100%", height: "100%", display: "block", border: 0, background: "white" }}
      />
    );
  }
  // Business scene ids and `data` are accepted here before the shared schema lists them;
  // the scene renderer owns their validation and fallback.
  const block = {
    id: element.id,
    type: "scene3d",
    sceneId: data.sceneId,
    altText: data.caption || `${messages.sceneAlt}: ${data.sceneId}`,
    ...(data.caption ? { caption: data.caption } : {}),
    ...(data.accent ? { accent: data.accent } : {}),
    ...(data.data !== undefined ? { data: data.data } : {}),
  } as Scene3DBlock;
  return (
    <div
      className="learnordie-canvas-scene"
      style={{ width: "100%", height: "100%", overflow: "auto" }}
    >
      <Scene3DBlockRenderer block={block} />
    </div>
  );
}

// A stable class adapter is rendered by VENDOR React, but invokes NO hooks.
// The DOM leaf owns a separate MAIN React root. Hooks in Scene3DBlockRenderer
// therefore see the matching dispatcher. Root disposal waits until the vendor
// commit has completed, avoiding nested synchronous-unmount React warnings.
type BridgeProps = { element: CanvasRuntimeElement };
const bridgeTypes = new WeakMap<
  CanvasRuntime,
  new (props: BridgeProps) => Component<BridgeProps>
>();

export function renderCanvasEmbeddable(
  runtime: CanvasRuntime,
  element: CanvasRuntimeElement,
): ReactNode {
  let Bridge = bridgeTypes.get(runtime);
  if (!Bridge) {
    class CanvasEmbedBridge extends Component<BridgeProps> {
      host: HTMLDivElement | null = null;
      root: Root | null = null;
      captureHost = (node: HTMLDivElement | null) => {
        this.host = node;
      };
      override componentDidMount() {
        if (!this.host) return;
        this.root = createRoot(this.host);
        this.paint();
      }
      override componentDidUpdate() {
        this.paint();
      }
      override componentWillUnmount() {
        const ownedRoot = this.root;
        this.root = null;
        if (ownedRoot) queueMicrotask(() => ownedRoot.unmount());
      }
      paint() {
        this.root?.render(
          createElement(
            EmbedErrorBoundary,
            { key: this.props.element.id, messages: runtime.messages },
            createElement(CanvasEmbedContent, {
              element: this.props.element,
              messages: runtime.messages,
            }),
          ),
        );
      }
      override render() {
        return runtime.createElement("div", {
          ref: this.captureHost,
          className: "learnordie-canvas-embed-host",
          "data-canvas-embed-id": this.props.element.id,
          style: {
            width: "100%",
            height: "100%",
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
            background: "transparent",
          },
        }) as ReactNode;
      }
    }
    Bridge = CanvasEmbedBridge;
    bridgeTypes.set(runtime, Bridge);
  }
  // Never return null: that would activate Excalidraw's generic external iframe.
  return runtime.createElement(Bridge, { key: element.id, element }) as ReactNode;
}
