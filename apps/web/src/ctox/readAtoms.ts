import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { CtoxAppApi } from "./ctoxClient";
import { getCtoxClient, subscribeCtoxClients } from "./ctoxClient";
import { readActiveWorkjetScope, subscribeActiveWorkjetScope } from "../activeWorkjetScope";
import { CtoxLocalReadError, normalizeCtoxReadError } from "./projectReadData";

/** Compatibility for existing atom consumers: synchronous local reads and live invalidation. */
export function createCtoxReadAtomFamily<Input, Value>(options: {
  collections: readonly string[];
  metrics?: boolean;
  read(api: CtoxAppApi, input: Input): Value;
}) {
  return Atom.family((key: string) => {
    const input: Input = JSON.parse(key);
    return Atom.make((get) => {
      let offs: (() => void)[] = [];
      const snapshot = (): AsyncResult.AsyncResult<Value, CtoxLocalReadError> => {
        const api = getCtoxClient(readActiveWorkjetScope().selectedInstanceId);
        if (!api)
          return AsyncResult.failure(
            Cause.fail(new CtoxLocalReadError("unavailable", "ctox_client_unavailable", "workjet")),
          );
        try {
          return AsyncResult.success(options.read(api, input));
        } catch (error) {
          return AsyncResult.failure(
            Cause.fail(normalizeCtoxReadError(error, options.collections.join(","))),
          );
        }
      };
      const bind = () => {
        offs.forEach((off) => off());
        offs = [];
        const api = getCtoxClient(readActiveWorkjetScope().selectedInstanceId);
        try {
          if (api)
            for (const collection of options.collections) {
              offs.push(api.query(collection, {}).subscribe(() => get.setSelf(snapshot())));
            }
          if (api && options.metrics)
            offs.push(api.metrics.subscribe(() => get.setSelf(snapshot())));
          get.setSelf(snapshot());
        } catch (error) {
          offs.forEach((off) => off());
          offs = [];
          get.setSelf(
            AsyncResult.failure(
              Cause.fail(normalizeCtoxReadError(error, options.collections.join(","))),
            ),
          );
        }
      };
      const offClients = subscribeCtoxClients(bind);
      const offScope = subscribeActiveWorkjetScope(bind);
      bind();
      get.addFinalizer(() => {
        offs.forEach((off) => off());
        offClients();
        offScope();
      });
      return snapshot();
    });
  });
}
