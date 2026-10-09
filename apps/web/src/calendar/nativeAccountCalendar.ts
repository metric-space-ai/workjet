import * as Schema from "effect/Schema";
import { newCommandId } from "../lib/utils";

import {
  CtoxWorkjetProjectControlResponse,
  isWorkjetCalendarReceiptForRequest,
  type WorkjetCalendarAccounts,
  type WorkjetCalendarEvents,
  type WorkjetCalendarNativeRequest,
} from "@workjet/contracts";
import {
  requestWorkjetProjectControl,
  describeWorkjetProjectControlFailure,
} from "../workjetProjectControl";

/** A read session is bound to one selected instance and one mounted calendar. */
export class NativeAccountCalendar {
  constructor(
    readonly instanceId: string,
    private readonly current: () => boolean,
    private readonly control: typeof requestWorkjetProjectControl = requestWorkjetProjectControl,
  ) {}
  private async read(request: WorkjetCalendarNativeRequest) {
    if (!this.current()) throw new Error("Calendar instance changed.");
    const result = await this.control(this.instanceId, request);
    if (!this.current()) throw new Error("Calendar instance changed.");
    if (result._tag !== "completed") throw new Error(describeWorkjetProjectControlFailure(result));
    const response = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
      onExcessProperty: "error",
    })(result.response);
    if (
      response.action !== request.action ||
      !isWorkjetCalendarReceiptForRequest(request, response)
    )
      throw new Error("Calendar receipt does not match this read.");
    return response;
  }
  async accounts(): Promise<WorkjetCalendarAccounts> {
    const response = await this.read({
      action: "project.calendar.accounts.read",
      commandId: newCommandId(),
    });
    if (response.action !== "project.calendar.accounts.read")
      throw new Error("Invalid calendar accounts receipt.");
    return response.calendar;
  }
  async events(accountId: string, startMs: number, endMs: number): Promise<WorkjetCalendarEvents> {
    const response = await this.read({
      action: "project.calendar.events.read",
      commandId: newCommandId(),
      accountId,
      startMs,
      endMs,
    });
    if (response.action !== "project.calendar.events.read")
      throw new Error("Invalid calendar events receipt.");
    return response.calendar;
  }
}
