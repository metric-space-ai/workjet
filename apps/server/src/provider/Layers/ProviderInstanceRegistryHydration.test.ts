/**
 * The CTOX derivation, asserted where it is a pure function.
 *
 * The defect this guards against is specific and was live in c7b3b68e4:
 * deriving provider rows from the LIVE connection list meant a failed probe or
 * a disconnect removed the row, `makeReconcile` classified the missing key as
 * removed, and it closed that instance's scope — tearing down a provider, and
 * any session bound to it, because a network check had failed once.
 *
 * The durable binding table is the source instead. Its rows are
 * first-writer-wins and survive a disconnect by design, so "was this connection
 * ever genuinely bound" is answerable after a restart without a second store.
 * Whether the instance is USABLE right now is a different question, answered by
 * the driver's own snapshot.
 */
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfigMap,
} from "@workjet/contracts";

import { mergeCtoxProviderInstances } from "./ProviderInstanceRegistryHydration.ts";

/** The map is keyed by a branded id, so build the key the contract's own way. */
const at = (map: ProviderInstanceConfigMap, key: string) => map[ProviderInstanceId.make(key)];

const empty = {} as ProviderInstanceConfigMap;
const BINDING_A = { connectionId: "connection-a", instanceId: "paired:manual_pairing:office-1" };
const BINDING_B = { connectionId: "connection-b", instanceId: "paired:manual_pairing:office-1" };

it("derives one provider instance per bound connection, not per CTOX instance", () => {
  // Both bindings name the SAME CTOX instance over different connections. They
  // are two credentials, and the driver refuses a thread bound to the other
  // one, so collapsing them into a single provider row would make that refusal
  // unreachable.
  const merged = mergeCtoxProviderInstances(empty, [BINDING_A, BINDING_B]);

  assert.deepEqual(Object.keys(merged).sort(), ["ctox_connection-a", "ctox_connection-b"]);
  assert.deepEqual(at(merged, "ctox_connection-a"), {
    driver: ProviderDriverKind.make("ctox"),
    config: { ctoxInstanceId: BINDING_A.instanceId, connectionId: BINDING_A.connectionId },
  });
});

it("keeps a bound instance regardless of whether its connection is reachable", () => {
  // There is deliberately no status input. A row that disappeared while a
  // connection was offline would be reconciled as removed, and the registry
  // closes removed scopes — so "offline" has to be a snapshot state, never a
  // missing key.
  const offlineAndOnlineAlike = mergeCtoxProviderInstances(empty, [BINDING_A]);
  assert.isDefined(at(offlineAndOnlineAlike, "ctox_connection-a"));
});

it("never overwrites an explicitly configured provider instance", () => {
  const explicit = {
    "ctox_connection-a": {
      driver: ProviderDriverKind.make("ctox"),
      config: { ctoxInstanceId: "hand-configured", connectionId: "connection-a" },
    },
  } as unknown as ProviderInstanceConfigMap;

  const merged = mergeCtoxProviderInstances(explicit, [BINDING_A]);

  // Same precedence the legacy `settings.providers` mirror already has: a
  // user-authored entry wins over a derived one.
  assert.deepEqual(at(merged, "ctox_connection-a"), at(explicit, "ctox_connection-a"));
});

it("adds nothing when no connection was ever bound", () => {
  assert.deepEqual(mergeCtoxProviderInstances(empty, []), empty);
});
