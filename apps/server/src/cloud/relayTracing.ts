import { makeRelayClientTracingLayer } from "@workjet/shared/relayTracing";

import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

const relayClientTracingConfig = resolveRelayClientTracingConfig();

export const headlessRelayClientTracingLayer = makeRelayClientTracingLayer(
  relayClientTracingConfig,
  {
    serviceName: "workjet-headless-relay-client",
    runtime: "node",
    client: "headless-cli",
  },
);

export const serverRelayBrokerTracingLayer = makeRelayClientTracingLayer(relayClientTracingConfig, {
  serviceName: "workjet-server",
  runtime: "node",
  client: "environment-server",
  component: "relay-broker",
});
