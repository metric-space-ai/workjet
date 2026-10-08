import assert from "node:assert/strict";
import test from "node:test";
import * as T from "three";
import { createModellSceneFactories } from "./modell-factories";
import { createModellSceneState, modellFallbackSvg } from "./modell-state";
import { modellTheme } from "./modell-theme";
import { modellSceneKeys } from "./modell-types";

for (const dark of [false, true]) {
  test(`all model scenes use native paper/ink and preserve interactions: ${dark ? "dark" : "light"}`, () => {
    const theme = modellTheme(dark);
    const state = createModellSceneState(false);
    const factories = createModellSceneFactories(T, theme);
    for (const key of modellSceneKeys) {
      const svg = modellFallbackSvg(key, state, "#e5c48c", "Original model", dark);
      assert.ok(svg.includes(`fill="${theme.paper}"`));
      assert.ok(svg.includes(`color:${theme.ink}`));
      assert.ok(!/#0c1922|#183c50|#e5c48c|#162e3c/.test(svg));
      if (key === "morph") continue; // Actual WebGL point-cloud path is covered in the browser.
      const root = new T.Group();
      const before = JSON.stringify(state);
      const scene = factories[key](root, (_anchor, text) => ({ textContent: text } as HTMLElement), state);
      assert.equal(JSON.stringify(state), before, "theme construction does not reset or mutate pedagogical state");
      assert.ok(root.children.length > 0);
      scene.update(0, 0);
      root.traverse((object) => {
        const item = object as T.Mesh;
        if (item.geometry) item.geometry.dispose();
        for (const material of item.material ? (Array.isArray(item.material) ? item.material : [item.material]) : []) {
          if (material instanceof T.MeshStandardMaterial) {
            assert.equal(material.metalness, 0);
            assert.equal(material.roughness, 1);
            assert.equal(material.emissiveIntensity, 0);
          }
          material.dispose();
        }
      });
    }
  });
}
