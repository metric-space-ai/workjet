// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off -- Validate bounded native UTF-8 snapshots outside SDK model history.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const DOCUMENT_BYTES = 1_052_672;
const FRAGMENT_BYTES = 24_576;
const CONTEXT_BYTES = 8_192;
const MAX_PAGES = Math.ceil(DOCUMENT_BYTES / (FRAGMENT_BYTES - 3));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);
const Page = Schema.Struct({
  schema: Schema.Literal("ctox.workjet.supervisor.confirmed_goal_page.v1"),
  state: Schema.Literals([
    "page",
    "snapshot_changed",
    "snapshot_unavailable",
    "capacity_unavailable",
  ]),
  project_id: Id,
  supervisor_thread_id: Id,
  snapshot_id: Uuid,
  document_sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  document_bytes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: DOCUMENT_BYTES })),
  byte_offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: DOCUMENT_BYTES })),
  byte_length: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: FRAGMENT_BYTES })),
  json_fragment: Schema.String.check(Schema.isMaxLength(FRAGMENT_BYTES)),
  captured_at_ms: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  document_complete: Schema.Boolean,
  next_cursor: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  ),
});
const Goal = Schema.Struct({
  goal: Schema.Struct({
    goal_id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  status: Id,
  items: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).check(Schema.isMaxLength(100)),
  steps: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).check(Schema.isMaxLength(100)),
});
const Document = Schema.Struct({
  contract: Schema.Literal("ctox.workjet.jour_fixe.v1"),
  project_id: Id,
  supervisor_thread_id: Id,
  confirmed_goal: Schema.NullOr(Goal),
});
const decodePage = Schema.decodeUnknownPromise(Page, { onExcessProperty: "error" });
const decodeDocument = Schema.decodeUnknownPromise(Document, { onExcessProperty: "error" });

/** One observed SDK read drains the native pages sequentially. The original
 * controller revalidates every operation. Keep raw fragments out of model
 * history and expose only actual, bounded selected item/step context. */
export function createNativeSupervisorConfirmedGoalReader(options: {
  readonly projectId: string;
  readonly supervisorThreadId: string;
  readonly requestPage: (operationId: string, argumentsJson: string) => Promise<unknown>;
}) {
  let retained: Buffer | undefined;
  let closed = false;
  const checkScope = (project: string, thread: string) => {
    if (project !== options.projectId || thread !== options.supervisorThreadId)
      throw new Error("Original confirmed-goal snapshot scope differs.");
  };
  return {
    async read(firstOperationId: string, itemIndex?: number) {
      if (closed) throw new Error("Original confirmed-goal reader is closed.");
      retained?.fill(0);
      retained = undefined;
      const fragments: Buffer[] = [];
      let offset = 0;
      let cursor: string | undefined;
      let first: typeof Page.Type | undefined;
      for (let count = 0; count < MAX_PAGES; count++) {
        if (closed) throw new Error("Original confirmed-goal reader is closed.");
        const page = await decodePage(
          await options.requestPage(
            count === 0 ? firstOperationId : NodeCrypto.randomUUID(),
            JSON.stringify(cursor === undefined ? {} : { cursor }),
          ),
        );
        checkScope(page.project_id, page.supervisor_thread_id);
        if (page.snapshot_id !== firstOperationId)
          throw new Error("Original confirmed-goal snapshot identity differs.");
        const metadata = {
          project_id: page.project_id,
          supervisor_thread_id: page.supervisor_thread_id,
          snapshot_id: page.snapshot_id,
          document_sha256: page.document_sha256,
          document_bytes: page.document_bytes,
          captured_at_ms: page.captured_at_ms,
        };
        if (page.state !== "page") {
          if (
            page.byte_length !== 0 ||
            page.json_fragment !== "" ||
            page.byte_offset !== 0 ||
            page.document_complete ||
            page.next_cursor != null
          )
            throw new Error("Original confirmed-goal unavailable framing differs.");
          return { ...metadata, state: page.state, snapshot_verified: false };
        }
        first ??= page;
        if (
          page.document_sha256 !== first.document_sha256 ||
          page.document_bytes !== first.document_bytes ||
          page.captured_at_ms !== first.captured_at_ms
        )
          throw new Error("Original confirmed-goal snapshot witness differs.");
        const bytes = Buffer.from(page.json_fragment, "utf8");
        // An isolated surrogate is not a lossless native UTF-8 fragment.
        if (
          bytes.toString("utf8") !== page.json_fragment ||
          page.byte_offset !== offset ||
          page.byte_length !== bytes.length ||
          offset + bytes.length > page.document_bytes ||
          bytes.length === 0
        )
          throw new Error("Original confirmed-goal fragment is not contiguous UTF-8.");
        fragments.push(bytes);
        offset += bytes.length;
        if (!page.document_complete) {
          const expected = `${firstOperationId}:${offset}`;
          if (page.next_cursor !== expected || offset >= page.document_bytes)
            throw new Error("Original confirmed-goal continuation differs.");
          cursor = expected;
          continue;
        }
        if (page.next_cursor != null || offset !== page.document_bytes)
          throw new Error("Original confirmed-goal snapshot EOF differs.");
        const documentBytes = Buffer.concat(fragments);
        if (
          NodeCrypto.createHash("sha256").update(documentBytes).digest("hex") !==
          page.document_sha256
        )
          throw new Error("Original confirmed-goal snapshot digest differs.");
        const document = await decodeDocument(JSON.parse(documentBytes.toString("utf8")));
        checkScope(document.project_id, document.supervisor_thread_id);
        retained = documentBytes;
        const goal = document.confirmed_goal;
        if (goal === null)
          return { ...metadata, state: "verified", snapshot_verified: true, confirmed_goal: null };
        if (goal.items.length !== goal.steps.length)
          throw new Error("Original confirmed-goal item and step count differs.");
        const index = itemIndex ?? goal.steps.findIndex((step) => step.status !== "completed");
        const reference = {
          goal: goal.goal,
          status: goal.status,
          item_count: goal.items.length,
          selected_item_index: index < 0 || index >= goal.items.length ? null : index,
        };
        const context = {
          ...metadata,
          state: "verified",
          snapshot_verified: true,
          context_state: reference.selected_item_index === null ? "no_item" : "available",
          confirmed_goal: {
            ...reference,
            item: reference.selected_item_index === null ? null : goal.items[index],
            step: reference.selected_item_index === null ? null : goal.steps[index],
          },
        };
        if (Buffer.byteLength(JSON.stringify(context)) <= CONTEXT_BYTES) return context;
        // Retain the exact document; report an oversized selected context
        // explicitly instead of silently truncating an Owner's acceptance.
        return {
          ...metadata,
          state: "verified",
          snapshot_verified: true,
          context_state: "item_exceeds_model_budget",
          confirmed_goal: reference,
        };
      }
      throw new Error("Original confirmed-goal page count exceeds native snapshot budget.");
    },
    close() {
      closed = true;
      retained?.fill(0);
      retained = undefined;
    },
  };
}
