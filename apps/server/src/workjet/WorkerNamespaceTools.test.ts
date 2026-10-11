import { expect, it } from "vite-plus/test";
import { appendWorkerToolOutput, workerToolOutputText } from "./WorkerNamespaceTools.ts";

it("keeps a bounded terminal suffix without splitting a UTF-8 character", () => {
  let output = { bytes: new Uint8Array(0), truncated: false };
  for (const text of ["first output", "🙂🙂🙂", "end"]) {
    output = appendWorkerToolOutput(output, new TextEncoder().encode(text), 10);
  }
  expect(output.truncated).toBe(true);
  expect(output.bytes.length).toBeLessThanOrEqual(10);
  expect(workerToolOutputText(output)).toBe("🙂end");
});

it("handles a zero-byte ACP output limit and preserves complete untruncated output", () => {
  const empty = { bytes: new Uint8Array(0), truncated: false };
  expect(workerToolOutputText(appendWorkerToolOutput(empty, new TextEncoder().encode("discard"), 0))).toBe("");
  const complete = appendWorkerToolOutput(empty, new TextEncoder().encode("🙂"), 16);
  expect(complete.truncated).toBe(false);
  expect(workerToolOutputText(complete)).toBe("🙂");
});
