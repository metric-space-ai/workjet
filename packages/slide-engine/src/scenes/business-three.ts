// Workjet fork delta: three.js building blocks for the business scenes (r140 API only).
// Every geometry, material and texture is created through the kit, so one `dispose()`
// releases a scene completely; sprites share three's internal quad, which is never disposed.
import type * as ThreeNamespace from "three";

import { estimateTextWidth, wrapText, type BusinessPalette } from "./business-common";

export type Three = typeof ThreeNamespace;

export type BusinessBounds = { min: [number, number, number]; max: [number, number, number] };

/** A built scene. The host centres `group`, fits the camera to `bounds()` and drives `animate`. */
export type BusinessSceneInstance = {
  group: ThreeNamespace.Group;
  /** Direction from the scene centre towards the camera. */
  camera: [number, number, number];
  /** Length of the intro animation in milliseconds. */
  duration: number;
  bounds(): BusinessBounds;
  /** Stateless: renders the intro at `progress` in [0, 1] with the current options. */
  animate(progress: number): void;
  setOption(name: BusinessSceneOption, value: boolean): void;
};

export type BusinessSceneOption = "showPrevious" | "showTarget";

export type TextStyle = {
  /** Font size in world units. */
  size: number;
  color: string;
  align?: "left" | "center" | "right";
  /** Wrap width in world units. */
  maxWidth?: number;
  maxLines?: number;
};

const MEASURE_PX = 100;
const LINE_HEIGHT = 1.22;
const PAD = 0.22;
const MAX_TEXTURE = 2048;

/** Camera-facing text drawn into a canvas texture; world size is independent of resolution. */
export class BusinessText {
  readonly sprite: ThreeNamespace.Sprite;
  width = 0;
  height = 0;
  private lines: string[] = [];
  private readonly canvas: HTMLCanvasElement;
  private texture: ThreeNamespace.CanvasTexture | null = null;
  private readonly material: ThreeNamespace.SpriteMaterial;
  private readonly kit: BusinessSceneKit;
  private readonly style: TextStyle;
  private drawnAt = 0;

  constructor(kit: BusinessSceneKit, text: string, style: TextStyle) {
    const T = kit.T;
    this.kit = kit;
    this.style = style;
    this.canvas = document.createElement("canvas");
    this.material = new T.SpriteMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      premultipliedAlpha: true,
    });
    this.sprite = new T.Sprite(this.material);
    this.sprite.renderOrder = 10;
    this.setText(text);
  }

  setText(text: string) {
    const { size, maxWidth, maxLines = 1 } = this.style;
    const measure = (value: string) => this.kit.measure(value, size);
    this.lines = maxWidth ? wrapText(text, maxWidth, maxLines, measure) : [text];
    const pad = size * PAD;
    this.width = Math.max(...this.lines.map(measure)) + pad * 2;
    this.height = this.lines.length * size * LINE_HEIGHT + pad * 2;
    this.sprite.scale.set(this.width, this.height, 1);
    this.drawnAt = 0;
    this.draw(this.kit.pixelsPerUnit);
  }

  /** Anchor in [0, 1]² of the sprite box (0,0 = bottom left), like Sprite.center. */
  place(x: number, y: number, z: number, anchorX = 0.5, anchorY = 0.5) {
    this.sprite.position.set(x, y, z);
    this.sprite.center.set(anchorX, anchorY);
    return this;
  }

  setOpacity(alpha: number) {
    this.material.opacity = alpha;
    this.sprite.visible = alpha > 0.01;
  }

  draw(pixelsPerUnit: number) {
    if (this.drawnAt && Math.abs(pixelsPerUnit / this.drawnAt - 1) < 0.2) return;
    const T = this.kit.T;
    const scale = Math.min(pixelsPerUnit, MAX_TEXTURE / this.width, MAX_TEXTURE / this.height);
    const width = Math.max(1, Math.ceil(this.width * scale));
    const height = Math.max(1, Math.ceil(this.height * scale));
    const resized = width !== this.canvas.width || height !== this.canvas.height;
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const { size, color, align = "center" } = this.style;
    const fontPx = size * scale;
    const pad = size * PAD * scale;
    ctx.clearRect(0, 0, width, height);
    ctx.font = `${fontPx}px ${this.kit.fontStack}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = align;
    ctx.lineJoin = "round";
    // A paper-coloured halo keeps text legible where it crosses drop lines or bars.
    // Large text (headline numbers) never sits on lines and stays crisp without it.
    const halo = size <= 0.25;
    ctx.lineWidth = fontPx * 0.18;
    ctx.strokeStyle = this.kit.palette.paper;
    ctx.fillStyle = color;
    const x = align === "left" ? pad : align === "right" ? width - pad : width / 2;
    this.lines.forEach((line, index) => {
      const y = pad + (index + 0.5) * fontPx * LINE_HEIGHT;
      if (halo) ctx.strokeText(line, x, y);
      ctx.fillText(line, x, y);
    });
    // r140 allocates immutable texture storage; a new size needs a new texture.
    if (!this.texture || resized) {
      this.texture?.dispose();
      const texture = new T.CanvasTexture(this.canvas);
      texture.encoding = T.sRGBEncoding;
      texture.premultiplyAlpha = true;
      texture.generateMipmaps = false;
      texture.minFilter = T.LinearFilter;
      texture.magFilter = T.LinearFilter;
      this.texture = texture;
      this.material.map = texture;
      this.material.needsUpdate = true;
    } else {
      this.texture.needsUpdate = true;
    }
    this.drawnAt = pixelsPerUnit;
  }

  dispose() {
    this.texture?.dispose();
    this.material.dispose();
    this.sprite.removeFromParent();
  }
}

export class BusinessSceneKit {
  readonly texts: BusinessText[] = [];
  pixelsPerUnit = 120;
  private readonly disposables = new Set<{ dispose(): void }>();
  private readonly measureContext: CanvasRenderingContext2D | null;
  readonly T: Three;
  readonly palette: BusinessPalette;
  readonly fontStack: string;

  constructor(T: Three, palette: BusinessPalette, fontStack: string) {
    this.T = T;
    this.palette = palette;
    this.fontStack = fontStack;
    this.measureContext = document.createElement("canvas").getContext("2d");
  }

  /** Text width in world units for a font size in world units. */
  measure(value: string, size: number) {
    const ctx = this.measureContext;
    if (!ctx) return estimateTextWidth(value, size);
    ctx.font = `${MEASURE_PX}px ${this.fontStack}`;
    return (ctx.measureText(value).width / MEASURE_PX) * size;
  }

  track<Item extends { dispose(): void }>(item: Item) {
    this.disposables.add(item);
    return item;
  }

  text(parent: ThreeNamespace.Object3D, value: string, style: TextStyle) {
    const text = new BusinessText(this, value, style);
    parent.add(text.sprite);
    this.texts.push(text);
    return text;
  }

  /** Matte, flat-shaded surface like the learnordie scenes. */
  solid(color: string, options: ThreeNamespace.MeshStandardMaterialParameters = {}) {
    return this.track(
      new this.T.MeshStandardMaterial({
        color,
        roughness: 1,
        metalness: 0,
        flatShading: true,
        ...options,
      }),
    );
  }

  /** Slightly jittered edges, the hand-drawn outline used by the learnordie boxes. */
  sketchEdges(
    parent: ThreeNamespace.Object3D,
    geometry: ThreeNamespace.BufferGeometry,
    color: string,
    opacity = 0.65,
    seed = 1,
    dashed = false,
  ) {
    const T = this.T;
    const edges = this.track(new T.EdgesGeometry(geometry));
    const position = edges.attributes.position as ThreeNamespace.BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      position.setXYZ(
        i,
        position.getX(i) + Math.sin((i + seed) * 13.7) * 0.008,
        position.getY(i) + Math.cos((i + seed) * 9.3) * 0.008,
        position.getZ(i),
      );
    }
    const material = dashed
      ? this.track(
          new T.LineDashedMaterial({
            color,
            transparent: true,
            opacity,
            dashSize: 0.07,
            gapSize: 0.06,
            toneMapped: false,
          }),
        )
      : this.track(
          new T.LineBasicMaterial({ color, transparent: true, opacity, toneMapped: false }),
        );
    const lines = new T.LineSegments(edges, material);
    if (dashed) lines.computeLineDistances();
    parent.add(lines);
    return lines;
  }

  line(
    parent: ThreeNamespace.Object3D,
    points: Array<[number, number, number]>,
    color: string,
    opacity = 1,
    dashed?: { dash: number; gap: number },
  ) {
    const T = this.T;
    const geometry = this.track(
      new T.BufferGeometry().setFromPoints(points.map(([x, y, z]) => new T.Vector3(x, y, z))),
    );
    const material = dashed
      ? this.track(
          new T.LineDashedMaterial({
            color,
            transparent: opacity < 1,
            opacity,
            dashSize: dashed.dash,
            gapSize: dashed.gap,
            toneMapped: false,
          }),
        )
      : this.track(
          new T.LineBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false }),
        );
    const line = new T.Line(geometry, material);
    if (dashed) line.computeLineDistances();
    parent.add(line);
    return line;
  }

  /** Re-rasterises text when the on-screen scale changed noticeably (resize, zoom). */
  setPixelsPerUnit(pixelsPerUnit: number) {
    this.pixelsPerUnit = pixelsPerUnit;
    for (const text of this.texts) text.draw(pixelsPerUnit);
  }

  dispose() {
    for (const text of this.texts) text.dispose();
    this.texts.length = 0;
    for (const item of this.disposables) item.dispose();
    this.disposables.clear();
  }
}

export function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function easeOutCubic(value: number) {
  const t = clamp01(value);
  return 1 - (1 - t) ** 3;
}

export function easeInOutCubic(value: number) {
  const t = clamp01(value);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Bounds of a set of world-space boxes. */
export function unionBounds(boxes: BusinessBounds[]): BusinessBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, box.min[axis]!);
      max[axis] = Math.max(max[axis]!, box.max[axis]!);
    }
  }
  return { min, max };
}

/** Box of a text sprite placed with `place()` (z thickness zero). */
export function textBounds(text: BusinessText): BusinessBounds {
  const { x, y, z } = text.sprite.position;
  const { x: ax, y: ay } = text.sprite.center;
  return {
    min: [x - ax * text.width, y - ay * text.height, z],
    max: [x + (1 - ax) * text.width, y + (1 - ay) * text.height, z],
  };
}
