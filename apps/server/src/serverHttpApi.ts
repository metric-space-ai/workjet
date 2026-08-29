import {
  EnvironmentAuthHttpApi,
  EnvironmentMetadataHttpApi,
  EnvironmentOrchestrationHttpApi,
  EnvironmentPullRequestsHttpApi,
} from "@t3tools/contracts";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";

/**
 * HTTP surface served by the local Workjet server after the remote hardcut.
 *
 * The shared product API temporarily retains the legacy Business OS mobile
 * control group for client compatibility. The server must not expose it.
 */
export class ServerEnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentPullRequestsHttpApi) {}
