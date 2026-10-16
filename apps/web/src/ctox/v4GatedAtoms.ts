import { Atom } from "effect/unstable/reactivity";
import { getCtoxClient, subscribeCtoxClients } from "./ctoxClient";
import { readActiveWorkjetScope, subscribeActiveWorkjetScope } from "../activeWorkjetScope";

/** V4 exactly when the host bound a kernel client for the selected instance (Scheibe C gate). */
export function isCtoxV4Selected(): boolean {
  return getCtoxClient(readActiveWorkjetScope().selectedInstanceId) !== null;
}

/** Live gate: flips when the host (un)mounts the kernel or the selection changes. */
export const ctoxV4SelectedAtom = Atom.make((get) => {
  const update = () => get.setSelf(isCtoxV4Selected());
  const offClients = subscribeCtoxClients(update);
  const offScope = subscribeActiveWorkjetScope(update);
  get.addFinalizer(() => {
    offClients();
    offScope();
  });
  return isCtoxV4Selected();
}).pipe(Atom.withLabel("ctox-v4-selected"));

/**
 * Same family signature as the legacy atom family. On a V4 instance the value comes from the
 * local kernel read; on V3 it is the unchanged legacy atom. A refresh reaches the active source,
 * so existing `registry.refresh(...)` calls keep refetching the V3 RPC.
 */
export function gateCtoxReadFamily<Input, Legacy, V4>(
  legacy: (input: Input) => Atom.Atom<Legacy>,
  v4: (input: Input) => Atom.Atom<V4>,
): (input: Input) => Atom.Atom<Legacy | V4> {
  const family = Atom.family((key: string) => {
    const input = JSON.parse(key) as Input;
    return Atom.readable<Legacy | V4>(
      (get) => (get(ctoxV4SelectedAtom) ? get(v4(input)) : get(legacy(input))),
      (refresh) =>
        refresh((isCtoxV4Selected() ? v4(input) : legacy(input)) as Atom.Atom<Legacy | V4>),
    );
  });
  return (input: Input) => family(JSON.stringify(input));
}
