// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { CtoxManagedInstanceId, WorkjetConnectionId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const WORKJET_WORKER_SOURCE_TOOLS = [
  "business_os.remote_worker_admission",
  "business_os.workjet_worker_dispatch",
] as const;
type AccountFetch = (url: string, init?: RequestInit) => Promise<Response>;
const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
);
const IssuedIdentity = Schema.Struct({ token: Schema.Struct({ tokenId: Uuid }) });
const Issued = Schema.Struct({
  ok: Schema.Literal(true),
  token: Schema.Struct({
    token: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(16_384)),
    tokenId: Uuid,
  }),
  managedMcp: Schema.Struct({ mcpUrl: Schema.String.check(Schema.isMaxLength(2_048)) }),
});
const decodeUuid = Schema.decodeUnknownSync(Uuid);
const decodeIssuedIdentity = Schema.decodeUnknownSync(IssuedIdentity);
const decodeIssued = Schema.decodeUnknownSync(Issued);
const decodeNativeInstanceId = Schema.decodeUnknownSync(CtoxManagedInstanceId);

export interface WorkjetWorkerSourceGrant {
  readonly connectionId: WorkjetConnectionId;
  readonly tenantId: string;
  readonly tokenId: string;
  readonly instanceId: string;
  readonly endpoint: string;
  readonly token: string;
  readonly displayName: string;
  readonly source: "ctox_dev";
}
export class WorkerSourceGrantError extends Error {
  readonly code: "signed_out" | "grant_unavailable" | "grant_revoke_unavailable";
  constructor(code: "signed_out" | "grant_unavailable" | "grant_revoke_unavailable") {
    super(code);
    this.code = code;
  }
}
export function workerSourceGrantIdentity(connectionId: string) {
  const match = /^ctox-dev-worker-source:([^:]+):([^:]+)$/.exec(connectionId);
  if (!match) return undefined;
  try {
    return {
      tenantId: decodeUuid(match[1]),
      tokenId: decodeUuid(match[2]),
    };
  } catch {
    return undefined;
  }
}

export async function revokeWorkjetWorkerSourceGrant(
  fetchAccount: AccountFetch,
  grant: Pick<WorkjetWorkerSourceGrant, "tenantId" | "tokenId">,
): Promise<void> {
  try {
    const response = await fetchAccount(
      `https://ctox.dev/api/instances/${encodeURIComponent(grant.tenantId)}/managed-mcp`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "revoke_token", tokenId: grant.tokenId }),
      },
    );
    if (!response.ok) throw new Error();
  } catch {
    throw new WorkerSourceGrantError("grant_revoke_unavailable");
  }
}

/** The existing owner API's historical rotate_token action is INSERT-only:
 * it issues an additional client and never receives an existing client ID. */
export async function issueWorkjetWorkerSourceGrant(
  fetchAccount: AccountFetch,
  tenantId: string,
): Promise<WorkjetWorkerSourceGrant> {
  let issuedIdentity: { tenantId: string; tokenId: string } | undefined;
  try {
    decodeUuid(tenantId);
    const response = await fetchAccount(
      `https://ctox.dev/api/instances/${encodeURIComponent(tenantId)}/managed-mcp`,
      {
        method: "POST",
        cache: "no-store",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "rotate_token",
          label: "Workjet worker source",
          expiresInDays: 1,
          scopes: {
            allowReads: false,
            allowWrites: true,
            allowApprovals: false,
            allowExternalEffects: false,
            rateLimitPerMinute: 30,
            allowedModules: ["ctox"],
            allowedCollections: ["__ctox_no_access__"],
            allowedTools: [...WORKJET_WORKER_SOURCE_TOOLS],
            deniedTools: [],
          },
        }),
      },
    );
    if (response.status === 401) throw new WorkerSourceGrantError("signed_out");
    if (!response.ok) throw new WorkerSourceGrantError("grant_unavailable");
    const payload: unknown = await response.json();
    const identity = decodeIssuedIdentity(payload);
    issuedIdentity = { tenantId, tokenId: identity.token.tokenId };
    const result = decodeIssued(payload);
    const endpoint = new URL(result.managedMcp.mcpUrl);
    const route = /^\/mcp\/([^/]+)$/.exec(endpoint.pathname);
    if (
      endpoint.origin !== "https://mcp.ctox.dev" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !route
    )
      throw new Error();
    const instanceId = decodeNativeInstanceId(decodeURIComponent(route[1]!));
    if (
      instanceId.includes("/") ||
      /\s/.test(instanceId) ||
      instanceId.startsWith("tenant:") ||
      instanceId.startsWith("managed:")
    )
      throw new Error();
    return {
      connectionId: WorkjetConnectionId.make(
        `ctox-dev-worker-source:${tenantId}:${result.token.tokenId}`,
      ),
      tenantId,
      tokenId: result.token.tokenId,
      instanceId,
      endpoint: endpoint.toString(),
      token: result.token.token,
      displayName: "Workjet worker source",
      source: "ctox_dev",
    };
  } catch (error) {
    if (issuedIdentity) await revokeWorkjetWorkerSourceGrant(fetchAccount, issuedIdentity);
    // Error messages and causes never contain the one-time response or token.
    throw error instanceof WorkerSourceGrantError
      ? error
      : new WorkerSourceGrantError("grant_unavailable");
  }
}

/** Keep an issued client scoped until the environment confirms SecretStore custody.
 * acquireRelease protects the issue/finalizer boundary from interruption. */
export function acquireWorkjetWorkerSourceGrant(
  fetchAccount: AccountFetch,
  tenantId: string,
  onRolledBack: (grant: WorkjetWorkerSourceGrant) => Effect.Effect<void> = () => Effect.void,
) {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const grant = await issueWorkjetWorkerSourceGrant(fetchAccount, tenantId);
        let committed = false;
        return {
          ...grant,
          commit: () => {
            committed = true;
          },
          isCommitted: () => committed,
        };
      },
      catch: (error) =>
        error instanceof WorkerSourceGrantError
          ? error
          : new WorkerSourceGrantError("grant_unavailable"),
    }),
    (grant) =>
      grant.isCommitted()
        ? Effect.void
        : Effect.tryPromise({
            try: () => revokeWorkjetWorkerSourceGrant(fetchAccount, grant),
            catch: () => new WorkerSourceGrantError("grant_revoke_unavailable"),
          }).pipe(
            Effect.andThen(onRolledBack(grant)),
            // Retain the tracked client when revocation is unavailable for revokeAll.
            Effect.catchCause(() => Effect.void),
          ),
  );
}
