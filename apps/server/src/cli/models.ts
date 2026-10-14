// @effect-diagnostics globalFetch:off -- A user-selected Workjet server is fetched without redirects.
import { WorkjetOfficialCodingModelExport } from "@workjet/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

export class CodingModelExportRequestError extends Schema.TaggedErrorClass<CodingModelExportRequestError>()(
  "CodingModelExportRequestError",
  { code: Schema.String },
) {
  override get message() {
    return `Could not read the Workjet coding model export (${this.code}). Check the server URL and orchestration read permission.`;
  }
}

const jsonSchema = Schema.fromJsonString(WorkjetOfficialCodingModelExport);
const decode = Schema.decodeUnknownSync(jsonSchema);
const encode = Schema.encodeSync(jsonSchema);

/** Never follow a redirect with the access token or reuse caller-supplied path data. */
export function codingModelExportUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new CodingModelExportRequestError({ code: "invalid_url" });
  }
  url.pathname = "/api/workjet/coding-models";
  return url.href;
}

async function readCodingModels(url: string, token: string) {
  const response = await fetch(codingModelExportUrl(url), {
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status !== 200) throw new Error("request_failed");
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > 2 * 1024 * 1024)
    throw new Error("response_too_large");
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw new Error("response_too_large");
  return decode(body);
}

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
          const result = yield* Effect.tryPromise({
            try: () => readCodingModels(url, token),
            catch: () => new CodingModelExportRequestError({ code: "request_failed" }),
          });
          yield* Console.log(encode(result));
        }),
      ),
    ),
  ]),
);
