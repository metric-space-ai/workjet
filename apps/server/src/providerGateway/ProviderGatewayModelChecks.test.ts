// @effect-diagnostics nodeBuiltinImport:off -- Real loopback transport regression.
import * as NodeHttp from "node:http";
import { describe, expect, it, vi } from "vite-plus/test";
import { WorkjetGatewayAccountId } from "@workjet/contracts";
import {
  makeModelChecks,
  MODEL_CHECK_COOLDOWN_MS,
  MODEL_CHECK_BATCH_LIMIT,
  MODEL_CHECK_QUEUE_LIMIT,
  MODEL_CHECK_TIMEOUT_MS,
  type ModelCheckTarget,
} from "./ProviderGatewayModelChecks.ts";
import { nodeProviderGatewayPlatform } from "./ProviderGatewayNodeAdapter.ts";

const target = (accountId = "one", revision = "credential-version-one"): ModelCheckTarget => ({
  accountId,
  modelId: "model",
  revision,
});
const setup = () => {
  let time = 1000;
  let persisted: string | null = null;
  let targets = [target(), target("two")];
  const calls: Array<string> = [];
  const options = {
    now: () => time,
    targets: async () => targets,
    read: async () => persisted,
    write: async (text: string) => {
      persisted = text;
    },
    probe: async (item: ModelCheckTarget) => {
      calls.push(item.accountId);
      return {
        status: "ok" as const,
        errorClass: null,
        httpStatus: 200,
        source: "upstream" as const,
      };
    },
  };
  return {
    options,
    calls,
    setTime: (next: number) => {
      time = next;
    },
    setTargets: (next: Array<ModelCheckTarget>) => {
      targets = next;
    },
    persisted: () => persisted,
  };
};
describe("bounded model checks", () => {
  it("times out an uncooperative probe, advances the queue and rejects its late success", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    fixture.setTargets(
      (await fixture.options.targets()).map((item) => ({ ...item, modelId: "grok-4.7" })),
    );
    let release!: (value: Awaited<ReturnType<typeof fixture.options.probe>>) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requestSignal!: AbortSignal;
    const checks = makeModelChecks({
      ...fixture.options,
      probe: (item, signal) => {
        if (item.accountId !== "one") return fixture.options.probe(item);
        requestSignal = signal;
        started();
        return new Promise<Awaited<ReturnType<typeof fixture.options.probe>>>((resolve) => {
          release = resolve;
        });
      },
    });
    try {
      await checks.schedule({});
      await began;
      await vi.advanceTimersByTimeAsync(MODEL_CHECK_TIMEOUT_MS);
      await checks.drain();
      const result = await checks.list();
      expect(result.pending).toEqual([]);
      expect(requestSignal.aborted).toBe(true);
      expect(result.checks.find((item) => item.accountId === "one")).toMatchObject({
        status: "unavailable",
        source: "gateway",
        errorClass: null,
        httpStatus: null,
        unavailableReason: "timeout",
      });
      expect(result.checks.find((item) => item.accountId === "two")?.status).toBe("ok");
      release({ status: "ok", source: "upstream", errorClass: null, httpStatus: 200 });
      await Promise.resolve();
      expect((await checks.list()).checks.find((item) => item.accountId === "one")?.status).toBe(
        "unavailable",
      );
      expect(JSON.parse(fixture.persisted()!).entries[0].check.unavailableReason).toBe("timeout");
    } finally {
      await checks.shutdown();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });
  it("cancels an uncooperative probe immediately without persisting a result", async () => {
    vi.useFakeTimers();
    const fixture = setup();
    fixture.setTargets([{ ...target(), modelId: "grok-4.7" }]);
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requestSignal!: AbortSignal;
    const checks = makeModelChecks({
      ...fixture.options,
      probe: (_item, signal) => {
        requestSignal = signal;
        started();
        return new Promise<Awaited<ReturnType<typeof fixture.options.probe>>>(() => undefined);
      },
    });
    try {
      await checks.schedule({});
      await began;
      await checks.cancel();
      expect(requestSignal.aborted).toBe(true);
      expect((await checks.list()).pending).toEqual([]);
      expect((await checks.list()).checks).toEqual([]);
      expect(fixture.persisted()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await checks.shutdown();
      vi.useRealTimers();
    }
  });
  it("clears only the reauthenticated account and rechecks even an unchanged revision", async () => {
    const fixture = setup();
    fixture.setTargets(
      (await fixture.options.targets()).map((item) => ({ ...item, modelId: "grok-4.7" })),
    );
    const checks = makeModelChecks(fixture.options);
    await checks.run({});
    fixture.calls.length = 0;
    const next = await checks.recheckAccounts(["one"]);
    expect(next.checks.map((item) => item.accountId)).toEqual(["two"]);
    expect(next.pending.map((item) => item.accountId)).toEqual(["one"]);
    await checks.drain();
    expect(fixture.calls).toEqual(["one"]);
    expect((await checks.list()).checks).toHaveLength(2);
    await checks.shutdown();
  });
  it.each([1, 2])("discards legacy v%s checks and checks them afresh", async (schemaVersion) => {
    const fixture = setup();
    const legacy = JSON.stringify({
      schemaVersion,
      entries: [
        {
          revision: target().revision,
          check: {
            accountId: "one",
            modelId: "model",
            status: "error",
            errorClass: "auth",
            httpStatus: 502,
            source: "upstream",
            checkedAtMs: 1000,
            latencyMs: 0,
          },
        },
      ],
    });
    const checks = makeModelChecks({ ...fixture.options, read: async () => legacy });
    expect((await checks.list()).checks).toEqual([]);
    const result = await checks.run({});
    expect(fixture.calls).toEqual(["one", "two"]);
    expect(result.checks.every((check) => check.source === "upstream")).toBe(true);
    expect(JSON.parse(fixture.persisted()!).schemaVersion).toBe(3);
  });
  it("advances every slow target before repeating a cooled prefix across mixed commands", async () => {
    const fixture = setup();
    const targets = Array.from({ length: 100 }, (_, index) => ({
      ...target("account"),
      modelId: `model-${index}`,
    }));
    fixture.setTargets(targets);
    const calledModels: Array<string> = [];
    const checks = makeModelChecks({
      ...fixture.options,
      probe: async (item) => {
        fixture.setTime(fixture.options.now() + 15_000);
        calledModels.push(item.modelId);
        return { status: "ok", errorClass: null, httpStatus: 200 };
      },
    });
    for (const force of [true, false, true, false]) {
      await checks.run({ force });
      const firstPass = calledModels.slice(0, targets.length);
      expect(new Set(firstPass).size).toBe(firstPass.length);
    }
    expect(fixture.options.now()).toBeGreaterThan(MODEL_CHECK_COOLDOWN_MS);
    expect(calledModels.slice(0, targets.length)).toEqual(targets.map((item) => item.modelId));
    expect((await checks.list()).checks).toHaveLength(100);
  });

  it("bounds slow admission, advances a deferred suffix and cancels active transport", async () => {
    const fixture = setup();
    const targets = Array.from({ length: 100 }, (_, index) => target(`account-${index}`));
    fixture.setTargets(targets);
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const slow = makeModelChecks({
      ...fixture.options,
      probe: async (_item, signal) => {
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
        return { status: "ok", errorClass: null, httpStatus: 200 };
      },
    });
    const first = await slow.schedule({});
    expect(first.pending).toHaveLength(MODEL_CHECK_BATCH_LIMIT);
    expect(first.deferredCount).toBe(100 - MODEL_CHECK_BATCH_LIMIT);
    await began;
    const second = await slow.schedule({});
    expect(second.pending.length).toBeLessThanOrEqual(MODEL_CHECK_QUEUE_LIMIT);
    await slow.shutdown();
    expect(aborted).toBe(true);
    expect((await slow.list()).checks).toEqual([]);
    expect((await slow.list()).pending).toEqual([]);

    const checks = makeModelChecks(fixture.options);
    await checks.run({ force: true });
    expect(fixture.calls).toHaveLength(32);
    await checks.run({ force: false });
    await checks.run({ force: false });
    const done = await checks.run({ force: false });
    expect(new Set(fixture.calls).size).toBe(100);
    expect(done.deferredCount).toBe(0);
    expect(done.checks).toHaveLength(100);
  });
  it("discards a delayed green when the account is replaced", async () => {
    const fixture = setup();
    fixture.setTargets([target()]);
    let release!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const checks = makeModelChecks({
      ...fixture.options,
      probe: async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: "ok", errorClass: null, httpStatus: 200 };
      },
    });
    await checks.schedule({});
    await began;
    fixture.setTargets([target("one", "new-credential")]);
    release();
    await checks.drain();
    expect((await checks.list()).checks).toEqual([]);
    expect(fixture.persisted()).toBeNull();
  });
  it("does not count future timestamps as fresh after clock rollback", async () => {
    const fixture = setup();
    const checks = makeModelChecks(fixture.options);
    await checks.run({});
    fixture.setTime(500);
    await checks.run({});
    expect(fixture.calls).toHaveLength(4);
  });
  it("schedules only changed credentials or newly added models after a mutation", async () => {
    const fixture = setup();
    const checks = makeModelChecks(fixture.options);
    const before = await checks.captureRevisions();
    fixture.setTargets([target(), target("two"), { ...target("one"), modelId: "new-model" }]);
    const result = await checks.scheduleChanged(before);
    expect(result.pending.map((item) => item.modelId)).toEqual(["new-model"]);
    await checks.drain();
    expect(fixture.calls).toEqual(["one"]);
  });

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
  it("stores no upstream error class when a local request throws private content", async () => {
    const fixture = setup();
    const checks = makeModelChecks({
      ...fixture.options,
      probe: async () => {
        throw new Error("key-private prompt Hi output-private");
      },
    });
    const result = await checks.run({});
    expect(
      result.checks.every(
        (item) =>
          item.status === "unavailable" && item.source === "gateway" && item.errorClass === null,
      ),
    ).toBe(true);
    expect(fixture.persisted()).not.toContain("private");
    expect(fixture.persisted()).not.toContain("Hi");
  });
  it("has one active transport request across distinct commands", async () => {
    const fixture = setup();
    let active = 0;
    let maximum = 0;
    const checks = makeModelChecks({
      ...fixture.options,
      probe: async () => {
        maximum = Math.max(maximum, ++active);
        await Promise.resolve();
        --active;
        return { status: "ok", errorClass: null, httpStatus: 200 };
      },
    });
    await Promise.all([
      checks.run({ accountId: WorkjetGatewayAccountId.make("one") }),
      checks.run({ accountId: WorkjetGatewayAccountId.make("two") }),
    ]);
    expect(maximum).toBe(1);
  });
});

describe("real loopback model probe", () => {
  it("pins the account and refuses ignored pins, invalid success and unknown models", async () => {
    const requests: Array<{ headers: NodeHttp.IncomingHttpHeaders; body: string }> = [];
    const server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        requests.push({ headers: request.headers, body });
        const input = JSON.parse(body) as { model: string };
        if (
          ![
            "ignored-pin",
            "ignored-error-pin",
            "preflight-auth",
            "preflight-quota",
            "cooldown",
          ].includes(input.model)
        )
          response.setHeader("X-CTOX-Account-Selected", request.headers["x-ctox-account"] ?? "");
        response.setHeader("content-type", "application/json");
        if (input.model === "oversized") {
          response.end("x".repeat(70 * 1024));
        } else if (["preflight-auth", "ignored-error-pin"].includes(input.model)) {
          response.statusCode = 401;
          if (input.model === "ignored-error-pin") response.setHeader("X-CTOX-Error-Class", "auth");
          response.end("{}");
        } else if (input.model === "preflight-quota") {
          response.statusCode = 429;
          response.end("{}");
        } else if (input.model === "cooldown") {
          response.statusCode = 503;
          response.end("{}");
        } else if (input.model === "preflight-model") {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: { code: "model_not_found" } }));
        } else if (input.model === "native-unknown") {
          response.statusCode = 503;
          response.setHeader("X-CTOX-Error-Class", "unknown-model");
          response.setHeader("X-CTOX-Upstream-Status", "404");
          response.end("{}");
        } else if (input.model === "html-auth") {
          response.statusCode = 401;
          response.setHeader("X-CTOX-Error-Class", "auth");
          response.setHeader("X-CTOX-Upstream-Status", "401");
          response.end("<html>private authentication error</html>");
        } else if (input.model === "quota") {
          response.statusCode = 429;
          response.setHeader("X-CTOX-Error-Class", "quota-rate-limit");
          response.setHeader("X-CTOX-Upstream-Status", "429");
          response.end("{}");
        } else if (input.model === "unknown") {
          response.statusCode = 400;
          response.setHeader("X-CTOX-Error-Class", "unknown-model");
          response.setHeader("X-CTOX-Upstream-Status", "400");
          response.end(
            JSON.stringify({ error: { code: "model_not_found", message: "secret-provider-text" } }),
          );
        } else if (input.model.startsWith("wrapped-")) {
          response.statusCode = 502;
          response.setHeader("X-CTOX-Error-Class", "auth");
          if (input.model !== "wrapped-legacy")
            response.setHeader("X-CTOX-Upstream-Status", input.model.slice("wrapped-".length));
          response.end("{}");
        } else if (input.model === "bare-404") {
          response.statusCode = 404;
          response.end("{}");
        } else if (input.model === "empty") response.end("{}");
        else
          response.end(
            JSON.stringify({
              status: input.model === "failed-status" ? "failed" : "completed",
              ...(input.model === "null-error" || input.model === "failed-status"
                ? { error: null }
                : input.model === "error-payload"
                  ? { error: { code: "upstream_error", message: "private failure" } }
                  : {}),
              output: [{ type: "message", content: [{ text: "private generated content" }] }],
            }),
          );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("address");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const probe = nodeProviderGatewayPlatform.providerModelCheck!;
      expect(await probe(endpoint, "kimi", "chosen", "valid")).toEqual({
        status: "ok",
        errorClass: null,
        httpStatus: 200,
        source: "upstream",
      });
      expect((await probe(endpoint, "kimi", "chosen", "unknown")).errorClass).toBe("unknown-model");
      for (const model of [
        "ignored-pin",
        "ignored-error-pin",
        "preflight-auth",
        "preflight-quota",
        "preflight-model",
        "cooldown",
        "bare-404",
        "empty",
        "error-payload",
        "failed-status",
        "wrapped-200",
        "wrapped-invalid",
        "wrapped-legacy",
      ]) {
        const result = await probe(endpoint, "kimi", "chosen", model);
        expect(result.status, model).toBe("unavailable");
        expect(result.source, model).toBe("gateway");
        expect(result.errorClass, model).toBeNull();
      }
      expect((await probe(endpoint, "minimax", "chosen", "null-error")).status).toBe("ok");
      expect((await probe(endpoint, "minimax", "chosen", "error-payload")).status).toBe(
        "unavailable",
      );
      expect((await probe(endpoint, "minimax", "chosen", "failed-status")).status).toBe(
        "unavailable",
      );
      expect((await probe(endpoint, "claude", "chosen", "bare-404")).errorClass).toBeNull();
      expect((await probe(endpoint, "kimi", "chosen", "native-unknown")).errorClass).toBe(
        "unknown-model",
      );
      expect((await probe(endpoint, "kimi", "chosen", "html-auth")).errorClass).toBe("auth");
      expect((await probe(endpoint, "kimi", "chosen", "quota")).errorClass).toBe(
        "quota-rate-limit",
      );
      for (const status of [401, 403]) {
        expect(await probe(endpoint, "xai", "chosen", `wrapped-${status}`)).toEqual({
          status: "error",
          errorClass: "auth",
          httpStatus: status,
          source: "upstream",
        });
      }

      await expect(probe(endpoint, "kimi", "chosen", "oversized")).rejects.toThrow("oversized");
      expect(requests[0]?.headers["x-ctox-provider"]).toBe("kimi");
      expect(requests[0]?.headers["x-ctox-account"]).toBe("chosen");
      expect(requests[0]?.headers["x-ctox-purpose"]).toBe("model-check");
      expect(JSON.parse(requests[0]!.body)).toEqual({
        model: "valid",
        input: [{ role: "user", content: "Hi" }],
        max_output_tokens: 8,
        stream: false,
      });
      expect((await probe(endpoint, "codex", "chosen", "null-error")).status).toBe("ok");
      expect(JSON.parse(requests.at(-1)!.body)).toEqual({
        model: "null-error",
        input: [{ role: "user", content: "Hi" }],
        instructions: "Reply with Hi only.",
        store: false,
        stream: false,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
