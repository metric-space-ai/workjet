import { assert, it } from "@effect/vitest";
import { canonicalWorkerJson } from "./CanonicalWorkerJson.ts";

it("preserves prior native digest encoding while sorting object keys and retaining array order", () => {
  assert.equal(
    canonicalWorkerJson({ b: [2, { z: null, a: true }], a: "quoted\\text", absent: undefined }),
    '{"a":"quoted\\\\text","b":[2,{"a":true,"z":null}]}',
  );
  assert.equal(canonicalWorkerJson({ a: 1, b: 2 }), canonicalWorkerJson({ b: 2, a: 1 }));
  assert.notEqual(canonicalWorkerJson([1, 2]), canonicalWorkerJson([2, 1]));
});
