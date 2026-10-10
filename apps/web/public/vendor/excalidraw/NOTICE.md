# Excalidraw vendor runtime

This directory contains a browser ESM closure of `@excalidraw/excalidraw@0.18.0`
plus React 19, built with esbuild for CTOX Business OS (no package manager at
runtime).

- Upstream: https://github.com/excalidraw/excalidraw
- License: MIT (see the Excalidraw LICENSE)
- Fonts: Virgil, Excalifont, Assistant, Cascadia, Comic Shanns, Liberation, Lilita, Nunito

## Learnordie native fork — 2026-09-12

Base: the user-supplied `excalidraw-business-os-source.zip`, vendor subtree only.
The original notice above is preserved as provenance, not as a runtime dependency.
No Business OS authentication, shell, application modules, or model-provider boot
code is included. The editor mounts directly into the application's DOM.

Local modifications:

- `runtime.mjs`: rename the minimal menu/welcome adapter for Learnordie.
- `excalidraw.mjs`: replace the `esm.sh` font fallback with the local module
  directory, so a missing local font never causes a CDN request.
- `excalidraw.mjs`: await the asynchronous image cursor decoder and translate
  invalid-raster decoding failures into the existing localized error dialog.
  Previously its detached promise rejected without informing the user. The
  exact pinned transformation is in `scripts/patch-excalidraw-image-import.mjs`.
  Image validation, supported formats and sandbox restrictions are unchanged.
- `chunk-SQ5PDB2P.js`: local no-op repair for a missing file in the archive.
  In upstream 0.18.0 this module only exports build configuration constants;
  the supplied subset-worker/subset-shared chunks use side-effect-only imports.
  Those constants have no side effects and are not consumed by the subsetter.
  Reference: https://unpkg.com/@excalidraw/excalidraw@0.18.0/dist/prod/chunk-SQ5PDB2P.js
- Fonts, locale modules, subsetter code, and CSS remain byte-for-byte supplied.

`PROVENANCE.json` records archive SHA-256, supplied file hashes and the fork's
runtime payload hashes. Licensing text is supplied in `LICENSE` and `licenses/`:
Excalidraw/React are MIT; font metadata/licenses are preserved separately and
are not relicensed under MIT. Original font binaries and embedded names remain
unchanged. Font source/license URLs are recorded with each notice. The source
archive did not contain a complete third-party dependency license inventory;
this notice does not assert that the opaque prebuilt closure was rebuilt or
independently audited dependency-by-dependency.

The Next adapter lives in `src/lib/excalidraw-runtime.ts`. Controlled three.js
and scripts-disabled opaque HTML/CSS sidecars live in `CanvasEmbed.tsx`. No
remote editor or iframe-based editor is used. SVG exports are static and do not
export the live sidecar's WebGL/HTML DOM.
