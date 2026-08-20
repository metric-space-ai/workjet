/**
 * One-shot import of the legacy Swift Workjet configuration.
 *
 * ## Why this lives in the server
 *
 * The Workjet configuration is server-authoritative: it is persisted as
 * `settings.workjet` inside the environment's own `settings.json`
 * (`ServerConfig.settingsPath`), and the plan explicitly refuses to make the
 * Electron renderer or the legacy Swift app an authority for those values. The
 * legacy document also lives in the home directory OF THE MACHINE THE SERVER
 * RUNS ON, so "is there something to import" is a question only that server can
 * answer. A desktop-side runner would answer it for the wrong machine the moment
 * the user opens a remote environment. The marker therefore sits next to
 * `settings.json`, and every environment decides once, for itself.
 *
 * ## Relationship to `DesktopUserDataMigration`
 *
 * Same discipline, deliberately one state fewer:
 *
 *  - a pure decision function whose every filesystem fact is passed in,
 *  - a durable marker that records the outcome INCLUDING a decline, so the offer
 *    is made at most once,
 *  - a read-only source: the legacy file is never written, moved, or deleted,
 *  - an explicit offer the operator has to answer.
 *
 * The desktop migration needs an `accepted-pending` state because copying a live
 * Chromium profile can corrupt it, so acceptance and copying must happen on
 * different launches. Here the import is one settings patch against a store this
 * server already owns, so there is nothing to defer and no restart to demand.
 */

import type { WorkjetConfiguration } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  LEGACY_WORKJET_CONFIG_FILE_NAME,
  LEGACY_WORKJET_CONFIG_RELATIVE_DIR,
  parseLegacyWorkjetConfig,
  type LegacyWorkjetReadFailure,
} from "./LegacyWorkjetConfig.ts";
import {
  EMPTY_LEGACY_WORKJET_BINDINGS,
  mapLegacyWorkjetConfig,
  type LegacyWorkjetDecision,
  type LegacyWorkjetImportBindings,
  type LegacyWorkjetMappingResult,
  type LegacyWorkjetPendingBinding,
} from "./LegacyWorkjetMapping.ts";

/**
 * Recorded next to `settings.json`. Its presence is the single "this was already
 * decided" signal, so the offer is shown at most once — including on a decline.
 */
export const LEGACY_WORKJET_IMPORT_MARKER_FILE = "workjet-legacy-import.json";

export const LegacyWorkjetImportOutcome = Schema.Literals([
  /** The import ran and the settings patch landed. */
  "imported",
  /** The operator said no. Terminal: the offer is never shown again. */
  "declined",
]);
export type LegacyWorkjetImportOutcome = typeof LegacyWorkjetImportOutcome.Type;

export const LegacyWorkjetImportMarker = Schema.Struct({
  version: Schema.Literal(1),
  outcome: LegacyWorkjetImportOutcome,
  /** Absolute path of the document the decision was made about. */
  legacyPath: Schema.NullOr(Schema.String),
  decidedAt: Schema.String,
  /** Legacy configuration version that was read; `null` for a decline. */
  legacyVersion: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  importedComputers: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  importedLlmRoutes: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  importedWorkerProfiles: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Records that still needed an operator binding when the import ran. */
  pendingBindings: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type LegacyWorkjetImportMarker = typeof LegacyWorkjetImportMarker.Type;

const decodeMarker = Schema.decodeEffect(Schema.fromJsonString(LegacyWorkjetImportMarker));
const encodeMarker = Schema.encodeEffect(Schema.fromJsonString(LegacyWorkjetImportMarker));

export type LegacyWorkjetImportDecision =
  /** Nothing to import: no legacy configuration exists on this machine. */
  | { readonly _tag: "fresh" }
  /** A legacy configuration exists and the operator has not been asked yet. */
  | { readonly _tag: "import-offer"; readonly legacyPath: string }
  /** A marker already records a terminal decision. */
  | { readonly _tag: "already-decided"; readonly outcome: LegacyWorkjetImportOutcome };

export interface LegacyWorkjetConfigCandidate {
  readonly path: string;
  readonly exists: boolean;
}

/**
 * Pure decision. Every filesystem fact it needs is passed in, so the whole matrix
 * is testable without a real home directory.
 *
 * A recorded marker always wins, so no path through this function can run the
 * import twice.
 */
export function decideLegacyWorkjetImport(input: {
  readonly marker: Option.Option<LegacyWorkjetImportMarker>;
  readonly candidates: readonly LegacyWorkjetConfigCandidate[];
}): LegacyWorkjetImportDecision {
  if (Option.isSome(input.marker)) {
    return { _tag: "already-decided", outcome: input.marker.value.outcome };
  }
  const legacyPath = input.candidates.find((candidate) => candidate.exists)?.path;
  return legacyPath === undefined ? { _tag: "fresh" } : { _tag: "import-offer", legacyPath };
}

/**
 * Where the Swift app keeps its configuration. It is a macOS menu-bar app, so a
 * non-darwin host has no candidates at all rather than a speculative path.
 */
export function legacyWorkjetConfigCandidatePaths(input: {
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly join: (first: string, ...rest: string[]) => string;
}): readonly string[] {
  if (input.platform !== "darwin" || input.homeDirectory.trim().length === 0) return [];
  return [
    input.join(
      input.homeDirectory,
      LEGACY_WORKJET_CONFIG_RELATIVE_DIR,
      LEGACY_WORKJET_CONFIG_FILE_NAME,
    ),
  ];
}

export type LegacyWorkjetImportPreview =
  | { readonly _tag: "mapped"; readonly result: LegacyWorkjetMappingResult }
  | { readonly _tag: "unreadable"; readonly failure: LegacyWorkjetReadFailure };

/** What the operator is asked to decide about. */
export interface LegacyWorkjetImportOffer {
  readonly legacyPath: string;
  /** Where the imported configuration would land. */
  readonly settingsPath: string;
  /**
   * Computed with NO bindings, so it shows the honest floor: what imports for
   * free, and everything that needs an operator decision first.
   */
  readonly preview: LegacyWorkjetImportPreview;
}

export type LegacyWorkjetImportResult =
  | {
      readonly _tag: "imported";
      readonly legacyPath: string;
      readonly configuration: WorkjetConfiguration;
      readonly decisions: readonly LegacyWorkjetDecision[];
      readonly pending: readonly LegacyWorkjetPendingBinding[];
    }
  /** Already decided. The settings document was not touched. */
  | { readonly _tag: "already-decided"; readonly outcome: LegacyWorkjetImportOutcome }
  /** Nothing to import. */
  | { readonly _tag: "fresh" }
  /** The document exists but failed closed. No marker is written. */
  | {
      readonly _tag: "unreadable";
      readonly legacyPath: string;
      readonly failure: LegacyWorkjetReadFailure;
    }
  /** The mapping succeeded but the settings store rejected the patch. No marker. */
  | { readonly _tag: "not-persisted"; readonly legacyPath: string; readonly detail: string };

export class LegacyWorkjetImport extends Context.Service<
  LegacyWorkjetImport,
  {
    /** Decision resolved once, while this service is constructed. */
    readonly decision: LegacyWorkjetImportDecision;
    /** Present only when a one-time offer should be shown. */
    readonly offer: Option.Option<LegacyWorkjetImportOffer>;
    /**
     * Run the import with the operator's bindings and record the outcome. Safe to
     * call twice: a recorded marker short-circuits to `already-decided`.
     */
    readonly accept: (
      bindings: LegacyWorkjetImportBindings,
    ) => Effect.Effect<LegacyWorkjetImportResult>;
    /** Record refusal. Terminal — the offer is never shown again. */
    readonly decline: Effect.Effect<void>;
  }
>()("t3/workjet/legacy/LegacyWorkjetImport") {}

export type LegacyWorkjetReadAndMap =
  | {
      readonly _tag: "mapped";
      readonly result: LegacyWorkjetMappingResult;
      readonly legacyVersion: number;
    }
  | { readonly _tag: "unreadable"; readonly failure: LegacyWorkjetReadFailure };

/**
 * Read and map a legacy document. Exported so the offer preview, the import, and
 * the tests all go through exactly one code path.
 */
export function readAndMapLegacyWorkjetConfig(input: {
  readonly text: string;
  readonly bindings: LegacyWorkjetImportBindings;
}): LegacyWorkjetReadAndMap {
  const read = parseLegacyWorkjetConfig(input.text);
  if (read._tag === "unreadable") return { _tag: "unreadable", failure: read.failure };
  return {
    _tag: "mapped",
    legacyVersion: read.config.version,
    result: mapLegacyWorkjetConfig({
      config: read.config,
      unknownFields: read.unknownFields,
      bindings: input.bindings,
    }),
  };
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService;
  const platform = yield* HostProcessPlatform;
  const processEnvironment = yield* HostProcessEnvironment;

  const markerPath = path.join(config.stateDir, LEGACY_WORKJET_IMPORT_MARKER_FILE);
  const homeDirectory = processEnvironment["HOME"] ?? processEnvironment["USERPROFILE"] ?? "";

  const readMarker = fileSystem.readFileString(markerPath).pipe(
    Effect.flatMap(decodeMarker),
    // A missing marker means "not decided yet". An unreadable or corrupt one is
    // treated the same way: the import writes a whole object computed from a
    // source it never mutates, so re-offering is safe, while refusing to
    // re-offer would strand the operator with no way back in.
    Effect.option,
  );

  const writeMarker = (marker: LegacyWorkjetImportMarker) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(markerPath, yield* encodeMarker(marker));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to record the Workjet legacy import marker", {
          markerPath,
          outcome: marker.outcome,
          cause: String(cause),
        }),
      ),
    );

  /** Read the legacy document. Read-only: nothing here can modify the source. */
  const readLegacyText = (legacyPath: string) =>
    fileSystem.readFileString(legacyPath).pipe(Effect.option);

  const candidatePaths = legacyWorkjetConfigCandidatePaths({
    homeDirectory,
    platform,
    join: path.join,
  });
  const candidates = yield* Effect.forEach(candidatePaths, (candidatePath) =>
    fileSystem.exists(candidatePath).pipe(
      Effect.orElseSucceed(() => false),
      Effect.map((exists) => ({ path: candidatePath, exists })),
    ),
  );

  const decision = decideLegacyWorkjetImport({ marker: yield* readMarker, candidates });

  const offer: Option.Option<LegacyWorkjetImportOffer> = yield* Effect.gen(function* () {
    if (decision._tag !== "import-offer") return Option.none<LegacyWorkjetImportOffer>();
    const text = yield* readLegacyText(decision.legacyPath);
    // A document that exists but cannot be read at all is not an offer we can
    // describe, so no offer is made and nothing is recorded.
    if (Option.isNone(text)) return Option.none<LegacyWorkjetImportOffer>();
    const read = readAndMapLegacyWorkjetConfig({
      text: text.value,
      bindings: EMPTY_LEGACY_WORKJET_BINDINGS,
    });
    return Option.some({
      legacyPath: decision.legacyPath,
      settingsPath: config.settingsPath,
      preview:
        read._tag === "mapped"
          ? ({ _tag: "mapped", result: read.result } as const)
          : ({ _tag: "unreadable", failure: read.failure } as const),
    });
  });

  const accept = (
    bindings: LegacyWorkjetImportBindings,
  ): Effect.Effect<LegacyWorkjetImportResult> =>
    Effect.gen(function* () {
      // Re-read the marker: a concurrent decision must not be overwritten, and a
      // second accept must not patch the settings again.
      const current = yield* readMarker;
      if (Option.isSome(current)) {
        const alreadyDecided: LegacyWorkjetImportResult = {
          _tag: "already-decided",
          outcome: current.value.outcome,
        };
        return alreadyDecided;
      }
      const nothingToDo: LegacyWorkjetImportResult = { _tag: "fresh" };
      if (decision._tag !== "import-offer") return nothingToDo;

      const legacyPath = decision.legacyPath;
      const text = yield* readLegacyText(legacyPath);
      if (Option.isNone(text)) return nothingToDo;

      const read = readAndMapLegacyWorkjetConfig({ text: text.value, bindings });
      if (read._tag === "unreadable") {
        // Fail closed and leave no marker: an unreadable document is a defect to
        // look at, not a decision the operator made.
        yield* Effect.logWarning("the legacy Workjet configuration failed closed", {
          legacyPath,
          reason: read.failure.reason,
          path: read.failure.path,
        });
        const unreadable: LegacyWorkjetImportResult = {
          _tag: "unreadable",
          legacyPath,
          failure: read.failure,
        };
        return unreadable;
      }

      const persisted = yield* Effect.result(
        settings.updateSettings({ workjet: read.result.configuration }),
      );
      if (persisted._tag === "Failure") {
        yield* Effect.logWarning("the Workjet legacy import could not be persisted", {
          legacyPath,
          cause: persisted.failure.message,
        });
        const notPersisted: LegacyWorkjetImportResult = {
          _tag: "not-persisted",
          legacyPath,
          detail: persisted.failure.message,
        };
        return notPersisted;
      }

      yield* writeMarker({
        version: 1,
        outcome: "imported",
        legacyPath,
        decidedAt: DateTime.formatIso(yield* DateTime.now),
        legacyVersion: read.legacyVersion,
        importedComputers: read.result.counts.computersImported,
        importedLlmRoutes: read.result.counts.llmRoutesImported,
        importedWorkerProfiles: read.result.counts.workersImported,
        pendingBindings: read.result.pending.length,
      });

      yield* Effect.logInfo("imported the legacy Workjet configuration", {
        legacyPath,
        settingsPath: config.settingsPath,
        computers: read.result.counts.computersImported,
        llmRoutes: read.result.counts.llmRoutesImported,
        workerProfiles: read.result.counts.workersImported,
        pendingBindings: read.result.pending.length,
      });

      const imported: LegacyWorkjetImportResult = {
        _tag: "imported",
        legacyPath,
        configuration: read.result.configuration,
        decisions: read.result.decisions,
        pending: read.result.pending,
      };
      return imported;
    });

  const decline = Effect.gen(function* () {
    if (decision._tag !== "import-offer") return;
    if (Option.isSome(yield* readMarker)) return;
    yield* writeMarker({
      version: 1,
      outcome: "declined",
      legacyPath: decision.legacyPath,
      decidedAt: DateTime.formatIso(yield* DateTime.now),
      legacyVersion: null,
      importedComputers: 0,
      importedLlmRoutes: 0,
      importedWorkerProfiles: 0,
      pendingBindings: 0,
    });
  });

  return LegacyWorkjetImport.of({ decision, offer, accept, decline });
}).pipe(Effect.withSpan("workjet.legacyImport.make"));

export const layer = Layer.effect(LegacyWorkjetImport, make);
