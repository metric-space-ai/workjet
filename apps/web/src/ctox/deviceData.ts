import * as Schema from "effect/Schema";
import { useCtoxQuery } from "./hooks";
import type { CtoxAppApi } from "./ctoxClient";
const Device = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["mobile", "desktop", "browser", "machine"]),
  platform: Schema.optionalKey(Schema.String),
  label: Schema.String,
  user_id: Schema.NonEmptyString,
  created_at_ms: Schema.Number,
  connected: Schema.Boolean,
  last_seen_at_ms: Schema.Number,
});
export type CtoxDevice = typeof Device.Type;
const decode = Schema.decodeUnknownSync(Device);
export function readCtoxDevices(api: CtoxAppApi) {
  return api
    .query("devices", {})
    .get()
    .map((row) => decode(row));
}
export function useCtoxDevices(instanceId: string | null) {
  const rows = useCtoxQuery<CtoxDevice>(instanceId, "devices", {});
  return rows.map((row) => decode(row));
}
