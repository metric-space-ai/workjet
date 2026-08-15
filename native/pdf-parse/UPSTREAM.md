# LiteParse upstream boundary

## Immutable source identity

| Field                  | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| Repository             | `https://github.com/run-llama/liteparse.git`                       |
| Tag                    | `v1.4.5`                                                           |
| Commit                 | `67726fc153393439f43d70268ba67d08bf49ed87`                         |
| Package version        | `1.4.5`                                                            |
| Package author         | `LlamaIndex`                                                       |
| Upstream license       | `Apache-2.0`                                                       |
| Apache license file    | `LICENSE.Apache-2.0`                                               |
| Apache license SHA-256 | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |

The tag resolves to the commit above. The upstream root has no `NOTICE` file at
this pin, so no upstream NOTICE has been fabricated here. The package metadata
identifies `LlamaIndex` as author and `Apache-2.0` as the license; this record
does not invent an upstream copyright statement.

## Why v1.4.5 is the content pin

The Rust transposition follows the behavior present at v1.4.5. In v1.4.6,
LiteParse changed `bboxToLine()` gap calculation from the rounded
`previousBbox.w` and a `-0.5` overlap tolerance to raw
`previousBbox.pageBbox.w` (falling back to `.w`) and a `-1.0` overlap
tolerance. The local parity behavior uses the v1.4.5 rounded-width / `-0.5`
boundary, so v1.4.5—not v1.4.6—is the accurate content source pin.

## File-family port map

All upstream paths below refer to commit
`67726fc153393439f43d70268ba67d08bf49ed87`.

| Local derived file or family                | Exact LiteParse source family                                                                                                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/config.rs`                        | Defaults and merging from `src/core/config.ts`; configuration and output-format shapes from `src/core/types.ts`                                                                                                         |
| `src/core/types.rs`                         | Core shapes from `src/core/types.ts`; PDF document, page, and screenshot boundary shapes from `src/engines/pdf/interface.ts`; projection anchor/result shapes from `src/processing/gridProjection.ts`                   |
| `src/processing/bbox.rs`                    | `src/processing/bbox.ts`                                                                                                                                                                                                |
| `src/processing/clean_text.rs`              | `src/processing/cleanText.ts`                                                                                                                                                                                           |
| `src/processing/grid_projection.rs`         | `src/processing/gridProjection.ts` and the public wrapper in `src/processing/grid.ts`                                                                                                                                   |
| `src/processing/text_utils.rs`              | `src/processing/textUtils.ts`                                                                                                                                                                                           |
| `src/parser.rs`                             | `src/core/parser.ts`                                                                                                                                                                                                    |
| `src/engines/pdf/interface.rs`              | `src/engines/pdf/interface.ts`                                                                                                                                                                                          |
| `parity/run_parity.py`                      | Reference transpositions of `src/processing/bbox.ts`, `src/processing/cleanText.ts`, `src/processing/gridProjection.ts`, and `src/processing/textUtils.ts`, consuming the fixture families listed below                 |
| `tests/parity.rs`                           | Rust parity coverage derived from `src/processing/bbox.test.ts`, `src/processing/cleanText.test.ts`, `src/processing/gridProjection.test.ts`, and `src/processing/textUtils.test.ts`, plus CTOX/Metric regression cases |
| `parity/fixtures/bbox_to_line.json`         | Cases derived from `src/processing/gridProjection.test.ts` and behavior in `src/processing/gridProjection.ts`                                                                                                           |
| `parity/fixtures/build_bounding_boxes.json` | Cases derived from `src/processing/bbox.test.ts` and behavior in `src/processing/bbox.ts`                                                                                                                               |
| `parity/fixtures/clean_text.json`           | Cases derived from `src/processing/cleanText.test.ts` and behavior in `src/processing/cleanText.ts`                                                                                                                     |
| `parity/fixtures/project_to_grid.json`      | Cases derived from `src/processing/gridProjection.test.ts`, `src/processing/gridProjection.ts`, and `src/processing/grid.ts`                                                                                            |
| `parity/fixtures/text_utils.json`           | Cases derived from `src/processing/textUtils.test.ts` and behavior in `src/processing/textUtils.ts`                                                                                                                     |

## Downstream modifications and licensing

CTOX/Metric Space AI transposed the TypeScript/JavaScript algorithms into
Rust, adapted configuration and data types, introduced a Rust PDF-engine trait
and error model, selected a `pdfium-render`-oriented backend boundary, and added
the Python/JSON/Rust parity harness and downstream regression coverage. These
files are modified from LiteParse rather than verbatim copies.

LiteParse-derived material remains under Apache-2.0. Metric Space AI-owned
additions are offered, at the recipient's choice, under MIT or
AGPL-3.0-only. The crate-level aggregate SPDX expression is therefore:

```text
Apache-2.0 AND (MIT OR AGPL-3.0-only)
```

That aggregate expression records both applicable boundaries. It does not
relicense LiteParse-derived material. See `LICENSE.Apache-2.0`, `LICENSE.MIT`,
and `LICENSE.AGPL-3.0-only` for the full terms.

## Fixture exclusion and public-release gate

`tests/fixtures/**` contains external document/page data. That data is
explicitly excluded from both the LiteParse Apache-2.0 grant and the Metric
Space AI `MIT OR AGPL-3.0-only` grant. Its presence in this source history is
not a claim that it is publishable. A public source release remains gated on
source-specific rights for each fixture or synthetic replacement, followed by
history sanitization as needed. Cargo packaging excludes this directory, so it
is not part of the published crate artifact. Do not infer fixture rights from
this crate's aggregate Cargo license expression.
