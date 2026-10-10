/** Renderer-independent lecture-scene keys, shared by factories and validation. */
export const modellSceneKeys = [
  "morph",
  "miniature",
  "law",
  "limits",
  "runtime",
  "learning",
  "language",
  "transfer",
] as const;

export type ModellSceneKey = (typeof modellSceneKeys)[number];
