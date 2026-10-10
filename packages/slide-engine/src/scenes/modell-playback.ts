import type { ModellSceneKey, ModellSceneState } from "./modell-types";

/** The visible playback control describes the simulation, not just its clock. */
export function modellIsPlaying(key: ModellSceneKey, state: ModellSceneState): boolean {
  return state.playing && (key !== "learning" || state.trainingRunning)
    && (key !== "runtime" || state.executing);
}

export function setModellPlaying(key: ModellSceneKey, state: ModellSceneState, playing: boolean) {
  state.playing = playing;
  if (key === "learning") {
    if (playing && state.steps >= state.trainingLimit) state.trainingLimit += 400;
    state.trainingRunning = playing;
  }
  if (key === "runtime") {
    state.executing = playing;
    if (playing) state.outputAngle = state.inputX * 60;
  }
}

export function toggleModellPlaying(key: ModellSceneKey, state: ModellSceneState) {
  setModellPlaying(key, state, !modellIsPlaying(key, state));
}
