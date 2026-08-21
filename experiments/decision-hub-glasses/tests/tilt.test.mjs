import test from "node:test";
import assert from "node:assert/strict";
import { createTiltGate } from "../src/tilt.mjs";

test("the first sample only calibrates, it never switches", () => {
  const gate = createTiltGate();
  assert.equal(gate.feed({ x: 0, y: 0, z: 100 }), null);
  assert.equal(gate.visible, true);
});

test("tilting the head back hides, tilting forward shows again", () => {
  const gate = createTiltGate({ threshold: 25 });
  gate.feed({ x: 0, y: 0, z: 0 });
  assert.equal(gate.feed({ x: 0, y: -40, z: 0 }), "hide");
  assert.equal(gate.visible, false);
  assert.equal(gate.feed({ x: 0, y: 40, z: 0 }), "show");
  assert.equal(gate.visible, true);
});

test("small movements never toggle the display", () => {
  const gate = createTiltGate({ threshold: 25 });
  gate.feed({ x: 0, y: 0, z: 0 });
  for (const y of [5, -8, 11, -6, 9]) {
    assert.equal(gate.feed({ x: 0, y, z: 0 }), null, `y=${y} must not switch`);
  }
  assert.equal(gate.visible, true);
});

test("a repeated tilt does not fire twice", () => {
  const gate = createTiltGate({ threshold: 25 });
  gate.feed({ x: 0, y: 0, z: 0 });
  assert.equal(gate.feed({ x: 0, y: -40, z: 0 }), "hide");
  assert.equal(gate.feed({ x: 0, y: -45, z: 0 }), null, "already hidden");
});
