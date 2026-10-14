import { EnvironmentHttpApi, WorkjetOfficialCodingModelExport } from "@workjet/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

const encode = Schema.encodeEffect(Schema.fromJsonString(WorkjetOfficialCodingModelExport));

/** An authenticated, fresh read from the running Workjet server. */
export const modelsCommand = Command.make("models").pipe(
  Command.withDescription("Inspect registered coding models with live account evidence."),
  Command.withSubcommands([
    Command.make("export", {
      url: Flag.string("url").pipe(
        Flag.withDescription("Workjet server origin (requires WORKJET_ACCESS_TOKEN)."),
      ),
    }).pipe(
      Command.withDescription("Print the official model and harness evidence as JSON."),
      Command.withHandler(({ url }) =>
        Effect.gen(function* () {
          const token = yield* Config.string("WORKJET_ACCESS_TOKEN");
          const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: url });
          const result = yield* client.orchestration.codingModels({
            headers: { authorization: `Bearer ${token}` },
          }).pipe(Effect.timeout(Duration.seconds(60)));
          yield* Console.log(yield* encode(result));
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      ),
    ),
  ]),
);
