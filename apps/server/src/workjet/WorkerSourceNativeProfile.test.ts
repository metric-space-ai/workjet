import { describe, expect, it } from "vite-plus/test";
import { workerSourceDriver, workerSourceNativeProfile, WORKER_SOURCE_HARNESS_DRIVERS } from "./WorkerSourceNativeProfile.ts";

describe("source-only native worker profiles", () => {
  const pin = { model: "gpt-6.1-sol", baseUrl: "http://127.0.0.1:54321/v1", apiKey: "fixture-source-key", directory: "/private-worker/source" };
  it("retains legacy Codex identity and rejects an unsupported native adapter", () => {
    expect(workerSourceDriver(undefined)).toBe("codex");
    expect(workerSourceDriver("cursor-agent")).toBeUndefined();
  });
  for (const harness of Object.keys(WORKER_SOURCE_HARNESS_DRIVERS) as Array<keyof typeof WORKER_SOURCE_HARNESS_DRIVERS>) {
    it(`binds ${harness} to one source model and the private key`, () => {
      const profile = workerSourceNativeProfile({ ...pin, harness });
      expect(profile.environment.HOME).toBe("/private-worker/source/home");
      expect(profile.environment.WORKJET_SOURCE_ISOLATED).toBe("true");
      expect(profile.environment.OPENAI_API_KEY).toBe("");
      const encoded = JSON.stringify(profile);
      expect(encoded).toContain(pin.model);
      expect(encoded).toContain("fixture-source-key");
      expect(encoded).not.toContain("api.openai.com");
      expect(profile.files.every(file => !file.name.includes("/"))).toBe(true);
      if (harness === "opencode") {
        const config = JSON.parse(profile.environment.OPENCODE_CONFIG_CONTENT!);
        expect(config.enabled_providers).toEqual(["workjet-source"]);
        expect(Object.keys(config.provider["workjet-source"].models)).toEqual([pin.model]);
        expect(config.provider["workjet-source"].options.baseURL).toBe(pin.baseUrl);
      }
      if (harness === "pi-code") {
        const config = JSON.parse(profile.files[0]!.content);
        expect(Object.keys(config.providers)).toEqual(["workjet-source"]);
        expect(config.providers["workjet-source"].models.map((m: { id: string }) => m.id)).toEqual([pin.model]);
      }
      if (harness === "minimax-code") {
        const config = JSON.parse(profile.files[0]!.content);
        expect(Object.keys(config.custom_provider["workjet-source"].models)).toEqual([pin.model]);
        expect(config.custom_provider["workjet-source"].options.baseURL).toBe("http://127.0.0.1:54321");
      }
    });
  }
  it("refuses external endpoints, relative homes and unbound models", () => {
    for (const change of [{ baseUrl: "https://api.openai.com/v1" }, { baseUrl: "http://127.0.0.1:1/v1?model=x" }, { directory: "relative" }, { model: "" }])
      expect(() => workerSourceNativeProfile({ ...pin, harness: "claude-code", ...change })).toThrow("Invalid source-only");
  });
});
