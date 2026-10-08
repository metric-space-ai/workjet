// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { WorkjetSpeechRoute, WorkjetSpeechRouteSetInput } from "./workjetSpeechRoutes.ts";

const decodeRoute = Schema.decodeUnknownSync(WorkjetSpeechRoute);
const decodeSetInput = Schema.decodeUnknownSync(WorkjetSpeechRouteSetInput);

describe("Workjet speech route contracts", () => {
  it("accepts the two session kinds with per-direction computers or null", () => {
    expect(
      decodeRoute({
        sessionKind: "regeltermin",
        sttEnvironmentId: "gpu-3",
        ttsEnvironmentId: null,
      }),
    ).toEqual({ sessionKind: "regeltermin", sttEnvironmentId: "gpu-3", ttsEnvironmentId: null });
    expect(
      decodeSetInput({ sessionKind: "spontan", sttEnvironmentId: null, ttsEnvironmentId: "gpu-4" }),
    ).toEqual({ sessionKind: "spontan", sttEnvironmentId: null, ttsEnvironmentId: "gpu-4" });
  });

  it("rejects unknown session kinds", () => {
    expect(() =>
      decodeRoute({ sessionKind: "other", sttEnvironmentId: null, ttsEnvironmentId: null }),
    ).toThrow();
  });

  it("rejects a route without explicit computer fields", () => {
    expect(() => decodeRoute({ sessionKind: "spontan" })).toThrow();
  });
});
