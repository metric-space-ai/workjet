import type { Dispatch, SetStateAction } from "react";

/**
 * Minimal React hook shim for tests that call components as plain functions
 * instead of mounting a renderer. Slots are keyed by call order, mirroring
 * React's own rules-of-hooks contract, and `useMemoCache` emulates the React
 * Compiler runtime so compiled components can execute unmodified.
 *
 * This module must stay free of runtime `react` imports: it is loaded from
 * inside `vi.mock("react", ...)` factories, and a value import would recurse
 * into the in-progress mock. Wire it up in each test file (mock calls cannot
 * live here because vitest hoists them per test module):
 *
 * ```ts
 * import { reactHookHarness } from "~/test/reactHookHarness";
 *
 * vi.mock("react", async (importOriginal) => {
 *   const actual = await importOriginal<typeof import("react")>();
 *   const { reactHookHarness } = await import("~/test/reactHookHarness");
 *   return {
 *     ...actual,
 *     useCallback: reactHookHarness.useCallback,
 *     useMemo: reactHookHarness.useMemo,
 *     useRef: reactHookHarness.useRef,
 *     useState: reactHookHarness.useState,
 *   };
 * });
 * vi.mock("react/compiler-runtime", async () => {
 *   const { reactHookHarness } = await import("~/test/reactHookHarness");
 *   return { c: reactHookHarness.useMemoCache };
 * });
 * ```
 *
 * Call `beginRender()` before each component invocation and `reset()` in
 * `beforeEach` to drop persisted state between tests.
 */
export function createReactHookHarness() {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useMemo<T>(factory: () => T): T {
      nextIndex();
      return factory();
    },
    /**
     * Runs the effect synchronously during the render call — there is no
     * commit phase when a component is invoked as a plain function. Deps are
     * compared with `Object.is` so a re-render only re-runs a changed effect,
     * which is what mount-once behaviour needs to be observable. Cleanups are
     * invoked before a re-run; there is no unmount, so a cleanup-only effect
     * never fires here.
     */
    useEffect(effect: () => void | (() => void), deps?: ReadonlyArray<unknown>): void {
      const index = nextIndex();
      const slot = slots[index] as
        | { deps: ReadonlyArray<unknown> | undefined; cleanup: (() => void) | void }
        | undefined;
      const unchanged =
        slot !== undefined &&
        deps !== undefined &&
        slot.deps !== undefined &&
        slot.deps.length === deps.length &&
        slot.deps.every((value, depIndex) => Object.is(value, deps[depIndex]));
      if (unchanged) return;
      if (slot && typeof slot.cleanup === "function") slot.cleanup();
      slots[index] = { deps, cleanup: effect() };
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
}

/** Shared instance so `vi.mock` factories and test bodies see the same slots. */
export const reactHookHarness = createReactHookHarness();
