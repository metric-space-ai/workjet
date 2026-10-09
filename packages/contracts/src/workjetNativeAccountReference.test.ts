import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { WorkjetConfiguration, WorkjetNativeAccountReference } from "./workjet.ts";
import { WorkjetLumaInstanceConfiguration } from "./workjetLumaConfiguration.ts";

const decodeConfiguration = Schema.decodeUnknownSync(WorkjetConfiguration);
const encodeConfiguration = Schema.encodeUnknownSync(WorkjetConfiguration);
const decodeInstanceConfiguration = Schema.decodeUnknownSync(WorkjetLumaInstanceConfiguration);
const encodeInstanceConfiguration = Schema.encodeUnknownSync(WorkjetLumaInstanceConfiguration);
const decodeReference = Schema.decodeUnknownSync(WorkjetNativeAccountReference);

const nativeAccountReference = {
  accountId: "196a89ba-ee86-4413-885c-04ca60e6f291",
  holderInstanceId: "322084e5-8239-48d7-b3c5-c5178fbe5822",
  accountRevision: 3,
};
const route = {
  id: "claude-selected",
  label: "Selected Claude account",
  gatewayAccountId: "source-claude-account",
  nativeAccountReference,
};

describe("native Luma account reference persistence", () => {
  it("retains the exact native reference through settings encode and reload", () => {
    const decode = decodeConfiguration;
    const encode = encodeConfiguration;
    const initial = decode({ llmRoutes: [route] });
    expect(decode(encode(initial)).llmRoutes).toEqual([route]);
  });

  it("retains the reference through the instance Luma document without secret fields", () => {
    const local = decodeConfiguration({
      llmRoutes: [
        {
          ...route,
          nativeAccountReference: {
            ...nativeAccountReference,
            accessToken: "private-fixture",
            secretRef: "private-fixture",
          },
        },
      ],
    });
    const encode = encodeInstanceConfiguration;
    const decode = decodeInstanceConfiguration;
    const publicDocument = encode(local);
    expect(decode(publicDocument).llmRoutes).toEqual([route]);
    expect(JSON.stringify(publicDocument)).not.toContain("private-fixture");
  });

  it("does not invent native authority for legacy gateway or driver references", () => {
    const local = decodeConfiguration({
      schemaVersion: 1,
      llmRoutes: [
        { id: "gateway", label: "Gateway", gatewayAccountId: route.gatewayAccountId },
        { id: "driver", label: "Driver", providerInstanceId: route.gatewayAccountId },
      ],
    });
    const reloaded = decodeConfiguration(
      encodeConfiguration(local),
    );
    expect(reloaded.llmRoutes.map((entry) => entry.gatewayAccountId)).toEqual([
      route.gatewayAccountId,
      route.gatewayAccountId,
    ]);
    for (const entry of reloaded.llmRoutes) {
      expect(entry).not.toHaveProperty("nativeAccountReference");
    }
  });

  it("rejects incomplete references and unsafe account revisions instead of discarding them", () => {
    const decode = decodeReference;
    for (const value of [
      { ...nativeAccountReference, accountId: "" },
      { ...nativeAccountReference, holderInstanceId: "" },
      { ...nativeAccountReference, holderInstanceId: "a".repeat(257) },
      { ...nativeAccountReference, accountRevision: 0 },
      { ...nativeAccountReference, accountRevision: -1 },
      { ...nativeAccountReference, accountRevision: 1.5 },
      { ...nativeAccountReference, accountRevision: Number.MAX_SAFE_INTEGER + 1 },
      { accountId: nativeAccountReference.accountId },
    ]) {
      expect(() => decode(value)).toThrow();
      expect(() =>
        decodeConfiguration({
          llmRoutes: [{ ...route, nativeAccountReference: value }],
        }),
      ).toThrow();
    }
  });
});
