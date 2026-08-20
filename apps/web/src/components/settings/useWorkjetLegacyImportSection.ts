import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, WorkjetLegacyImportBindings } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import type {
  WorkjetLegacyImportAnswer,
  WorkjetLegacyImportDraft,
  WorkjetLegacyImportSectionState,
} from "./WorkjetLegacyImport";

/**
 * Operator-facing text for a refusal.
 *
 * The server refuses a binding it cannot verify and writes NOTHING when it
 * does, so every message here says what was rejected rather than implying a
 * partial import happened.
 */
export function workjetLegacyImportFailureDescription(error: unknown): string {
  const reason =
    typeof error === "object" && error !== null && "reason" in error
      ? String((error as { readonly reason: unknown }).reason)
      : null;
  const subject =
    typeof error === "object" && error !== null && "subject" in error
      ? ((error as { readonly subject: unknown }).subject ?? null)
      : null;
  const named = typeof subject === "string" && subject.length > 0 ? ` (${subject})` : "";
  switch (reason) {
    case "unknown-environment":
      return `This server cannot verify that Code environment${named}. Only this server's own environment and environments the configuration already uses can be bound.`;
    case "unknown-gateway-account":
      return `The provider gateway has no such account${named}.`;
    case "gateway-unavailable":
      return "The provider gateway is unavailable, so an account binding cannot be verified. Start the gateway, or skip the records that need an account.";
    case "unknown-record":
      return `The legacy configuration no longer has that record${named}. Re-check the offer and answer it again.`;
    case "unresolved-pending":
      return `One record still has no answer${named}. Bind it or skip it explicitly.`;
    case "conflicting-binding":
      return `That record was answered more than once${named}.`;
    case "import-unavailable":
      return "The legacy import is unavailable on this server.";
    default:
      return "The server refused this import. Nothing was changed.";
  }
}

export interface WorkjetLegacyImportSection {
  readonly state: WorkjetLegacyImportSectionState;
  readonly draft: WorkjetLegacyImportDraft;
  readonly onAnswer: (key: string, answer: WorkjetLegacyImportAnswer) => void;
  /** True only while a one-time offer is actually waiting for an answer. */
  readonly hasOffer: boolean;
}

/**
 * Runtime state for the one-shot legacy Swift import surface.
 *
 * The draft lives here rather than in the view so the view stays a pure
 * function of (offer, draft) — the accept gate is then a plain function the
 * tests can state, not a behavior hidden in a component.
 */
export function useWorkjetLegacyImportSection(
  environmentId: EnvironmentId | null,
): WorkjetLegacyImportSection {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetLegacyImport({ environmentId, input: {} }),
  );
  const decide = useAtomCommand(serverEnvironment.decideWorkjetLegacyImport, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState<WorkjetLegacyImportDraft>({});
  const [error, setError] = useState<string | null>(null);
  const [isDeciding, setIsDeciding] = useState(false);

  // A different environment is a different machine, a different legacy
  // document, and a different decision, so no answer may survive the switch.
  useEffect(() => {
    setDraft({});
    setError(null);
  }, [environmentId]);

  const onAnswer = useCallback((key: string, answer: WorkjetLegacyImportAnswer) => {
    setError(null);
    setDraft((current) => ({ ...current, [key]: answer }));
  }, []);

  const run = useCallback(
    (
      input:
        | { readonly action: "accept"; readonly bindings: WorkjetLegacyImportBindings }
        | { readonly action: "decline" },
    ) => {
      if (environmentId === null || isDeciding) return;
      setIsDeciding(true);
      setError(null);
      void (async () => {
        const result = await decide({ environmentId, input });
        if (result._tag === "Success") {
          const outcome = result.value.outcome;
          toastManager.add({
            type: outcome === "imported" || outcome === "declined" ? "success" : "warning",
            title:
              outcome === "imported"
                ? "Legacy Workjet configuration imported"
                : outcome === "declined"
                  ? "Legacy Workjet import declined"
                  : outcome === "already-decided"
                    ? "This environment already decided"
                    : outcome === "nothing-to-import"
                      ? "Nothing to import"
                      : outcome === "unreadable"
                        ? "The legacy configuration could not be read"
                        : "The import could not be saved",
            description:
              outcome === "imported"
                ? `${result.value.importedComputers} computer(s), ${result.value.importedLlmRoutes} route(s), ${result.value.importedWorkerProfiles} worker(s). The decision is recorded and will not be offered again.`
                : outcome === "declined"
                  ? "Recorded. The offer will not be shown again on this machine."
                  : outcome === "unreadable" || outcome === "not-persisted"
                    ? "Nothing was written and no decision was recorded."
                    : "Nothing was changed.",
          });
        } else if (!isAtomCommandInterrupted(result)) {
          setError(workjetLegacyImportFailureDescription(squashAtomCommandFailure(result)));
        }
      })().finally(() => setIsDeciding(false));
    },
    [decide, environmentId, isDeciding],
  );

  const inspection = query.data ?? null;
  return {
    draft,
    onAnswer,
    hasOffer: inspection?.state === "offer",
    state: {
      inspection,
      isInitialLoading: environmentId !== null && query.isPending && inspection === null,
      hasInspectFailure: query.error !== null,
      isRefreshing: query.isPending && inspection !== null,
      isDeciding,
      error,
      onRefresh: query.refresh,
      onAccept: (bindings) => run({ action: "accept", bindings }),
      onDecline: () => run({ action: "decline" }),
    },
  };
}
