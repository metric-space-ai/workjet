# Jour fixe presentations

A Jour fixe meeting can carry a presentation: a learnordie `SlideDocument`
(`learnordie.slide.v1`) whose slides are drawn as a hand-drawn Excalidraw canvas
with embedded three.js scenes. The project Supervisor writes it in CTOX; the
Owner presents and edits it in Workjet.

## Pieces

- `packages/slide-engine` (`@workjet/slide-engine`) is the engine: schema,
  edit operations, block-to-canvas migration, business scenes, the React
  renderers and the canvas adapter (`./canvas`). It is a fork of learnordie's
  `packages/slide-engine`; `UPSTREAM.md` lists every change. CTOX validates
  documents with the bundled validator built from this package
  (`scripts/build-validator.mjs`), so both sides accept the same documents.
- `apps/web/public/vendor/excalidraw` is the Excalidraw runtime the canvas
  adapter loads with a same-origin dynamic import (see its `WORKJET.md`).
- `packages/contracts/src/workjetPresentation.ts` mirrors CTOX's
  `ctox.workjet.presentation.v1` fixture.
- `apps/web/src/lib/jourFixePresentation.ts` reads and saves through the
  existing project control path.

## Transport

All requests go through `requestWorkjetProjectControl`, like the other Jour fixe
actions; there is no HTTP data path.

1. `project.presentation.read` returns the meeting's manifest (or `null`):
   revision, document file id and generation, SHA-256 and size, slide ids.
2. `project.presentation.content.read` returns one range of at most 128 KiB of
   that revision. The client assembles all ranges, checks every range hash and
   the document hash, then validates the document with the engine.
3. `project.presentation.canvas.save` sends one slide's canvas scene with the
   revision it was edited from. CTOX re-validates the whole document and stores
   a new revision; a newer revision rejects the save, so the client reloads.

Decks the Supervisor writes must also pass the validator's `lintMeeting` op
(`src/meeting-lint.ts`): no heading that repeats the slide title, no slide or
table that only says evidence is missing, no wording about the slide, the
display, the data plumbing or the author, and no internal ids or system terms.
The Owner's own canvas saves are not linted.

Every revision is an immutable file. Canvas edits change the presentation
revision only, never the meeting's `deck_revision`, so comments, to-dos and
narration stay bound to their slide ids. The meeting deck (one markdown slide
per presentation slide, same ids) is derived by the Supervisor's `publish_deck`.

## Room integration

The meeting room shows `SlideCanvas` for the current slide id when a
presentation exists: `mode: "present"` while presenting, `mode: "edit"` with
`onSceneChange` for editing, saving through `saveJourFixePresentationCanvas`.
Slides without a presentation keep the markdown stage.

## Fixture

`apps/web/slide-engine-fixture.html` (port 5746, renderer CSP as meta tag) and
`scripts/slide-engine-fixture-ui.mjs` prove fonts, live WebGL, editing, saving
and slide switching in Chromium without a CTOX instance.
