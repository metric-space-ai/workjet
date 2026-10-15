# @learnordie/slide-engine

Internal learnordie slide runtime package.

This package is the canonical home for the reveal.js-derived presentation core, the controlled learnordie renderer, the CSS contract, QA hooks and the standalone runtime.

The Next.js app consumes this package through the `@learnordie/slide-engine` workspace dependency. App-level components may adapt product data into `SlideDocument`, but schema, renderer, fixtures and engine contracts live here.

## Rules

- The package lives in the `metric-space-ai/learnordie` monorepo.
- It is not a separate product repository.
- reveal.js code is vendored only as selected core modules under `vendor/reveal-core/src`.
- Every copied upstream path is tracked in `NOTICE.md` and `vendor/reveal-core/UPSTREAM.md`.
- No unsanitized free HTML becomes the slide source of truth.
- Browser QA must cover desktop, tablet and mobile before replacing `SlideCanvas`.
- Standalone exports must be rendered from `SlideDocument` through the package exporter, not from app-local legacy HTML.

## CSS Contract

`styles/core.css` defines the package-owned runtime contract for slide tokens, layout budgets, mobile reflow/scaled/hybrid modes, print behavior and common renderer safeguards. Theme files in `styles/themes/` implement the three schema theme IDs:

- `learnordie-north`
- `learnordie-technical`
- `learnordie-dark-room`

The app imports these files through package exports such as `@learnordie/slide-engine/styles/core.css`. QA checks assert that every `SlideLayoutId` has a CSS selector and every `SlideThemeId` has a package-exported theme file.

## Vendor Commands

- `npm run vendor:reveal-core` imports the pinned reveal.js `6.0.1` core snapshot.
- `npm run check:slide-engine-vendor` verifies the upstream commit, copied paths and excluded demo/plugin/theme paths.

The vendored upstream source is treated as third-party reference/runtime material. Product code should use the typed learnordie exports from this package instead of importing arbitrary files from `vendor/`.

## Standalone Runtime

`src/standalone.ts` renders a validated `SlideDocument` into self-contained HTML for long-term offline use. The exported document embeds the slide data JSON, manifest JSON, package CSS, package interaction script, optional inline audio sources and quiz feedback logic.

## Agentic Editing Runtime

`src/editing.ts` exposes the structured edit contract for agents and the future WYSIWYG editor. It applies batches of operations against stable `slideId`, `blockId`, `assetId`, `noteId` and `anchorId` targets, then validates the full `SlideDocument` before returning an accepted document.

Agents should use this API instead of editing rendered HTML or app-local legacy slide data. Failed operations return repair-oriented issues so the generation loop can retry only the affected slide or block.

## Agentic Generation Runtime

`src/agent.ts` exposes the first `learnordie.slide-agent.v1` generation contract. It turns material-like sources and optional assets into a deterministic briefing, outline and validated `SlideDocument` draft. This is the stable shape that LLM agents should target before the richer production planner is wired into lecturer workflows.

The generation contract keeps provenance mandatory: generated content slides carry `sourceRefs`, speaker notes and quiz anchors, while invalid draft output is reported through the same repair issue format as schema validation and structured edit batches.

## Legacy Bridge

`src/legacy.ts` is the compatibility bridge between the existing app `Slide[]` model and the new `SlideDocument` runtime. It supports both directions: old lectures can render through the engine, and accepted `SlideDocument` edits can be synchronized back into `Slide[]` for legacy live/learn surfaces while the native `Lecture.slideDocument` snapshot remains the primary engine payload.

## Editor QA

`DeckRenderer` and `SlideRenderer` expose optional block-selection hooks for editor surfaces. The app-level QA route `/slide-engine/qa/editor` uses those hooks together with `applySlideDocumentEdits` to prove text edits, layout changes, figure asset replacement, formula edits, table cell/row/column edits, quiz-anchor updates and invalid-patch repair feedback in a real browser.
