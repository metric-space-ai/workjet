import { assert, it } from "@effect/vitest";
import { codingModelExportUrl, CodingModelExportRequestError } from "./models.ts";

it("uses the fixed Workjet export path and refuses credential-bearing or redirect-prone URLs", () => {
  assert.equal(
    codingModelExportUrl("https://workjet.example/"),
    "https://workjet.example/api/workjet/coding-models",
  );
  for (const value of [
    "https://user:secret@workjet.example/",
    "https://workjet.example/?next=https://other.example",
    "http://workjet.example/",
    "file:///tmp/workjet",
  ]) {
    assert.throws(() => codingModelExportUrl(value), CodingModelExportRequestError);
  }
});
