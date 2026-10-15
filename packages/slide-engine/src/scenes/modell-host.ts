import type * as ThreeNamespace from "three";

import { createModellSceneFactories } from "./modell-factories";
import type { ModellTheme } from "./modell-theme";
import type { ModellSceneInstance, ModellSceneKey, ModellSceneState } from "./modell-types";

type Three = typeof ThreeNamespace;

type LabelItem = { anchor: ThreeNamespace.Object3D; el: HTMLElement };

export type ModellSceneHostOptions = {
  port: HTMLElement;
  labels: HTMLElement;
  state: ModellSceneState;
  ariaLabel: string;
  onFail: () => void;
  theme?: ModellTheme;
};

// Portierung von window.ModelScenes aus der Vorlage: dieselben Lichter, dieselbe
// Orthokamera und dieselbe Label-Projektion, aber an einen Container gebunden,
// ohne globale DOM-Zugriffe und mit vollstaendigem Freigeben des WebGL-Kontexts.
export class ModellSceneHost {
  failed = false;

  private readonly T: Three;
  private readonly port: HTMLElement;
  private readonly labels: HTMLElement;
  private readonly state: ModellSceneState;
  private readonly onFail: () => void;
  private readonly factories: ReturnType<typeof createModellSceneFactories>;
  private readonly resizeObserver: ResizeObserver;
  private readonly detachPointer: () => void;
  private renderer: ThreeNamespace.WebGLRenderer | null = null;
  private scene: ThreeNamespace.Scene | null = null;
  private root: ThreeNamespace.Group | null = null;
  private camera: ThreeNamespace.OrthographicCamera | null = null;
  private active: ModellSceneInstance | null = null;
  private labelItems: LabelItem[] = [];
  private dragX = 0;
  private dragY = 0;
  private readonly projected: ThreeNamespace.Vector3;

  constructor(T: Three, options: ModellSceneHostOptions) {
    this.T = T;
    this.port = options.port;
    this.labels = options.labels;
    this.state = options.state;
    this.onFail = options.onFail;
    this.projected = new T.Vector3();
    // r140: sRGB-Farbeingaben in den linearen Arbeitsfarbraum ueberfuehren (fehlt in @types/three 0.140).
    (T as unknown as { ColorManagement: { legacyMode: boolean } }).ColorManagement.legacyMode = false;
    this.factories = createModellSceneFactories(T, options.theme);

    try {
      const renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power", preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
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

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.port);
    this.detachPointer = this.attachPointerRotation();
  }

  set(key: ModellSceneKey) {
    const T = this.T;
    this.disposeScene();
    const scene = new T.Scene();
    scene.add(new T.AmbientLight(0xffffff, 0.9));
    const key1 = new T.DirectionalLight(0xffffff, 0.55);
    key1.position.set(4, 7, 8);
    scene.add(key1);
    const fill = new T.DirectionalLight(0xffffff, 0.25);
    fill.position.set(-5, 1, -2);
    scene.add(fill);
    const root = new T.Group();
    scene.add(root);
    this.scene = scene;
    this.root = root;
    this.active = this.factories[key](root, (anchor, text, cls = "") => this.addLabel(anchor, text, cls), this.state);
    const camera = new T.OrthographicCamera(-5, 5, 3, -3, 0.01, 100);
    camera.position.set(...this.active.camera);
    camera.lookAt(0, 0, 0);
    this.camera = camera;
    this.dragX = 0;
    this.dragY = 0;
    this.resize();
  }

  reset() {
    this.dragX = 0;
    this.dragY = 0;
    this.resize();
  }

  render(t: number, dt: number) {
    if (!this.active || !this.scene || !this.root || !this.camera) return;
    this.active.update(t, dt);
    this.root.rotation.y = this.dragX;
    this.root.rotation.x = this.dragY;
    this.scene.updateMatrixWorld();
    if (!this.renderer || this.failed) {
      this.labels.style.display = "none";
      return;
    }
    this.renderer.render(this.scene, this.camera);
    const width = this.port.clientWidth;
    const height = this.port.clientHeight;
    // Ohne gemessene Buehne (versteckt, noch nicht gelayoutet) bleiben Beschriftungen verborgen.
    if (!width || !height) return;
    const vec = this.projected;
    for (const { anchor, el } of this.labelItems) {
      anchor.getWorldPosition(vec);
      vec.project(this.camera);
      const visible = vec.z >= -1 && vec.z <= 1 && Math.abs(vec.x) < 1.02 && Math.abs(vec.y) < 1.04;
      let parent: ThreeNamespace.Object3D | null = anchor;
      let parentsVisible = true;
      while (parent) {
        if (!parent.visible) parentsVisible = false;
        parent = parent.parent;
      }
      el.style.display = visible && parentsVisible ? "block" : "none";
      el.style.left = `${(vec.x * 0.5 + 0.5) * width}px`;
      el.style.top = `${(-vec.y * 0.5 + 0.5) * height}px`;
    }
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.detachPointer();
    this.disposeScene();
    if (this.renderer) {
      this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    this.active = null;
  }

  private resize() {
    if (!this.camera || !this.active) return;
    const width = this.port.clientWidth;
    const height = this.port.clientHeight;
    if (!width || !height) return;
    const ratio = width / height;
    const worldH = Math.max(this.active.height, this.active.width / ratio);
    const worldW = worldH * ratio;
    this.camera.left = -worldW / 2;
    this.camera.right = worldW / 2;
    this.camera.top = worldH / 2;
    this.camera.bottom = -worldH / 2;
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    if (this.renderer && !this.failed) this.renderer.setSize(width, height);
  }

  private addLabel(anchor: ThreeNamespace.Object3D, text: string, cls: string) {
    const el = document.createElement("div");
    // Narrative captions duplicate the slide. Retain axis names, quantities and
    // diagram-node labels, but let the motion itself carry these explanations.
    if (new Set([
      "ABBILD → BEZIEHUNG → FUNKTION", "AUSWÄHLEN · VEREINFACHEN · WEGLASSEN",
      "EINE VOLLSTÄNDIGE PERIODE", "KRAFTBILANZ", "21 BEISPIELE · 3 LERNBARE PARAMETER",
      "WIEDERHOLTE VERARBEITUNG · × N", "PRÜFEN UND RÜCKKOPPELN",
      "MODELL + INTERFACE", "LAUFZEITUMGEBUNG"
    ]).has(text)) return el;
    el.className = `lb-scene3d-label ${cls}`.trim();
    el.textContent = text;
    el.style.display = "none";
    this.labels.append(el);
    this.labelItems.push({ anchor, el });
    return el;
  }

  private disposeScene() {
    if (this.scene) {
      const geometries = new Set<{ dispose(): void }>();
      const materials = new Set<{ dispose(): void }>();
      const textures = new Set<{ dispose(): void }>();
      this.scene.traverse((object) => {
        const candidate = object as ThreeNamespace.Object3D & {
          geometry?: { dispose(): void };
          material?: (ThreeNamespace.Material & { map?: ThreeNamespace.Texture | null }) | Array<ThreeNamespace.Material & { map?: ThreeNamespace.Texture | null }>;
        };
        if (candidate.geometry) geometries.add(candidate.geometry);
        if (candidate.material) {
          for (const material of Array.isArray(candidate.material) ? candidate.material : [candidate.material]) {
            materials.add(material);
            if (material.map) textures.add(material.map);
          }
        }
      });
      geometries.forEach((item) => item.dispose());
      materials.forEach((item) => item.dispose());
      textures.forEach((item) => item.dispose());
    }
    this.scene = null;
    this.root = null;
    this.labels.replaceChildren();
    this.labelItems = [];
  }

  private fail() {
    this.failed = true;
    if (this.renderer) this.renderer.domElement.style.display = "none";
    this.onFail();
  }

  private readonly handleContextLost = (event: Event) => {
    event.preventDefault();
    this.fail();
  };

  private attachPointerRotation() {
    let drag: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY };
      this.port.setPointerCapture(event.pointerId);
      this.port.dataset.dragging = "true";
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      this.dragX = Math.max(-0.45, Math.min(0.45, this.dragX + (event.clientX - drag.x) * 0.004));
      this.dragY = Math.max(-0.22, Math.min(0.22, this.dragY + (event.clientY - drag.y) * 0.003));
      drag = { x: event.clientX, y: event.clientY };
    };
    const end = () => {
      drag = null;
      delete this.port.dataset.dragging;
    };
    this.port.addEventListener("pointerdown", down);
    this.port.addEventListener("pointermove", move);
    this.port.addEventListener("pointerup", end);
    this.port.addEventListener("pointercancel", end);
    return () => {
      this.port.removeEventListener("pointerdown", down);
      this.port.removeEventListener("pointermove", move);
      this.port.removeEventListener("pointerup", end);
      this.port.removeEventListener("pointercancel", end);
    };
  }
}
