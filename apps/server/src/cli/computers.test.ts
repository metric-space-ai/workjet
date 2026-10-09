import { EnvironmentScopeRequiredError, AuthOrchestrationReadScope } from "@workjet/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  computerInventoryRequestError,
  workerComputerInventoryUrl,
  readWorkerComputerInventory,
  resolveWorkerInventorySource,
} from "./computers.ts";

it("retains the authenticated server's safe error code and trace", () => {
  const error = computerInventoryRequestError(
    new EnvironmentScopeRequiredError({
      code: "insufficient_scope",
      requiredScope: AuthOrchestrationReadScope,
      traceId: "inventory-trace",
    }),
  );
  expect(error.code).toBe("insufficient_scope");
  expect(error.traceId).toBe("inventory-trace");
});

it("does not preserve an unexpected transport error containing credentials", () => {
  const error = computerInventoryRequestError(new Error("Bearer private-session-secret"));
  expect(error.code).toBe("request_failed");
  expect(JSON.stringify(error)).not.toContain("private-session-secret");
  expect(error.message).not.toContain("private-session-secret");
});

it("accepts only explicit loopback worker harness URLs", () => {
  expect(workerComputerInventoryUrl("http://127.0.0.1:4321/v1")).toBe(
    "http://127.0.0.1:4321/v1/workjet/computers",
  );
  expect(workerComputerInventoryUrl("http://[::1]:4321/v1/")).toBe(
    "http://[::1]:4321/v1/workjet/computers",
  );
  for (const value of [
    "https://example.com/v1",
    "http://192.168.1.2:4321/v1",
    "http://localhost:4321/v1",
    "http://user:secret@127.0.0.1:4321/v1",
    "http://127.0.0.1:4321/v1?token=secret",
    "http://127.0.0.1:4321/",
  ]) {
    expect(() => workerComputerInventoryUrl(value)).toThrow("invalid_worker_source_url");
  }
});

it.effect("uses the worker source registry with its ephemeral capability", () =>
  Effect.gen(function* () {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const expected = {
      schemaVersion: 1,
      computers: [
        {
          id: "source-computer",
          label: "Registered source computer",
          environmentId: "source-environment",
          presentationKind: "ssh",
          harnesses: [],
          profiles: [],
        },
      ],
    };
    const http = HttpClient.make((request) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(expected)));
    });
    const inventory = yield* readWorkerComputerInventory(
      "http://127.0.0.1:4321/v1",
      "worker-only-key",
    ).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(inventory).toEqual(expected);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:4321/v1/workjet/computers",
        authorization: "Bearer worker-only-key",
      },
    ]);
  }),
);

it("fails closed for partially injected worker access", () => {
  expect(resolveWorkerInventorySource()).toBeUndefined();
  expect(resolveWorkerInventorySource("http://127.0.0.1:4321/v1", "worker-only-key")).toEqual({
    sourceUrl: "http://127.0.0.1:4321/v1",
    sourceKey: "worker-only-key",
  });
  expect(() => resolveWorkerInventorySource("http://127.0.0.1:4321/v1")).toThrow(
    "worker_source_incomplete",
  );
  expect(() => resolveWorkerInventorySource(undefined, "worker-only-key")).toThrow(
    "worker_source_incomplete",
  );
});
