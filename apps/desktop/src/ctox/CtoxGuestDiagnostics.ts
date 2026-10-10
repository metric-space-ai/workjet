import {
  CtoxGuestPreparationReason,
  type CtoxGuestPreparationDiagnostic,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Only fixed classifications and numeric transport facts may leave the guest boundary. */
export function guestPreparationDiagnostic(
  stage: CtoxGuestPreparationDiagnostic["stage"],
  details: Readonly<Record<string, string | number | null>> = {},
): CtoxGuestPreparationDiagnostic {
  const code = details.errorCode ?? details.code;
  return {
    stage,
    reason: Schema.is(CtoxGuestPreparationReason)(details.reason) ? details.reason : "unknown",
    ...(typeof code === "number" && Number.isSafeInteger(code) ? { errorCode: code } : {}),
    ...(typeof details.httpStatus === "number" &&
    Number.isInteger(details.httpStatus) &&
    details.httpStatus >= 100 &&
    details.httpStatus <= 599
      ? { httpStatus: details.httpStatus }
      : {}),
  };
}

/** An explicit span persists even when the caller has no traced Effect span. */
export function recordGuestPreparationFailure(
  instanceId: string,
  diagnostic: CtoxGuestPreparationDiagnostic,
) {
  const attributes = { component: "CtoxGuestManager", instanceId, ...diagnostic };
  return Effect.logWarning("Business OS preparation failed").pipe(
    Effect.annotateLogs(attributes),
    Effect.withSpan("ctox.guest.preparation.failed", { attributes }),
  );
}
