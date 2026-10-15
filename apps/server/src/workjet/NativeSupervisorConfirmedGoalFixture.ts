// @effect-diagnostics nodeBuiltinImport:off -- Native paging fixtures, never live execution or model authority.
import * as NodeCrypto from "node:crypto";

export function goalDocument(confirmedGoal: unknown = null) {
  return {
    contract: "ctox.workjet.jour_fixe.v1",
    project_id: "fixture-project",
    supervisor_thread_id: "fixture-supervisor",
    confirmed_goal: confirmedGoal,
  };
}

export function goalPage(document: unknown, snapshotId: string, offset = 0) {
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  let end = Math.min(offset + 24_576, bytes.length);
  // Native adjusts the end to a UTF-8 boundary.
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  const complete = end === bytes.length;
  return {
    schema: "ctox.workjet.supervisor.confirmed_goal_page.v1",
    state: "page",
    project_id: "fixture-project",
    supervisor_thread_id: "fixture-supervisor",
    snapshot_id: snapshotId,
    document_sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    document_bytes: bytes.length,
    byte_offset: offset,
    byte_length: end - offset,
    json_fragment: bytes.subarray(offset, end).toString("utf8"),
    captured_at_ms: 1,
    document_complete: complete,
    next_cursor: complete ? null : `${snapshotId}:${end}`,
  };
}
