import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates Greppy inspection from server-wide runtime operation", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetGreppyInspect)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetGreppyInstall)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("authorizes automatic worktree storage inspection as an orchestration read", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetWorktreesInspect)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates provider gateway reads from lifecycle operation", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetGatewayStatus)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetGatewayCatalog)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetGatewayStart)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetGatewayStop)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the mesh roster under orchestration read, never a mailbox write scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetMeshRoster)).toBe(
      AuthOrchestrationReadScope,
    );
    // The roster must not inherit the send scope: looking at the recipient list
    // is not permission to put an envelope into somebody's mailbox.
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetMailboxSendMessage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the multi-computer overview under orchestration read too", () => {
    // The overview is the roster plus timestamps and counts this server already
    // holds. Wider data, same class of read — it must never require, or grant,
    // an operate scope.
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetMeshOverview)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates reading a cross-mode link from creating one or returning through it", () => {
    // The two reads carry references and a redacted label; the two writes create
    // a thread and cross an authority boundary.
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetCrossModeGetThreadLink)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetCrossModeListLinks)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetCrossModeOpenInCode)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetCrossModeSubmit)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates reading the handoff inbox from sending or accepting a handoff", () => {
    // Seeing that work was offered is a read; putting an envelope on another
    // machine, or creating a thread and starting a turn on it, are not.
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetMailboxListHandoffs)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetMailboxSendHandoff)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.workjetMailboxAcceptHandoff)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});
