// Workjet fork delta: the one canonical list of scene3d ids. `schema.ts` (block sceneId)
// and `excalidraw/canvas-schema.ts` (embed sceneId) both read it from here, so a new scene
// id can never be accepted by one schema and rejected by the other.
import { businessSceneIdValues } from "./business-data";
import type { ModellSceneKey } from "./modell-types";

/** The learnordie lecture scenes; fixed visualisations without caller data. */
export const modellSceneIdValues = [
  "modell.morph",
  "modell.miniature",
  "modell.law",
  "modell.limits",
  "modell.runtime",
  "modell.learning",
  "modell.language",
  "modell.transfer",
] as const;

/** Every scene id a scene3d block or canvas embed may name. */
export const scene3dSceneIdValues = [...modellSceneIdValues, ...businessSceneIdValues] as const;

export type ModellSceneId = (typeof modellSceneIdValues)[number];
export type Scene3DSceneId = (typeof scene3dSceneIdValues)[number];

const modellSceneKeyById = {
  "modell.morph": "morph",
  "modell.miniature": "miniature",
  "modell.law": "law",
  "modell.limits": "limits",
  "modell.runtime": "runtime",
  "modell.learning": "learning",
  "modell.language": "language",
  "modell.transfer": "transfer",
} as const satisfies Record<ModellSceneId, ModellSceneKey>;

export function isModellSceneId(sceneId: string): sceneId is ModellSceneId {
  return Object.hasOwn(modellSceneKeyById, sceneId);
}

/** Factory key of a learnordie scene for the modell host. Business ids are not modell scenes. */
export function scene3dSceneKey(sceneId: ModellSceneId): ModellSceneKey {
  if (!isModellSceneId(sceneId))
    throw new Error(`Scene "${String(sceneId)}" is not a modell scene.`);
  return modellSceneKeyById[sceneId];
}
