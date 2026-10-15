import * as Schema from "effect/Schema";
/** Public metadata only; the private key and thumbprint never cross IPC. */
export const CtoxControlDeviceStatus = Schema.Struct({
  state: Schema.Literals(["active", "not_configured"]),
  createdAt: Schema.optionalKey(Schema.String),
  lastUsedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  expiresAt: Schema.optionalKey(Schema.String),
  notice: Schema.optionalKey(Schema.String),
});
export type CtoxControlDeviceStatus = typeof CtoxControlDeviceStatus.Type;
