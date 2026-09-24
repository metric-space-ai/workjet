import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(16_000));
const Module = { module_id: Id };
const App = {
  ...Module,
  title: Schema.optionalKey(Id),
  description: Schema.optionalKey(Text),
  category: Schema.optionalKey(Id),
  version: Schema.optionalKey(Id),
};
const Limit = Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })));
const RetryKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/));
const Delegation = { idempotency_key: RetryKey };

/** Finite Business OS operations. Routing and actor context are never model arguments. */
const CtoxBusinessOsRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("delegate_task"),
    ...Module,
    ...Delegation,
    title: Id,
    objective: Text,
    record_id: Schema.optionalKey(Id),
  }),
  Schema.Struct({ operation: Schema.Literal("get_delegation"), idempotency_key: RetryKey }),
  Schema.Struct({ operation: Schema.Literal("get_delegation_status"), idempotency_key: RetryKey }),
  Schema.Struct({ operation: Schema.Literals(["status", "list_modules"]) }),
  Schema.Struct({
    operation: Schema.Literals([
      "get_module",
      "list_entities",
      "list_app_files",
      "validate_app",
      "smoke_app",
      "e2e_app",
    ]),
    ...Module,
  }),
  Schema.Struct({ operation: Schema.Literal("read_app_file"), ...Module, path: Id }),
  Schema.Struct({
    operation: Schema.Literal("read_app_skill_resource"),
    resource: Schema.String.check(Schema.isMaxLength(2_048)),
  }),
  Schema.Struct({
    operation: Schema.Literal("search_app_source"),
    ...Module,
    query: Text,
    limit: Limit,
  }),
  Schema.Struct({
    operation: Schema.Literal("write_app_file"),
    ...Module,
    path: Id,
    content: Schema.String.check(Schema.isMaxLength(128_000)),
  }),
  Schema.Struct({
    operation: Schema.Literal("prepare_app_source"),
    ...App,
    instruction: Schema.optionalKey(Text),
  }),
  Schema.Struct({
    operation: Schema.Literal("create_app"),
    ...App,
    ...Delegation,
    instruction: Text,
  }),
  Schema.Struct({
    operation: Schema.Literal("modify_app"),
    ...Module,
    ...Delegation,
    instruction: Text,
    title: Schema.optionalKey(Id),
  }),
  Schema.Struct({ operation: Schema.Literal("get_command_status"), command_id: Id }),
  Schema.Struct({
    operation: Schema.Literal("list_runs"),
    status: Schema.optionalKey(Id),
    limit: Limit,
  }),
  Schema.Struct({ operation: Schema.Literal("get_run"), run_id: Id }),
  Schema.Struct({
    operation: Schema.Literal("open_link"),
    kind: Id,
    module_or_collection: Id,
    id: Schema.optionalKey(Id),
  }),
]);
export const WorkjetCtoxBusinessOsInput = Schema.Struct({ request: CtoxBusinessOsRequest });
export type WorkjetCtoxBusinessOsInput = typeof WorkjetCtoxBusinessOsInput.Type;

export const WorkjetCtoxBusinessOsResult = Schema.Struct({
  instanceId: Id,
  result: Schema.Unknown,
});
export type WorkjetCtoxBusinessOsResult = typeof WorkjetCtoxBusinessOsResult.Type;

export const CTOX_BUSINESS_OS_INSTRUCTIONS = `Use ctox_business_os for the Business OS instance bound to this thread. Start with status and list_modules. A connection failure does not authorize switching instances or using another identity.
For direct app development, inspect get_module or prepare_app_source, then list_app_files/read_app_file/search_app_source and write_app_file. Read every required development_contract skill resource with read_app_skill_resource before editing. Use the returned shell/runtime contract; do not invent a shell, database path, CLI, SQL or browser data bridge. Validate changes with validate_app; use smoke_app/e2e_app for the relevant UI and persistence workflows. Do not claim success without the returned evidence.
Use create_app/modify_app to delegate app development to native CTOX. Use delegate_task for other native work scoped to an existing module, with a clear title and objective. Choose and retain an idempotency_key for each logical delegation before sending it. These enqueue work; retain command_id/task_id and inspect get_command_status/get_run before reporting completion. After transport uncertainty, reuse the same key and identical arguments; never generate a new key for that retry. Workjet checks server support before dispatch. If retry support is missing, do not remove the key to force a retry. Other writes do not have this retry contract: check their actual outcome before repeating them. Use open_link to return the Business OS result to the user.
Workjet durably records keyed delegation intent before sending it. Use get_delegation with the original key after a lost response, compaction or restart to recover the exact request and any known command/task ids. Missing ids mean the remote outcome is unknown, not that nothing ran. The stored reference is not live execution status: use get_delegation_status with the same key to observe the bound native command. An unresolved state means its remote outcome is unknown; blocked/waiting and unknown future states are not completion. get_command_status remains available for other permitted commands. If credentials changed, reconcile the original request before attempting new work.
This capability grants typed app access under the server's policy. It does not grant CTOX's global CTO role, Crew memory or permission to fabricate approvals. Follow the authenticated actor's actual permissions; never inject _context or credentials.`;
