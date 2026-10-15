# Native scene sidecar

`SlideNode.canvas` is optional and uses `learnordie.excalidraw.v1`. No database
migration is needed: the document remains stored as SlideDocument JSON.

- `canvasSceneForSlide(slide, assets = [])` returns the validated existing canvas
  unchanged or deterministically migrates blocks into a 1600 × 900 native scene.
- `updateSlideCanvas(document, slideId, scene)` validates the entire document,
  replaces only the target canvas and updates bounded heading/paragraph/title
  projections. Full native text is retained even beyond legacy text budgets.
- `canvasTextForBlock(slide, blockId)` reads native text for a semantic block;
  empty string means the mapped text has been removed. `undefined` means no canvas.
- `canvasSceneSchema`, `canvasElementSchema`, `canvasEmbedSchema`, `CanvasScene`,
  `CanvasElement`, `CanvasEmbed` are exported from `canvas-schema.ts` (also schema.ts).

Native text uses font family 1 (handwritten), not screenshots. Conversions include
headings, body/list text, definition/callout panels, editable formula source,
individual table cells, code, quotations, process boxes/arrows and comparison
panels. Common chart `labels`/`values` bar/line/scatter data becomes native vectors.
Legacy bearing/ramp/formula diagrams become editable elements. 3D scene IDs become
embeddables with `customData.learnordie` and the inert
`https://learnordie.invalid/embed/<encoded-element-id>` sentinel link. Runtime must
never fetch this URL. Sources, notes, quiz anchors, slide IDs and original assets
remain in the surrounding document. Custom element mappings use `sourceBlockId`.

## Authority and compatibility

Once a canvas exists it is the visual source of truth. Old AI block/layout/title
and referenced-asset mutations return `edit.canvas_authoritative`; old legacy
save mutations throw that explicit error. Metadata, notes and quiz anchors can
still be edited. Invalid native documents cannot silently fall back to legacy.
The old AI tool contract does not yet author native elements; callers must surface
the error and direct the user to the native editor. Parent owns that UI wiring.

## Boundaries

- Raster file data is limited to matching PNG/JPEG/WebP/GIF data-URL signatures,
  4 MiB each, 100 files / 8 MiB total; this is not a full image decoder validation.
  SVG and remote URLs are not imported into executable/image scene data. Existing
  unconverted assets retain a visibly labeled pending-import placeholder with
  image geometry and `customData: { sourceAssetId, sourceBlockId, assetPlaceholder:
  true }`. Exactly one element per figure is marked for hydration. Parent can
  replace that rectangle with a native image and add an approved raster to files;
  the separate `<block-id>:caption` text starts with `Bildimport ausstehend` and
  should be refreshed when hydration succeeds. No fetch occurs in conversion.
  Remote asset compatibility is incomplete until the controlled client importer
  is integrated; SVG needs a separate trusted rasterization path, never active HTML.
- Up to 2,000 elements / 2 MiB native JSON, bounded finite coordinates and numeric
  properties, 64 KiB per text/HTML value, bounded nesting; duplicate IDs and missing
  image files are rejected. Document width/height are positive, finite, ≤10,000.
- HTML schema validates data shape/size, NOT security of markup. Runtime must
  sanitize HTML/CSS and use an opaque sandbox WITHOUT scripts/same-origin, with
  restrictive CSP and no network/forms/popups/navigation. Controlled three.js
  interactivity is separate. Do not insert document HTML into application DOM.
- Unsupported chart structures remain editable JSON source. Formulas remain
  editable LaTeX/MathML source, not typeset math. Dense legacy slides are scaled
  to fit without dropping source; this can require visual re-layout by the user.
- Browser editing, runtime restoration and UI quality are parent integration
  checks, not proven by these pure data tests.

## Tests

Through the shared host gate and `greppy bash-smart`, run Node with
`--experimental-strip-types --import ./scripts/alias-register.mjs --test
--test-concurrency=2 packages/slide-engine/src/excalidraw/scene.test.ts`.
The tests cover determinism, block conversion, editable tables/math, embed IDs,
mixed content persistence, legacy projections, rejected stale edits, raster
restrictions, invalid geometry/native data and dense-content retention.
