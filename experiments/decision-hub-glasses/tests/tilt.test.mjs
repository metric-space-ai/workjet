import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { createTiltGate } from "../src/tilt.mjs";

NodeTest("the first sample only calibrates, it never switches", () => {
  const gate = createTiltGate();
  NodeAssert.equal(gate.feed({ x: 0, y: 0, z: 100 }), null);
  NodeAssert.equal(gate.visible, true);
});

NodeTest("tilting the head back hides, tilting forward shows again", () => {
  const gate = createTiltGate({ threshold: 25 });
  gate.feed({ x: 0, y: 0, z: 0 });
  NodeAssert.equal(gate.feed({ x: 0, y: -40, z: 0 }), "hide");
  NodeAssert.equal(gate.visible, false);
  NodeAssert.equal(gate.feed({ x: 0, y: 40, z: 0 }), "show");
  NodeAssert.equal(gate.visible, true);
});

NodeTest("small movements never toggle the display", () => {
  const gate = createTiltGate({ threshold: 25 });
  gate.feed({ x: 0, y: 0, z: 0 });
  for (const y of [5, -8, 11, -6, 9]) {
    NodeAssert.equal(gate.feed({ x: 0, y, z: 0 }), null, `y=${y} must not switch`);
  }
  NodeAssert.equal(gate.visible, true);
});

NodeTest("a repeated tilt does not fire twice", () => {
  const gate = createTiltGate({ threshold: 25 });
  gate.feed({ x: 0, y: 0, z: 0 });
  NodeAssert.equal(gate.feed({ x: 0, y: -40, z: 0 }), "hide");
  NodeAssert.equal(gate.feed({ x: 0, y: -45, z: 0 }), null, "already hidden");
});
