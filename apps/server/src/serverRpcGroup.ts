import { WS_METHODS, WsRpcGroup } from "@t3tools/contracts";

/**
 * RPC surface served by the local Workjet server.
 *
 * The shared contract temporarily retains the legacy relay-client procedures
 * for clients that have not completed the hardcut. They are intentionally not
 * exposed by the server.
 */
export const ServerWsRpcGroup = WsRpcGroup.omit(
  WS_METHODS.cloudGetRelayClientStatus,
  WS_METHODS.cloudInstallRelayClient,
);
