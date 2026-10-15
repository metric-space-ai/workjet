# Slide Engine Notice

This package is part of the `metric-space-ai/learnordie` monorepo.

It contains a controlled, reduced reveal.js core snapshot for learnordie presentation rendering.

## Upstream

- Project: reveal.js
- Upstream repository: https://github.com/hakimel/reveal.js
- License: MIT
- Target release family: 6.0.1
- Pinned commit: 52c6c8b2a9626915cfaa8a87ae47add261f282be
- Import policy: copied upstream paths are tracked in `vendor/reveal-core/manifest.json` and `vendor/reveal-core/UPSTREAM.md`.

## three.js (scene3d)

- Project: three.js
- Upstream repository: https://github.com/mrdoob/three.js
- License: MIT (`LICENSES/three.js-MIT.txt`)
- Version: r140 (`three@0.140.0`, npm dependency, pinned for visual parity with the source lecture)
- Use: runtime for `scene3d` blocks, loaded on demand in the browser only.

The scene factories in `src/scenes/modell-factories.ts` are taken verbatim from the lecture file
`Modellbegriff_ThreeJS_clean.html` ("Der Modellbegriff im Wandel") supplied by the course owner.
