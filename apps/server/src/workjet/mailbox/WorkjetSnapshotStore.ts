// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Content-addressed immutable prompt-snapshot store (docs/workjet-plan.md →
 * "Transfer context by immutable prompt snapshots and bounded references …").
 *
 * The delegation contract in `@t3tools/contracts` pins a prompt with a
 * `WorkjetContentDigest` plus a bounded `WorkjetSealedPayloadRef`. Until this
 * module existed those three fields were CALLER-SUPPLIED, so nothing in the
 * server ever verified that the digest described any real content: a harness
 * could name a snapshot that does not exist, or pin a digest that does not
 * match the prompt it intended to send. This store is the producing side of
 * that contract — the digest is computed from the bytes the server itself
 * wrote, and is re-verified against the bytes on every read.
 *
 * Invariants:
 *
 * 1. IMMUTABLE. A stored object is never rewritten, moved, or deleted. Two
 *    puts of identical content resolve to the same path and the second one is
 *    a no-op, so `put` is idempotent rather than racy.
 * 2. CONTENT-ADDRESSED. The path is derived from the digest alone. There is no
 *    thread, session, delegation, or environment id anywhere in the layout
 *    (the same server-wide-root rule the greppy store follows), so identical
 *    prompts from different threads deduplicate and no path leaks routing
 *    metadata.
 * 3. VERIFIED ON READ. `get` re-hashes the bytes it just read and fails with
 *    {@link WorkjetSnapshotCorruptError} on any mismatch. A tampered or
 *    truncated file can therefore never be handed back as a valid snapshot.
 * 4. BOUNDED. Writes enforce the contract's 8 MiB ceiling before touching the
 *    filesystem, and reads refuse a file that has grown past it, so a hostile
 *    or damaged state directory cannot pull unbounded data into memory.
 *
 * NOT in this slice, by design:
 *
 * - No delete and no garbage collection. Immutability is the point: a
 *   delegation, its parent, and any later audit all resolve the same digest,
 *   and reclaiming a snapshot while a live delegation still references it
 *   would break exactly the guarantee this store exists to provide. RETENTION
 *   IS A FUTURE OWNER DECISION — it needs a reference-counting or
 *   age-plus-liveness policy that spans the delegation graph, and that policy
 *   does not exist yet.
 * - No encryption. Snapshots are stored as plaintext in the server's own state
 *   directory. Sealing a payload to the target environment key is a transport
 *   concern and a separate open plan item; {@link WorkjetSealedPayloadRef} is
 *   reused here strictly as the contract's bounded reference SHAPE.
 */
import {
  WorkjetContentDigest,
  type WorkjetPayloadByteLength,
  WorkjetSealedPayloadRef,
} from "@t3tools/contracts";
import { Buffer } from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";

// ===============================
// Bounds and layout
// ===============================

/**
 * Hard ceiling on a single snapshot, taken from `WorkjetPayloadByteLength`
 * (8 MiB). Callers are expected to bound their own input far below this; this
 * is the contract backstop, not a budget.
 */
export const WORKJET_SNAPSHOT_MAX_BYTES = 8_388_608;

/** Server-wide snapshot root, relative to `ServerConfig.stateDir`. */
export const WORKJET_SNAPSHOT_ROOT_SEGMENTS = ["workjet-mailbox", "snapshots"] as const;

/** Owner-only permissions; prompts are user content, not world-readable data. */
const SNAPSHOT_FILE_MODE = 0o600;
const SNAPSHOT_DIRECTORY_MODE = 0o700;

const SHA256_DIGEST_BYTES = 32;

// ===============================
// Errors
// ===============================

/** The content exceeds the 8 MiB contract ceiling and was never written. */
export class WorkjetSnapshotTooLargeError extends Schema.TaggedErrorClass<WorkjetSnapshotTooLargeError>()(
  "WorkjetSnapshotTooLargeError",
  {
    byteLength: Schema.Number,
    maximumBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Prompt snapshot of ${this.byteLength} bytes exceeds the ${this.maximumBytes} byte ceiling.`;
  }
}

/** No object is stored under this digest. */
export class WorkjetSnapshotNotFoundError extends Schema.TaggedErrorClass<WorkjetSnapshotNotFoundError>()(
  "WorkjetSnapshotNotFoundError",
  { digest: Schema.String },
) {
  override get message(): string {
    return `No prompt snapshot stored for digest ${this.digest}.`;
  }
}

/**
 * The stored bytes do not hash to the digest they are filed under, are no
 * longer valid UTF-8, or have grown past the ceiling. Carries the digest and a
 * bounded issue label only — never the offending content, because the plan
 * forbids prompt material in logs and traces.
 */
export class WorkjetSnapshotCorruptError extends Schema.TaggedErrorClass<WorkjetSnapshotCorruptError>()(
  "WorkjetSnapshotCorruptError",
  {
    digest: Schema.String,
    issue: Schema.Literals(["digest-mismatch", "invalid-utf8", "size-exceeded"]),
  },
) {
  override get message(): string {
    return `Prompt snapshot ${this.digest} failed verification: ${this.issue}.`;
  }
}

/** A filesystem operation failed. The path is deliberately not included. */
export class WorkjetSnapshotIoError extends Schema.TaggedErrorClass<WorkjetSnapshotIoError>()(
  "WorkjetSnapshotIoError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Prompt snapshot store operation ${this.operation} failed.`;
  }
}

export type WorkjetSnapshotStoreError =
  | WorkjetSnapshotTooLargeError
  | WorkjetSnapshotNotFoundError
  | WorkjetSnapshotCorruptError
  | WorkjetSnapshotIoError;

/** Schema-aware runtime checks; `instanceof` is not the schema-aware narrowing. */
export const isWorkjetSnapshotTooLargeError = Schema.is(WorkjetSnapshotTooLargeError);
export const isWorkjetSnapshotNotFoundError = Schema.is(WorkjetSnapshotNotFoundError);
export const isWorkjetSnapshotCorruptError = Schema.is(WorkjetSnapshotCorruptError);
export const isWorkjetSnapshotIoError = Schema.is(WorkjetSnapshotIoError);

// ===============================
// Digest ↔ reference mapping
// ===============================

const sha256Hex = (bytes: Uint8Array): WorkjetContentDigest =>
  WorkjetContentDigest.make(NodeCrypto.createHash("sha256").update(bytes).digest("hex"));

/**
 * Deterministic mapping from a SHA-256 digest to the bounded payload
 * reference: base64url of the RAW 32 digest bytes, unpadded.
 *
 *   digest "3f2a…"  (64 lowercase hex chars, 32 bytes)
 *     → ref        (43 base64url chars, no `=` padding)
 *
 * 43 characters sits inside the contract's 16–512 window and matches
 * `^[A-Za-z0-9_-]{16,512}$`, so every digest produces a legal
 * {@link WorkjetSealedPayloadRef}. The mapping is total and injective, and
 * {@link snapshotDigestForRef} inverts it exactly, so a reference always
 * round-trips back to the digest that produced it. Encoding the digest rather
 * than minting a random handle is what makes a reference self-describing: the
 * receiving side can recompute the storage location from the reference alone,
 * with no lookup table to keep in sync.
 */
export const snapshotRefForDigest = (digest: WorkjetContentDigest): WorkjetSealedPayloadRef =>
  WorkjetSealedPayloadRef.make(Buffer.from(digest, "hex").toString("base64url"));

/**
 * Inverse of {@link snapshotRefForDigest}. `None` for any reference that does
 * not decode to exactly 32 bytes, so a foreign or hand-written reference is
 * rejected rather than silently mapped onto some path.
 */
export const snapshotDigestForRef = (reference: string): Option.Option<WorkjetContentDigest> => {
  const bytes = Buffer.from(reference, "base64url");
  if (bytes.byteLength !== SHA256_DIGEST_BYTES) return Option.none();
  // Re-encoding must reproduce the input; base64url decoding is lenient and
  // would otherwise accept several spellings of the same 32 bytes.
  if (bytes.toString("base64url") !== reference) return Option.none();
  return Option.some(WorkjetContentDigest.make(bytes.toString("hex")));
};

/**
 * Two-level fan-out on the digest prefix — `<ab>/<cd>/<full-digest>.bin` —
 * so a directory never accumulates more than a few hundred entries even with
 * a large snapshot population. The full digest remains in the filename, so the
 * stored path is self-identifying and a shard directory can never be confused
 * with content.
 */
export const snapshotRelativeSegments = (
  digest: WorkjetContentDigest,
): readonly [string, string, string] => [digest.slice(0, 2), digest.slice(2, 4), `${digest}.bin`];

// ===============================
// Service
// ===============================

/** What a stored snapshot contributes to a delegation's prompt reference. */
export interface WorkjetPromptSnapshotReference {
  readonly digest: WorkjetContentDigest;
  readonly snapshotRef: WorkjetSealedPayloadRef;
  readonly byteLength: WorkjetPayloadByteLength;
}

/** Metadata of a stored snapshot, obtained without reading its content. */
export interface WorkjetSnapshotStat {
  readonly byteLength: WorkjetPayloadByteLength;
}

export interface WorkjetSnapshotStoreShape {
  /**
   * UTF-8 encode, enforce the ceiling, hash, and write atomically. Identical
   * content resolves to the identical path, so a repeat put succeeds without
   * rewriting the existing object.
   */
  readonly put: (
    text: string,
  ) => Effect.Effect<WorkjetPromptSnapshotReference, WorkjetSnapshotStoreError>;

  /** Read, RE-VERIFY the digest against the bytes, and decode as UTF-8. */
  readonly get: (digest: WorkjetContentDigest) => Effect.Effect<string, WorkjetSnapshotStoreError>;

  /**
   * Existence plus byte length from the directory entry alone; `None` means no
   * object is stored under this digest. The content is never read.
   */
  readonly stat: (
    digest: WorkjetContentDigest,
  ) => Effect.Effect<Option.Option<WorkjetSnapshotStat>, WorkjetSnapshotStoreError>;

  /** Pure, total {@link snapshotRefForDigest}; exposed for callers holding only a digest. */
  readonly refFor: (digest: WorkjetContentDigest) => WorkjetSealedPayloadRef;
}

export class WorkjetSnapshotStore extends Context.Service<
  WorkjetSnapshotStore,
  WorkjetSnapshotStoreShape
>()("t3/workjet/mailbox/WorkjetSnapshotStore") {}

const ioFailure = (operation: string) => (cause: unknown) =>
  new WorkjetSnapshotIoError({ operation, cause });

/**
 * `fatal` decoding turns a byte sequence that is not valid UTF-8 into a typed
 * corruption instead of the replacement characters a lenient decoder would
 * silently substitute.
 */
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const root = path.join(config.stateDir, ...WORKJET_SNAPSHOT_ROOT_SEGMENTS);
  const snapshotPath = (digest: WorkjetContentDigest): string =>
    path.join(root, ...snapshotRelativeSegments(digest));

  /**
   * tmp + rename inside the destination shard directory, mirroring
   * `atomicWrite.ts`. Staying inside the shard keeps the rename on one
   * filesystem, so a reader either sees no file or sees the complete object —
   * never a partial one.
   */
  const writeAtomically = (filePath: string, bytes: Uint8Array) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, {
          recursive: true,
          mode: SNAPSHOT_DIRECTORY_MODE,
        });
        const tempDirectory = yield* fs.makeTempDirectoryScoped({
          directory,
          prefix: `${path.basename(filePath)}.`,
        });
        const tempPath = path.join(tempDirectory, "snapshot.tmp");
        yield* fs.writeFile(tempPath, bytes, { mode: SNAPSHOT_FILE_MODE });
        yield* fs.rename(tempPath, filePath);
      }),
    ).pipe(Effect.mapError(ioFailure("put:write")));

  const put = (
    text: string,
  ): Effect.Effect<WorkjetPromptSnapshotReference, WorkjetSnapshotStoreError> =>
    Effect.gen(function* () {
      const bytes = utf8Encoder.encode(text);
      const byteLength = bytes.byteLength;
      if (byteLength > WORKJET_SNAPSHOT_MAX_BYTES) {
        return yield* new WorkjetSnapshotTooLargeError({
          byteLength,
          maximumBytes: WORKJET_SNAPSHOT_MAX_BYTES,
        });
      }

      const digest = sha256Hex(bytes);
      const filePath = snapshotPath(digest);

      // Content addressing makes this check sufficient for idempotency: an
      // existing file at this path already holds bytes with this digest, so
      // rewriting it could only replace the content with itself.
      const alreadyStored = yield* fs
        .exists(filePath)
        .pipe(Effect.mapError(ioFailure("put:exists")));
      if (!alreadyStored) {
        yield* writeAtomically(filePath, bytes);
      }

      return {
        digest,
        snapshotRef: snapshotRefForDigest(digest),
        byteLength,
      } satisfies WorkjetPromptSnapshotReference;
    });

  const statInfo = (digest: WorkjetContentDigest) =>
    Effect.gen(function* () {
      const filePath = snapshotPath(digest);
      const present = yield* fs.exists(filePath).pipe(Effect.mapError(ioFailure("stat:exists")));
      if (!present) return Option.none<FileSystem.File.Info>();
      const info = yield* fs.stat(filePath).pipe(Effect.mapError(ioFailure("stat:stat")));
      return Option.some(info);
    });

  const stat = (
    digest: WorkjetContentDigest,
  ): Effect.Effect<Option.Option<WorkjetSnapshotStat>, WorkjetSnapshotStoreError> =>
    statInfo(digest).pipe(Effect.map(Option.map((info) => ({ byteLength: Number(info.size) }))));

  const get = (digest: WorkjetContentDigest): Effect.Effect<string, WorkjetSnapshotStoreError> =>
    Effect.gen(function* () {
      const info = yield* statInfo(digest);
      if (Option.isNone(info)) {
        return yield* new WorkjetSnapshotNotFoundError({ digest });
      }
      // Bound the read before allocating: a file that outgrew the ceiling is
      // corrupt by definition, since nothing in this store could have written it.
      if (Number(info.value.size) > WORKJET_SNAPSHOT_MAX_BYTES) {
        return yield* new WorkjetSnapshotCorruptError({ digest, issue: "size-exceeded" });
      }

      const bytes = yield* fs
        .readFile(snapshotPath(digest))
        .pipe(Effect.mapError(ioFailure("get:read")));

      // The whole point of the store: the digest is proven against the bytes
      // on the way out, not merely trusted because of where the file sits.
      if (sha256Hex(bytes) !== digest) {
        return yield* new WorkjetSnapshotCorruptError({ digest, issue: "digest-mismatch" });
      }

      return yield* Effect.try({
        try: () => strictUtf8Decoder.decode(bytes),
        catch: () => new WorkjetSnapshotCorruptError({ digest, issue: "invalid-utf8" }),
      });
    });

  return {
    put,
    get,
    stat,
    refFor: snapshotRefForDigest,
  } satisfies WorkjetSnapshotStoreShape;
});

export const WorkjetSnapshotStoreLive = Layer.effect(WorkjetSnapshotStore, make);
