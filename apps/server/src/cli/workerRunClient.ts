// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { WorkerRunLedgerError } from "../workjet/WorkerRunLedger.ts";
import packageJson from "../../package.json" with { type: "json" };
const envelope = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optional(Schema.Number),
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
);
const initialize = Schema.Struct({
  serverInfo: Schema.Struct({ name: Schema.Literal("Workjet") }),
});
const toolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
});
const fail = () =>
  new WorkerRunLedgerError({
    detail: "Worker MCP transport rejected the request or returned an invalid response",
  });
export const workerRunToolRequest = Effect.fn("cli.workerRun.request")(
  function* (
    target: { readonly endpoint: string; readonly token: string },
    name: string,
    input: Readonly<Record<string, unknown>>,
  ) {
    const http = yield* HttpClient.HttpClient;
    const post = Effect.fn("cli.workerRun.post")(function* (
      method: string,
      id: number | null,
      params: unknown,
      sessionId?: string,
    ) {
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        jsonrpc: "2.0",
        ...(id === null ? {} : { id }),
        method,
        params,
      });
      const response = yield* http.execute(
        HttpClientRequest.post(target.endpoint).pipe(
          HttpClientRequest.bearerToken(target.token),
          HttpClientRequest.setHeaders({
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-06-18",
            ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
          }),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
      );
      if (response.status < 200 || response.status >= 300) return yield* fail();
      if (id === null) return { value: undefined, sessionId: response.headers["mcp-session-id"] };
      const text = yield* response.text;
      if (new TextEncoder().encode(text).length > 256 * 1024) return yield* fail();
      const data = response.headers["content-type"]?.includes("text/event-stream")
        ? text
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
        : [text];
      const messages = yield* Effect.forEach(data, (body) =>
        Schema.decodeUnknownEffect(envelope)(body),
      );
      const matches = messages.filter((entry) => entry.id === id);
      if (
        matches.length !== 1 ||
        matches[0]!.error !== undefined ||
        matches[0]!.result === undefined
      )
        return yield* fail();
      return { value: matches[0]!.result, sessionId: response.headers["mcp-session-id"] };
    });
    return yield* Effect.acquireUseRelease(
      post("initialize", 1, {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "Workjet CLI", version: packageJson.version },
      }).pipe(
        Effect.flatMap((response) =>
          Effect.gen(function* () {
            yield* Schema.decodeUnknownEffect(initialize)(response.value);
            if (!response.sessionId) return yield* fail();
            return response.sessionId;
          }),
        ),
      ),
      (sessionId) =>
        Effect.gen(function* () {
          yield* post("notifications/initialized", null, {}, sessionId);
          const response = yield* post("tools/call", 2, { name, arguments: input }, sessionId);
          return yield* Schema.decodeUnknownEffect(toolResult)(response.value);
        }),
      (sessionId) =>
        http
          .execute(
            HttpClientRequest.delete(target.endpoint).pipe(
              HttpClientRequest.bearerToken(target.token),
              HttpClientRequest.setHeader("mcp-session-id", sessionId),
            ),
          )
          .pipe(Effect.asVoid, Effect.timeout(Duration.seconds(3)), Effect.ignore),
    );
  },
  Effect.scoped,
  Effect.timeout(Duration.minutes(5)),
  Effect.mapError(fail),
);
