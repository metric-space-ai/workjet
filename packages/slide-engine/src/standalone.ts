import type { SlideAssetRef, SlideBlock, SlideDocument, SlideNode } from "./schema";
import { createModellSceneState, modellFallbackDataUri, modellSceneAccents } from "./scenes/modell-state";
import { scene3dSceneKey } from "./scenes/scene-ids";
import { renderStandaloneCanvas, standaloneCanvasScript, STANDALONE_CANVAS_CSP } from "./standalone-canvas";

export const SLIDE_STANDALONE_RENDERER_VERSION = "learnordie-slide-standalone-v2" as const;

export type StandaloneAnswerOption = {
  key: string;
  text: string;
  correct: boolean;
};

export type StandaloneQuestion = {
  level: string;
  text: string;
  answers: StandaloneAnswerOption[];
  explanation: string;
};

export type StandaloneAudioSource = {
  path: string;
  originalName: string;
  mediaType: string;
  src: string;
  sha256: string;
  source: "upload" | "fallback" | string;
};

export type StandaloneMetadata = {
  version: string;
  exportedAt: string;
  title?: string;
  seriesTitle?: string;
  payloadSha256?: string;
  manifestSha256?: string;
  selfContained?: boolean;
  externalAssetCount?: number;
};

export type RenderStandaloneSlideDocumentInput = {
  document: SlideDocument;
  metadata: StandaloneMetadata;
  questions?: StandaloneQuestion[];
  audioSources?: StandaloneAudioSource[];
  dataJson: string;
  manifestJson: string;
  assetUrlMode?: "inline-only" | "relative-or-inline" | "allow-external";
  nativeCanvasRuntime?: { source: string; sha256: string; licenses: string };
};

export function standaloneStyles() {
  return `
    :root { color-scheme: light; --ink: #071722; --muted: #506675; --line: #b9cbd6; --panel: #fbfdfe; --soft: #edf5f8; --good: #d9f2e4; --bad: #ffe0dd; --accent: #c7881b; --blue: #1f79a8; --green: #2d8e57; --red: #b84a42; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #f6fafc; }
    main { min-height: 100vh; padding: clamp(20px, 5vw, 72px); }
    header { display: grid; gap: 18px; max-width: 1040px; }
    .skip-link { position: absolute; top: 12px; left: 12px; z-index: 10; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; border-radius: 8px; background: var(--ink); color: white; font-weight: 850; }
    .skip-link:focus { width: auto; height: auto; padding: 10px 12px; overflow: visible; clip: auto; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    h1 { max-width: 980px; margin: 0; font-size: clamp(36px, 7vw, 76px); line-height: 1.02; letter-spacing: 0; }
    h2 { margin: 0 0 16px; font-size: clamp(24px, 4vw, 42px); line-height: 1.08; }
    h3 { margin: 0 0 16px; font-size: clamp(22px, 3.5vw, 38px); line-height: 1.1; }
    h4 { margin: 0 0 10px; font-size: clamp(18px, 2.4vw, 28px); line-height: 1.18; }
    p { margin: 0; }
    .kicker, .eyebrow { margin: 0; color: var(--muted); font-size: 14px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.02em; }
    .meta, .manifest, .audio-block, .ld-standalone-slide, .question { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
    .meta, .manifest, .audio-block { display: grid; gap: 8px; max-width: 980px; padding: 14px 16px; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
    .meta strong, .manifest strong, .audio-block strong { color: var(--ink); }
    audio { width: min(100%, 560px); }
    .ld-standalone-section { display: grid; gap: 18px; max-width: 1080px; margin-top: 36px; }
    .ld-standalone-slide, .question { display: grid; gap: clamp(14px, 2vw, 24px); padding: clamp(18px, 3vw, 32px); }
    .ld-slide-meta { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 13px; font-weight: 780; }
    .ld-slide-body { display: grid; gap: clamp(14px, 2vw, 22px); min-width: 0; }
    .ld-native-export { min-width: 0; display: grid; gap: 12px; }
    .ld-native-export details { overflow-wrap: anywhere; }
    .ld-native-export pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    [data-native-export-status="failed"], [data-native-export-status="unsupported"] { border: 2px solid #a34232; padding: 12px; }
    [data-native-export-view] { min-width: 0; }
    .slide-doc-block { min-width: 0; overflow-wrap: anywhere; }
    .slide-doc-block[data-block-type="paragraph"], .question p { max-width: 820px; font-size: clamp(17px, 2.4vw, 22px); line-height: 1.45; }
    .slide-doc-block ul, .slide-doc-block ol { display: grid; gap: 8px; margin: 0; padding-left: 22px; font-size: clamp(17px, 2.2vw, 21px); line-height: 1.38; }
    .definition, .callout, .comparison-side, .code-block, .quote-block, .chart-block, .figure-placeholder { border: 1px solid var(--line); border-radius: 10px; background: var(--soft); padding: 14px 16px; }
    .definition { border-left: 5px solid var(--blue); }
    .callout { border-left: 5px solid var(--accent); }
    .callout[data-tone="warning"] { border-left-color: var(--red); }
    .callout[data-tone="tip"] { border-left-color: var(--green); }
    .figure-block { display: grid; gap: 8px; margin: 0; }
    .figure-block img { max-width: 100%; max-height: 520px; object-fit: contain; border: 1px solid var(--line); border-radius: 10px; background: white; }
    figcaption, .caption { color: var(--muted); font-size: 13px; font-weight: 700; line-height: 1.35; }
    .formula-block, .code-block { overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; white-space: pre-wrap; word-break: break-word; }
    .formula-block { font-size: clamp(18px, 2.2vw, 28px); }
    .comparison { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); gap: 12px; }
    .process { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
    .process li { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 12px; }
    .process-index { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 50%; background: var(--ink); color: white; font-weight: 900; }
    .chart-plot { display: grid; align-items: end; grid-template-columns: repeat(auto-fit, minmax(42px, 1fr)); gap: 10px; min-height: 180px; }
    .chart-item { display: grid; align-items: end; gap: 6px; height: 100%; text-align: center; color: var(--muted); font-size: 12px; font-weight: 800; }
    .chart-bar { align-self: end; min-height: 8px; border-radius: 8px 8px 3px 3px; background: linear-gradient(180deg, var(--blue), var(--accent)); }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 10px; }
    table { width: 100%; border-collapse: collapse; font-size: clamp(14px, 1.7vw, 18px); }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: var(--soft); font-weight: 850; }
    .quiz-anchor { display: inline-flex; justify-self: start; border: 1px solid var(--accent); border-radius: 999px; background: #fff5dd; padding: 8px 12px; font-size: 13px; font-weight: 850; }
    .answers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 4px; }
    button { min-height: 56px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 8px; background: #dceaf1; color: var(--ink); font: inherit; font-weight: 760; text-align: left; cursor: pointer; }
    button:focus-visible, audio:focus-visible, .skip-link:focus-visible { outline: 4px solid #1e6b9a; outline-offset: 3px; }
    button span { display: inline-grid; place-items: center; width: 30px; height: 30px; margin-right: 10px; border-radius: 999px; background: rgba(255,255,255,0.74); color: var(--muted); font-weight: 900; }
    button[aria-disabled="true"] { cursor: default; }
    button.correct { border-color: #7eba95; background: var(--good); }
    button.incorrect { border-color: #e6958d; background: var(--bad); }
    .feedback { min-height: 28px; margin: 14px 0 0; color: var(--muted); font-weight: 850; }
    .explanation { color: var(--muted); }
    .manifest ul { margin: 0; padding-left: 18px; }
    @media (max-width: 700px) {
      main { padding: 16px; }
      .answers { grid-template-columns: 1fr; }
      button { min-height: 52px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; }
    }
    @media print {
      @page { size: A4 portrait; margin: 14mm; }
      html { scroll-behavior: auto; }
      body { background: white; color: #000; }
      main { min-height: auto; padding: 0; }
      .skip-link, audio { display: none !important; }
      header, .meta, .manifest, .audio-block { max-width: none; break-inside: avoid; page-break-inside: avoid; }
      h1 { font-size: 32pt; }
      h2 { font-size: 22pt; }
      h3 { font-size: 18pt; }
      h4 { font-size: 13pt; }
      .ld-standalone-section { display: block; max-width: none; margin-top: 12mm; }
      .ld-standalone-slide, .question {
        display: grid;
        min-height: 182mm;
        margin: 0 0 10mm;
        padding: 10mm;
        border-color: #8fa2ad;
        background: white;
        box-shadow: none;
        break-after: page;
        break-inside: avoid;
        page-break-after: always;
        page-break-inside: avoid;
      }
      .ld-standalone-slide:last-of-type, .question:last-of-type {
        break-after: auto;
        page-break-after: auto;
      }
      #questions { break-before: page; page-break-before: always; }
      .slide-doc-block[data-block-type="paragraph"], .question p { font-size: 12pt; line-height: 1.35; }
      .slide-doc-block ul, .slide-doc-block ol { font-size: 11pt; line-height: 1.3; }
      .figure-block img { max-height: 96mm; }
      .answers { grid-template-columns: 1fr; }
      button {
        min-height: auto;
        padding: 6pt 8pt;
        border-color: #7e929d;
        background: white;
        color: #000;
      }
      button[data-correct="true"] { border-left: 5pt solid var(--green); }
      .feedback { display: none; }
    }
  `.trim();
}

export function standaloneScript() {
  return `
    (() => {
      function moveAnswerFocus(button, direction) {
        const answers = Array.from(button.closest("[data-question]").querySelectorAll("[data-answer]"));
        const currentIndex = answers.indexOf(button);
        if (currentIndex < 0) return;
        const nextIndex = direction === "first"
          ? 0
          : direction === "last"
            ? answers.length - 1
            : (currentIndex + direction + answers.length) % answers.length;
        answers[nextIndex].focus();
      }

      document.querySelectorAll("[data-question]").forEach((question) => {
        question.addEventListener("keydown", (event) => {
          const button = event.target.closest("[data-answer]");
          if (!button || !question.contains(button)) return;
          if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            moveAnswerFocus(button, 1);
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            event.preventDefault();
            moveAnswerFocus(button, -1);
          }
          if (event.key === "Home") {
            event.preventDefault();
            moveAnswerFocus(button, "first");
          }
          if (event.key === "End") {
            event.preventDefault();
            moveAnswerFocus(button, "last");
          }
        });

        question.addEventListener("click", (event) => {
          const button = event.target.closest("[data-answer]");
          if (!button || !question.contains(button)) return;
          if (question.dataset.answered === "true") return;
          question.dataset.answered = "true";
          const isCorrect = button.dataset.correct === "true";
          question.querySelectorAll("[data-answer]").forEach((answer) => {
            answer.classList.toggle("correct", answer.dataset.correct === "true");
            answer.classList.toggle("incorrect", answer === button && !isCorrect);
            answer.setAttribute("aria-disabled", "true");
            answer.setAttribute("aria-pressed", answer === button ? "true" : "false");
          });
          const feedback = question.querySelector("[data-feedback]");
          if (feedback) {
            feedback.textContent = isCorrect ? "Richtig." : "Nicht korrekt. Die richtige Antwort ist grün markiert.";
            feedback.focus({ preventScroll: true });
          }
        });
      });
    })();
  `.trim() + "\n" + standaloneCanvasScript();
}

export function renderStandaloneSlideDocumentHtml(input: RenderStandaloneSlideDocumentInput) {
  const styles = standaloneStyles();
  const script = standaloneScript();
  const title = input.metadata.title ?? input.document.title;
  const seriesTitle = input.metadata.seriesTitle ?? "learnordie";
  const selfContained = input.metadata.selfContained ?? true;
  const externalAssetCount = input.metadata.externalAssetCount ?? 0;
  const hasNativeCanvas = input.document.slides.some((slide) => Boolean(slide.canvas));

  return `<!doctype html>
<html lang="${escapeAttribute(input.document.language)}">
<head>
  <meta charset="utf-8">
  ${hasNativeCanvas ? `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(STANDALONE_CANVAS_CSP)}">` : ""}
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(seriesTitle)} - ${escapeHtml(title)}</title>
  <style>${styles}</style>
</head>
<body>
  <a class="skip-link" href="#slides">Zum Folieninhalt springen</a>
  <main id="inhalt" aria-labelledby="export-title" data-slide-engine="${SLIDE_STANDALONE_RENDERER_VERSION}" data-slide-document-id="${escapeAttribute(input.document.id)}" data-slide-document-version="${escapeAttribute(input.document.schemaVersion)}" data-print-profile="browser-pdf-a4">
    <header>
      <p class="kicker">${escapeHtml(seriesTitle)}</p>
      <h1 id="export-title">${escapeHtml(title)}</h1>
    </header>
    <section class="meta" aria-label="Export-Metadaten">
      <strong>Standalone Export ${escapeHtml(input.metadata.version)}</strong>
      <span>Exportiert: ${escapeHtml(input.metadata.exportedAt)}</span>
      ${input.metadata.payloadSha256 ? `<span>Payload SHA-256: ${escapeHtml(input.metadata.payloadSha256)}</span>` : ""}
      ${input.metadata.manifestSha256 ? `<span>Manifest SHA-256: ${escapeHtml(input.metadata.manifestSha256)}</span>` : ""}
      <span>Self-contained: ${selfContained ? "ja" : "nein"}, externe Assets: ${externalAssetCount}</span>
      <span>Server-KI, Analytics und Synchronisation sind in diesem Offline-Export nicht enthalten.</span>
    </section>
    ${renderAudioBlock(input.audioSources ?? [])}
    <section class="manifest" aria-label="Offline-Manifest">
      <strong>Offline-Manifest</strong>
      <span>Alle Asset-Prüfsummen sind im HTML eingebettet.</span>
      <ul data-manifest-assets></ul>
    </section>
    <section id="slides" class="ld-standalone-section" aria-labelledby="slides-title">
      <h2 id="slides-title" class="sr-only">Folien</h2>
      ${renderSlides(input.document, input.assetUrlMode ?? "inline-only", Boolean(input.nativeCanvasRuntime))}
    </section>
    ${input.nativeCanvasRuntime ? `<details><summary>Lizenzen der eingebetteten Zeichen-Engine und Schriften</summary><pre>${escapeHtml(input.nativeCanvasRuntime.licenses)}</pre></details>` : ""}
    <section id="questions" class="ld-standalone-section" aria-labelledby="questions-title">
      <h2 id="questions-title">Eingebettete Fragen</h2>
      ${renderQuestions(input.questions ?? [])}
    </section>
  </main>
  <script type="application/json" id="learnbuddy-data">${escapeJsonForScript(input.dataJson)}</script>
  <script type="application/json" id="learnbuddy-manifest">${escapeJsonForScript(input.manifestJson)}</script>
  <script>
    (() => {
      const manifestNode = document.getElementById("learnbuddy-manifest");
      const list = document.querySelector("[data-manifest-assets]");
      if (!manifestNode || !list) return;
      try {
        const manifest = JSON.parse(manifestNode.textContent || "{}");
        (manifest.assets || []).forEach((asset) => {
          const item = document.createElement("li");
          item.textContent = [asset.path, asset.sha256].filter(Boolean).join(" · ");
          list.appendChild(item);
        });
      }
      catch {}
    })();
  </script>
  <script>${script}</script>
  ${hasNativeCanvas && input.nativeCanvasRuntime ? `<script type="module" data-native-runtime-sha256="${escapeAttribute(input.nativeCanvasRuntime.sha256)}">${input.nativeCanvasRuntime.source.replace(/<\/script/gi, "<\\/script")}</script>` : ""}
</body>
</html>`;
}

function renderSlides(document: SlideDocument, assetUrlMode: RenderStandaloneSlideDocumentInput["assetUrlMode"], nativeRuntimeAvailable: boolean) {
  const assets = new Map(document.assets.map((asset) => [asset.id, asset]));
  return document.slides
    .map((slide, index) => renderSlide(slide, index + 1, document.slides.length, assets, assetUrlMode, nativeRuntimeAvailable))
    .join("");
}

function renderSlide(
  slide: SlideNode,
  slideNumber: number,
  slideCount: number,
  assets: Map<string, SlideAssetRef>,
  assetUrlMode: RenderStandaloneSlideDocumentInput["assetUrlMode"],
  nativeRuntimeAvailable: boolean
) {
  return `
    <article class="ld-standalone-slide" id="${escapeAttribute(slide.id)}" aria-labelledby="${escapeAttribute(slide.id)}-title" data-slide-id="${escapeAttribute(slide.id)}" data-layout="${escapeAttribute(slide.layout)}" data-intent="${escapeAttribute(slide.intent)}">
      <div class="ld-slide-meta">
        <span>${escapeHtml(sourceSummary(slide.sourceRefs.length))}</span>
        <span>${slideNumber} / ${slideCount}</span>
      </div>
      <h3 id="${escapeAttribute(slide.id)}-title">${escapeHtml(slide.title)}</h3>
      <div class="ld-slide-body">
        ${slide.canvas ? renderStandaloneCanvas(slide.canvas, nativeRuntimeAvailable) : visibleBodyBlocks(slide).map((block) => renderBlock(block, assets, assetUrlMode)).join("")}
      </div>
    </article>`;
}

function renderBlock(
  block: SlideBlock,
  assets: Map<string, SlideAssetRef>,
  assetUrlMode: RenderStandaloneSlideDocumentInput["assetUrlMode"]
): string {
  const dataAttrs = `data-block-id="${escapeAttribute(block.id)}" data-block-type="${escapeAttribute(block.type)}"`;
  switch (block.type) {
    case "heading": {
      const level = Math.min(Math.max(block.level ?? 2, 2), 4);
      return `<h${level} class="slide-doc-block" ${dataAttrs}>${escapeHtml(block.text)}</h${level}>`;
    }
    case "paragraph":
      return `<p class="slide-doc-block" ${dataAttrs}>${escapeHtml(block.text)}</p>`;
    case "bulletList":
      return `<ul class="slide-doc-block" ${dataAttrs}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    case "numberedList":
      return `<ol class="slide-doc-block" ${dataAttrs}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`;
    case "definition":
      return `<section class="slide-doc-block definition" ${dataAttrs}><h4>${escapeHtml(block.term)}</h4><p>${escapeHtml(block.definition)}</p>${block.example ? `<p class="caption">Beispiel: ${escapeHtml(block.example)}</p>` : ""}</section>`;
    case "callout":
      return `<aside class="slide-doc-block callout" ${dataAttrs} data-tone="${escapeAttribute(block.tone)}">${block.title ? `<h4>${escapeHtml(block.title)}</h4>` : ""}<p>${escapeHtml(block.text)}</p></aside>`;
    case "figure":
      return renderFigureBlock(block, assets, assetUrlMode);
    case "formula": {
      const formula = block.latex ?? block.mathMl ?? "";
      return `<figure class="slide-doc-block figure-block" ${dataAttrs}><pre class="formula-block" role="math"><code>${escapeHtml(formula)}</code></pre>${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
    }
    case "table":
      return `<figure class="slide-doc-block figure-block" ${dataAttrs}><div class="table-wrap"><table>${block.caption ? `<caption>${escapeHtml(block.caption)}</caption>` : ""}<thead><tr>${block.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${block.rows.map((row) => `<tr>${block.columns.map((_column, index) => `<td>${escapeHtml(row[index] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div></figure>`;
    case "chart":
      return renderChartBlock(block, dataAttrs);
    case "process":
      return `<ol class="slide-doc-block process" ${dataAttrs}>${block.steps.map((step, index) => `<li><span class="process-index">${index + 1}</span><div><h4>${escapeHtml(step.title)}</h4>${step.text ? `<p>${escapeHtml(step.text)}</p>` : ""}</div></li>`).join("")}</ol>`;
    case "comparison":
      return `<section class="slide-doc-block comparison" ${dataAttrs}>${renderComparisonSide(block.left)}${renderComparisonSide(block.right)}</section>`;
    case "code":
      return `<figure class="slide-doc-block figure-block" ${dataAttrs}><pre class="code-block"><code>${escapeHtml(block.code)}</code></pre>${block.caption ? `<figcaption>${escapeHtml(block.language)} · ${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
    case "quote":
      return `<blockquote class="slide-doc-block quote-block" ${dataAttrs}><p>${escapeHtml(block.text)}</p>${block.attribution ? `<footer class="caption">${escapeHtml(block.attribution)}</footer>` : ""}</blockquote>`;
    case "quizAnchor":
      return `<span class="slide-doc-block quiz-anchor" ${dataAttrs} data-quiz-anchor="${escapeAttribute(block.anchorId)}">Niveau ${escapeHtml(block.level)}${block.prompt ? ` · ${escapeHtml(block.prompt)}` : ""}</span>`;
    case "spacer":
      return `<span class="slide-doc-block" ${dataAttrs} aria-hidden="true" style="display:block;height:${block.size === "large" ? 40 : block.size === "medium" ? 22 : 10}px"></span>`;
    case "scene3d":
      return renderScene3DBlock(block, dataAttrs);
  }
}

// Der Export bleibt ohne WebGL-Laufzeit: die Szene erscheint als 2D-Ersatzansicht
// der Vorlage, der interaktive Teil lebt in der App.
function renderScene3DBlock(block: Extract<SlideBlock, { type: "scene3d" }>, dataAttrs: string) {
  const key = scene3dSceneKey(block.sceneId);
  const accent = block.accent ?? modellSceneAccents[key];
  const src = modellFallbackDataUri(key, createModellSceneState(false), accent, block.altText);
  return `<figure class="slide-doc-block figure-block scene3d-block" ${dataAttrs} data-scene-id="${escapeAttribute(block.sceneId)}"><img src="${escapeAttribute(src)}" alt="${escapeAttribute(block.altText)}"><figcaption>${escapeHtml(block.caption ?? block.altText)} · Interaktive 3D-Fassung in learnordie.app</figcaption></figure>`;
}

function renderFigureBlock(
  block: Extract<SlideBlock, { type: "figure" }>,
  assets: Map<string, SlideAssetRef>,
  assetUrlMode: RenderStandaloneSlideDocumentInput["assetUrlMode"]
) {
  const asset = assets.get(block.assetId);
  const safeUrl = standaloneSafeAssetUrl(asset?.url, assetUrlMode);
  const label = block.caption ?? asset?.title ?? block.assetId;
  const alt = block.altText ?? asset?.altText ?? asset?.description ?? label;
  return `<figure class="slide-doc-block figure-block" data-block-id="${escapeAttribute(block.id)}" data-block-type="${escapeAttribute(block.type)}" data-asset-id="${escapeAttribute(block.assetId)}">${safeUrl ? `<img src="${escapeAttribute(safeUrl)}" alt="${escapeAttribute(alt)}">` : `<div class="figure-placeholder" role="img" aria-label="${escapeAttribute(alt)}">${escapeHtml(label)}</div>`}${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
}

function renderChartBlock(block: Extract<SlideBlock, { type: "chart" }>, dataAttrs: string) {
  const series = normalizeChartData(block.data);
  return `<figure class="slide-doc-block chart-block" ${dataAttrs}>${block.title ? `<h4>${escapeHtml(block.title)}</h4>` : ""}<div class="chart-plot" role="img" aria-label="${escapeAttribute(block.title ?? block.caption ?? `${block.chartType} chart`)}">${series.map((item) => `<span class="chart-item"><span class="chart-bar" style="height:${Math.max(8, item.ratio * 100)}%" aria-label="${escapeAttribute(`${item.label}: ${item.value}`)}"></span><span>${escapeHtml(item.label)}</span></span>`).join("")}</div>${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ""}</figure>`;
}

function renderComparisonSide(side: Extract<SlideBlock, { type: "comparison" }>["left"]) {
  return `<div class="comparison-side"><h4>${escapeHtml(side.title)}</h4>${side.body ? `<p>${escapeHtml(side.body)}</p>` : ""}${side.items?.length ? `<ul>${side.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}</div>`;
}

function renderQuestions(questions: StandaloneQuestion[]) {
  if (questions.length === 0) {
    return `<p class="caption">Keine Fragen in diesem Standalone-Export.</p>`;
  }

  return questions
    .map((question, index) => `
      <article class="question" id="frage-${index + 1}" data-question aria-labelledby="frage-${index + 1}-title" aria-describedby="frage-${index + 1}-feedback frage-${index + 1}-explanation">
        <h3 id="frage-${index + 1}-title">Niveau ${escapeHtml(question.level)}</h3>
        <p>${escapeHtml(question.text)}</p>
        <div class="answers" role="group" aria-label="Antwortoptionen zu Frage ${index + 1}">
          ${question.answers.map((answer) => `<button type="button" data-answer data-correct="${answer.correct ? "true" : "false"}" aria-pressed="false" aria-disabled="false" aria-label="Antwort ${escapeAttribute(answer.key)}: ${escapeAttribute(answer.text)}"><span aria-hidden="true">${escapeHtml(answer.key)}</span>${escapeHtml(answer.text)}</button>`).join("")}
        </div>
        <p class="feedback" id="frage-${index + 1}-feedback" role="status" aria-live="polite" aria-atomic="true" tabindex="-1" data-feedback>Antwort wählen.</p>
        <p class="explanation" id="frage-${index + 1}-explanation"><strong>Erklärung:</strong> ${escapeHtml(question.explanation)}</p>
      </article>`)
    .join("");
}

function renderAudioBlock(audioSources: StandaloneAudioSource[]) {
  if (audioSources.length === 0) return "";

  return `
    <section class="audio-block" aria-label="Dozentenaudio">
      <strong>Dozentenaudio</strong>
      <span>${audioSources.some((asset) => asset.source === "upload")
        ? "Dieser Export enthält die hinterlegte Audiospur des Dozenten."
        : "Dieser Export enthält einen eingebetteten Audio-Fallback. Echte Vorlesungsaudio-Dateien können später an derselben Manifeststelle ersetzt werden."}</span>
      ${audioSources.map((asset) => `
        <figure>
          <figcaption>${escapeHtml(asset.originalName)} · ${escapeHtml(asset.sha256)}</figcaption>
          <audio controls preload="metadata" src="${escapeAttribute(asset.src)}"></audio>
        </figure>`).join("")}
    </section>`;
}

function visibleBodyBlocks(slide: SlideNode) {
  const [firstBlock, ...remainingBlocks] = slide.blocks;
  if (firstBlock?.type === "heading" && firstBlock.text.trim() === slide.title.trim()) {
    return remainingBlocks;
  }

  return slide.blocks;
}

function sourceSummary(count: number) {
  if (count === 0) return "";
  if (count === 1) return "1 Quelle";
  return `${count} Quellen`;
}

function standaloneSafeAssetUrl(url: string | undefined, mode: RenderStandaloneSlideDocumentInput["assetUrlMode"]) {
  if (!url) return undefined;
  if (mode === "allow-external") return url;
  if (url.startsWith("data:")) return url;
  if (mode === "relative-or-inline" && !/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return undefined;
}

function normalizeChartData(data: Extract<SlideBlock, { type: "chart" }>["data"]) {
  const labels = Array.isArray(data?.labels) ? data.labels.map((item) => String(item)) : [];
  const values = Array.isArray(data?.values) ? data.values.map((item) => Number(item)) : [];
  const pairs = labels
    .map((label, index) => ({ label, value: Number.isFinite(values[index]) ? values[index] : 0 }))
    .filter((item) => item.label.trim().length > 0)
    .slice(0, 8);
  const raw = pairs.length > 0 ? pairs : [
    { label: "A", value: 1 },
    { label: "B", value: 0.72 },
    { label: "C", value: 0.44 }
  ];
  const max = Math.max(...raw.map((item) => Math.abs(item.value)), 1);
  return raw.map((item) => ({
    ...item,
    ratio: Math.abs(item.value) / max
  }));
}

function escapeHtml(input: string | number) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(input: string | number) {
  return escapeHtml(input);
}

function escapeJsonForScript(input: string) {
  return input
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
