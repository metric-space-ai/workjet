# liteparse-rs

A focused Rust transposition of the LiteParse core.

## Upstream provenance

The content boundary is LiteParse v1.4.5 from
`https://github.com/run-llama/liteparse.git`, commit
`67726fc153393439f43d70268ba67d08bf49ed87`. `UPSTREAM.md` records the
immutable source identity, Apache checksum, exact file-family port map,
v1.4.5 behavior pin, and downstream modification boundary.

## What is ported

This crate ports the algorithmic center of LiteParse into a Rust-first layout pipeline:

- `src/core/config.rs` — config defaults and override merging
- `src/core/types.rs` — page, text box, OCR, anchors, and output types
- `src/processing/clean_text.rs` — margin stripping and page text cleanup
- `src/processing/text_utils.rs` — OCR table-artifact cleanup + super/subscript helpers
- `src/processing/bbox.rs` — bounding box helpers
- `src/processing/grid_projection.rs` — rotation normalization, line grouping, word merging, dot-garbage filtering, and a pragmatic grid renderer
- `src/parser.rs` — orchestration layer over a PDF backend trait
- `src/engines/pdf/*` — backend trait and a `pdfium-render` oriented backend design

## PDF backend choice

For Rust, `pdfium-render` is the most practical backend because it can:

- load PDFs
- render pages at configurable DPI
- extract text
- expose per-character geometry and rotation metadata
- expose image/page object information

That makes it the closest single-backend replacement for LiteParse's v1.4.5 split between PDF.js text extraction and PDFium page rendering.

The crate is wired so the algorithmic core is backend-agnostic through the `PdfEngine` trait. The `PdfiumBackend` is the intended production backend, but the parser core itself does not depend on Pdfium details.

## Parity coverage

The `parity/fixtures/` directory contains source-derived algorithm fixtures based on the pinned LiteParse tests and helper logic. `parity/run_parity.py` runs those fixtures against a reference implementation that mirrors the Rust algorithms in this crate.

Covered parity checks:

- `bboxToLine()` merge / split / markup / sort cases
- `projectToGrid()` simple single-column case
- `projectToGrid()` two-column case
- `projectToGrid()` dot-garbage filtering
- `buildBoundingBoxes()`
- `cleanOcrTableArtifacts()`
- `cleanRawText()`

## Licensing and fixture boundary

The crate software has the aggregate SPDX expression:

```text
Apache-2.0 AND (MIT OR AGPL-3.0-only)
```

LiteParse-derived material remains Apache-2.0; this is not a relicensing of
upstream work. Metric Space AI-owned additions are available under the
owner-authorized choice `MIT OR AGPL-3.0-only`. Full terms are in
`LICENSE.Apache-2.0`, `LICENSE.MIT`, and `LICENSE.AGPL-3.0-only`.

`tests/fixtures/**` document/page data is excluded from both license grants.
Cargo packaging excludes that directory, but the Git history must still not be
treated as publishable until each fixture has source-specific rights or a
synthetic replacement and the later public history-sanitization gate is
complete. See `UPSTREAM.md` for the complete boundary.
