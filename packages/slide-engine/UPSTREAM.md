# Upstream: learnordie slide engine

## Source

| Field                 | Value                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| Repository            | `https://github.com/metric-space-ai/learnordie` (`packages/slide-engine`)   |
| Commit                | `d94f8a594dbea7e4bd9b4872fcdaf5c7342b5dfe` (2026-09-14)                     |
| Subtree               | `bf810fc861c73b2dd96b59514f82bdc8d3bf111a` (`packages/slide-engine`)        |
| Workjet import commit | `68527d48` (`chore(slide-engine): import learnordie slide engine verbatim`) |

The import commit is byte-identical to the source commit for every copied path (verified with
`cmp` against `git show d94f8a5:<path>` for all 37 files).

## Ownership and authorization

learnordie has no license file and no `license` field. Michael Welsch / Metric Space AI owns the
code and ordered this port into Workjet on 08.10.2026. No SPDX expression has been assigned to the
ported files yet; that choice stays with the owner (see `LICENSE_POLICY.md`). Third-party notices
are kept unchanged: `NOTICE.md`, `LICENSES/three.js-MIT.txt` (three.js r140, npm `three@0.140.0`)
and `LICENSES/reveal.js-MIT.txt`.

## Copied paths

`README.md`, `NOTICE.md`, `package.json`, `LICENSES/**`, `styles/**` (core and three themes) and
`src/**`: `agent.ts`, `editing.ts`, `fixtures.ts`, `index.ts`, `legacy.ts`, `schema.ts`,
`standalone.ts`, `standalone-canvas.ts`, `components/*`, `excalidraw/*` (including `README.md`),
`scenes/*` (modell scenes, oscillator physics, scene ids) and their three tests.

## Omitted paths

- `vendor/reveal-core/**` (39 files: `UPSTREAM.md`, `manifest.json`, `src/**`). No runtime module
  imports it: nothing under `src/` references `vendor/`. `README.md` (its vendor commands and the
  `@learnordie/slide-engine` name describe learnordie) and `NOTICE.md` are kept verbatim.

## Package setup

- `tsconfig.json` extends `tsconfig.base.json` and relaxes, for the vendored code only:
  - `module: ESNext`, `moduleResolution: Bundler`: the vendored modules import siblings without
    file extensions (`./schema`), which `NodeNext` rejects.
  - `jsx: react-jsx`: the renderer components are TSX; the base config sets no JSX mode.
  - `noUncheckedIndexedAccess: false`, `exactOptionalPropertyTypes: false`: the vendored code was
    written without them (about 75 and 15 errors respectively, all in vendored files; the files
    Workjet added compile cleanly with both enabled).
- The Effect language service stays on. The two tests that use `node:fs` or `node:child_process`
  opt out of `nodeBuiltinImport` with a file comment, as other packages do.
- `vp fmt` ignores the vendored files and `src/scenes/business-data.ts` (listed in the root
  `vite.config.ts`) so they stay diffable against upstream; files added by Workjet are formatted.
  `vp lint` runs on the whole package without exceptions (4 `react(no-array-index-key)` warnings
  in the vendored renderers, no errors).

## Fork deltas

1. **Package identity.** Renamed `@learnordie/slide-engine` to `@workjet/slide-engine`; pinned
   `zod` to `4.4.3` (the lockfile version); added `typecheck`, `test` and `build:validator`
   scripts, dev dependencies (`@types/node`, `@types/react`, `@types/three@0.140.0`,
   `esbuild@0.28.1`, `vite-plus`), `tsconfig.json`, `vite.config.ts` and the subpath exports
   `./scenes/business-data`, `./scenes/scene-ids`, `./meeting`, `./fixtures/jour-fixe-deck` and
   `./validator`.
2. **Business scene data contract.** `src/scenes/business-data.ts` defines `business.kpi-bars`
   and `business.trend` with their zod data schemas and `BUSINESS_SCENE_DATA_MAX_BYTES`
   (commit `a330b77b`).
3. **One scene id list.** `src/scenes/scene-ids.ts` owns `modellSceneIdValues` and
   `scene3dSceneIdValues` (modell ids followed by business ids). `schema.ts` (block `sceneId`) and
   `excalidraw/canvas-schema.ts` (embed `sceneId`, which hardcoded a duplicate list) both read it.
   `schema.ts` re-exports the ids, `Scene3DSceneId`, `ModellSceneId`, `isModellSceneId` and the
   business-data exports.
4. **Explicit modell mapping.** `scene3dSceneKey` maps through a typed table instead of stripping
   the `modell.` prefix. It accepts only `ModellSceneId` and throws for any other id;
   `isModellSceneId` is the type guard for callers that see every scene id.
5. **Scene data.** The `scene3d` block and the canvas `scene3d` embed gain an optional `data`
   field. `src/scene-data.ts` holds the rule used for both: business ids require `data` that parses
   with `businessSceneDataSchemas[sceneId]` and serializes to at most
   `BUSINESS_SCENE_DATA_MAX_BYTES` UTF-8 bytes; `modell.*` ids take no `data`. Violations are
   semantic validation errors `scene3d.missing_data`, `scene3d.invalid_data` and
   `scene3d.unexpected_data` with path, repair hint, `slideId` and `blockId` (for embeds the
   element's `sourceBlockId`, when present). Deleted canvas elements are not checked.
   `updateSlideCanvas` enforces the rule through its full document validation.
6. **Migration carries data.** `canvasSceneForSlide` copies a block's `data` into the embed's
   `customData.learnordie.data`.
7. **Zod issue helper.** `schema.ts` exports `repairIssuesFromZodIssues` so callers that parse a
   canvas scene on its own can report its failures in the repair issue format.
8. **Standalone exports.** Business scenes have no modell fallback. `standalone.ts` renders them,
   and `standalone-canvas.ts` snapshots their embeds, as a static SVG of the caption and the KPI
   lines (`businessSceneSnapshotDataUri`); the accessible canvas text adds the KPI summary.
9. **Read models.** `src/meeting.ts` adds `slideDocumentOutline` (compact structure for agents)
   and `meetingSlides` (per slide: title ≤ 256 characters; `body_markdown` from canvas text and
   embeds when the slide has a canvas, otherwise from the blocks; narration from `talkingPoint`
   notes, including notes without a `kind`, else the body as plain text; both ≤ 4096 UTF-8 bytes,
   cut on a code point boundary with `…`). `src/scene-data.ts` adds the KPI line format
   `KPI: label value unit (Δ ±x %)` with host-independent number formatting.
10. **Validator.** `src/validator/protocol.ts` (`handleValidatorRequest`, exported as
    `./validator`), `src/validator/cli.ts` and `scripts/build-validator.mjs` (esbuild `0.28.1`,
    ESM, node22, unminified, no react/three) produce `dist/slide-engine-validator.mjs` for CTOX.
    Ops: `validate`, `applyEdits`, `updateCanvas`, `canvasForSlide`, `outline`, `meetingSlides`.
    `applyEdits` rejects operations without a known `kind` (`edit.unknown_operation`) before
    calling `applySlideDocumentEdits`, which would otherwise count them as applied.
11. **Tests.** The three vendored tests run under vitest (`vite-plus/test`, namespace import of
    `node:assert/strict`). The last `excalidraw/scene.test.ts` case depended on learnordie app
    helpers (`src/lib/slide-documents`); it now asserts the engine guarantees those helpers rely
    on. New tests cover the scene id list, the data rule, migration, the read models and the
    bundled validator, using the German Jour fixe deck in `fixtures/jour-fixe-deck.json`
    (exported typed as `src/fixtures/jour-fixe-deck.ts`).
12. **Renderer type fix.** `components/Scene3DBlockRenderer.tsx` casts `block.sceneId` to
    `ModellSceneId` before `scene3dSceneKey`, so it compiles with the widened id list. Business ids
    reaching it throw until the business scene renderer replaces this path.
13. **Index exports.** `src/index.ts` also exports `scene-data.ts` and the `meeting.ts` read
    models.
