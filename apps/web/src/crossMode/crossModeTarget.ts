// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The renderer's LOCAL cross-mode link target (docs/workjet-plan.md
 * "Cross-mode workflow bridge", items 4 and 5).
 *
 * ── Ownership note — this type is deliberately temporary ────────────────────
 * The versioned cross-mode LINK CONTRACT (`packages/contracts/src/
 * workjetCrossMode*`) and the server RPCs that mint and resolve links are
 * owned elsewhere. This module defines only what the navigation and
 * notification layer needs: the shape a link RESOLVES TO once it has already
 * been validated by that authority — a bounded, already-checked target.
 *
 * When the contract lands, `CrossModeTarget` must be re-typed onto it and this
 * module reduced to the renderer-side helpers (`normalizeCrossModeTarget`,
 * `productModeForCrossModeMode`, `describeCrossModeTarget`). Nothing else in
 * `crossMode/` constructs a target, so the swap is a single-file change.
 *
 * ── Redaction ───────────────────────────────────────────────────────────────
 * A target carries ADDRESSES only: bounded opaque ids and a bounded object
 * kind code. It never carries Business OS record data, thread content, prompt
 * text, or any other payload — the payload stays in the owning authority and
 * is fetched there after the navigation lands. Because every field below is a
 * bounded id or a closed literal, a would-be payload has no field to travel
 * in: decoding an object that carries one DROPS the excess key.
 */
import type { WorkjetProductMode } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Version of the local target shape. Bumped when the sibling contract lands. */
export const CROSS_MODE_TARGET_SCHEMA_VERSION = 1;

/**
 * The two product modes a link can address. Note the naming split that the
 * plan text uses: the LINK says `business-os`, while the persisted client
 * setting (`WorkjetProductMode`) says `ctox`. `productModeForCrossModeMode`
 * is the only place the two vocabularies meet.
 */
export const CrossModeMode = Schema.Literals(["code", "business-os"]);
export type CrossModeMode = typeof CrossModeMode.Type;

/** Bounded opaque handle. Never an account, a credential, or a record body. */
const CrossModeId = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
);

/**
 * A Business OS object KIND is a code, not a label: a small lowercase token
 * the owning authority defines. It exists so the navigator can pick a surface,
 * and so a notification can say what kind of thing is waiting without naming
 * it.
 */
const CrossModeObjectKind = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/),
);

/**
 * A CTOX Business OS app module id. Kept byte-compatible with
 * `CTOX_APP_MODULE_ID_PATTERN` in `apps/desktop/src/ctox/CtoxGuestManager.ts`,
 * because the navigator hands this straight to `bridge.openApp`.
 */
const CrossModeModuleId = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
);

/** Address of one Business OS object. An address, never the object. */
export const CrossModeBusinessOsObjectRef = Schema.Struct({
  kind: CrossModeObjectKind,
  id: CrossModeId,
  /** Which Business OS app owns it, when the link knows. */
  moduleId: Schema.optionalKey(CrossModeModuleId),
});
export type CrossModeBusinessOsObjectRef = typeof CrossModeBusinessOsObjectRef.Type;

/**
 * Where a cross-mode link points. Flat by design — this mirrors the shape the
 * sibling's resolver returns.
 */
export const CrossModeTarget = Schema.Struct({
  mode: CrossModeMode,
  /** Code mode: which environment owns the thread. */
  environmentId: Schema.optionalKey(CrossModeId),
  /** Code mode: which thread to open. */
  threadId: Schema.optionalKey(CrossModeId),
  /** Business OS mode: which CTOX instance owns the object. */
  ctoxInstanceId: Schema.optionalKey(CrossModeId),
  /** Business OS mode: which object inside that instance. */
  businessOsObject: Schema.optionalKey(CrossModeBusinessOsObjectRef),
});
export type CrossModeTarget = typeof CrossModeTarget.Type;

const decodeTargetOption = Schema.decodeUnknownOption(CrossModeTarget);

/**
 * Decode an untrusted value into a target, or `null`. Excess keys are dropped
 * rather than surfaced, so a payload smuggled alongside a valid target cannot
 * reach the navigator or a notification.
 */
export function decodeCrossModeTarget(value: unknown): CrossModeTarget | null {
  const decoded = decodeTargetOption(value);
  return Option.isSome(decoded) ? normalizeCrossModeTarget(decoded.value) : null;
}

/**
 * Drop every field that does not belong to the target's own mode.
 *
 * A `code` target has no business carrying a CTOX instance id, and a
 * `business-os` target has no business carrying a thread id: keeping them
 * would let a link created in one authority address the other's sidebar. This
 * is a narrowing, never a rejection — the mode is authoritative.
 */
export function normalizeCrossModeTarget(target: CrossModeTarget): CrossModeTarget {
  if (target.mode === "code") {
    return {
      mode: "code",
      ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
      ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
    };
  }
  return {
    mode: "business-os",
    ...(target.ctoxInstanceId === undefined ? {} : { ctoxInstanceId: target.ctoxInstanceId }),
    ...(target.businessOsObject === undefined ? {} : { businessOsObject: target.businessOsObject }),
  };
}

/** True when the target names a concrete entry, not just its owning mode. */
export function isAddressedCrossModeTarget(target: CrossModeTarget): boolean {
  return target.mode === "code"
    ? target.threadId !== undefined && target.environmentId !== undefined
    : target.ctoxInstanceId !== undefined;
}

/** The persisted product-mode value that owns this cross-mode target. */
export function productModeForCrossModeMode(mode: CrossModeMode): WorkjetProductMode {
  return mode === "business-os" ? "ctox" : "code";
}

/** The cross-mode vocabulary for a persisted product-mode value. */
export function crossModeModeForProductMode(mode: WorkjetProductMode): CrossModeMode {
  return mode === "ctox" ? "business-os" : "code";
}

/** Human-readable mode name, for notification text and accessible labels. */
export function crossModeModeLabel(mode: CrossModeMode): string {
  return mode === "business-os" ? "Business OS" : "Code";
}

/**
 * A bounded one-line description BUILT from ids and codes only. No free text
 * from any payload ever reaches this string — there is none to read.
 */
export function describeCrossModeTarget(target: CrossModeTarget): string {
  if (target.mode === "code") {
    if (target.threadId === undefined) return "Code";
    return target.environmentId === undefined
      ? `Code thread ${target.threadId}`
      : `Code thread ${target.threadId} in ${target.environmentId}`;
  }
  const instance =
    target.ctoxInstanceId === undefined ? "Business OS" : `Business OS ${target.ctoxInstanceId}`;
  const object = target.businessOsObject;
  return object === undefined ? instance : `${instance} · ${object.kind} ${object.id}`;
}

/** Stable key for deduping targets in a bounded notification list. */
export function crossModeTargetKey(target: CrossModeTarget): string {
  const normalized = normalizeCrossModeTarget(target);
  if (normalized.mode === "code") {
    return `code:${normalized.environmentId ?? ""}:${normalized.threadId ?? ""}`;
  }
  const object = normalized.businessOsObject;
  return `business-os:${normalized.ctoxInstanceId ?? ""}:${object?.kind ?? ""}:${object?.id ?? ""}`;
}
