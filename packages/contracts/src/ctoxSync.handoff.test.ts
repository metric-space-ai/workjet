import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  SessionHandoffWireRequestSchema,
  SessionHandoffWireReplySchema,
} from "./ctoxSync.schema.generated.ts";

const decode = Schema.decodeUnknownSync(SessionHandoffWireRequestSchema, {
  onExcessProperty: "error",
});
const request = {
  issuerIdentity: "ed25519:" + "a".repeat(64),
  phase: "receive",
  bindingDigest: "b".repeat(64),
  audience: "scope",
  nonce: "c".repeat(32),
  spec: {
    jobId: "job",
    sessionId: "session",
    scopeId: "scope",
    harness: "native",
    harnessVersion: "1",
    modelRouteId: "openai",
    gatewayAccountId: "account",
    modelId: "model",
    requiredCapabilities: ["execution.native"],
  },
  checkpointDigest: "d".repeat(64),
  checkpointSequence: 1,
  ownership: { nodeId: 1, generation: 2 },
};
describe("native handoff phase wire shape", () => {
  it("preserves the protected artifact range and signed receive decision", () => {
    const receivePermit = {
      version: 1,
      bindingDigest: request.bindingDigest,
      phase: "receive",
      audience: request.audience,
      nonce: request.nonce,
      jobId: request.spec.jobId,
      sessionId: request.spec.sessionId,
      scopeId: request.spec.scopeId,
      checkpointDigest: request.checkpointDigest,
      checkpointSequence: request.checkpointSequence,
      ownershipGeneration: request.ownership.generation,
      principalEpoch: 1,
      bindingRevision: 2,
      issuedAtMs: 1,
      expiresAtMs: 60001,
      signature: "test-placeholder",
    };
    const artifact = { sha256: "f".repeat(64), sizeBytes: 8192 };
    const fetch = {
      type: "fetch",
      request,
      challenge: "e".repeat(32),
      receivePermit,
      artifact,
      offset: 0,
    };
    expect(decode(fetch)).toEqual(fetch);
    expect(() => decode({ ...fetch, offset: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => decode({ ...fetch, approved: true })).toThrow();
    const chunk = {
      type: "chunk",
      permit: receivePermit,
      artifact,
      offset: 0,
      sizeBytes: 8192,
      hex: "6162",
    };
    const decodeReply = Schema.decodeUnknownSync(SessionHandoffWireReplySchema, {
      onExcessProperty: "error",
    });
    expect(decodeReply(chunk)).toEqual(chunk);
    expect(() => decodeReply({ ...chunk, data: "untyped payload" })).toThrow();
  });

  it("keeps the exact request and receiver challenge in the authorization message", () => {
    const message = { type: "authorize", request, challenge: "e".repeat(32) };
    expect(decode(message)).toEqual(message);
    expect(decode({ type: "probe", request })).toEqual({ type: "probe", request });
    expect(
      Schema.decodeUnknownSync(SessionHandoffWireReplySchema)({
        type: "challenge",
        challenge: "e".repeat(32),
      }),
    ).toEqual({ type: "challenge", challenge: "e".repeat(32) });
  });
  it("rejects a missing challenge, unknown authority flags and unsafe generations", () => {
    expect(() => decode({ type: "authorize", request })).toThrow();
    expect(() => decode({ type: "probe", request, approved: true })).toThrow();
    expect(() =>
      decode({
        type: "probe",
        request: {
          ...request,
          ownership: { nodeId: 1, generation: Number.MAX_SAFE_INTEGER + 1 },
        },
      }),
    ).toThrow();
  });
});
