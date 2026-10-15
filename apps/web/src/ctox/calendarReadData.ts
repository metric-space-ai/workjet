import { verifyCtoxConnectionTarget } from "./crossModeReadData";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  WorkjetCalendarAccounts,
  WorkjetCalendarEvents,
  type WorkjetCalendarTarget,
  type WorkjetCalendarEventsInput,
  type EnvironmentId,
} from "@workjet/contracts";
import type { AtomCommand } from "@workjet/client-runtime/state/runtime";
import { getCtoxClient } from "./ctoxClient";
import { readActiveWorkjetScope } from "../activeWorkjetScope";
import { createCtoxReadAtomFamily } from "./readAtoms";
import { CtoxLocalReadError, normalizeCtoxReadError } from "./projectReadData";

type Target<Input> = { readonly environmentId: EnvironmentId; readonly input: Input };
const accounts = createCtoxReadAtomFamily<Target<WorkjetCalendarTarget>, WorkjetCalendarAccounts>({
  collections: [
    "workjet_connections",
    "workjet_calendar_accounts",
    "workjet_calendar_events",
    "workjet_calendar_state",
  ],
  read: (api, { environmentId, input }) => {
    verifyCtoxConnectionTarget(api, input, environmentId);
    const state = api.get<{ truncated: boolean }>("workjet_calendar_state", "accounts").get();
    if (!state)
      throw new CtoxLocalReadError(
        "not_found",
        "projection_missing",
        "workjet_calendar_state/accounts",
      );
    return Schema.decodeUnknownSync(WorkjetCalendarAccounts)({
      ok: true,
      truncated: state.truncated,
      accounts: api
        .query("workjet_calendar_accounts", { selector: { is_deleted: { $ne: true } } })
        .get(),
    });
  },
});
const calendarEvents: AtomCommand<
  Target<WorkjetCalendarEventsInput>,
  WorkjetCalendarEvents,
  CtoxLocalReadError
> = {
  label: "ctox-local:calendar-events",
  run: async (_registry, { environmentId, input }) => {
    try {
      const api = getCtoxClient(readActiveWorkjetScope().selectedInstanceId);
      if (!api) throw new CtoxLocalReadError("unavailable", "ctox_client_unavailable", "workjet");
      verifyCtoxConnectionTarget(api, input.target, environmentId);
      const state = api
        .get<{ truncated: boolean; synced_at_ms: number }>(
          "workjet_calendar_state",
          input.accountId,
        )
        .get();
      if (!state)
        throw new CtoxLocalReadError("not_found", "projection_missing", "workjet_calendar_state");
      return AsyncResult.success(
        Schema.decodeUnknownSync(WorkjetCalendarEvents)({
          ok: true,
          truncated: state.truncated,
          synced_at_ms: state.synced_at_ms,
          events: api
            .query("workjet_calendar_events", {
              selector: {
                account_id: input.accountId,
                start_ms: { $lt: input.endMs },
                end_ms: { $gt: input.startMs },
                is_deleted: { $ne: true },
              },
              sort: [{ start_ms: "asc" }],
            })
            .get(),
        }),
      );
    } catch (error) {
      return AsyncResult.failure(
        Cause.fail(normalizeCtoxReadError(error, "workjet_calendar_events")),
      );
    }
  },
};
export const ctoxCalendarReads = {
  calendarAccounts: (target: Target<WorkjetCalendarTarget>) => accounts(JSON.stringify(target)),
  calendarEvents,
};
