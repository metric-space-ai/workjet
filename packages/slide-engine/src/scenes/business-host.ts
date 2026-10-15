// Workjet fork delta: WebGL host for the business scenes. Unlike the learnordie lecture host it
// renders on demand only: a frame is drawn while the intro animation runs, while the user drags,
// and after resize/theme/data/option changes. Idle scenes schedule no animation frames.
import type * as ThreeNamespace from "three";

import type { BusinessPalette } from "./business-common";
import type { BusinessSceneData, BusinessSceneId, KpiBarsData, TrendData } from "./business-data";
import { createKpiBarsScene } from "./business-kpi-bars";
import {
  BusinessSceneKit,
  type BusinessSceneInstance,
  type BusinessSceneOption,
  type Three,
} from "./business-three";
import { createTrendScene } from "./business-trend";

export type BusinessSceneOptions = Record<BusinessSceneOption, boolean>;

export type BusinessSceneHostOptions<Id extends BusinessSceneId = BusinessSceneId> = {
  port: HTMLElement;
  sceneId: Id;
  data: BusinessSceneData[Id];
  palette: BusinessPalette;
  options: BusinessSceneOptions;
  ariaLabel: string;
  /** Skip the grow/draw-in animation (prefers-reduced-motion). */
  reducedMotion: boolean;
  /** Called once after the first frame is on screen (swap the fallback image for the canvas). */
  onReady?: () => void;
  onFail: () => void;
};

const YAW_LIMIT = 0.55;
const PITCH_MIN = -0.2;
const PITCH_MAX = 0.3;
const FONT_WAIT_MS = 1200;
const HAND_FONTS = ["Excalifont", "Virgil"];

export class BusinessSceneHost {
  failed = false;

  private readonly T: Three;
  private readonly port: HTMLElement;
  private readonly sceneId: BusinessSceneId;
  private readonly reducedMotion: boolean;
  private readonly onFail: () => void;
  private onReady: (() => void) | undefined;
  private readonly resizeObserver: ResizeObserver;
  private readonly detachPointer: () => void;
  private readonly scene: ThreeNamespace.Scene;
  private readonly root: ThreeNamespace.Group;
  private readonly camera: ThreeNamespace.OrthographicCamera;
  private readonly corner: ThreeNamespace.Vector3;
  private data: BusinessSceneData[BusinessSceneId];
  private palette: BusinessPalette;
  private options: BusinessSceneOptions;
  private renderer: ThreeNamespace.WebGLRenderer | null = null;
  private kit: BusinessSceneKit | null = null;
  private instance: BusinessSceneInstance | null = null;
  private fontStack = "";
  private yaw = 0;
  private pitch = 0;
  private frame = 0;
  /** Intro animation start: null = idle, -1 = starts with the next frame. */
  private animationStart: number | null = null;
  private progress = 0;
  private destroyed = false;

  constructor(T: Three, options: BusinessSceneHostOptions) {
    this.T = T;
    this.port = options.port;
    this.sceneId = options.sceneId;
    this.data = options.data;
    this.palette = options.palette;
    this.options = { ...options.options };
    this.reducedMotion = options.reducedMotion;
    this.onFail = options.onFail;
    this.onReady = options.onReady;
    this.corner = new T.Vector3();
    // r140: sRGB colour inputs into the linear working space (missing in @types/three 0.140).
    (T as unknown as { ColorManagement: { legacyMode: boolean } }).ColorManagement.legacyMode =
      false;

    this.scene = new T.Scene();
    // Softer than the lecture rig so the accent keeps its hue; faces still read as 3D.
    this.scene.add(new T.AmbientLight(0xffffff, 0.62));
    const key = new T.DirectionalLight(0xffffff, 0.5);
    key.position.set(3, 6, 8);
    this.scene.add(key);
    const fill = new T.DirectionalLight(0xffffff, 0.18);
    fill.position.set(-6, 2, 3);
    this.scene.add(fill);
    this.root = new T.Group();
    this.scene.add(this.root);
    this.camera = new T.OrthographicCamera(-5, 5, 3, -3, 0.1, 100);

    try {
      const renderer = new T.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: "low-power",
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(this.pixelRatio());
      renderer.outputEncoding = T.sRGBEncoding;
      renderer.toneMapping = T.NoToneMapping;
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.setAttribute("aria-label", options.ariaLabel);
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost);
      this.port.prepend(renderer.domElement);
      this.renderer = renderer;
    } catch {
      this.fail();
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.fit();
      this.requestRender();
    });
    this.resizeObserver.observe(this.port);
    this.detachPointer = this.attachPointer();
    document.fonts?.addEventListener("loadingdone", this.handleFontsLoaded);

    const family = getComputedStyle(this.port).fontFamily || `"Comic Sans MS", cursive`;
    this.fontStack = `${HAND_FONTS.join(", ")}, ${family}`;
    if (!this.failed) {
      void waitForFonts(this.fontStack, this.sampleText(), FONT_WAIT_MS).then(() => {
        if (!this.destroyed) this.build(!this.reducedMotion);
      });
    }
  }

  setPalette(palette: BusinessPalette) {
    this.palette = palette;
    if (this.instance) this.build(false);
  }

  setData<Id extends BusinessSceneId>(data: BusinessSceneData[Id]) {
    this.data = data;
    if (this.instance) this.build(false);
  }

  setOptions(options: BusinessSceneOptions) {
    this.options = { ...options };
    if (!this.instance) return;
    for (const name of Object.keys(options) as BusinessSceneOption[])
      this.instance.setOption(name, options[name]);
    this.requestRender();
  }

  reset() {
    this.yaw = 0;
    this.pitch = 0;
    this.requestRender();
  }

  /** True while a frame is scheduled; idle scenes return false. */
  get busy() {
    return this.frame !== 0;
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resizeObserver.disconnect();
    this.detachPointer();
    document.fonts?.removeEventListener("loadingdone", this.handleFontsLoaded);
    this.disposeInstance();
    if (this.renderer) {
      this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
  }

  private build(animate: boolean) {
    this.disposeInstance();
    const kit = new BusinessSceneKit(this.T, this.palette, this.fontStack);
    const instance =
      this.sceneId === "business.kpi-bars"
        ? createKpiBarsScene(kit, this.data as KpiBarsData, {
            showPrevious: this.options.showPrevious,
          })
        : createTrendScene(kit, this.data as TrendData, { showTarget: this.options.showTarget });
    const bounds = instance.bounds();
    instance.group.position.set(
      -(bounds.min[0] + bounds.max[0]) / 2,
      -(bounds.min[1] + bounds.max[1]) / 2,
      -(bounds.min[2] + bounds.max[2]) / 2,
    );
    this.root.add(instance.group);
    this.kit = kit;
    this.instance = instance;
    if (animate) {
      this.progress = 0;
      this.animationStart = -1;
    } else if (this.animationStart === null) {
      this.progress = 1;
    }
    instance.animate(this.progress);
    this.fit();
    this.requestRender();
  }

  private disposeInstance() {
    if (this.instance) this.root.remove(this.instance.group);
    this.kit?.dispose();
    this.kit = null;
    this.instance = null;
  }

  private pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, 1.8);
  }

  /** Fits the orthographic frustum to the scene bounds as seen from the scene's camera direction. */
  private fit() {
    const instance = this.instance;
    const width = this.port.clientWidth;
    const height = this.port.clientHeight;
    if (!instance || !width || !height) return;
    const camera = this.camera;
    const [dx, dy, dz] = instance.camera;
    const length = Math.hypot(dx, dy, dz) || 1;
    camera.position.set((dx / length) * 30, (dy / length) * 30, (dz / length) * 30);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const bounds = instance.bounds();
    const offset = instance.group.position;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < 8; i++) {
      this.corner
        .set(
          (i & 1 ? bounds.max[0] : bounds.min[0]) + offset.x,
          (i & 2 ? bounds.max[1] : bounds.min[1]) + offset.y,
          (i & 4 ? bounds.max[2] : bounds.min[2]) + offset.z,
        )
        .applyMatrix4(camera.matrixWorldInverse);
      minX = Math.min(minX, this.corner.x);
      maxX = Math.max(maxX, this.corner.x);
      minY = Math.min(minY, this.corner.y);
      maxY = Math.max(maxY, this.corner.y);
    }
    const margin = Math.max(maxX - minX, maxY - minY) * 0.04 + 0.12;
    minX -= margin;
    maxX += margin;
    minY -= margin;
    maxY += margin;
    const ratio = width / height;
    const contentRatio = (maxX - minX) / (maxY - minY);
    if (contentRatio < ratio) {
      const extra = ((maxY - minY) * ratio - (maxX - minX)) / 2;
      minX -= extra;
      maxX += extra;
    } else {
      const extra = ((maxX - minX) / ratio - (maxY - minY)) / 2;
      minY -= extra;
      maxY += extra;
    }
    camera.left = minX;
    camera.right = maxX;
    camera.bottom = minY;
    camera.top = maxY;
    camera.near = 0.1;
    camera.far = 100;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    if (this.renderer && !this.failed) {
      this.renderer.setPixelRatio(this.pixelRatio());
      this.renderer.setSize(width, height);
    }
    this.kit?.setPixelsPerUnit((height / (maxY - minY)) * this.pixelRatio());
  }

  private requestRender() {
    if (this.frame || this.destroyed || this.failed) return;
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number) => {
    this.frame = 0;
    const instance = this.instance;
    if (!instance || !this.renderer) return;
    if (this.animationStart !== null) {
      if (this.animationStart < 0) this.animationStart = now;
      this.progress = Math.min(1, (now - this.animationStart) / instance.duration);
      instance.animate(this.progress);
      if (this.progress < 1) this.requestRender();
      else this.animationStart = null;
    }
    this.root.rotation.set(this.pitch, this.yaw, 0);
    this.renderer.render(this.scene, this.camera);
    if (this.onReady && this.port.clientWidth && this.port.clientHeight) {
      const ready = this.onReady;
      this.onReady = undefined;
      ready();
    }
  };

  private sampleText() {
    // Hand-drawn fonts ship as unicode-range subsets; ask for the glyphs this scene needs.
    return (
      JSON.stringify(this.data)
        .replace(/[{}[\]":,]/gu, " ")
        .slice(0, 400) + " 0123456789 +−±%€ Ziel ggü. Vorwert"
    );
  }

  private readonly handleFontsLoaded = (event: Event) => {
    const faces = (event as Event & { fontfaces?: readonly FontFace[] }).fontfaces ?? [];
    if (
      !this.instance ||
      !faces.some((face) => this.fontStack.includes(face.family.replace(/^["']|["']$/gu, "")))
    )
      return;
    this.build(false);
  };

  private fail() {
    this.failed = true;
    if (this.renderer) this.renderer.domElement.style.display = "none";
    this.onFail();
  }

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.fail();
  };

  private attachPointer() {
    let drag: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY };
      this.port.setPointerCapture(event.pointerId);
      this.port.dataset.dragging = "true";
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      this.yaw = Math.max(
        -YAW_LIMIT,
        Math.min(YAW_LIMIT, this.yaw + (event.clientX - drag.x) * 0.005),
      );
      this.pitch = Math.max(
        PITCH_MIN,
        Math.min(PITCH_MAX, this.pitch + (event.clientY - drag.y) * 0.004),
      );
      drag = { x: event.clientX, y: event.clientY };
      this.requestRender();
    };
    const end = () => {
      drag = null;
      delete this.port.dataset.dragging;
    };
    const reset = () => this.reset();
    this.port.addEventListener("pointerdown", down);
    this.port.addEventListener("pointermove", move);
    this.port.addEventListener("pointerup", end);
    this.port.addEventListener("pointercancel", end);
    this.port.addEventListener("dblclick", reset);
    return () => {
      this.port.removeEventListener("pointerdown", down);
      this.port.removeEventListener("pointermove", move);
      this.port.removeEventListener("pointerup", end);
      this.port.removeEventListener("pointercancel", end);
      this.port.removeEventListener("dblclick", reset);
    };
  }
}

/** Waits (bounded) until the stack's web fonts are loaded so canvas text is not rasterised in a fallback. */
async function waitForFonts(stack: string, sample: string, timeoutMs: number) {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts) return;
  const families = stack
    .split(",")
    .map((family) => family.trim())
    .filter(Boolean);
  const loads = families.map((family) => fonts.load(`32px ${family}`, sample).catch(() => []));
  let timer = 0;
  await Promise.race([
    Promise.all(loads),
    new Promise<void>((resolve) => {
      timer = window.setTimeout(resolve, timeoutMs);
    }),
  ]);
  window.clearTimeout(timer);
}
