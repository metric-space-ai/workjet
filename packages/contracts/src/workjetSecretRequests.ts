import * as Schema from "effect/Schema";
import { CommandId } from "./baseSchemas.ts";

/**
 * Agent secret requests (CTOX `ctox secret request`, metric-space-ai/ctox#794).
 *
 * The transcript and every response carry metadata and the reference only.
 * The value crosses exactly one boundary: the `secret.request.fulfill`
 * request, which CTOX writes straight into its encrypted secret store.
 */
const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const RequestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
export const WorkjetSecretRequestStatus = Schema.Literals(["pending", "stored", "declined"]);
export type WorkjetSecretRequestStatus = typeof WorkjetSecretRequestStatus.Type;

export const WorkjetSecretRequestRecord = Schema.Struct({
  requestId: RequestId,
  scope: text(128),
  name: text(128),
  label: text(200),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
  threadKey: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  status: WorkjetSecretRequestStatus,
  ref: text(300),
  createdAt: Schema.String.check(Schema.isMaxLength(64)),
});
export type WorkjetSecretRequestRecord = typeof WorkjetSecretRequestRecord.Type;

export const WORKJET_SECRET_VALUE_MAX = 8192;

/** CTOX credential keys: env-style, e.g. OPENROUTER_API_KEY. */
export const CredentialName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/),
);

/** Write-only listing: names and whether a value is set, never the value. */
export const WorkjetCredentialRecord = Schema.Struct({
  name: CredentialName,
  description: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  isSet: Schema.Boolean,
  updatedAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
});
export type WorkjetCredentialRecord = typeof WorkjetCredentialRecord.Type;

export const WorkjetSecretRequestRequests = [
  Schema.Struct({
    action: Schema.Literal("secret.request.list"),
    commandId: CommandId,
    status: Schema.optionalKey(WorkjetSecretRequestStatus),
    threadKey: Schema.optionalKey(text(256)),
  }),
  Schema.Struct({
    action: Schema.Literal("secret.request.fulfill"),
    commandId: CommandId,
    requestId: RequestId,
    value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(WORKJET_SECRET_VALUE_MAX)),
  }),
  Schema.Struct({
    action: Schema.Literal("secret.request.decline"),
    commandId: CommandId,
    requestId: RequestId,
  }),
  Schema.Struct({ action: Schema.Literal("secret.list"), commandId: CommandId }),
  Schema.Struct({
    action: Schema.Literal("secret.put"),
    commandId: CommandId,
    name: CredentialName,
    value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(WORKJET_SECRET_VALUE_MAX)),
  }),
  Schema.Struct({
    action: Schema.Literal("secret.delete"),
    commandId: CommandId,
    name: CredentialName,
  }),
] as const;

export const WorkjetSecretRequestResponses = [
  Schema.Struct({
    action: Schema.Literal("secret.request.list"),
    requests: Schema.Array(WorkjetSecretRequestRecord).check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    action: Schema.Literals(["secret.request.fulfill", "secret.request.decline"]),
    requestId: RequestId,
    status: WorkjetSecretRequestStatus,
    ref: Schema.optionalKey(text(300)),
  }),
  Schema.Struct({
    action: Schema.Literal("secret.list"),
    secrets: Schema.Array(WorkjetCredentialRecord).check(Schema.isMaxLength(300)),
  }),
  Schema.Struct({
    action: Schema.Literals(["secret.put", "secret.delete"]),
    name: CredentialName,
  }),
] as const;
