# Third-Party Notices

## vscode-icons

The custom file icon symbols in `src/pierre-icons.ts` are adapted from the
[`vscode-icons`](https://github.com/vscode-icons/vscode-icons) project.

Copyright (c) 2016 Roberto Huertas

Licensed under the MIT License. The full license text is available in the
upstream repository: <https://github.com/vscode-icons/vscode-icons/blob/master/LICENSE>.

## Excalidraw runtime (Jour fixe presentation canvas)

`public/vendor/excalidraw/` is a verbatim copy of the browser runtime that
`metric-space-ai/learnordie` ships at commit
`d94f8a594dbea7e4bd9b4872fcdaf5c7342b5dfe` (`public/vendor/excalidraw/`). It is a
prebuilt ESM closure of [Excalidraw](https://github.com/excalidraw/excalidraw)
0.18.0 with its own copy of React 19; `PROVENANCE.json` records every file's
SHA-256 and the modifications made for the learnordie fork, and `WORKJET.md`
describes how Workjet loads it.

- Excalidraw: Copyright (c) 2020 Excalidraw, MIT License (`LICENSE`).
- React: Copyright (c) Meta Platforms, Inc. and affiliates, MIT License
  (`licenses/React.txt`).
- Fonts: Virgil, Excalifont, Assistant, Cascadia, Liberation, Lilita and Nunito
  under the SIL Open Font License 1.1; Comic Shanns under the MIT License. Each
  license text is kept next to the fonts in `licenses/`.
