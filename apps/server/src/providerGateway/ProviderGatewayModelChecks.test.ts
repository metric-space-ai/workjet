// @effect-diagnostics nodeBuiltinImport:off -- Real loopback transport regression.
import * as Http from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { WorkjetGatewayAccountId } from "@workjet/contracts";
import { makeModelChecks, MODEL_CHECK_COOLDOWN_MS, type ModelCheckTarget } from "./ProviderGatewayModelChecks.ts";
import { nodeProviderGatewayPlatform } from "./ProviderGatewayNodeAdapter.ts";

const target = (accountId = "one", revision = "credential-version-one"): ModelCheckTarget => ({ accountId, modelId: "model", revision });
const setup = () => {
  let time = 1000;
  let persisted: string | null = null;
  let targets = [target(), target("two")];
  const calls: Array<string> = [];
  const options = {
    now: () => time, targets: async () => targets,
    read: async () => persisted, write: async (text: string) => { persisted = text; },
    probe: async (item: ModelCheckTarget) => { calls.push(item.accountId); return { status: "ok" as const, errorClass: null, httpStatus: 200 }; },
  };
  return { options, calls, setTime: (next: number) => { time = next; }, setTargets: (next: Array<ModelCheckTarget>) => { targets = next; }, persisted: () => persisted };
};
describe("bounded model checks", () => {
  it("coalesces, serializes, gates and persists checks across restart", async () => {
    const fixture = setup();
    const checks = makeModelChecks(fixture.options);
    await Promise.all([checks.run({}), checks.run({})]);
    expect(fixture.calls).toEqual(["one", "two"]);
    await checks.run({});
    expect(fixture.calls).toHaveLength(2);
    const restarted = makeModelChecks(fixture.options);
    expect((await restarted.list()).checks).toHaveLength(2);
    await restarted.run({});
    expect(fixture.calls).toHaveLength(2);
    await restarted.run({ accountId: WorkjetGatewayAccountId.make("one"), force: true });
    expect(fixture.calls).toEqual(["one", "two", "one"]);
    fixture.setTime(1000 + MODEL_CHECK_COOLDOWN_MS);
    await restarted.run({});
    expect(fixture.calls).toHaveLength(5);
  });
  it("promotes a simultaneous manual override over a cooled automatic command", async () => {
    const fixture = setup();
    const checks = makeModelChecks(fixture.options);
    await checks.run({});
    await Promise.all([checks.run({}), checks.run({ force: true })]);
    expect(fixture.calls).toEqual(["one", "two", "one", "two"]);
  });
  it("invalidates only changed account credentials and deleted models", async () => {
    const fixture = setup();
    const checks = makeModelChecks(fixture.options);
    await checks.run({});
    fixture.setTargets([target("one", "replacement"), target("two")]);
    expect((await checks.list()).checks.map((item) => item.accountId)).toEqual(["two"]);
    await checks.run({});
    expect(fixture.calls).toEqual(["one", "two", "one"]);
    fixture.setTargets([]);
    expect((await checks.list()).checks).toEqual([]);
  });
  it("stores a fixed error class when a provider throws private content", async () => {
    const fixture = setup();
    const checks = makeModelChecks({ ...fixture.options, probe: async () => { throw new Error("key-private prompt Hi output-private"); } });
    const result = await checks.run({});
    expect(result.checks.every((item) => item.errorClass === "network-provider")).toBe(true);
    expect(fixture.persisted()).not.toContain("private");
    expect(fixture.persisted()).not.toContain("Hi");
  });
  it("has one active transport request across distinct commands", async () => {
    const fixture = setup();
    let active = 0;
    let maximum = 0;
    const checks = makeModelChecks({ ...fixture.options, probe: async () => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve(); --active;
      return { status: "ok", errorClass: null, httpStatus: 200 };
    }});
    await Promise.all([checks.run({ accountId: WorkjetGatewayAccountId.make("one") }), checks.run({ accountId: WorkjetGatewayAccountId.make("two") })]);
    expect(maximum).toBe(1);
  });
});

describe("real loopback model probe", () => {
  it("pins the account and refuses ignored pins, invalid success and unknown models", async () => {
    const requests: Array<{ headers: Http.IncomingHttpHeaders; body: string }> = [];
    const server = Http.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => {
        requests.push({ headers: request.headers, body });
        const input = JSON.parse(body) as { model: string };
        if (input.model !== "ignored-pin") response.setHeader("X-CTOX-Account-Selected", request.headers["x-ctox-account"] ?? "");
        response.setHeader("content-type", "application/json");
        if (input.model === "unknown") { response.statusCode = 400; response.end(JSON.stringify({ error: { code: "model_not_found", message: "secret-provider-text" } })); }
        else if (input.model === "empty") response.end("{}");
        else response.end(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ text: "private generated content" }] }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("address");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const probe = nodeProviderGatewayPlatform.providerModelCheck!;
      expect(await probe(endpoint, "kimi", "chosen", "valid")).toEqual({ status: "ok", errorClass: null, httpStatus: 200 });
      expect((await probe(endpoint, "kimi", "chosen", "unknown")).errorClass).toBe("unknown-model");
      expect((await probe(endpoint, "kimi", "chosen", "ignored-pin")).errorClass).toBe("account-selection-unavailable");
      expect((await probe(endpoint, "kimi", "chosen", "empty")).status).toBe("error");
      expect(requests[0]?.headers["x-ctox-provider"]).toBe("kimi");
      expect(requests[0]?.headers["x-ctox-account"]).toBe("chosen");
      expect(JSON.parse(requests[0]!.body)).toEqual({ model: "valid", input: "Hi", max_output_tokens: 8, stream: false });
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
