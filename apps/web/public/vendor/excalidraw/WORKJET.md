# Excalidraw runtime in Workjet

- Source: `metric-space-ai/learnordie`, commit `d94f8a594dbea7e4bd9b4872fcdaf5c7342b5dfe`,
  directory `public/vendor/excalidraw/`.
- Copied verbatim: every file in this directory except this `WORKJET.md` is byte-identical to the
  source directory (Excalidraw 0.18.0 + React 19 browser ESM closure, fonts, locales, licenses,
  `NOTICE.md`, `PROVENANCE.json`). Do not edit, format or lint these files; replace the directory
  from the source repository instead and update the commit above.
- Loading: the slide engine canvas adapter (`packages/slide-engine/src/canvas/runtime.ts`,
  package export `./canvas`) calls `loadCanvasRuntime({ assetBaseUrl: "/vendor/excalidraw/" })`.
  It sets `window.EXCALIDRAW_ASSET_PATH` to this directory, adds `excalidraw.css` once as a
  same-origin stylesheet, and imports `runtime.mjs` with a same-origin dynamic `import()` (no inline
  script, no `blob:` URL, no CDN). `runtime.mjs` imports `excalidraw.mjs`; Excalidraw loads its fonts from
  `fonts/`. The `locales/*.js` files are not requested: all locales are bundled in
  `excalidraw.mjs`.
- Vite copies this directory unchanged from `apps/web/public` into the web build output; the
  desktop app serves it from the bundled renderer with `.mjs`/`.js` as `text/javascript`, `.css` as
  `text/css` and `.woff2` as `font/woff2`.
