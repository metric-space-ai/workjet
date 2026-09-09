/**
 * The pinning rule, asserted directly.
 *
 * A CTOX provider instance is built with ONE connection and submits over it.
 * The scope resolver, meanwhile, answers from the thread's own binding. If the
 * driver compared only the instance id, a thread bound to connection A would be
 * acted on through connection B whenever both point at the same CTOX instance —
 * and two connections to one instance can carry different agent tokens and
 * scopes, so that is a privilege change, not a routing detail.
 *
 * Two different INSTANCES is the easy case and would pass either way; the case
 * that actually distinguishes a correct implementation is two connections to
 * the SAME instance.
 */
import { assert, it } from "@effect/vitest";

import { nativeBindingMismatchDetail } from "./CtoxDriver.ts";

const INSTANCE = "paired:manual_pairing:office-1";
const OTHER_INSTANCE = "paired:manual_pairing:office-2";
const CONNECTION_A = "connection-a";
const CONNECTION_B = "connection-b";

const pinned = { ctoxInstanceId: INSTANCE, connectionId: CONNECTION_A };

it("accepts only the exact instance AND connection this provider instance is pinned to", () => {
  assert.isNull(
    nativeBindingMismatchDetail({ ctoxInstanceId: INSTANCE, connectionId: CONNECTION_A }, pinned),
  );
});

it("refuses a thread bound to another connection of the SAME CTOX instance", () => {
  const detail = nativeBindingMismatchDetail(
    { ctoxInstanceId: INSTANCE, connectionId: CONNECTION_B },
    pinned,
  );
  assert.isNotNull(detail);
  // The refusal has to name the connection, because "same instance" is exactly
  // the reason a reader would otherwise assume this was allowed.
  assert.include(detail ?? "", CONNECTION_B);
  assert.include(detail ?? "", CONNECTION_A);
});

it("refuses a thread bound to another CTOX instance", () => {
  const detail = nativeBindingMismatchDetail(
    { ctoxInstanceId: OTHER_INSTANCE, connectionId: CONNECTION_A },
    pinned,
  );
  assert.isNotNull(detail);
  assert.include(detail ?? "", OTHER_INSTANCE);
});
