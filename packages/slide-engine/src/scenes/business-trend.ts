// Workjet fork delta: `business.trend` — one value over the Regeltermine as a flat ribbon with
// point markers, direct labels for first/min/max, the latest value large and an optional target.
import type * as ThreeNamespace from "three";

import {
  dropOverlappingLabels,
  spreadVertically,
  trendLayout,
  type TrendValueLabel,
} from "./business-common";
import type { TrendData } from "./business-data";
import {
  clamp01,
  easeInOutCubic,
  textBounds,
  unionBounds,
  type BusinessBounds,
  type BusinessSceneInstance,
  type BusinessSceneKit,
  type BusinessText,
} from "./business-three";

const CHART_HEIGHT = 2.6;
const THICKNESS = 0.07;
const DEPTH = 0.42;
const VALUE_SIZE = 0.2;

export function createTrendScene(
  kit: BusinessSceneKit,
  data: TrendData,
  options: { showTarget: boolean },
): BusinessSceneInstance {
  const T = kit.T;
  const palette = kit.palette;
  const layout = trendLayout(data);
  const group = new T.Group();
  const count = layout.points.length;
  const width = Math.min(8.6, Math.max(5.2, 1.15 * (count - 1)));
  const front = DEPTH / 2;
  const points = layout.points.map((point) => ({ x: point.t * width, y: point.y * CHART_HEIGHT }));
  let showTarget = options.showTarget;
  let progress = 0;

  // Ribbon: a thin slab following straight segments (no spline overshoot between meetings).
  const slabPositions = new Float32Array(((count - 1) * 24 + 12) * 3);
  const slabGeometry = kit.track(new T.BufferGeometry());
  slabGeometry.setAttribute("position", new T.BufferAttribute(slabPositions, 3));
  const slab = new T.Mesh(slabGeometry, kit.solid(palette.accentFill, { side: T.DoubleSide }));
  slab.frustumCulled = false;
  group.add(slab);

  const edgePositions = new Float32Array(count * 3);
  const edgeGeometry = kit.track(new T.BufferGeometry());
  edgeGeometry.setAttribute("position", new T.BufferAttribute(edgePositions, 3));
  const edge = new T.Line(
    edgeGeometry,
    kit.track(
      new T.LineBasicMaterial({
        color: palette.ink,
        transparent: true,
        opacity: 0.75,
        toneMapped: false,
      }),
    ),
  );
  edge.frustumCulled = false;
  group.add(edge);

  kit.line(
    group,
    [
      [-0.15, 0, front],
      [width + 0.15, 0, front],
    ],
    palette.ink,
    0.5,
  );
  kit.line(
    group,
    [
      [-0.15, 0, -front],
      [width + 0.15, 0, -front],
    ],
    palette.line,
    0.4,
  );

  const markerGeometry = kit.track(new T.SphereGeometry(0.075, 16, 12));
  const markerMaterial = kit.solid(palette.ink);
  const markers = points.slice(0, -1).map((point) => {
    const marker = new T.Mesh(markerGeometry, markerMaterial);
    marker.position.set(point.x, point.y, front);
    group.add(marker);
    return marker;
  });
  const drops = points.map((point) =>
    kit.line(
      group,
      [
        [point.x, point.y - THICKNESS / 2, 0],
        [point.x, 0, 0],
      ],
      palette.line,
      0.85,
      { dash: 0.06, gap: 0.07 },
    ),
  );

  const lastPoint = points[count - 1]!;
  const lastGroup = new T.Group();
  lastGroup.position.set(lastPoint.x, lastPoint.y, front);
  lastGroup.add(
    new T.Mesh(kit.track(new T.SphereGeometry(0.12, 20, 14)), kit.solid(palette.accentFill)),
  );
  lastGroup.add(
    new T.Mesh(kit.track(new T.TorusGeometry(0.22, 0.016, 8, 48)), kit.solid(palette.accentInk)),
  );
  group.add(lastGroup);

  // Target: a faint level plane with a dashed edge in the secondary colour.
  const targetGroup = new T.Group();
  const targetMaterials: Array<ThreeNamespace.Material & { opacity: number }> = [];
  let targetText: BusinessText | null = null;
  if (layout.target) {
    const y = layout.target.y * CHART_HEIGHT;
    const planeMaterial = kit.track(
      new T.MeshBasicMaterial({
        color: palette.secondary,
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        side: T.DoubleSide,
        toneMapped: false,
      }),
    );
    const plane = new T.Mesh(
      kit.track(new T.PlaneGeometry(width + 0.3, DEPTH * 2.4)),
      planeMaterial,
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(width / 2, y, 0);
    targetGroup.add(plane);
    const dashMaterial = kit.track(
      new T.MeshBasicMaterial({ color: palette.secondary, transparent: true, toneMapped: false }),
    );
    const dashGeometry = kit.track(new T.BoxGeometry(0.16, 0.03, 0.03));
    for (let x = 0.08; x < width; x += 0.27) {
      const dash = new T.Mesh(dashGeometry, dashMaterial);
      dash.position.set(x, y, front + 0.04);
      targetGroup.add(dash);
    }
    targetMaterials.push(planeMaterial, dashMaterial);
    group.add(targetGroup);
    targetText = kit.text(group, layout.target.text, {
      size: 0.19,
      color: palette.secondary,
      align: "left",
    });
  }

  const title = kit.text(group, layout.unit ? `${layout.label} · ${layout.unit}` : layout.label, {
    size: 0.24,
    color: palette.muted,
    align: "left",
    maxWidth: width + 2.5,
  });
  title.place(-0.05, CHART_HEIGHT + 0.6, 0, 0, 0.5);

  // Direct value labels; colliding ones are dropped (earlier = more important wins).
  const labelY = (label: TrendValueLabel) =>
    points[label.index]!.y +
    (label.placement === "above" ? 0.16 + VALUE_SIZE * 0.6 : -0.16 - VALUE_SIZE * 0.6);
  const kept = dropOverlappingLabels(
    layout.valueLabels,
    (index) => points[index]!.x,
    labelY,
    (index) => kit.measure(layout.points[index]!.valueText, VALUE_SIZE) + 0.15,
    VALUE_SIZE * 1.6,
  );
  const valueTexts = kept.map((label) => {
    const point = points[label.index]!;
    const text = kit.text(group, layout.points[label.index]!.valueText, {
      size: VALUE_SIZE,
      color: palette.ink,
    });
    text.place(
      point.x,
      point.y + (label.placement === "above" ? 0.16 : -0.16),
      front,
      0.5,
      label.placement === "above" ? 0 : 1,
    );
    return { index: label.index, text };
  });

  const spacing = count > 1 ? width / (count - 1) : width;
  const axisWidth = Math.max(spacing * (count > layout.axisLabels.length ? 1.7 : 0.95), 0.9);
  const axisTexts = layout.axisLabels.map((index) => {
    const text = kit.text(group, layout.points[index]!.label, {
      size: 0.17,
      color: palette.muted,
      maxWidth: axisWidth,
      maxLines: 1,
    });
    text.place(points[index]!.x, -0.14, front, 0.5, 1);
    return { index, text };
  });

  // Right column: the latest value large at its own height, the target label beside its line.
  const columnX = width + 0.42;
  const big = kit.text(group, layout.lastText, { size: 0.66, color: palette.ink, align: "left" });
  const change = kit.text(group, layout.changeText, {
    size: 0.18,
    color: palette.muted,
    align: "left",
  });
  const blockHeight = big.height + change.height - 0.12;
  const stacked = [{ center: lastPoint.y, height: blockHeight }];
  if (targetText && layout.target)
    stacked.push({ center: layout.target.y * CHART_HEIGHT, height: targetText.height });
  const [blockCenter = lastPoint.y, targetCenter = 0] = spreadVertically(stacked, 0.06);
  big.place(columnX, blockCenter + blockHeight / 2, front, 0, 1);
  change.place(columnX + 0.04, blockCenter + blockHeight / 2 - big.height + 0.12, front, 0, 1);
  targetText?.place(columnX + 0.04, targetCenter, front, 0, 0.5);

  const writeSlab = (reach: number) => {
    let offset = 0;
    const vertex = (x: number, y: number, z: number) => {
      slabPositions[offset++] = x;
      slabPositions[offset++] = y;
      slabPositions[offset++] = z;
    };
    const corners = (x: number, y: number) => ({
      tf: [x, y + THICKNESS / 2, front] as const,
      tb: [x, y + THICKNESS / 2, -front] as const,
      bf: [x, y - THICKNESS / 2, front] as const,
      bb: [x, y - THICKNESS / 2, -front] as const,
    });
    type Corner = readonly [number, number, number];
    const quad = (a: Corner, b: Corner, c: Corner, d: Corner) => {
      for (const corner of [a, b, c, a, c, d]) vertex(corner[0], corner[1], corner[2]);
    };
    const cap = (x: number, y: number) => {
      const c = corners(x, y);
      quad(c.tb, c.bb, c.bf, c.tf);
    };
    const first = points[0]!;
    cap(first.x, first.y);
    let end = first;
    let edgeCount = 0;
    const edgePoint = (x: number, y: number, index: number) => {
      edgePositions[edgeCount * 3] = x;
      edgePositions[edgeCount * 3 + 1] = y + THICKNESS / 2 + Math.sin(index * 12.9) * 0.006;
      edgePositions[edgeCount * 3 + 2] = front + 0.004;
      edgeCount++;
    };
    edgePoint(first.x, first.y, 0);
    for (let index = 0; index < count - 1 && reach > index; index++) {
      const a = points[index]!;
      const b = points[index + 1]!;
      const f = Math.min(1, reach - index);
      const bx = a.x + (b.x - a.x) * f;
      const by = a.y + (b.y - a.y) * f;
      const ca = corners(a.x, a.y);
      const cb = corners(bx, by);
      quad(ca.tb, ca.tf, cb.tf, cb.tb);
      quad(ca.bf, cb.bf, cb.tf, ca.tf);
      quad(ca.bb, cb.bb, cb.bf, ca.bf);
      quad(ca.tb, cb.tb, cb.bb, ca.bb);
      end = { x: bx, y: by };
      edgePoint(bx, by, index + 1);
    }
    cap(end.x, end.y);
    slabGeometry.setDrawRange(0, offset / 3);
    slabGeometry.attributes.position!.needsUpdate = true;
    slabGeometry.computeVertexNormals();
    edgeGeometry.setDrawRange(0, edgeCount);
    edgeGeometry.attributes.position!.needsUpdate = true;
  };

  const animate = (next: number) => {
    progress = clamp01(next);
    const reach = easeInOutCubic(progress) * (count - 1);
    writeSlab(reach);
    const reached = (index: number) => clamp01((reach - index) * 2.5 + 1);
    markers.forEach((marker, index) => {
      marker.visible = reach >= index - 1e-6;
    });
    drops.forEach((drop, index) => {
      drop.visible = reach >= index - 1e-6;
    });
    for (const { index, text } of valueTexts)
      text.setOpacity(reach >= index - 1e-6 ? reached(index) : 0);
    for (const { index, text } of axisTexts)
      text.setOpacity(reach >= index - 1e-6 ? reached(index) : 0);
    const finale = clamp01((progress - 0.82) / 0.18);
    lastGroup.visible = finale > 0;
    lastGroup.scale.setScalar(0.6 + 0.4 * finale);
    big.setOpacity(finale);
    change.setOpacity(finale);
    title.setOpacity(clamp01(progress * 3));
    const targetAlpha = showTarget ? clamp01(progress * 3) : 0;
    targetGroup.visible = targetAlpha > 0;
    if (targetMaterials[0]) targetMaterials[0].opacity = 0.08 * targetAlpha;
    if (targetMaterials[1]) targetMaterials[1].opacity = targetAlpha;
    targetText?.setOpacity(targetAlpha);
  };

  const bounds = (): BusinessBounds =>
    unionBounds([
      { min: [-0.15, 0, -DEPTH * 1.2], max: [width + 0.15, CHART_HEIGHT, DEPTH * 1.2] },
      textBounds(title),
      textBounds(big),
      textBounds(change),
      ...(targetText ? [textBounds(targetText)] : []),
      ...valueTexts.map(({ text }) => textBounds(text)),
      ...axisTexts.map(({ text }) => textBounds(text)),
    ]);

  animate(0);
  return {
    group,
    camera: [0.9, 1.5, 10],
    duration: 1100 + 30 * count,
    bounds,
    animate,
    setOption(name, value) {
      if (name !== "showTarget") return;
      showTarget = value;
      animate(progress);
    },
  };
}
