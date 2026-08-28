# Workjet synthetic page-text contracts

This directory contains original, hand-authored Workjet data for exercising the
page-fixture evaluator in ordinary CI. `corpus.json` is the only manifest, and
it lists every direct JSON child of `pages/` exactly once.

Each page JSON keeps the production `PageFixture` wire fields and adds one
required test-only `synthetic_text` string. The integration test passes that
text directly to `evaluate_page_fixture_text`; it does not load, download,
parse, render, or generate a PDF.

The `pdf` fields are inert placeholders under `synthetic-pdfs/*.pdf`. No
`synthetic-pdfs/` directory or PDF binary is committed. These contracts validate
the evaluator and expected page-text linearization rules only. They do not
provide PDFium extraction, PDF rendering, or visual end-to-end coverage.

Run the synthetic contract test from the repository root:

```sh
CARGO_TARGET_DIR=/Volumes/tmp/workjet/build/pdf-synthetic-fixtures \
  cargo test --manifest-path native/pdf-parse/Cargo.toml \
  --test synthetic_fixtures --no-default-features
```

The suite strictly validates the manifest and page schemas, path containment,
unique IDs, placeholder PDF names, complete page enumeration, bounded corpus
size, and aggregate coverage of:

- exact lines;
- required patterns;
- ordered phrases;
- same-line groups;
- separate-line groups;
- forbidden patterns; and
- allowed missing lines.
