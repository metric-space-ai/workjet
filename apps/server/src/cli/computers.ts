import {
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  WorkjetComputerInventory,
} from "@workjet/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

export class ComputerInventoryRequestError extends Schema.TaggedErrorClass<ComputerInventoryRequestError>()(
  "ComputerInventoryRequestError",
  { code: Schema.String, traceId: Schema.optionalKey(Schema.String) },
) {
  override get message() {
    return `Could not read the computer registry (${this.code}${this.traceId ? `, trace ${this.traceId}` : ""}). Check the worker source channel or server URL and orchestration read permission.`;
  }
}
const isEnvironmentError = Schema.is(EnvironmentHttpCommonError);
const isInventoryError = Schema.is(ComputerInventoryRequestError);
const encodeInventory = Schema.encodeEffect(Schema.fromJsonString(WorkjetComputerInventory));
const decodeInventory = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkjetComputerInventory));

export function computerInventoryRequestError(error: unknown) {
  if (isInventoryError(error)) return error;
  return new ComputerInventoryRequestError(
    isEnvironmentError(error)
      ? { code: error.code, traceId: error.traceId }
      : { code: "request_failed" },
  );
}

/** Ephemeral worker capabilities may only be sent to the installed loopback harness. */
export function workerComputerInventoryUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ComputerInventoryRequestError({ code: "invalid_worker_source_url" });
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.port ||
    Number(url.port) < 1 ||
    !["/v1", "/v1/"].includes(url.pathname)
  ) {
    throw new ComputerInventoryRequestError({ code: "invalid_worker_source_url" });
  }
  url.pathname = "/v1/workjet/computers";
  return url.href;
}

export function resolveWorkerInventorySource(sourceUrl?: string, sourceKey?: string) {
  if (sourceUrl === undefined && sourceKey === undefined) return undefined;
  if (sourceUrl === undefined || sourceKey === undefined || !sourceKey.trim()) {
    throw new ComputerInventoryRequestError({ code: "worker_source_incomplete" });
  }
  return { sourceUrl, sourceKey };
}

export const readWorkerComputerInventory = Effect.fn("cli.computers.readWorker")(
  function* (sourceUrl: string, sourceKey: string) {
    if (!sourceKey.trim())
      return yield* new ComputerInventoryRequestError({ code: "worker_source_key_missing" });
    const url = yield* Effect.try({
      try: () => workerComputerInventoryUrl(sourceUrl),
      catch: computerInventoryRequestError,
    });
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.bearerToken(sourceKey),
        HttpClientRequest.acceptJson,
      ),
    );
    if (response.status !== 200)
      return yield* new ComputerInventoryRequestError({
        code: `worker_source_status_${response.status}`,
      });
    const body = yield* response.text;
    if (body.length > 1024 * 1024)
      return yield* new ComputerInventoryRequestError({ code: "worker_source_response_too_large" });
    return yield* decodeInventory(body);
  },
  Effect.scoped,
  Effect.timeout(Duration.seconds(10)),
  Effect.mapError(computerInventoryRequestError),
);

export const computersCommand = Command.make("computers").pipe(
  Command.withDescription(
    "Discover configured Code computers and worker profiles (not an online probe).",
  ),
  Command.withSubcommands([
    Command.make("list", {
      url: Flag.string("url").pipe(
        Flag.withDescription("Workjet server origin outside a worker source channel."),
        Flag.optional,
      ),
      json: Flag.boolean("json").pipe(Flag.withDefault(false)),
    }).pipe(
      Command.withDescription(
        "Use the scoped worker source channel, or WORKJET_ACCESS_TOKEN with --url.",
      ),
      Command.withHandler(({ url, json }) =>
        Effect.gen(function* () {
          const sourceUrl = yield* Config.option(Config.string("WORKJET_WORKER_SOURCE_URL"));
          const sourceKey = yield* Config.option(Config.string("WORKJET_WORKER_SOURCE_KEY"));
          const workerSource = yield* Effect.try({
            try: () =>
              resolveWorkerInventorySource(
                Option.getOrUndefined(sourceUrl),
                Option.getOrUndefined(sourceKey),
              ),
            catch: computerInventoryRequestError,
          });
          const inventory = yield* Effect.gen(function* () {
            if (workerSource !== undefined) {
              return yield* readWorkerComputerInventory(
                workerSource.sourceUrl,
                workerSource.sourceKey,
              );
            }
            if (Option.isNone(url))
              return yield* new ComputerInventoryRequestError({ code: "server_url_missing" });
            const token = yield* Config.string("WORKJET_ACCESS_TOKEN");
            const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: url.value });
            return yield* client.orchestration
              .computers({ headers: { authorization: `Bearer ${token}` } })
              .pipe(
                Effect.timeout(Duration.seconds(10)),
                Effect.mapError(computerInventoryRequestError),
              );
          });
          yield* Console.log(
            json
              ? yield* encodeInventory(inventory)
              : inventory.computers
                  .map(
                    (computer) =>
                      `${computer.id}\t${computer.label}\t${computer.environmentId}\t${computer.harnesses.map((harness) => `${harness.harness} (${harness.available ? "configured available" : "configured unavailable"})`).join(", ")}\t${computer.profiles.map((profile) => `${profile.id} (${profile.name})`).join(", ")}`,
                  )
                  .join("\n"),
          );
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    ),
  ]),
);
