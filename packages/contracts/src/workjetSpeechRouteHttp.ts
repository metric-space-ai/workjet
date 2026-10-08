// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import {
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";
import {
  WorkjetSpeechRoute,
  WorkjetSpeechRouteListResult,
  WorkjetSpeechRouteSetInput,
} from "./workjetSpeechRoutes.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const SpeechRouteErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
] as const;

export class WorkjetSpeechRouteHttpGroup extends HttpApiGroup.make("speechRoutes")
  .add(
    HttpApiEndpoint.post("list", "/api/workjet/speech/routes/list", {
      headers: OptionalBearerHeaders,
      success: WorkjetSpeechRouteListResult,
      error: SpeechRouteErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("set", "/api/workjet/speech/routes/set", {
      headers: OptionalBearerHeaders,
      payload: WorkjetSpeechRouteSetInput,
      success: WorkjetSpeechRoute,
      error: SpeechRouteErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/** Standalone scaffold, mirroring the Business OS computer membership API; not mounted in EnvironmentHttpApi yet. */
export class WorkjetSpeechRouteHttpApi extends HttpApi.make("workjetSpeechRoutes").add(
  WorkjetSpeechRouteHttpGroup,
) {}
