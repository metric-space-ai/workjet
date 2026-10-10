import {
  DEFAULT_WORKJET_CONFIGURATION,
  EnvironmentId,
  ThreadId,
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetGatewayAccountId,
  WorkjetLlmRouteId,
  ProviderInstanceId,
  ProjectId,
  WorkjetGatewayInferenceError,
  type WorkjetGatewayInferenceInput,
  type WorkjetGatewayScopedCatalog,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { makeSourceGatewayInference } from "./SourceGatewayInference.ts";
import {
  makeCtoxRemoteWorkerAdmissionClient,
  remoteWorkerRequestDigest,
} from "../workjet/ctox/CtoxRemoteWorkerAdmission.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const environmentId = EnvironmentId.make("source");
const target = {
  connectionId: WorkjetConnectionId.make("target-connection"),
  instanceId: "target-instance",
  computerId: WorkjetComputerId.make("computer"),
};
const references = {
  credentialRef: { environmentId, accountId: WorkjetGatewayAccountId.make("exact-account") },
  providerRef: { environmentId, provider: "codex" as const },
  modelRef: { environmentId, provider: "codex" as const, modelId: "exact-model" },
};
const catalog: WorkjetGatewayScopedCatalog = {
  schemaVersion: 1,
  target,
  accounts: [
    {
      credentialRef: references.credentialRef,
      providerRef: references.providerRef,
      label: "Actual account",
      modelRefs: [references.modelRef],
    },
  ],
};
const input: WorkjetGatewayInferenceInput = {
  sourceConnectionId: WorkjetConnectionId.make("source-native"),
  workerRequest: {
    schemaVersion: 1,
    requestId: ThreadId.make("request"),
    targetEnvironmentId: EnvironmentId.make("target"),
    computerId: target.computerId,
    parent: { environmentId, threadId: ThreadId.make("supervisor") },
    parentTeamRole: "supervisor",
    parentCapabilityIds: ["greppy"],
    enabledCapabilityIds: ["greppy"],
    managedInstructions: "One PR",
    project: {
      id: ProjectId.make("project"),
      title: "Project",
      repository: {
        canonicalKey: "github:example/repository",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/example/repository",
        },
      },
    },
    revision: "c".repeat(40),
    task: "Task",
    title: "Task",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-07T10:00:00.000Z",
    expiresAt: "2026-10-08T10:00:00.000Z",
  },
  permit: {
    contract: "ctox.workjet.remote-worker-admission.v1",
    permitId: "permit",
    ownerUserId: "owner",
    authorityEpoch: 1,
    authorityFingerprint: `sha256:${"a".repeat(64)}`,
    expiresAtMs: 300000,
    state: "claimed",
    executionId: "execution",
    renewalSequence: 0,
    binding: {
      requestId: "request",
      requestDigest: "b".repeat(64),
      sourceEnvironmentId: environmentId,
      sourceSupervisorThreadId: ThreadId.make("supervisor"),
      sourceInstanceId: "source-instance",
      projectId: "project",
      targetEnvironmentId: EnvironmentId.make("target"),
      targetConnectionId: target.connectionId,
      targetInstanceId: target.instanceId,
      targetComputerId: target.computerId,
      repositoryUrl: "https://github.com/example/repository",
      repositoryHead: "c".repeat(40),
      workspaceKey: "request",
      ...references,
      capabilities: ["repository_read", "repository_write", "run_checks", "open_pull_request"],
    },
  },
  requestJson: encodeJson({
    model: "exact-model",
    input: [{ role: "user", content: "Task" }],
    stream: false,
  }),
};
const fixture = (forwardProtocol?: Parameters<typeof makeSourceGatewayInference>[0]["forwardProtocol"]) => {
  const events: string[] = [];
  const deadlines: number[] = [];
  let scoped = catalog;
  let receipt: unknown = input.permit;
  let nativeError: WorkjetGatewayInferenceError | undefined;
  let now = 1000;
  let afterForward: () => void = () => undefined;
  const consumer = makeSourceGatewayInference({
    environmentId: Effect.succeed(environmentId),
    configuration: Effect.succeed({
      ...DEFAULT_WORKJET_CONFIGURATION,
      llmRoutes: [
        {
          id: WorkjetLlmRouteId.make("route"),
          label: "Configured route",
          gatewayAccountId: references.credentialRef.accountId,
        },
      ],
    }),
    requireSourceInstance: (instanceId) =>
      instanceId === "codex"
        ? Effect.void
        : Effect.fail(new WorkjetGatewayInferenceError({ reason: "binding-mismatch" })),
    scopedCatalog: () =>
      Effect.sync(() => {
        events.push("catalog");
        return scoped;
      }),
    revalidate: () =>
      Effect.suspend(() => {
        events.push("native");
        return nativeError === undefined ? Effect.succeed(receipt) : Effect.fail(nativeError);
      }),
    forward: (selected, request, deadline) =>
      Effect.sync(() => {
        events.push("forward");
        expect(selected).toEqual({ target, ...references });
        expect(request).toBe(input.requestJson);
        deadlines.push(deadline);
        afterForward();
        return encodeJson({ output: [{ text: "result" }] });
      }),
    ...(forwardProtocol === undefined ? {} : { forwardProtocol }),
    now: Effect.sync(() => now),
  });
  return {
    consumer,
    events,
    deadlines,
    scope: (value: WorkjetGatewayScopedCatalog) => {
      scoped = value;
    },
    native: (value: unknown) => {
      receipt = value;
    },
    unavailable: () => {
      nativeError = new WorkjetGatewayInferenceError({ reason: "native-admission-unavailable" });
    },
    expire: () => {
      now = 1000000;
    },
    afterForward: (action: () => void) => {
      afterForward = action;
    },
  };
};
const reason = (request: Effect.Effect<unknown, WorkjetGatewayInferenceError>) =>
  Effect.match(request, {
    onFailure: (error) => error.reason,
    onSuccess: () => {
      throw new Error("Expected gateway admission to fail");
    },
  });

describe("source gateway inference", () => {
  it.effect("distinguishes unavailable native authority from a malformed receipt", () =>
    Effect.gen(function* () {
      const unavailable = fixture();
      unavailable.unavailable();
      expect(yield* reason(unavailable.consumer.admit(input))).toBe("native-admission-unavailable");
      expect(unavailable.events).not.toContain("forward");
      const malformed = fixture();
      malformed.native({ invalid: true });
      expect(yield* reason(malformed.consumer.admit(input))).toBe("native-admission-rejected");
      expect(malformed.events).not.toContain("forward");
    }),
  );
  it.effect("provides current create/turn admission without performing model inference", () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(yield* f.consumer.admit(input)).toEqual({});
      expect(f.events).toEqual(["catalog", "native"]);
      f.scope({ ...catalog, accounts: [] });
      expect(yield* reason(f.consumer.admit(input))).toBe("grant-unavailable");
      expect(f.events).not.toContain("forward");
    }),
  );

  it.effect(
    "uses the Instances admission client to verify the immutable worker request and source scope",
    () =>
      Effect.gen(function* () {
        const calls: unknown[] = [];
        const digest = yield* remoteWorkerRequestDigest(input.workerRequest);
        const prepared = {
          ...input,
          permit: { ...input.permit, binding: { ...input.permit.binding, requestDigest: digest } },
        };
        const admission = makeCtoxRemoteWorkerAdmissionClient({
          connections: {
            resolveReadyTarget: (connectionId, instanceId) =>
              Effect.sync(() => {
                expect(connectionId).toBe(input.sourceConnectionId);
                expect(instanceId).toBe(input.permit.binding.sourceInstanceId);
                return { endpoint: "https://source.example/mcp", token: "source-only" };
              }),
          },
          gateway: { scopedCatalog: () => Effect.succeed(catalog) },
          transport: {
            probe: () => Effect.succeed(undefined),
            callTool: (target, tool, args) =>
              Effect.sync(() => {
                expect(target.token).toBe("source-only");
                expect(tool).toBe("business_os.remote_worker_admission");
                calls.push(args);
                return { structuredContent: prepared.permit };
              }),
          },
        });
        const consumer = makeSourceGatewayInference({
          environmentId: Effect.succeed(environmentId),
          configuration: Effect.succeed(DEFAULT_WORKJET_CONFIGURATION),
          requireSourceInstance: () => Effect.void,
          scopedCatalog: () => Effect.succeed(catalog),
          revalidate: (current) =>
            admission
              .execute(
                {
                  connectionId: current.sourceConnectionId,
                  instanceId: current.permit.binding.sourceInstanceId,
                },
                current.workerRequest,
                current.permit.binding,
                "revalidate",
                current.permit.permitId,
                current.permit.executionId,
              )
              .pipe(
                Effect.mapError(
                  () => new WorkjetGatewayInferenceError({ reason: "native-admission-rejected" }),
                ),
              ),
          forward: () => Effect.succeed('{"output":[]}'),
          now: Effect.succeed(1000),
        });
        expect(yield* consumer.infer(prepared)).toEqual({
          requestJson: '{"output":[]}',
        });
        expect(calls).toHaveLength(2);
        const tampered = {
          ...prepared,
          workerRequest: { ...prepared.workerRequest, task: "Changed task" },
        };
        expect(yield* reason(consumer.infer(tampered))).toBe("native-admission-rejected");
        expect(calls).toHaveLength(2);
      }),
  );

  it.effect("resolves a real llmRoutes account into exact source references", () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(
        yield* f.consumer.bindModel({
          target,
          routeId: WorkjetLlmRouteId.make("route"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-model" },
        }),
      ).toEqual({ target, ...references });
      expect(
        yield* reason(
          f.consumer.bindModel({
            target,
            routeId: WorkjetLlmRouteId.make("unknown"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-model" },
          }),
        ),
      ).toBe("binding-mismatch");
      expect(
        yield* reason(
          f.consumer.bindModel({
            target,
            routeId: WorkjetLlmRouteId.make("route"),
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "alias" },
          }),
        ),
      ).toBe("grant-unavailable");
    }),
  );
  it.effect(
    "intersects fresh source grants with native revalidation before and after actual forwarding",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        expect(yield* f.consumer.infer(input)).toEqual({
          requestJson: encodeJson({ output: [{ text: "result" }] }),
        });
        expect(f.events).toEqual(["catalog", "native", "forward", "catalog", "native"]);
        expect(f.deadlines).toEqual([input.permit.expiresAtMs]);
        f.scope({ ...catalog, accounts: [] });
        expect(yield* reason(f.consumer.infer(input))).toBe("grant-unavailable");
        expect(f.events.filter((e) => e === "forward")).toHaveLength(1);
      }),
  );
  it.effect("accepts monotonic renewal of the same execution before and during inference", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.native({ ...input.permit, renewalSequence: 1, expiresAtMs: 600000 });
      f.afterForward(() => f.native({ ...input.permit, renewalSequence: 2, expiresAtMs: 900000 }));
      expect(yield* f.consumer.infer(input)).toEqual({
        requestJson: encodeJson({ output: [{ text: "result" }] }),
      });
      expect(f.deadlines).toEqual([600000]);
      expect(f.events).toEqual(["catalog", "native", "forward", "catalog", "native"]);
    }),
  );
  it.effect("withholds a renewed response if immutable native authority was substituted", () =>
    Effect.gen(function* () {
      for (const mutation of [
        { ownerUserId: "other-owner" },
        { authorityEpoch: 2 },
        { authorityFingerprint: `sha256:${"b".repeat(64)}` },
        { permitId: "other-permit" },
        { executionId: "other-execution" },
        { state: "revoked" },
        { binding: { ...input.permit.binding, projectId: "other-project" } },
      ]) {
        const f = fixture();
        f.afterForward(() =>
          f.native({
            ...input.permit,
            renewalSequence: 1,
            expiresAtMs: 600000,
            ...mutation,
          }),
        );
        expect(yield* reason(f.consumer.infer(input))).toBe("native-admission-rejected");
      }
    }),
  );
  it.effect("rejects a renewal sequence regression against the fresh pre-forward receipt", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.native({ ...input.permit, renewalSequence: 2, expiresAtMs: 600000 });
      f.afterForward(() => f.native({ ...input.permit, renewalSequence: 1, expiresAtMs: 900000 }));
      expect(yield* reason(f.consumer.infer(input))).toBe("native-admission-rejected");
      expect(f.events).toContain("forward");
    }),
  );
  it.effect(
    "rejects expiry extension without native renewal and requires a full bounded turn lease",
    () =>
      Effect.gen(function* () {
        const unsequenced = fixture();
        unsequenced.native({ ...input.permit, expiresAtMs: 600000 });
        expect(yield* reason(unsequenced.consumer.infer(input))).toBe("native-admission-rejected");
        const nearExpiry = fixture();
        const short = { ...input, permit: { ...input.permit, expiresAtMs: 5000 } };
        nearExpiry.native(short.permit);
        expect(yield* reason(nearExpiry.consumer.infer(short))).toBe("native-admission-rejected");
        expect(nearExpiry.events).not.toContain("forward");
      }),
  );
  it.effect.each([
    "ownerUserId",

    "authorityEpoch",
    "executionId",
    "permitId",
    "expiresAtMs",
    "renewalSequence",
  ])("rejects changed native %s before forwarding", (field) =>
    Effect.gen(function* () {
      const f = fixture();
      f.native({
        ...input.permit,
        [field]:
          field === "authorityEpoch" || field === "expiresAtMs" || field === "renewalSequence"
            ? 2
            : "changed",
      });
      expect(yield* reason(f.consumer.infer(input))).toBe("native-admission-rejected");
      expect(f.events).not.toContain("forward");
    }),
  );
  it.effect("refuses foreign target, provider, model and source account references", () =>
    Effect.gen(function* () {
      for (const modified of [
        { ...catalog, target: { ...target, instanceId: "foreign" } },
        {
          ...catalog,
          accounts: [
            {
              ...catalog.accounts[0]!,
              providerRef: { environmentId, provider: "claude" as const },
            },
          ],
        },
        { ...catalog, accounts: [{ ...catalog.accounts[0]!, modelRefs: [] }] },
        {
          ...catalog,
          accounts: [
            {
              ...catalog.accounts[0]!,
              credentialRef: { environmentId, accountId: WorkjetGatewayAccountId.make("foreign") },
            },
          ],
        },
      ]) {
        const f = fixture();
        f.scope(modified);
        expect(yield* reason(f.consumer.infer(input))).toMatch(
          /binding-mismatch|grant-unavailable/,
        );
        expect(f.events).not.toContain("forward");
      }
    }),
  );
  it.effect("withholds the response when grant revocation or expiry happens during inference", () =>
    Effect.gen(function* () {
      const revoked = fixture();
      revoked.afterForward(() => revoked.scope({ ...catalog, accounts: [] }));
      expect(yield* reason(revoked.consumer.infer(input))).toBe("grant-unavailable");
      const expired = fixture();
      expired.afterForward(expired.expire);
      expect(yield* reason(expired.consumer.infer(input))).toBe("native-admission-rejected");
    }),
  );
  it.effect.each([
    { model: "alias", input: [] },
    { model: "exact-model", input: [], stream: true },
    { model: "exact-model", input: [], background: true },
    { model: "exact-model", input: [], previous_response_id: "foreign" },
  ])("rejects alternate model and unbounded/cross-session request shapes", (body) =>
    Effect.gen(function* () {
      const f = fixture();
      expect(yield* reason(f.consumer.infer({ ...input, requestJson: encodeJson(body) }))).toBe(
        "invalid-request",
      );
      expect(f.events).toEqual([]);
    }),
  );
});

describe("source native protocols", () => {
  it.effect.each(["messages", "chat-completions", "responses"] as const)(
    "revalidates the same pinned authority around twenty %s tool turns",
    protocol => Effect.gen(function* () {
      const calls: string[] = [];
      const f = fixture((selected, request, deadline, actualProtocol) => Effect.sync(() => {
        expect(selected).toEqual({ target, ...references });
        expect(deadline).toBe(input.permit.expiresAtMs);
        expect(actualProtocol).toBe(protocol);
        calls.push(request);
        return { requestJson: "native events", contentType: "text/event-stream" as const };
      }));
      for (let turn = 0; turn < 20; turn++) {
        const requestJson = encodeJson({
          model: input.permit.binding.modelRef.modelId,
          stream: true,
          ...(protocol === "responses" ? { input: [{ role: "user", content: String(turn) }] }
            : { messages: [{ role: "user", content: String(turn) }] }),
        });
        expect(yield* f.consumer.infer({ ...input, protocol, requestJson })).toEqual({
          requestJson: "native events", contentType: "text/event-stream",
        });
        expect(calls.at(-1)).toBe(requestJson);
      }
      expect(calls).toHaveLength(20);
      expect(f.events).toEqual(Array.from({ length: 20 }, () => ["catalog", "native", "catalog", "native"]).flat());
    }),
  );
  it.effect("rejects wrong native shapes and withholds results after revocation", () => Effect.gen(function* () {
    let forwards = 0;
    const f = fixture(() => Effect.sync(() => {
      forwards++;
      f.scope({ ...catalog, accounts: [] });
      return { requestJson: "private result", contentType: "application/json" as const };
    }));
    for (const body of [
      { model: input.permit.binding.modelRef.modelId, input: [] },
      { model: input.permit.binding.modelRef.modelId, messages: [], stream: "true" },
      { model: input.permit.binding.modelRef.modelId, messages: [], conversation: "foreign" },
    ]) {
      expect(yield* reason(f.consumer.infer({ ...input, protocol: "messages", requestJson: encodeJson(body) }))).toBe("invalid-request");
    }
    expect(forwards).toBe(0);
    expect(yield* reason(f.consumer.infer({
      ...input, protocol: "messages",
      requestJson: encodeJson({ model: input.permit.binding.modelRef.modelId, messages: [], stream: false }),
    }))).toBe("grant-unavailable");
    expect(forwards).toBe(1);
  }));
});
