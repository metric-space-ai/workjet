// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { workerRunToolRequest } from "./workerRunClient.ts";
const target = { endpoint: "http://127.0.0.1:12345/mcp", token: "fixture-scoped-bearer" };
it.effect("negotiates and closes only its own MCP session, including an SSE tool reply", () =>
  Effect.gen(function* () {
    const seen: Array<{ method: string; session: string | undefined }> = [];
    let step = 0;
    const http = HttpClient.make((request) => {
      seen.push({ method: request.method, session: request.headers["mcp-session-id"] });
      assert.equal(request.headers.authorization, `Bearer ${target.token}`);
      const responses = [
        Response.json(
          { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "Workjet" } } },
          { headers: { "mcp-session-id": "owned-session" } },
        ),
        new Response(null, { status: 202 }),
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"isError":false,"structuredContent":{"runId":"fake-worker-a"}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
        new Response(null, { status: 204 }),
      ];
      return Effect.succeed(HttpClientResponse.fromWeb(request, responses[step++]!));
    });
    const result = yield* workerRunToolRequest(target, "workjet_dispatch_worker", {
      task: "Fixture assignment",
      pool: "worker",
      taskType: "tests",
      difficulty: "small",
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    assert.deepEqual(result.structuredContent, { runId: "fake-worker-a" });
    assert.deepEqual(seen, [
      { method: "POST", session: undefined },
      { method: "POST", session: "owned-session" },
      { method: "POST", session: "owned-session" },
      { method: "DELETE", session: "owned-session" },
    ]);
  }),
);
it.effect("rejects an uncorrelated reply and closes its acquired session", () =>
  Effect.gen(function* () {
    let step = 0;
    let deleted = false;
    const http = HttpClient.make((request) => {
      if (request.method === "DELETE") deleted = true;
      const responses = [
        Response.json(
          { id: 1, result: { serverInfo: { name: "Workjet" } } },
          { headers: { "mcp-session-id": "owned-session" } },
        ),
        new Response(null, { status: 202 }),
        Response.json({ id: 77, result: { structuredContent: { runId: "foreign" } } }),
        new Response(null, { status: 204 }),
      ];
      return Effect.succeed(HttpClientResponse.fromWeb(request, responses[step++]!));
    });
    assert.equal(
      (yield* Effect.exit(
        workerRunToolRequest(target, "workjet_dispatch_worker", {}).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
      ))._tag,
      "Failure",
    );
    assert.isTrue(deleted);
  }),
);
