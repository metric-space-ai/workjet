import * as Schema from "effect/Schema";

const Uuid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const base = { version: Schema.Literal(1), operationId: Uuid };
export const WorkjetInstanceGrokRequests = [
  Schema.Struct({ ...base, action: Schema.Literal("instance.grok.read") }),
  Schema.Struct({ ...base, action: Schema.Literal("instance.grok.start") }),
  Schema.Struct({ ...base, action: Schema.Literal("instance.grok.poll"), loginId: Uuid }),
  Schema.Struct({ ...base, action: Schema.Literal("instance.grok.cancel"), loginId: Uuid }),
  Schema.Struct({ ...base, action: Schema.Literal("instance.grok.check"), modelId: Text }),
  Schema.Struct({ ...base, action: Schema.Literal("instance.grok.remove") }),
] as const;
export const WorkjetInstanceGrokResponse = Schema.Struct({
  ...base,
  action: Schema.Literals(["instance.grok.read", "instance.grok.start", "instance.grok.poll", "instance.grok.cancel", "instance.grok.check", "instance.grok.remove"]),
  installed: Schema.Boolean,
  accountLabel: Text,
  login: Schema.NullOr(Schema.Struct({
    loginId: Uuid,
    phase: Schema.Literals(["pending", "accepted", "cancelled", "failed", "expired"]),
    verificationUri: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
    userCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    expiresAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  })),
  models: Schema.Array(Text).check(Schema.isMaxLength(200)),
  check: Schema.NullOr(Schema.Struct({
    modelId: Text,
    status: Schema.Literals(["ok", "error"]),
    checkedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    latencyMs: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
    errorCode: Schema.NullOr(Schema.Literals(["timeout", "missing_credential", "model_unavailable", "invalid_response", "request_failed"])),
  })),
});
export type WorkjetInstanceGrokResponse = typeof WorkjetInstanceGrokResponse.Type;
