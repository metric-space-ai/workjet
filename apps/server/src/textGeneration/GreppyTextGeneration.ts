import { TextGenerationError } from "@workjet/contracts";
import * as Effect from "effect/Effect";

import { TextGeneration } from "./TextGeneration.ts";
import { GREPPY_TEXT_GENERATION_MESSAGE } from "../provider/greppy/GreppyProtocol.ts";

const unsupported = (
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle",
) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: GREPPY_TEXT_GENERATION_MESSAGE,
    }),
  );

/** Greppy has no commit, pull request, branch, or title API. */
export const makeGreppyTextGeneration = Effect.succeed(
  TextGeneration.of({
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  }),
);
