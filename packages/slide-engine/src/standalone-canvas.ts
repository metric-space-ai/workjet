import { canvasSceneSchema, type CanvasScene } from "./excalidraw/canvas-schema";
import { createModellSceneState, modellFallbackDataUri, modellSceneAccents } from "./scenes/modell-state";
import { scene3dSceneKey } from "./scenes/scene-ids";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");

export const STANDALONE_CANVAS_CSP = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; connect-src data:; frame-src about:; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

export function renderStandaloneCanvas(input: CanvasScene, runtimeAvailable: boolean) {
  const scene = canvasSceneSchema.parse(input);
  const snapshots: Record<string, string> = {};
  const active = scene.elements.filter((element) => !element.isDeleted);
  for (const element of active) {
    const embed = element.customData?.learnordie;
    if (embed?.type !== "scene3d") continue;
    const key = scene3dSceneKey(embed.sceneId);
    snapshots[element.id] = modellFallbackDataUri(key, createModellSceneState(false), embed.accent ?? modellSceneAccents[key], embed.caption ?? embed.sceneId);
  }
  const text = active.filter((element) => element.type === "text").map((element) => element.originalText ?? element.text ?? "");
  const embeds = active.filter((element) => element.type === "embeddable");
  return `<div class="ld-native-export" data-native-export-status="${runtimeAvailable ? "loading" : "unsupported"}">
    <p data-native-export-message role="status">${runtimeAvailable ? "Native Canvas-Folie wird lokal gerendert …" : "Native Canvas-Darstellung fehlt in diesem Export. Die aktuellen Canvas-Daten sind unten erhalten; alte Blöcke werden nicht als Ersatz ausgegeben."}</p>
    <noscript><p>Die native Darstellung benötigt JavaScript im Offline-Dokument. Aktuelle Canvas-Texte und eingebettete Originaldaten bleiben erhalten.</p></noscript>
    <div data-native-export-view></div>
    <p class="caption">Native Canvas-Fassung · ${active.length} Elemente. HTML/CSS bleibt isoliert; 3D ist eine statische Ersatzansicht, nicht interaktiv. Serverfunktionen sind offline nicht verfügbar.</p>
    <details data-native-export-accessible><summary>Canvas-Text und Exporthinweise</summary>${text.map((value) => `<p style="white-space:pre-wrap">${escape(value)}</p>`).join("")}${embeds.map((element) => {
      const embed = element.customData!.learnordie!;
      return embed.type === "html" ? `<details><summary>HTML/CSS: ${escape(embed.title)}</summary><pre>${escape(embed.html)}</pre></details>` : `<p>Statische 3D-Ansicht: ${escape(embed.caption ?? embed.sceneId)}</p>`;
    }).join("")}<p>Originale Canvas-Geometrie, Bilddaten und eingebettete Inhalte bleiben in den Exportdaten erhalten. Für nicht mitgelieferte Schriftzeichen verwendet der Browser verfügbare Ersatzschriften.</p></details>
    <script type="application/json" data-native-export-scene>${json({ scene, snapshots })}</script>
  </div>`;
}

/** Trusted offline glue. It has no outer-scope dependencies after serialization. */
export function standaloneCanvasScript() {
  return `(${hydrateStandaloneCanvas.toString()})(${rewriteStandaloneSvg.toString()});`;
}

/** Native SVG may wrap an embed twice; only its innermost anchor is a placeholder. */
export function rewriteStandaloneSvg(svg: SVGSVGElement, createEmbed: (id: string) => SVGElement | null): number {
  const rendered = new Set<string>();
  for (const anchor of Array.from(svg.querySelectorAll("a"))) {
    if (!svg.contains(anchor)) continue;
    // The outer hyperlink wrapper owns the transformed native group. Unwrap it
    // without replacing or detaching that group; process the still-attached leaf.
    if (anchor.querySelector("a")) { anchor.replaceWith(...Array.from(anchor.childNodes)); continue; }
    const link = anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href") ?? "";
    const prefix = "https://learnordie.invalid/embed/";
    let id = "";
    if (link.startsWith(prefix)) {
      try { id = decodeURIComponent(link.slice(prefix.length)); } catch { /* Invalid markers are inert links. */ }
    }
    if (id && rendered.has(id)) throw new Error("Doppelter nativer Embed-Platzhalter.");
    const replacement = id ? createEmbed(id) : null;
    if (!replacement) { anchor.replaceWith(...Array.from(anchor.childNodes)); continue; }
    anchor.replaceWith(replacement);
    rendered.add(id);
  }
  // A <use href="#symbol"> is an image instance, not an outbound hyperlink.
  // Validate fragments against IDs in THIS SVG, without interpolating selectors.
  const localIds = new Set(Array.from(svg.querySelectorAll("[id]")).map((element) => element.getAttribute("id")));
  for (const element of Array.from(svg.querySelectorAll("*"))) {
    for (const attribute of ["href", "xlink:href"]) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const local = /^#[A-Za-z0-9_:.~-]+$/.test(value) && localIds.has(value.slice(1));
      const image = element.localName === "image" && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value);
      if (!local && !image) element.removeAttribute(attribute);
    }
  }
  return rendered.size;
}

function hydrateStandaloneCanvas(rewriteSvg: typeof rewriteStandaloneSvg) {
  const browser = window as Window & { __learnordieOfflineSvg?: (options: object) => Promise<SVGSVGElement> };
  const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";
  const allowedTags = new Set("div span section article aside header footer main nav p h1 h2 h3 h4 h5 h6 strong b em i u s del small sub sup mark code pre blockquote q abbr time address br hr ul ol li dl dt dd table caption thead tbody tfoot tr th td colgroup col figure figcaption img details summary progress meter style svg g path circle ellipse rect line polyline polygon text tspan defs lineargradient radialgradient stop clippath title desc".split(" "));
  const allowedAttributes = new Set("class id style title lang dir role width height alt colspan rowspan scope start reversed open value min max low high optimum datetime viewbox d x y x1 y1 x2 y2 cx cy r rx ry points fill stroke stroke-width opacity transform offset stop-color stop-opacity preserveaspectratio".split(" "));
  function htmlDocument(html: string) {
    if (html.length > 65536) throw new Error("HTML-Inhalt ist zu groß.");
    const template = document.createElement("template");
    template.innerHTML = html;
    const visit = (parent: ParentNode, depth: number) => {
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === 8) { node.remove(); continue; }
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        const tag = element.localName.toLowerCase();
        if (!allowedTags.has(tag) || depth > 32) { element.remove(); continue; }
        for (const attribute of Array.from(element.attributes)) {
          const name = attribute.name.toLowerCase();
          const image = tag === "img" && name === "src" && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(attribute.value);
          if (!image && !allowedAttributes.has(name) && !/^aria-[a-z-]+$/.test(name)) element.removeAttribute(attribute.name);
        }
        visit(element, depth + 1);
      }
    };
    visit(template.content, 0);
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html,body{margin:0;min-height:100%;box-sizing:border-box}body{padding:16px;font-family:system-ui,sans-serif;color:#20252b;overflow-wrap:anywhere}*,*:before,*:after{box-sizing:inherit}img,svg{max-width:100%}</style></head><body>${template.innerHTML}</body></html>`;
  }
  let started = false;
  async function run() {
    if (started || !browser.__learnordieOfflineSvg) return;
    started = true;
    for (const root of document.querySelectorAll<HTMLElement>(".ld-native-export")) {
      const message = root.querySelector<HTMLElement>("[data-native-export-message]")!;
      let timer = 0;
      try {
        const { scene, snapshots } = JSON.parse(root.querySelector("[data-native-export-scene]")!.textContent!) as { scene: CanvasScene; snapshots: Record<string, string> };
        const embeds = new Map(scene.elements.filter((element) => !element.isDeleted && element.customData?.learnordie).map((element) => [element.id, element]));
        const elements = scene.elements.filter((element) => !element.isDeleted).map((element) => ({ ...element,
          link: element.type === "embeddable" ? `https://learnordie.invalid/embed/${encodeURIComponent(element.id)}` : null,
        }));
        if (!elements.length) {
          message.textContent = "Leere Canvas-Folie (keine sichtbaren Elemente).";
          root.dataset.nativeExportStatus = "ready";
          continue;
        }
        const svg = await Promise.race([
          browser.__learnordieOfflineSvg({ elements, files: scene.files, renderEmbeddables: false, appState: { viewBackgroundColor: scene.backgroundColor, exportBackground: true }, exportPadding: 24 }),
          new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("Native Darstellung überschreitet das Zeitlimit.")), 20000); }),
        ]);
        // Native SVG preserves each anchor's exact transform, bounds, order and
        // frame clipping. Replace that inert placeholder in-place, not an overlay
        // with guessed coordinates or a second legacy renderer.
        const renderedEmbeds = rewriteSvg(svg, (id) => {
          const element = embeds.get(id);
          if (!element) return null;
          const embed = element.customData!.learnordie!;
          const foreign = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
          foreign.setAttribute("width", String(element.width));
          foreign.setAttribute("height", String(element.height));
          foreign.setAttribute("data-native-embed-id", id);
          const box = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
          box.style.cssText = "width:100%;height:100%;overflow:hidden;background:white;display:flex;flex-direction:column";
          if (embed.type === "html") {
            const iframe = document.createElement("iframe");
            iframe.title = embed.title;
            iframe.setAttribute("sandbox", "");
            iframe.referrerPolicy = "no-referrer";
            iframe.style.cssText = "width:100%;height:100%;border:0;display:block";
            iframe.srcdoc = htmlDocument(embed.html);
            box.append(iframe);
          } else {
            if (!snapshots[id]?.startsWith("data:image/svg+xml")) throw new Error("Statische 3D-Ansicht fehlt.");
            const image = document.createElement("img");
            image.alt = embed.caption ?? embed.sceneId;
            image.src = snapshots[id];
            image.style.cssText = "display:block;width:100%;min-height:0;flex:1;object-fit:contain";
            const caption = document.createElement("small");
            caption.textContent = `${embed.caption ?? embed.sceneId} · Statische 3D-Ansicht (offline nicht interaktiv)`;
            box.append(image, caption);
          }
          foreign.append(box);
          return foreign;
        });
        if (renderedEmbeds !== embeds.size) throw new Error("Nicht alle Einbettungen konnten nativ dargestellt werden.");
        svg.style.cssText = "display:block;width:100%;height:auto;max-width:100%";
        root.querySelector("[data-native-export-view]")!.replaceChildren(svg);
        root.dataset.nativeExportStatus = "ready";
        message.textContent = "Native Canvas-Folie lokal gerendert.";
      } catch {
        root.dataset.nativeExportStatus = "failed";
        message.setAttribute("role", "alert");
        message.textContent = "Native Canvas-Darstellung fehlgeschlagen. Aktuelle Texte und vollständige Canvas-Daten bleiben erhalten; bitte mit einem aktuellen Browser erneut öffnen. Es wird keine veraltete Block-Fassung angezeigt.";
        root.querySelector("details")?.setAttribute("open", "");
      } finally { window.clearTimeout(timer); }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
  }
  window.addEventListener("learnordie-offline-native-ready", () => { void run(); }, { once: true });
  void run();
  const failStartup = () => {
    if (started) return;
    document.querySelectorAll<HTMLElement>(".ld-native-export").forEach((root) => {
      root.dataset.nativeExportStatus = "failed";
      const message = root.querySelector<HTMLElement>("[data-native-export-message]")!;
      message.setAttribute("role", "alert");
      message.textContent = "Die eingebettete Zeichen-Engine konnte nicht starten. Canvas-Daten und Texte bleiben erhalten; bitte einen aktuellen Browser mit DecompressionStream verwenden.";
    });
  };
  window.addEventListener("learnordie-offline-native-failed", failStartup, { once: true });
  window.setTimeout(failStartup, 20000);
}
