import type { Group, Object3D } from "three";

export const modellSceneKeys = [
  "morph",
  "miniature",
  "law",
  "limits",
  "runtime",
  "learning",
  "language",
  "transfer"
] as const;

export type ModellSceneKey = (typeof modellSceneKeys)[number];

export type ModellSceneState = {
  playing: boolean;
  morph: number;
  abstraction: number;
  stiffness: number;
  sceneTime: number;
  oscillator: { x: number; v: number; time: number };
  oscillatorTrace: Array<{ time: number; x: number }>;
  description: "force" | "energy";
  executing: boolean;
  inputX: number;
  outputAngle: number;
  servoAngle: number;
  a: [number, number, number];
  steps: number;
  trainingRunning: boolean;
  trainingLimit: number;
  accumulator: number;
  inferX: number;
  context: 0 | 1;
  langStep: number;
  tokenAdded: boolean;
  transferStep: number;
  data: Array<[number, number]>;
};

export type ModellLabelFn = (anchor: Object3D, text: string, cls?: string) => HTMLElement;

export type ModellSceneInstance = {
  width: number;
  height: number;
  camera: [number, number, number];
  top: number;
  update(t: number, dt: number): void;
};

export type ModellSceneFactory = (root: Group, lab: ModellLabelFn, state: ModellSceneState) => ModellSceneInstance;

export type ModellSceneFactories = Record<ModellSceneKey, ModellSceneFactory>;
