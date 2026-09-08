// @effect-diagnostics nodeBuiltinImport:off -- Desktop main owns this private, durable installation journal.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  WorkjetProvisioningSnapshot,
  WorkjetProvisioningStartInput,
  WorkjetProvisioningTarget,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const RecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  ownerSession: Schema.String,
  request: WorkjetProvisioningStartInput,
  target: WorkjetProvisioningTarget,
  snapshot: WorkjetProvisioningSnapshot,
});
const RecordJson = Schema.fromJsonString(RecordSchema);
const decodeRecord = Schema.decodeUnknownSync(RecordSchema);
const decodeRecordJson = Schema.decodeUnknownSync(RecordJson);
const encodeRecordJson = Schema.encodeSync(RecordJson);
const decodeRequest = Schema.decodeUnknownSync(WorkjetProvisioningStartInput);
export type ProvisioningRecord = typeof RecordSchema.Type;
const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));
const exists = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }));

function canonicalRequest(input: WorkjetProvisioningStartInput) {
  const decoded = decodeRequest(input);
  return {
    preflightId: decoded.preflightId,
    action: decoded.action,
    components: [...new Set(decoded.components)].sort(),
    channel: decoded.channel ?? "stable",
  };
}

/** Local installation evidence only; this journal never grants Sync membership. */
export class ProvisioningJournal {
  readonly directory: string;
  readonly ownerSession = NodeCrypto.randomUUID();
  private persistenceFailed = false;

  private requireReadable() {
    if (this.persistenceFailed)
      throw new Error(
        "Provisioning persistence failed. Restart Workjet to recover the last durable record.",
      );
  }

  private readonly platform: NodeJS.Platform;

  constructor(stateDir: string, platform: NodeJS.Platform) {
    this.platform = platform;
    this.directory = NodePath.join(stateDir, "ctox", "provisioning");
  }

  private filePath(operationId: string) {
    // No user-controlled path segments, including on Windows.
    return NodePath.join(
      this.directory,
      NodeCrypto.createHash("sha256").update(operationId).digest("hex") + ".json",
    );
  }

  private async syncDirectory() {
    if (this.platform === "win32") return;
    const directory = await NodeFSP.open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async write(record: ProvisioningRecord, create: boolean) {
    const contents = encodeRecordJson(record);
    await NodeFSP.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.filePath(record.snapshot.operationId);
    const temporary = destination + "." + NodeCrypto.randomUUID() + ".tmp";
    try {
      const file = await NodeFSP.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(contents + "\n", "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      if (create) {
        // Publish a complete record exclusively. Racing starts cannot both launch.
        await NodeFSP.link(temporary, destination);
      } else {
        await NodeFSP.rename(temporary, destination);
      }
      await this.syncDirectory();
    } finally {
      await NodeFSP.unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }

  private visible(record: ProvisioningRecord): ProvisioningRecord {
    if (
      record.ownerSession === this.ownerSession ||
      (record.snapshot.state !== "running" && record.snapshot.state !== "queued")
    )
      return record;
    const snapshot = record.snapshot;
    return {
      ...record,
      snapshot: {
        ...snapshot,
        state: "interrupted",
        errorCode: "outcome_unknown",
        serviceState: "unknown",
        backendHealthy: false,
        activeConnection: false,
        events: [
          ...snapshot.events.slice(-255),
          {
            sequence: (snapshot.events.at(-1)?.sequence ?? -1) + 1,
            timestamp: snapshot.events.at(-1)?.timestamp ?? "unknown",
            phase: "failed",
            status: "failed",
            percent: snapshot.events.at(-1)?.percent ?? 0,
            message:
              "This Workjet session does not own the operation. The target may still be running. Check it before starting another operation; this operation will not be repeated automatically.",
          },
        ],
      },
    };
  }

  async get(operationId: string): Promise<ProvisioningRecord | null> {
    this.requireReadable();
    let contents: string;
    try {
      contents = await NodeFSP.readFile(this.filePath(operationId), "utf8");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const record = decodeRecordJson(contents);
    if (record.snapshot.operationId !== operationId || record.request.preflightId !== operationId) {
      throw new Error("Provisioning journal identity mismatch.");
    }
    return this.visible(record);
  }

  async replay(input: WorkjetProvisioningStartInput): Promise<ProvisioningRecord | null> {
    const record = await this.get(input.preflightId);
    if (
      record &&
      JSON.stringify(canonicalRequest(record.request)) !== JSON.stringify(canonicalRequest(input))
    ) {
      throw new Error(
        "This preflight already belongs to a different operation. Run a new preflight.",
      );
    }
    return record;
  }

  async create(
    input: WorkjetProvisioningStartInput,
    target: WorkjetProvisioningTarget,
    snapshot: WorkjetProvisioningSnapshot,
  ): Promise<{ created: boolean; record: ProvisioningRecord }> {
    this.requireReadable();
    const record = decodeRecord({
      version: 1,
      ownerSession: this.ownerSession,
      request: canonicalRequest(input),
      target,
      snapshot,
    });
    if (snapshot.operationId !== input.preflightId)
      throw new Error("Provisioning request identity mismatch.");
    try {
      await this.write(record, true);
      return { created: true, record };
    } catch (error) {
      if (!exists(error)) {
        this.persistenceFailed = true;
        throw error;
      }
      const replay = await this.replay(input);
      if (!replay) throw new Error("Provisioning journal disappeared.", { cause: error });
      return { created: false, record: replay };
    }
  }

  async save(record: ProvisioningRecord) {
    this.requireReadable();
    if (record.ownerSession !== this.ownerSession) {
      throw new Error("An interrupted operation cannot resume in another Workjet session.");
    }
    try {
      await this.write(record, false);
    } catch (error) {
      this.persistenceFailed = true;
      throw error;
    }
  }

  async list(): Promise<ReadonlyArray<ProvisioningRecord>> {
    this.requireReadable();
    let names: string[];
    try {
      names = await NodeFSP.readdir(this.directory);
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const records: ProvisioningRecord[] = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const record = decodeRecordJson(
        await NodeFSP.readFile(NodePath.join(this.directory, name), "utf8"),
      );
      if (
        this.filePath(record.snapshot.operationId) !== NodePath.join(this.directory, name) ||
        record.request.preflightId !== record.snapshot.operationId
      ) {
        throw new Error("Provisioning journal identity mismatch.");
      }
      records.push(this.visible(record));
    }
    return records
      .sort((a, b) =>
        (b.snapshot.events.at(-1)?.timestamp ?? "").localeCompare(
          a.snapshot.events.at(-1)?.timestamp ?? "",
        ),
      )
      .slice(0, 50);
  }
}
