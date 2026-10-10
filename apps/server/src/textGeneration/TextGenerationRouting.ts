import { TextGenerationError } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import type { ProviderGatewayRoutingError } from "../provider/Errors.ts";

export type TextGenerationRoutingError = ProviderGatewayRoutingError | TextGenerationError;
export type TextGenerationEnvironmentResolver = (
  model: string,
) => Effect.Effect<NodeJS.ProcessEnv, TextGenerationRoutingError>;

/** Resolve the selected account and current gateway endpoint before each CLI launch. */
export const resolveTextGenerationEnvironment = (
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle",
  model: string,
  fallback: NodeJS.ProcessEnv,
  resolve?: TextGenerationEnvironmentResolver,
): Effect.Effect<NodeJS.ProcessEnv, TextGenerationError> =>
  resolve === undefined
    ? Effect.succeed(fallback)
    : resolve(model).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Provider gateway routing failed for text generation.",
              cause,
            }),
        ),
      );
