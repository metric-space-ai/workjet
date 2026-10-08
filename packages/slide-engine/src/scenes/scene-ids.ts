import type { Scene3DSceneId } from "../schema";
import type { ModellSceneKey } from "./modell-types";

export function scene3dSceneKey(sceneId: Scene3DSceneId): ModellSceneKey {
  return sceneId.slice("modell.".length) as ModellSceneKey;
}
