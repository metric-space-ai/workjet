// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Login origins of the native Google calendar sign-in (ctox #875,
 * `connect: "calendar-oauth"`).
 *
 * The in-app login window only ever shows pages of these origins; every other
 * top-level navigation and every popup to another origin is blocked. The list
 * is fixed in the app, never taken from the instance or the provider.
 */
export const CALENDAR_AUTHORIZE_ORIGINS: ReadonlyArray<string> = ["https://accounts.google.com"];
