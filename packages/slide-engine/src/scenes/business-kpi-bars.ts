// Workjet fork delta: `business.kpi-bars` — current KPI values as solid bars, the previous
// Regeltermin as dashed ghost bars behind them, and the change above each bar.
import type * as ThreeNamespace from "three";

import { kpiBarsLayout, toneColor } from "./business-common";
import type { KpiBarsData } from "./business-data";
import {
  clamp01,
  easeOutCubic,
  textBounds,
  unionBounds,
  type BusinessBounds,
  type BusinessSceneInstance,
  type BusinessSceneKit,
  type BusinessText,
} from "./business-three";

/** World height of a normalised bar of 1. */
const BAR_HEIGHT = 2.5;
const BAR_WIDTH = 0.58;
const BAR_DEPTH = 0.5;
const GHOST_SHIFT = 0.17;
const GHOST_DEPTH = -0.3;
const LABEL_GAP = 0.14;
const STAGGER = 0.12;
const MIN_SCALE = 0.002;

type BarParts = {
  bar: ThreeNamespace.Mesh;
  ghost: ThreeNamespace.Object3D | null;
  ghostMaterials: Array<ThreeNamespace.Material & { opacity: number }>;
  value: BusinessText;
  delta: BusinessText | null;
  label: BusinessText;
  /** Centre of the current bar; value and delta sit above it. */
  x: number;
  height: number;
  top: (withPrevious: boolean) => number;
};

export function createKpiBarsScene(
  kit: BusinessSceneKit,
  data: KpiBarsData,
  options: { showPrevious: boolean },
): BusinessSceneInstance {
  const T = kit.T;
  const palette = kit.palette;
  const layout = kpiBarsLayout(data);
  const group = new T.Group();
  const count = layout.items.length;
  const halfWidth = layout.width / 2;
  let showPrevious = options.showPrevious;
  let progress = 0;

  const barGeometry = kit.track(new T.BoxGeometry(BAR_WIDTH, 1, BAR_DEPTH));
  const barMaterial = kit.solid(palette.accentFill);

  const parts: BarParts[] = layout.items.map((item, index) => {
    const hasGhost = item.previousHeight !== undefined;
    const x = item.x + (hasGhost ? GHOST_SHIFT : 0);
    const bar = new T.Mesh(barGeometry, barMaterial);
    bar.position.set(x, 0, 0);
    kit.sketchEdges(bar, barGeometry, palette.ink, 0.7, index * 5 + 1);
    group.add(bar);

    let ghost: ThreeNamespace.Object3D | null = null;
    const ghostMaterials: BarParts["ghostMaterials"] = [];
    if (hasGhost) {
      const height = (item.previousHeight ?? 0) * BAR_HEIGHT;
      const geometry = kit.track(
        new T.BoxGeometry(BAR_WIDTH, Math.max(Math.abs(height), 0.004), BAR_DEPTH),
      );
      const ghostFill = kit.track(
        new T.MeshBasicMaterial({
          color: palette.ghost,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      const mesh = new T.Mesh(geometry, ghostFill);
      mesh.position.set(item.x - GHOST_SHIFT, height / 2, GHOST_DEPTH);
      mesh.renderOrder = 1;
      const edges = kit.sketchEdges(mesh, geometry, palette.muted, 0.9, index * 5 + 3, true);
      ghostMaterials.push(ghostFill, edges.material as ThreeNamespace.Material);
      group.add(mesh);
      ghost = mesh;
    }

    const height = item.height * BAR_HEIGHT;
    const previousHeight = (item.previousHeight ?? 0) * BAR_HEIGHT;
    const top = (withPrevious: boolean) =>
      Math.max(0, height, withPrevious && hasGhost ? previousHeight : 0);
    const bottom = Math.min(0, height, hasGhost ? previousHeight : 0);
    const value = kit.text(group, item.valueText, { size: 0.27, color: palette.ink });
    const delta = item.delta
      ? kit.text(group, item.delta.text, { size: 0.21, color: toneColor(palette, item.delta.tone) })
      : null;
    const label = kit.text(group, item.label, {
      size: 0.2,
      color: palette.ink,
      maxWidth: layout.pitch * 0.92,
      maxLines: 3,
    });
    label.place(item.x, bottom - 0.16, BAR_DEPTH / 2, 0.5, 1);
    return { bar, ghost, ghostMaterials, value, delta, label, height, top, x };
  });

  // Baseline at the front edge plus a faint floor outline give the bars something to stand on.
  const front = BAR_DEPTH / 2 + 0.02;
  kit.line(
    group,
    [
      [-halfWidth - 0.1, 0, front],
      [halfWidth + 0.1, 0, front],
    ],
    palette.ink,
    0.75,
  );
  kit.line(
    group,
    [
      [-halfWidth - 0.1, 0, front],
      [-halfWidth - 0.1, 0, -0.75],
      [halfWidth + 0.1, 0, -0.75],
      [halfWidth + 0.1, 0, front],
    ],
    palette.line,
    0.45,
  );

  const lowestLabel = Math.min(...parts.map((part) => textBounds(part.label).min[1]));
  const footnote =
    layout.scale === "per-item"
      ? kit
          .text(group, "je Kennzahl skaliert", { size: 0.15, color: palette.muted })
          .place(halfWidth, lowestLabel - 0.08, front, 1, 1)
      : null;

  const placeLabels = () => {
    for (const part of parts) {
      const x = part.x;
      const withDelta = showPrevious && part.delta !== null;
      const top = part.top(showPrevious) + LABEL_GAP;
      part.delta?.place(x, top, front, 0.5, 0);
      part.value.place(
        x,
        withDelta && part.delta ? top + part.delta.height - 0.04 : top,
        front,
        0.5,
        0,
      );
    }
  };

  const animate = (next: number) => {
    progress = clamp01(next);
    const span = 1 + STAGGER * (count - 1);
    placeLabels();
    parts.forEach((part, index) => {
      const local = clamp01(progress * span - STAGGER * index);
      const grown = easeOutCubic(local);
      const height = part.height * grown;
      part.bar.scale.y = Math.max(MIN_SCALE, Math.abs(height));
      part.bar.position.y = height / 2;
      const labelAlpha = clamp01((local - 0.55) / 0.45);
      part.value.setOpacity(labelAlpha);
      part.delta?.setOpacity(showPrevious ? labelAlpha : 0);
      if (part.ghost) {
        part.ghost.visible = showPrevious && local > 0;
        part.ghostMaterials[0]!.opacity = 0.7 * clamp01(local * 1.6);
        part.ghostMaterials[1]!.opacity = 0.9 * clamp01(local * 1.6);
      }
      part.label.setOpacity(clamp01(local * 2));
    });
    footnote?.setOpacity(clamp01((progress - 0.6) / 0.4));
  };

  const bounds = (): BusinessBounds => {
    // Measured with previous values shown so toggling never moves the camera.
    const saved = showPrevious;
    showPrevious = layout.hasPrevious;
    placeLabels();
    const boxes = parts.flatMap((part) => [
      textBounds(part.value),
      textBounds(part.label),
      ...(part.delta ? [textBounds(part.delta)] : []),
    ]);
    if (footnote) boxes.push(textBounds(footnote));
    boxes.push({
      min: [-halfWidth - 0.15, Math.min(0, ...parts.map((part) => part.height)), -0.8],
      max: [halfWidth + 0.15, Math.max(0, ...parts.map((part) => part.top(true))), front],
    });
    showPrevious = saved;
    placeLabels();
    return unionBounds(boxes);
  };

  animate(0);
  return {
    group,
    camera: [1.6, 1.9, 10],
    duration: 650 + 90 * (count - 1),
    bounds,
    animate,
    setOption(name, value) {
      if (name !== "showPrevious") return;
      showPrevious = value;
      animate(progress);
    },
  };
}
